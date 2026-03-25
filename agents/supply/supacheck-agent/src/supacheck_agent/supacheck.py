"""
supacheck - Scan websites for exposed Supabase credentials,
then optionally probe whether those credentials allow unauthorized
database access (missing RLS).

Adapted for use as an agent tool — functions are called by the orchestrator,
not from CLI.
"""

from __future__ import annotations

import json
import re
from urllib.parse import urljoin, urlparse

import requests


# -- Regex patterns --------------------------------------------------------

# Supabase project URL: https://<project-ref>.supabase.co
SUPABASE_URL_PATTERN = re.compile(r"https://[a-z0-9\-]+\.supabase\.co")

# Supabase anon/service keys are JWTs (three base64url segments)
SUPABASE_KEY_PATTERN = re.compile(
    r"eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"
)

# Framework env-var names that get bundled into client-side JS
SUPABASE_HINT_PATTERNS = [
    re.compile(r"NEXT_PUBLIC_SUPABASE_URL", re.IGNORECASE),
    re.compile(r"NEXT_PUBLIC_SUPABASE_ANON_KEY", re.IGNORECASE),
    re.compile(r"NEXT_PUBLIC_SUPABASE_KEY", re.IGNORECASE),
    re.compile(r"VITE_SUPABASE_URL", re.IGNORECASE),
    re.compile(r"VITE_SUPABASE_ANON_KEY", re.IGNORECASE),
    re.compile(r"VITE_SUPABASE_KEY", re.IGNORECASE),
    re.compile(r"REACT_APP_SUPABASE_URL", re.IGNORECASE),
    re.compile(r"REACT_APP_SUPABASE_ANON_KEY", re.IGNORECASE),
    re.compile(r"NUXT_PUBLIC_SUPABASE_URL", re.IGNORECASE),
    re.compile(r"NUXT_PUBLIC_SUPABASE_KEY", re.IGNORECASE),
    re.compile(r"SUPABASE_URL", re.IGNORECASE),
    re.compile(r"SUPABASE_KEY", re.IGNORECASE),
    re.compile(r"SUPABASE_ANON_KEY", re.IGNORECASE),
    re.compile(r"supabaseUrl", re.IGNORECASE),
    re.compile(r"supabaseKey", re.IGNORECASE),
    re.compile(r"supabaseAnonKey", re.IGNORECASE),
    re.compile(r"createClient\s*\(", re.IGNORECASE),
    re.compile(r"@supabase/supabase-js"),
]

# HTML <script src="..."> and <link href="...*.js">
SCRIPT_SRC_PATTERN = re.compile(
    r'<script[^>]+src=["\']([^"\']+)["\']', re.IGNORECASE
)
LINK_HREF_PATTERN = re.compile(
    r'<link[^>]+href=["\']([^"\']+\.js[^"\']*)["\']', re.IGNORECASE
)

# Match JS paths referenced as string literals in code
CHUNK_PATTERN = re.compile(
    r'["\']'
    r'((?:https?://[^"\']+|'
    r'(?:\.{0,2}/)'
    r'[^"\'(){};=<>\s!|&]{1,250}'
    r'\.js(?:\?[^"\']*)?)'
    r')["\']'
)


# -- Helpers ---------------------------------------------------------------


def _fetch_page(url: str, session: requests.Session, silent: bool = False) -> str | None:
    """Fetch a URL and return its text content."""
    try:
        resp = session.get(url, timeout=15)
        resp.raise_for_status()
        return resp.text
    except requests.RequestException:
        return None


def _extract_js_urls(html: str, base_url: str) -> set[str]:
    """Extract JavaScript file URLs from HTML tags and string-literal chunk refs."""
    urls: set[str] = set()
    for pattern in [SCRIPT_SRC_PATTERN, LINK_HREF_PATTERN, CHUNK_PATTERN]:
        for match in pattern.finditer(html):
            src = match.group(1)
            if src.startswith("data:"):
                continue
            urls.add(urljoin(base_url, src))
    return urls


