"""Core orchestrator — purely LLM-driven via tool calling.

Each tick:
  1. Gather state (balances, API key status, SSE events)
  2. Ask the planner (LLM) — it decides which tools to call
  3. Execute tool calls, feed results back
  4. If the LLM wants more tool calls, loop; otherwise wait for next tick

The agent discovers everything from the OpenAPI spec and citizen.md.
No hardcoded lifecycle flows.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from requester_agent.config import settings
from requester_agent.engine.planner import Planner, ToolCall
from requester_agent.sse.client import SSEListener
from requester_agent.state import EventRecord, init_db, async_session
from requester_agent.tools.http import HttpResponse, http_request, http_get_page, close_client
from requester_agent.tools.metrics import metrics_inc
from requester_agent.tools.solana import (
    load_keypair,
    solana_transfer,
    sign_payment,
    sign_message,
    encode_payment_proof,
    get_usdc_balance,
    get_sol_balance,
)
from requester_agent.tools.storage import fs_read, fs_write, secret_get, secret_set
from requester_agent.tools.utils import generate_id, log, sleep_ms
from requester_agent.tools.validation import OpenAPIValidator

logger = logging.getLogger(__name__)

# Cap conversation history to avoid blowing context
MAX_HISTORY = 40


class Orchestrator:
    """LLM-driven orchestrator — the LLM calls tools, we execute them."""

    def __init__(self) -> None:
        self.planner = Planner()
        self.keypair = load_keypair()
        self.address = str(self.keypair.pubkey())
        self.openapi_validator: OpenAPIValidator | None = None
        self.citizen_md: str = ""
        self.api_base_url: str = settings.platform_url  # may be updated by discovery
        self.api_key: str | None = None
        self._running = False
        self._history: list[dict[str, Any]] = []
        self._sse_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    # ── Bootstrap ────────────────────────────────────────────────────

    async def start(self) -> None:
        log("INFO", "Orchestrator starting", {"agent": settings.agent_name, "wallet": self.address})
        await init_db()
        await self._fetch_docs()
        log("INFO", f"API base resolved to: {self.api_base_url}")
        self.api_key = secret_get("AGIC_API_KEY")
        self._running = True

        sse_task = None
        if self.api_key:
            sse_task = asyncio.create_task(self._start_sse(), name="sse")

        try:
            await self._agent_loop()
        except asyncio.CancelledError:
            pass
        finally:
            self._running = False
            if sse_task:
                sse_task.cancel()
            await close_client()
            log("INFO", "Orchestrator stopped")

    async def stop(self) -> None:
        self._running = False

    # ── Doc Discovery & Fetching ────────────────────────────────────

    async def _fetch_docs(self) -> None:
        """Discover and fetch platform docs from the base URL alone.

        Strategy:
        1. Hit the base platform URL — many APIs return a root resource with
           links to docs, openapi spec, etc.
        2. Look for openapi/swagger and citizen.md URLs in the response.
        3. Fall back to well-known path conventions.
        4. Fall back to local cache.
        """
        base = settings.platform_url.rstrip("/")
        discovered = await self._discover_doc_urls(base)

        # Fetch OpenAPI spec — also derive API base from its URL
        openapi_url = discovered.get("openapi")
        if openapi_url:
            # The API base is where the spec lives (minus the filename)
            from urllib.parse import urlparse
            parsed = urlparse(openapi_url)
            path = parsed.path.rsplit("/", 1)[0]  # strip filename like /openapi.json
            self.api_base_url = f"{parsed.scheme}://{parsed.netloc}{path}".rstrip("/")
            log("INFO", f"API base derived from OpenAPI URL: {self.api_base_url}")
        await self._fetch_openapi(openapi_url)

        # Fetch citizen.md
        citizen_url = discovered.get("citizen_md")
        await self._fetch_citizen_md(citizen_url)

    async def _discover_doc_urls(self, base: str) -> dict[str, str]:
        """Probe the platform root to discover doc endpoints."""
        discovered: dict[str, str] = {}

        # Try hitting the base URL for a discovery/root resource
        log("INFO", "Discovering platform docs", {"base": base})
        try:
            resp = await http_get_page(base)
            if isinstance(resp.json_body, dict):
                body = resp.json_body
                # Handle envelope
                data = body.get("data", body)
                if isinstance(data, dict):
                    discovered.update(self._extract_doc_links(data, base))
            # Also scan raw text for URLs if JSON didn't yield results
            if not discovered:
                discovered.update(self._scan_text_for_doc_urls(resp.text, base))
        except Exception as exc:
            log("WARN", f"Root discovery failed: {exc}")

        # Try /docs endpoint (common pattern)
        if not discovered:
            try:
                resp = await http_get_page(f"{base}/docs")
                if isinstance(resp.json_body, dict):
                    data = resp.json_body.get("data", resp.json_body)
                    if isinstance(data, dict):
                        discovered.update(self._extract_doc_links(data, base))
                if not discovered:
                    discovered.update(self._scan_text_for_doc_urls(resp.text, base))
            except Exception:
                pass

        # Fall back to well-known conventions
        if "openapi" not in discovered:
            candidates = [
                f"{base}/openapi.json",
                f"{base}/docs/openapi.json",
                f"{base}/swagger.json",
                f"{base}/api-docs",
            ]
            for url in candidates:
                try:
                    resp = await http_request("HEAD", url)
                    assert isinstance(resp, HttpResponse)
                    if resp.status == 200:
                        discovered["openapi"] = url
                        log("INFO", f"OpenAPI found at convention path: {url}")
                        break
                except Exception:
                    continue

        if "citizen_md" not in discovered:
            candidates = [
                f"{base}/docs/citizen.md",
                f"{base}/citizen.md",
                f"{base}/docs/citizen",
            ]
            for url in candidates:
                try:
                    resp = await http_request("HEAD", url)
                    assert isinstance(resp, HttpResponse)
                    if resp.status == 200:
                        discovered["citizen_md"] = url
                        log("INFO", f"citizen.md found at convention path: {url}")
                        break
                except Exception:
                    continue

        log("INFO", "Discovery complete", discovered)
        # Cache discovered URLs for future runs
        if discovered:
            fs_write("discovered_urls.json", json.dumps(discovered, indent=2))
        return discovered

    def _extract_doc_links(self, data: dict[str, Any], base: str) -> dict[str, str]:
        """Extract doc URLs from a JSON response body by scanning keys and values."""
        found: dict[str, str] = {}
        # Flatten: check all string values recursively
        for key, val in self._flatten_dict(data):
            key_lower = key.lower()
            if isinstance(val, str) and (val.startswith("http") or val.startswith("/")):
                url = val if val.startswith("http") else f"{base}{val}"
                if any(kw in key_lower for kw in ["openapi", "swagger", "api_spec", "apispec", "spec"]):
                    found["openapi"] = url
                elif any(kw in key_lower for kw in ["citizen", "guide", "norms", "rules"]):
                    found["citizen_md"] = url
                elif "doc" in key_lower and val.endswith(".json"):
                    found.setdefault("openapi", url)
                elif "doc" in key_lower and val.endswith(".md"):
                    found.setdefault("citizen_md", url)
        return found

    def _scan_text_for_doc_urls(self, text: str, base: str) -> dict[str, str]:
        """Scan raw text/HTML for doc URLs as a last resort."""
        import re
        found: dict[str, str] = {}
        # Look for URLs containing openapi/swagger
        urls = re.findall(r'https?://[^\s"\'<>]+', text)
        for url in urls:
            lower = url.lower()
            if any(kw in lower for kw in ["openapi", "swagger"]) and "openapi" not in found:
                found["openapi"] = url
            elif "citizen" in lower and "citizen_md" not in found:
                found["citizen_md"] = url
        # Also look for relative paths
        paths = re.findall(r'["\'](/[^\s"\'<>]+\.(?:json|md))["\']', text)
        for path in paths:
            lower = path.lower()
            if any(kw in lower for kw in ["openapi", "swagger"]) and "openapi" not in found:
                found["openapi"] = f"{base}{path}"
            elif "citizen" in lower and "citizen_md" not in found:
                found["citizen_md"] = f"{base}{path}"
        return found

    @staticmethod
    def _flatten_dict(d: dict, prefix: str = "") -> list[tuple[str, Any]]:
        """Recursively flatten a dict into (dotted_key, value) pairs."""
        items: list[tuple[str, Any]] = []
        for k, v in d.items():
            full_key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                items.extend(Orchestrator._flatten_dict(v, full_key))
            elif isinstance(v, list):
                for i, item in enumerate(v):
                    if isinstance(item, dict):
                        items.extend(Orchestrator._flatten_dict(item, f"{full_key}[{i}]"))
                    else:
                        items.append((f"{full_key}[{i}]", item))
            else:
                items.append((full_key, v))
        return items

    async def _fetch_openapi(self, url: str | None) -> None:
        """Fetch and cache the OpenAPI spec. Also extract API base URL from servers."""
        spec = None
        if url:
            try:
                resp = await http_get_page(url)
                spec = json.loads(resp.text)
                fs_write("openapi.json", json.dumps(spec, indent=2))
            except Exception as exc:
                log("WARN", f"Failed to fetch OpenAPI from {url}: {exc}")

        # Fall back to cache
        if spec is None:
            cached = fs_read("openapi.json")
            if cached and isinstance(cached, str):
                spec = json.loads(cached)
                log("WARN", "Using cached OpenAPI spec")

        if spec is None:
            log("ERROR", "No OpenAPI spec available — agent will operate without endpoint validation")
            return

        self.openapi_validator = OpenAPIValidator(spec)
        log("INFO", "OpenAPI loaded", {"operations": len(self.openapi_validator.get_all_operations())})

        # Extract API base URL from the spec's servers field
        servers = spec.get("servers", [])
        if servers and isinstance(servers[0], dict):
            server_url = servers[0].get("url", "")
            if server_url and server_url.startswith("http"):
                self.api_base_url = server_url.rstrip("/")
                log("INFO", f"API base URL from OpenAPI spec: {self.api_base_url}")

    async def _fetch_citizen_md(self, url: str | None) -> None:
        """Fetch and cache citizen.md. Also extract API base URL if mentioned."""
        if url:
            try:
                resp = await http_get_page(url)
                self.citizen_md = resp.text
                fs_write("citizen.md", self.citizen_md)
                self._extract_api_url_from_docs(self.citizen_md)
                log("INFO", "citizen.md fetched", {"url": url, "length": len(self.citizen_md)})
                return
            except Exception as exc:
                log("WARN", f"Failed to fetch citizen.md from {url}: {exc}")

        # Fall back to cache
        cached = fs_read("citizen.md")
        if cached and isinstance(cached, str):
            self.citizen_md = cached
            log("WARN", "Using cached citizen.md")
        else:
            log("WARN", "No citizen.md available — agent will operate without behavioral norms")

    def _extract_api_url_from_docs(self, text: str) -> None:
        """Scan citizen.md or any doc text for API base URLs."""
        import re
        # Look for URLs that look like API endpoints (contain /api/ or /v1/ etc.)
        urls = re.findall(r'https?://[^\s"\'<>`)]+', text)
        for url in urls:
            # Prefer URLs with /api/ or /v1/ in them
            if any(seg in url.lower() for seg in ["/api/", "/v1/", "/v2/"]):
                clean = url.rstrip("/.,;:)")
                if clean != self.api_base_url:
                    self.api_base_url = clean
                    log("INFO", f"API base URL from docs: {self.api_base_url}")
                return

    # ── Main Agent Loop ──────────────────────────────────────────────

    async def _agent_loop(self) -> None:
        tick = 0
        while self._running:
            tick += 1
            try:
                log("INFO", f"=== Tick {tick} ===")
                state = await self._gather_state()

                # Include SSE events
                sse_events = self._drain_sse_queue()
                if sse_events:
                    state["sse_events"] = sse_events

                # Append state to history
                self._append_history({
                    "role": "state",
                    "content": f"## Current State (tick {tick})\n{json.dumps(state, indent=2, default=str)}\n\nWhat should I do next?",
                })

                # LLM decides → may produce multiple rounds of tool calls
                await self._run_tool_loop(tick)

            except Exception as exc:
                import traceback
                log("ERROR", f"Tick {tick} error: {exc}\n{traceback.format_exc()}")
                # Clean up history — remove any dangling assistant tool_calls
                # that don't have matching tool results
                self._cleanup_history()

            await sleep_ms(settings.poll_interval_ms)

    async def _run_tool_loop(self, tick: int) -> None:
        """Let the LLM call tools in a loop until it's done."""
        max_rounds = 10  # Safety cap
        for round_num in range(max_rounds):
            state = await self._gather_state()
            thinking, tool_calls = await self.planner.decide(state, self._history)

            if thinking:
                log("INFO", f"Planner: {thinking[:200]}")

            if not tool_calls:
                # LLM is done — no more actions
                if thinking:
                    self._append_history({"role": "thinking", "content": thinking})
                break

            # Build the assistant message with tool calls (for history)
            assistant_msg: dict[str, Any] = {
                "role": "assistant",
                "content": thinking or None,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
                    }
                    for tc in tool_calls
                ],
            }
            self._append_history(assistant_msg)

            # Execute each tool call and append results
            for tc in tool_calls:
                result = await self._execute_tool(tc)
                log("INFO", f"Tool {tc.name} → {json.dumps(result, default=str)[:200]}")
                self._append_history({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(result, default=str),
                })

                # Persist for debugging
                await self._persist_event(f"tool.{tc.name}", {"tick": tick, "args": tc.arguments, "result": result})

    # ── Tool Execution ───────────────────────────────────────────────

    async def _execute_tool(self, tc: ToolCall) -> dict[str, Any]:
        """Route a tool call to the appropriate handler."""
        try:
            match tc.name:
                case "http_request":
                    return await self._tool_http_request(tc.arguments)
                case "solana_transfer":
                    return await self._tool_solana_transfer(tc.arguments)
                case "sign_payment":
                    return await self._tool_sign_payment(tc.arguments)
                case "sign_message":
                    return self._tool_sign_message(tc.arguments)
                case "search_docs":
                    return self._tool_search_docs(tc.arguments)
                case "get_balance":
                    return await self._tool_get_balance()
                case "store_secret":
                    return self._tool_store_secret(tc.arguments)
                case "read_file":
                    return self._tool_read_file(tc.arguments)
                case "wait":
                    return {"status": "ok", "reason": tc.arguments.get("reason", "")}
                case _:
                    return {"error": f"Unknown tool: {tc.name}"}
        except Exception as exc:
            return {"error": str(exc)}

    async def _tool_http_request(self, args: dict[str, Any]) -> dict[str, Any]:
        method = args["method"]
        path = args["path"]

        # Validate against OpenAPI
        if self.openapi_validator and path.startswith("/"):
            valid, reason = self.openapi_validator.validate_action(method, path)
            if not valid:
                return {"error": f"OpenAPI validation failed: {reason}. Check the spec for valid endpoints."}

        # Build URL
        if path.startswith("/"):
            url = f"{self.api_base_url.rstrip('/')}{path}"
        else:
            url = path

        headers = args.get("headers") or {}
        if self.api_key:
            headers.setdefault("Authorization", f"Bearer {self.api_key}")
        headers["Idempotency-Key"] = generate_id()

        resp = await http_request(
            method=method,
            url=url,
            headers=headers,
            query_params=args.get("query_params"),
            body=args.get("body"),
        )
        assert isinstance(resp, HttpResponse)
        metrics_inc("http_requests", {"method": method, "status": str(resp.status)})

        result: dict[str, Any] = {"status": resp.status}
        if resp.json_body is not None:
            result["body"] = resp.json_body
        else:
            result["text"] = resp.text[:2000]

        # Auto-detect API key in registration responses
        self._maybe_capture_api_key(resp.json_body)

        return result

    async def _tool_solana_transfer(self, args: dict[str, Any]) -> dict[str, Any]:
        log("INFO", f"Solana transfer: {args['amount']} base units → {args['to_address'][:16]}...")
        try:
            result = await solana_transfer(
                from_keypair=self.keypair,
                to_address=args["to_address"],
                amount=args["amount"],
            )
        except Exception as exc:
            log("ERROR", f"Solana transfer exception: {exc}")
            return {"error": str(exc), "confirmed": False, "rpc_url": settings.solana_rpc_url}
        metrics_inc("solana_transfers", {"confirmed": str(result.confirmed)})

        out: dict[str, Any] = {
            "tx_signature": result.tx_signature,
            "confirmed": result.confirmed,
        }
        if not result.confirmed:
            out["error"] = result.error or "Transfer failed — check RPC URL and wallet balance"
            out["rpc_url"] = settings.solana_rpc_url

        # Also provide the payment proof header value for convenience
        if result.confirmed:
            out["x_payment_header"] = encode_payment_proof(
                tx_signature=result.tx_signature,
                payer=self.address,
                amount_usdc=args["amount"] / 1_000_000,
            )

        return out

    async def _tool_get_balance(self) -> dict[str, Any]:
        usdc = sol = 0
        try:
            usdc = await get_usdc_balance(self.address)
        except Exception as exc:
            return {"error": f"Failed to get USDC balance: {exc}"}
        try:
            sol = await get_sol_balance(self.address)
        except Exception as exc:
            return {"usdc": usdc, "sol_error": str(exc)}
        return {"usdc_base_units": usdc, "usdc_display": usdc / 1_000_000, "sol_lamports": sol}

    def _tool_store_secret(self, args: dict[str, Any]) -> dict[str, Any]:
        name = args["name"]
        value = args["value"]
        # Guard against hallucinated API keys — must look real
        if name == "AGIC_API_KEY" and (not value or len(value) < 20 or value.startswith("fake")):
            return {"error": "Refusing to store invalid API key. Only store the real apiKey from /v1/auth/verify."}
        secret_set(name, value)
        # If it's the API key, update our reference + start SSE
        if name == "AGIC_API_KEY":
            self.api_key = value
            asyncio.create_task(self._start_sse(), name="sse")
        return {"stored": name}

    async def _tool_sign_payment(self, args: dict[str, Any]) -> dict[str, Any]:
        is_ata = args.get("recipient_is_ata", False)
        log("INFO", f"Sign payment: {args['amount']} base units → {args['to_address'][:16]}... (ata={is_ata})")
        result = await sign_payment(
            from_keypair=self.keypair,
            to_address=args["to_address"],
            amount=args["amount"],
            recipient_is_ata=is_ata,
        )
        if result.error:
            return {"error": result.error}
        return {
            "x_payment": result.x_payment,
            "instructions": "Use this value as the x-payment header in your API request.",
        }

    def _tool_sign_message(self, args: dict[str, Any]) -> dict[str, Any]:
        msg = args["message"]
        log("INFO", f"Signing message: {msg[:80]}...")
        signature = sign_message(self.keypair, msg)
        return {"signature": signature, "wallet": self.address}

    def _tool_search_docs(self, args: dict[str, Any]) -> dict[str, Any]:
        """Search citizen.md by splitting into sections and matching query."""
        import re
        query = args.get("query", "").lower()
        if not query:
            return {"error": "query is required"}

        content = fs_read("citizen.md")
        if not content or not isinstance(content, str):
            return {"error": "citizen.md not available"}

        # Split by markdown headers
        sections = re.split(r'(^#{1,3}\s+.+$)', content, flags=re.MULTILINE)
        # Pair headers with their content
        paired: list[tuple[str, str]] = []
        i = 0
        while i < len(sections):
            if re.match(r'^#{1,3}\s+', sections[i]):
                header = sections[i]
                body = sections[i + 1] if i + 1 < len(sections) else ""
                paired.append((header, body))
                i += 2
            else:
                # Content before first header
                if sections[i].strip():
                    paired.append(("", sections[i]))
                i += 1

        # Find matching sections
        matches: list[str] = []
        total_len = 0
        for header, body in paired:
            full = f"{header}\n{body}"
            if query in header.lower() or query in body.lower():
                if total_len + len(full) > 4000:
                    break
                matches.append(full.strip())
                total_len += len(full)

        if not matches:
            return {"result": f"No sections matching '{query}' found in citizen.md"}
        return {"result": "\n\n".join(matches)}

    def _tool_read_file(self, args: dict[str, Any]) -> dict[str, Any]:
        content = fs_read(args["path"])
        if content is None:
            return {"error": f"File not found: {args['path']}"}
        if isinstance(content, bytes):
            return {"content": content.decode("utf-8", errors="replace")[:4000]}
        return {"content": content[:4000]}

    # ── State ────────────────────────────────────────────────────────

    async def _gather_state(self) -> dict[str, Any]:
        state: dict[str, Any] = {
            "agent_name": settings.agent_name,
            "wallet_address": self.address,
            "api_base_url": self.api_base_url,
            "has_api_key": self.api_key is not None,
            "limits": {
                "max_concurrent_tasks": settings.max_concurrent_tasks,
                "max_budget_per_task": settings.max_budget_per_task,
            },
        }
        return state

    # ── SSE ──────────────────────────────────────────────────────────

    async def _start_sse(self) -> None:
        if not self.api_key:
            return
        listener = SSEListener(base_url=self.api_base_url, api_key=self.api_key)
        listener.on_event(self._on_sse_event)
        await listener.listen()

    async def _on_sse_event(self, event_type: str, payload: dict[str, Any]) -> None:
        await self._sse_queue.put({"event": event_type, **payload})

    def _drain_sse_queue(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        while not self._sse_queue.empty():
            try:
                events.append(self._sse_queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return events

    # ── Helpers ───────────────────────────────────────────────────────

    def _append_history(self, entry: dict[str, Any]) -> None:
        self._history.append(entry)
        if len(self._history) > MAX_HISTORY:
            self._history = self._history[-MAX_HISTORY:]

    def _cleanup_history(self) -> None:
        """Remove dangling assistant messages with tool_calls that lack matching tool results.

        This prevents the LLM from receiving an invalid message sequence after errors.
        """
        if not self._history:
            return
        # Walk backwards: if the last entry is an assistant with tool_calls,
        # check that all tool_call IDs have matching tool results after it
        cleaned = list(self._history)
        while cleaned:
            last = cleaned[-1]
            if last.get("role") == "assistant" and last.get("tool_calls"):
                # Check if all tool calls have results
                tc_ids = {tc["id"] for tc in last["tool_calls"]}
                result_ids = {
                    e.get("tool_call_id")
                    for e in cleaned
                    if e.get("role") == "tool"
                }
                if not tc_ids.issubset(result_ids):
                    cleaned.pop()
                    continue
            break
        self._history = cleaned

    def _maybe_capture_api_key(self, body: Any) -> None:
        """Auto-detect API key in responses and store it."""
        if self.api_key or not isinstance(body, dict):
            return
        data = body.get("data", body)
        if not isinstance(data, dict):
            return
        key = data.get("apiKey") or data.get("api_key")
        if key:
            self.api_key = key
            secret_set("AGIC_API_KEY", key)
            log("INFO", "API key auto-captured from response")
            asyncio.create_task(self._start_sse(), name="sse")

    async def _persist_event(self, event_type: str, payload: dict[str, Any]) -> None:
        try:
            async with async_session() as session:
                session.add(EventRecord(event_type=event_type, payload=payload))
                await session.commit()
        except Exception:
            pass