def _scan_content(content: str, source_label: str) -> dict:
    """Scan text for Supabase URLs, keys, and variable-name hints."""
    findings: dict = {"urls": [], "keys": [], "full_keys": [], "hints": []}

    for match in SUPABASE_URL_PATTERN.finditer(content):
        url = match.group(0)
        start = max(0, match.start() - 60)
        end = min(len(content), match.end() + 60)
        context = content[start:end].replace("\n", " ").strip()
        findings["urls"].append(
            {"value": url, "context": context, "source": source_label}
        )

    for match in SUPABASE_KEY_PATTERN.finditer(content):
        key = match.group(0)
        region_start = max(0, match.start() - 500)
        region_end = min(len(content), match.end() + 500)
        region = content[region_start:region_end].lower()
        if "supabase" in region:
            short_key = key[:20] + "..." + key[-10:]
            findings["keys"].append({"value": short_key, "source": source_label})
            findings["full_keys"].append(key)

    for pattern in SUPABASE_HINT_PATTERNS:
        for match in pattern.finditer(content):
            start = max(0, match.start() - 40)
            end = min(len(content), match.end() + 40)
            context = content[start:end].replace("\n", " ").strip()
            findings["hints"].append(
                {"value": match.group(0), "context": context, "source": source_label}
            )

    return findings


def _merge_findings(all_findings: dict, new_findings: dict) -> None:
    """Merge new findings into cumulative results, deduplicating."""
    seen_urls = {f["value"] for f in all_findings["urls"]}
    seen_keys = {f["value"] for f in all_findings["keys"]}
    seen_full = set(all_findings["full_keys"])

    for f in new_findings["urls"]:
        if f["value"] not in seen_urls:
            all_findings["urls"].append(f)
            seen_urls.add(f["value"])

    for f in new_findings["keys"]:
        if f["value"] not in seen_keys:
            all_findings["keys"].append(f)
            seen_keys.add(f["value"])

    for k in new_findings["full_keys"]:
        if k not in seen_full:
            all_findings["full_keys"].append(k)
            seen_full.add(k)

    seen_hints = {(f["value"], f["source"]) for f in all_findings["hints"]}
    for f in new_findings["hints"]:
        hkey = (f["value"], f["source"])
        if hkey not in seen_hints:
            all_findings["hints"].append(f)
            seen_hints.add(hkey)


# -- Phase 1: Website scanning --------------------------------------------


def scan_website(target_url: str, deep: bool = False) -> dict:
    """Fetch the website and scan for exposed Supabase credentials."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (compatible; supacheck/1.0; security audit)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })

    all_findings: dict = {"urls": [], "keys": [], "full_keys": [], "hints": []}
    scanned_urls: set[str] = set()

    # Step 1: main page
    html = _fetch_page(target_url, session)
    if html is None:
        raise RuntimeError(f"Could not fetch {target_url}")
    scanned_urls.add(target_url)

    page_findings = _scan_content(html, f"HTML: {target_url}")
    _merge_findings(all_findings, page_findings)

    # Step 2: JS files
    js_urls = _extract_js_urls(html, target_url)

    if deep:
        parsed = urlparse(target_url)
        base = f"{parsed.scheme}://{parsed.netloc}"
        for path in [
            "/static/js/main.js",
            "/static/js/bundle.js",
            "/_next/static/chunks/main.js",
            "/_next/static/chunks/app.js",
            "/assets/index.js",
            "/build/bundle.js",
        ]:
            js_urls.add(urljoin(base, path))

    parsed_target = urlparse(target_url)
    for js_url in sorted(js_urls):
        if js_url in scanned_urls:
            continue
        scanned_urls.add(js_url)

        parsed_js = urlparse(js_url)
        if parsed_js.netloc and parsed_js.netloc != parsed_target.netloc:
            if not any(
                h in parsed_js.netloc
                for h in ["vercel", "netlify", "cloudfront", "githubusercontent"]
            ):
                continue

        js_content = _fetch_page(js_url, session, silent=True)
        if js_content is None:
            continue

        short_label = urlparse(js_url).path
        if len(short_label) > 60:
            short_label = "..." + short_label[-57:]

        js_findings = _scan_content(js_content, f"JS: {short_label}")
        _merge_findings(all_findings, js_findings)

        # In deep mode, follow nested JS references (one level)
        if deep:
            for nested in _extract_js_urls(js_content, js_url):
                if nested not in scanned_urls:
                    scanned_urls.add(nested)
                    nested_content = _fetch_page(nested, session, silent=True)
                    if nested_content:
                        nf = _scan_content(
                            nested_content, f"JS: {urlparse(nested).path}"
                        )
                        _merge_findings(all_findings, nf)

    # Step 3: inline scripts / meta tags
    inline_patterns = [
        re.compile(r"__NEXT_DATA__.*?</script>", re.DOTALL),
        re.compile(r"window\.__.*?</script>", re.DOTALL),
        re.compile(
            r'<meta[^>]+content=["\'][^"\']*supabase[^"\']*["\']', re.IGNORECASE
        ),
    ]
    for pattern in inline_patterns:
        for match in pattern.finditer(html):
            _merge_findings(
                all_findings, _scan_content(match.group(0), "Inline script/meta")
            )

    return all_findings


# -- Phase 2: RLS / CRUD probing ------------------------------------------


def _make_supa_headers(anon_key: str) -> dict[str, str]:
    return {
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}",
        "Content-Type": "application/json",
    }


def _discover_tables(base_url: str, headers: dict) -> list[str]:
    """Discover tables via the PostgREST OpenAPI spec."""
    url = urljoin(base_url, "/rest/v1/")
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 200:
            spec = resp.json()
            paths = spec.get("paths", {})
            return sorted(
                p.lstrip("/") for p in paths
                if p != "/" and not p.startswith("/rpc/")
            )
    except (requests.RequestException, json.JSONDecodeError):
        pass
    return []


def _probe_select(base_url: str, headers: dict, table: str) -> tuple:
    url = urljoin(base_url, f"/rest/v1/{table}?select=*&limit=5")
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if not isinstance(data, list):
                return "blocked", "non-table", []
            return ("exposed" if data else "empty"), len(data), data
        return "blocked", resp.status_code, []
    except (requests.RequestException, json.JSONDecodeError):
        return "error", None, []


def _probe_insert(base_url: str, headers: dict, table: str) -> tuple:
    url = urljoin(base_url, f"/rest/v1/{table}")
    h = {**headers, "Prefer": "return=minimal"}
    try:
        resp = requests.post(url, headers=h, json={}, timeout=10)
        if resp.status_code in (201, 400, 409):
            return True, resp.status_code
        return False, resp.status_code
    except requests.RequestException:
        return False, None


def _probe_update(base_url: str, headers: dict, table: str, sample_row: dict | None) -> tuple:
    if sample_row:
        cols = list(sample_row.keys())
        filter_col = "id" if "id" in cols else cols[0]
        filter_val = sample_row[filter_col]
        set_col = next((c for c in cols if c != filter_col), filter_col)
        set_val = sample_row[set_col]

        url = urljoin(base_url, f"/rest/v1/{table}?{filter_col}=eq.{filter_val}")
        h = {**headers, "Prefer": "count=exact"}
        try:
            resp = requests.patch(url, headers=h, json={set_col: set_val}, timeout=10)
            if resp.status_code in (401, 403):
                return "blocked", resp.status_code
            if resp.status_code in (200, 204):
                content_range = resp.headers.get("Content-Range", "")
                if "/" in content_range:
                    count_str = content_range.split("/")[-1]
                    if count_str.isdigit() and int(count_str) > 0:
                        return "exposed", int(count_str)
                return "inconclusive", resp.status_code
            return "blocked", resp.status_code
        except requests.RequestException:
            return "error", None

    url = urljoin(base_url, f"/rest/v1/{table}")
    h = {**headers, "Prefer": "count=exact"}
    try:
        resp = requests.patch(url, headers=h, json={}, timeout=10)
        if resp.status_code in (401, 403):
            return "blocked", resp.status_code
        return "inconclusive", resp.status_code
    except requests.RequestException:
        return "error", None


def _probe_delete(base_url: str, headers: dict, table: str, sample_row: dict | None) -> tuple:
    if sample_row:
        cols = list(sample_row.keys())
        filter_col = "id" if "id" in cols else cols[0]
        real_val = sample_row[filter_col]
        url = urljoin(
            base_url,
            f"/rest/v1/{table}"
            f"?{filter_col}=eq.{real_val}"
            f"&{filter_col}=neq.{real_val}"
        )
    else:
        url = urljoin(base_url, f"/rest/v1/{table}?id=eq.__supacheck_noop__")

    try:
        resp = requests.delete(url, headers=headers, timeout=10)
        if resp.status_code in (401, 403):
            return "blocked", resp.status_code
        if resp.status_code in (200, 204):
            if sample_row:
                return "exposed", resp.status_code
            return "inconclusive", resp.status_code
        return "inconclusive", resp.status_code
    except requests.RequestException:
        return "error", None


def _discover_schema(base_url: str, headers: dict) -> dict:
    """Fetch the OpenAPI spec and extract table schemas."""
    url = urljoin(base_url, "/rest/v1/")
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        if resp.status_code != 200:
            return {}
        spec = resp.json()
        definitions = spec.get("definitions", {})
        schema_map = {}
        for table_name, table_def in definitions.items():
            if table_name.startswith("rpc/"):
                continue
            props = table_def.get("properties", {})
            required = set(table_def.get("required", []))
            columns = []
            for col_name, col_info in props.items():
                col_type = col_info.get("format", col_info.get("type", "unknown"))
                desc = col_info.get("description", "")
                pk = "<PK>" if "primary" in desc.lower() else ""
                fk = ""
                if "fk" in desc.lower() or "foreign" in desc.lower() or "references" in desc.lower():
                    fk = "<FK>"
                nullable = "NULL" if col_name not in required else "NOT NULL"
                columns.append({
                    "name": col_name,
                    "type": col_type,
                    "nullable": nullable,
                    "pk": pk,
                    "fk": fk,
                })
            if columns:
                schema_map[table_name] = columns
        return schema_map
    except (requests.RequestException, json.JSONDecodeError):
        return {}


def _probe_auth_signup(base_url: str, headers: dict) -> str:
    url = urljoin(base_url, "/auth/v1/signup")
    try:
        resp = requests.post(
            url, headers=headers,
            json={"email": "supacheck-probe@invalid.test", "password": "TestOnly12345!"},
            timeout=10,
        )
        if resp.status_code == 200:
            return "open"
        if resp.status_code in (422, 400):
            return "accessible"
        if resp.status_code == 429:
            return "rate_limited"
        return "blocked"
    except requests.RequestException:
        return "error"


def _probe_auth_settings(base_url: str, headers: dict) -> dict | None:
    url = urljoin(base_url, "/auth/v1/settings")
    try:
        resp = requests.get(url, headers={"apikey": headers["apikey"]}, timeout=10)
        if resp.status_code == 200:
            return resp.json()
        return None
    except (requests.RequestException, json.JSONDecodeError):
        return None


def _probe_auth_admin(base_url: str, headers: dict) -> tuple:
    url = urljoin(base_url, "/auth/v1/admin/users")
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            users = data.get("users", data) if isinstance(data, dict) else data
            if isinstance(users, list):
                sample = []
                for u in users[:3]:
                    if isinstance(u, dict):
                        sample.append({
                            "email": u.get("email", "?")[:3] + "***",
                            "role": u.get("role", "?"),
                            "created_at": u.get("created_at", "?"),
                        })
                return "exposed", {"count": len(users), "sample": sample}
            return "exposed", {"count": 1, "sample": []}
        return "blocked", resp.status_code
    except (requests.RequestException, json.JSONDecodeError):
        return "error", None


def _probe_storage_buckets(base_url: str, headers: dict) -> dict:
    results: dict = {
        "buckets": [], "accessible_buckets": [],
        "listable_buckets": [], "downloadable_files": [],
    }
    url = urljoin(base_url, "/storage/v1/bucket")
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 200:
            buckets = resp.json()
            if isinstance(buckets, list):
                results["buckets"] = buckets
                for bucket in buckets:
                    name = bucket.get("name", bucket.get("id", ""))
                    is_public = bucket.get("public", False)
                    results["accessible_buckets"].append({
                        "name": name,
                        "public": is_public,
                    })
                    list_url = urljoin(base_url, f"/storage/v1/object/list/{name}")
                    try:
                        lr = requests.post(
                            list_url, headers=headers,
                            json={"prefix": "", "limit": 10, "offset": 0},
                            timeout=10,
                        )
                        if lr.status_code == 200:
                            objects = lr.json()
                            if isinstance(objects, list) and objects:
                                file_objects = [
                                    o for o in objects
                                    if o.get("id") or o.get("name")
                                ]
                                results["listable_buckets"].append({
                                    "name": name,
                                    "public": is_public,
                                    "sample_objects": [
                                        o.get("name", str(o)) for o in file_objects[:5]
                                    ],
                                    "count": len(objects),
                                })
                                for obj in file_objects[:2]:
                                    obj_name = obj.get("name", "")
                                    if not obj_name or obj.get("metadata") is None:
                                        continue
                                    if is_public:
                                        dl_url = urljoin(
                                            base_url,
                                            f"/storage/v1/object/public/{name}/{obj_name}"
                                        )
                                    else:
                                        dl_url = urljoin(
                                            base_url,
                                            f"/storage/v1/object/authenticated/{name}/{obj_name}"
                                        )
                                    try:
                                        dr = requests.head(dl_url, headers=headers, timeout=5)
                                        if dr.status_code == 200:
                                            results["downloadable_files"].append({
                                                "bucket": name,
                                                "file": obj_name,
                                                "size": dr.headers.get("Content-Length", "?"),
                                                "type": dr.headers.get("Content-Type", "?"),
                                                "public": is_public,
                                            })
                                    except requests.RequestException:
                                        pass
                    except requests.RequestException:
                        pass
    except (requests.RequestException, json.JSONDecodeError):
        pass
    return results


def _probe_rpc_functions(base_url: str, headers: dict) -> tuple:
    url = urljoin(base_url, "/rest/v1/")
    rpc_funcs: list[str] = []
    dangerous: list[str] = []
    callable_funcs: list[dict] = []
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 200:
            spec = resp.json()
            paths = spec.get("paths", {})
            for path in paths:
                if path.startswith("/rpc/"):
                    func_name = path[5:]
                    rpc_funcs.append(func_name)
                    danger_names = [
                        "http_get", "http_post", "http_put", "http_delete", "http",
                        "exec", "execute", "eval", "run_sql", "query",
                    ]
                    if func_name.lower() in danger_names:
                        dangerous.append(func_name)

            for func_name in rpc_funcs:
                rpc_url = urljoin(base_url, f"/rest/v1/rpc/{func_name}")
                try:
                    r = requests.post(rpc_url, headers=headers, json={}, timeout=5)
                    if r.status_code in (200, 204):
                        try:
                            body = r.json()
                        except json.JSONDecodeError:
                            body = r.text[:200]
                        callable_funcs.append({
                            "name": func_name,
                            "status": r.status_code,
                            "sample": str(body)[:200],
                        })
                    elif r.status_code == 400:
                        callable_funcs.append({
                            "name": func_name,
                            "status": r.status_code,
                            "sample": "(requires params)",
                        })
                except requests.RequestException:
                    pass
    except (requests.RequestException, json.JSONDecodeError):
        pass
    return rpc_funcs, dangerous, callable_funcs


def _probe_graphql(base_url: str, headers: dict) -> dict:
    results: dict = {
        "available": False, "introspection": False,
        "types": [], "data_accessible": False, "data_proof": [],
    }
    url = urljoin(base_url, "/graphql/v1")

    try:
        resp = requests.post(
            url, headers=headers,
            json={"query": "{ __typename }"},
            timeout=10,
        )
        if resp.status_code == 200:
            data = resp.json()
            if "data" in data:
                results["available"] = True
    except (requests.RequestException, json.JSONDecodeError):
        return results

    if not results["available"]:
        return results

    introspection_query = (
        '{ __schema { types { name kind fields { name type { name kind } } } } }'
    )
    try:
        resp = requests.post(
            url, headers=headers,
            json={"query": introspection_query},
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            types = data.get("data", {}).get("__schema", {}).get("types", [])
            user_types = [
                t for t in types
                if not t["name"].startswith("__") and t.get("fields")
            ]
            if user_types:
                results["introspection"] = True
                results["types"] = [
                    {"name": t["name"], "fields": [f["name"] for f in (t.get("fields") or [])[:6]]}
                    for t in user_types[:20]
                ]
    except (requests.RequestException, json.JSONDecodeError):
        pass

    return results


def _probe_schemas(base_url: str, headers: dict) -> list[str]:
    url = urljoin(base_url, "/rest/v1/")
    h = {**headers, "Accept-Profile": "__supacheck_nonexistent__"}
    schemas: list[str] = []
    try:
        resp = requests.get(url, headers=h, timeout=10)
        if resp.status_code in (400, 406):
            body = resp.text
            match = re.search(r'following: ([a-z_, ]+)', body, re.IGNORECASE)
            if match:
                schemas = [s.strip() for s in match.group(1).split(",") if s.strip()]
            else:
                try:
                    err = resp.json()
                    msg = err.get("message", err.get("details", ""))
                    match = re.search(r'following: ([a-z_, ]+)', msg, re.IGNORECASE)
                    if match:
                        schemas = [s.strip() for s in match.group(1).split(",") if s.strip()]
                except json.JSONDecodeError:
                    pass
    except requests.RequestException:
        pass
    return schemas


def _probe_edge_functions(base_url: str, headers: dict) -> list[dict]:
    common_names = [
        "hello", "test", "webhook", "stripe-webhook", "send-email",
        "process", "cron", "notify", "api", "graphql", "proxy",
        "payment", "checkout", "auth", "callback", "ingest",
        "upload", "resize", "generate", "embed", "search",
    ]
    found: list[dict] = []
    for name in common_names:
        url = urljoin(base_url, f"/functions/v1/{name}")
        try:
            resp = requests.post(url, headers=headers, json={}, timeout=5)
            if resp.status_code != 404:
                found.append({"name": name, "status": resp.status_code})
        except requests.RequestException:
            pass
    return found


def _probe_service_info(base_url: str, headers: dict) -> dict:
    info: dict = {}
    try:
        resp = requests.get(
            urljoin(base_url, "/rest/v1/"),
            headers={"apikey": headers["apikey"]},
            timeout=10,
        )
        server = resp.headers.get("Server", "")
        if server:
            info["postgrest"] = server
    except requests.RequestException:
        pass

    try:
        resp = requests.get(urljoin(base_url, "/auth/v1/health"), timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            info["gotrue_version"] = data.get("version", "unknown")
    except (requests.RequestException, json.JSONDecodeError):
        pass

    return info


# -- Phase 2 entry point --------------------------------------------------


def run_probes(supabase_url: str, anon_key: str) -> list[dict]:
    """Run comprehensive vulnerability probes. Returns list of vulnerable tables."""
    headers = _make_supa_headers(anon_key)
    supabase_url = supabase_url.rstrip("/")
    vulnerabilities: list[dict] = []

    # Connectivity check
    rest_url = urljoin(supabase_url, "/rest/v1/")
    try:
        resp = requests.get(rest_url, headers=headers, timeout=10)
        if resp.status_code != 200:
            return [{"type": "connectivity", "status": "failed", "detail": resp.status_code}]
    except requests.RequestException as e:
        return [{"type": "connectivity", "status": "error", "detail": str(e)}]

    # Service info
    svc_info = _probe_service_info(supabase_url, headers)
    if svc_info:
        vulnerabilities.append({"type": "service_info", "severity": "LOW", "detail": svc_info})

    # Schema enumeration
    schemas = _probe_schemas(supabase_url, headers)
    if schemas:
        sensitive = [s for s in schemas if s in ("storage", "auth", "graphql_public")]
        vulnerabilities.append({
            "type": "schema_enumeration",
            "severity": "HIGH" if sensitive else "MEDIUM",
            "schemas": schemas,
            "sensitive_schemas": sensitive,
        })

    # Table discovery
    tables = _discover_tables(supabase_url, headers)
    if tables:
        vulnerabilities.append({
            "type": "table_discovery",
            "severity": "MEDIUM",
            "tables": tables,
        })

    # Schema map
    schema_map = _discover_schema(supabase_url, headers)
    if schema_map:
        vulnerabilities.append({
            "type": "schema_exposed",
            "severity": "HIGH",
            "table_count": len(schema_map),
            "column_count": sum(len(cols) for cols in schema_map.values()),
            "tables": {
                tbl: [{"name": c["name"], "type": c["type"]} for c in cols]
                for tbl, cols in schema_map.items()
            },
        })

    # RLS / CRUD checks
    for table in tables:
        issues = []
        sample_row = None

        sel_status, sel_detail, rows = _probe_select(supabase_url, headers, table)
        sample_row = rows[0] if rows else None
        if sel_status == "exposed":
            issues.append(f"SELECT ({sel_detail} rows)")

        ins_allowed, _ = _probe_insert(supabase_url, headers, table)
        if ins_allowed:
            issues.append("INSERT")

        upd_status, _ = _probe_update(supabase_url, headers, table, sample_row)
        if upd_status == "exposed":
            issues.append("UPDATE")

        del_status, _ = _probe_delete(supabase_url, headers, table, sample_row)
        if del_status == "exposed":
            issues.append("DELETE")

        if issues:
            vuln: dict = {
                "type": "missing_rls",
                "severity": "CRITICAL",
                "table": table,
                "exposed_operations": issues,
            }
            if sample_row:
                proof = json.dumps(sample_row, default=str)
                if len(proof) > 300:
                    proof = proof[:300] + "..."
                vuln["sample_data"] = proof
            vulnerabilities.append(vuln)

    # RPC functions
    rpc_funcs, dangerous, callable_funcs = _probe_rpc_functions(supabase_url, headers)
    if callable_funcs:
        vulnerabilities.append({
            "type": "rpc_exposed",
            "severity": "CRITICAL" if dangerous else "HIGH",
            "functions": rpc_funcs,
            "dangerous": dangerous,
            "callable": callable_funcs,
        })

    # Auth settings
    auth_settings = _probe_auth_settings(supabase_url, headers)
    if auth_settings:
        auto_confirm = auth_settings.get("mailer_autoconfirm", False)
        disable_signup = auth_settings.get("disable_signup", False)
        vulnerabilities.append({
            "type": "auth_settings_exposed",
            "severity": "CRITICAL" if auto_confirm else "HIGH",
            "auto_confirm": auto_confirm,
            "signup_disabled": disable_signup,
            "settings": {
                k: auth_settings.get(k)
                for k in ["mailer_autoconfirm", "phone_autoconfirm", "disable_signup"]
                if k in auth_settings
            },
        })

    # Auth signup
    signup = _probe_auth_signup(supabase_url, headers)
    if signup in ("open", "accessible"):
        vulnerabilities.append({
            "type": "auth_signup",
            "severity": "HIGH" if signup == "open" else "MEDIUM",
            "status": signup,
        })

    # Auth admin
    admin_status, admin_detail = _probe_auth_admin(supabase_url, headers)
    if admin_status == "exposed":
        vulnerabilities.append({
            "type": "auth_admin_exposed",
            "severity": "CRITICAL",
            "detail": admin_detail,
        })

    # Storage buckets
    storage = _probe_storage_buckets(supabase_url, headers)
    if storage["accessible_buckets"]:
        vulnerabilities.append({
            "type": "storage_exposed",
            "severity": "HIGH" if storage["downloadable_files"] else "MEDIUM",
            "buckets": storage["accessible_buckets"],
            "listable": storage["listable_buckets"],
            "downloadable": storage["downloadable_files"],
        })

    # GraphQL
    gql = _probe_graphql(supabase_url, headers)
    if gql["available"]:
        vulnerabilities.append({
            "type": "graphql_exposed",
            "severity": "HIGH" if gql["introspection"] else "MEDIUM",
            "introspection": gql["introspection"],
            "types": gql["types"][:10],
            "data_accessible": gql["data_accessible"],
        })

    # Edge functions
    edge_funcs = _probe_edge_functions(supabase_url, headers)
    if edge_funcs:
        vulnerabilities.append({
            "type": "edge_functions_exposed",
            "severity": "MEDIUM",
            "functions": edge_funcs,
        })

    return vulnerabilities


def print_report(vulnerabilities: list[dict]) -> None:
    """Print a human-readable report (for CLI usage)."""
    if not vulnerabilities:
        print("No vulnerabilities found.")
        return

    severity_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    sorted_vulns = sorted(
        vulnerabilities,
        key=lambda v: severity_order.get(v.get("severity", "LOW"), 4)
    )

    for v in sorted_vulns:
        sev = v.get("severity", "?")
        vtype = v.get("type", "unknown")
        print(f"[{sev}] {vtype}")
        for k, val in v.items():
            if k not in ("severity", "type"):
                print(f"  {k}: {val}")
        print()
