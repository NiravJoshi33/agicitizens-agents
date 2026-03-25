"""Base orchestrator — shared agent loop, doc discovery, and common tool execution.

Agents subclass BaseOrchestrator and override:
  - ``_create_planner()``    → return a Planner with agent-specific prompt/tools
  - ``_execute_custom_tool()`` → handle agent-specific tools (return None to fall through)
  - ``_gather_custom_state()`` → add agent-specific state fields
  - ``_fetch_custom_docs()``   → fetch additional docs at startup
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any
from urllib.parse import urlparse

from agic_core.config import settings
from agic_core.planner import Planner, ToolCall
from agic_core.sse.client import SSEListener
from agic_core.state import EventRecord, get_session, init_db
from agic_core.tools.http import HttpResponse, http_request, http_get_page, close_client
from agic_core.tools.metrics import metrics_inc
from agic_core.tools.solana import (
    load_keypair,
    solana_transfer,
    sign_payment,
    sign_message,
    encode_payment_proof,
    get_usdc_balance,
    get_sol_balance,
)
from agic_core.tools.storage import fs_read, fs_write, secret_get, secret_set
from agic_core.tools.utils import generate_id, log, sleep_ms
from agic_core.tools.validation import OpenAPIValidator

logger = logging.getLogger(__name__)

MAX_HISTORY = 40


class BaseOrchestrator:
    """LLM-driven orchestrator with hooks for agent-specific behaviour."""

    def __init__(self) -> None:
        self.keypair = load_keypair()
        self.address = str(self.keypair.pubkey())
        self.openapi_validator: OpenAPIValidator | None = None
        self.citizen_md: str = ""
        self.api_base_url: str = settings.platform_url
        self.api_key: str | None = None
        self.planner: Planner = self._create_planner()
        self._running = False
        self._history: list[dict[str, Any]] = []
        self._sse_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    # ── Hooks for subclasses ─────────────────────────────────────────

    def _create_planner(self) -> Planner:
        """Return a Planner configured with agent-specific prompt and tools."""
        raise NotImplementedError

    async def _execute_custom_tool(self, tc: ToolCall) -> dict[str, Any] | None:
        """Handle agent-specific tools. Return None to fall through to common tools."""
        return None

    async def _gather_custom_state(self) -> dict[str, Any]:
        """Return agent-specific state fields to merge into the tick state."""
        return {}

    async def _fetch_custom_docs(self) -> None:
        """Fetch additional docs at startup (e.g. Moltbook skill.md)."""
        pass

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

    # ── Doc Discovery ────────────────────────────────────────────────

    async def _fetch_docs(self) -> None:
        base = settings.platform_url.rstrip("/")
        discovered = await self._discover_doc_urls(base)

        openapi_url = discovered.get("openapi")
        if openapi_url:
            parsed = urlparse(openapi_url)
            path = parsed.path.rsplit("/", 1)[0]
            self.api_base_url = f"{parsed.scheme}://{parsed.netloc}{path}".rstrip("/")
            log("INFO", f"API base derived from OpenAPI URL: {self.api_base_url}")
        await self._fetch_openapi(openapi_url)

        citizen_url = discovered.get("citizen_md")
        await self._fetch_citizen_md(citizen_url)

        # Agent-specific docs
        await self._fetch_custom_docs()

    async def _discover_doc_urls(self, base: str) -> dict[str, str]:
        discovered: dict[str, str] = {}

        log("INFO", "Discovering platform docs", {"base": base})
        try:
            resp = await http_get_page(base)
            if isinstance(resp.json_body, dict):
                data = resp.json_body.get("data", resp.json_body)
                if isinstance(data, dict):
                    discovered.update(self._extract_doc_links(data, base))
            if not discovered:
                discovered.update(self._scan_text_for_doc_urls(resp.text, base))
        except Exception as exc:
            log("WARN", f"Root discovery failed: {exc}")

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

        if "openapi" not in discovered:
            for url in [f"{base}/openapi.json", f"{base}/docs/openapi.json", f"{base}/swagger.json", f"{base}/api-docs"]:
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
            for url in [f"{base}/docs/citizen.md", f"{base}/citizen.md", f"{base}/docs/citizen"]:
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
        if discovered:
            fs_write("discovered_urls.json", json.dumps(discovered, indent=2))
        return discovered

    def _extract_doc_links(self, data: dict[str, Any], base: str) -> dict[str, str]:
        found: dict[str, str] = {}
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
        found: dict[str, str] = {}
        urls = re.findall(r'https?://[^\s"\'<>]+', text)
        for url in urls:
            lower = url.lower()
            if any(kw in lower for kw in ["openapi", "swagger"]) and "openapi" not in found:
                found["openapi"] = url
            elif "citizen" in lower and "citizen_md" not in found:
                found["citizen_md"] = url
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
        items: list[tuple[str, Any]] = []
        for k, v in d.items():
            full_key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                items.extend(BaseOrchestrator._flatten_dict(v, full_key))
            elif isinstance(v, list):
                for i, item in enumerate(v):
                    if isinstance(item, dict):
                        items.extend(BaseOrchestrator._flatten_dict(item, f"{full_key}[{i}]"))
                    else:
                        items.append((f"{full_key}[{i}]", item))
            else:
                items.append((full_key, v))
        return items

    async def _fetch_openapi(self, url: str | None) -> None:
        spec = None
        if url:
            try:
                resp = await http_get_page(url)
                spec = json.loads(resp.text)
                fs_write("openapi.json", json.dumps(spec, indent=2))
            except Exception as exc:
                log("WARN", f"Failed to fetch OpenAPI from {url}: {exc}")

        if spec is None:
            cached = fs_read("openapi.json")
            if cached and isinstance(cached, str):
                spec = json.loads(cached)
                log("WARN", "Using cached OpenAPI spec")

        if spec is None:
            log("ERROR", "No OpenAPI spec available")
            return

        self.openapi_validator = OpenAPIValidator(spec)
        log("INFO", "OpenAPI loaded", {"operations": len(self.openapi_validator.get_all_operations())})

        servers = spec.get("servers", [])
        if servers and isinstance(servers[0], dict):
            server_url = servers[0].get("url", "")
            if server_url and server_url.startswith("http"):
                self.api_base_url = server_url.rstrip("/")
                log("INFO", f"API base URL from OpenAPI spec: {self.api_base_url}")

    async def _fetch_citizen_md(self, url: str | None) -> None:
        if url:
            try:
                resp = await http_get_page(url)
                text = resp.text
                # Validate it's actually markdown, not an HTML page
                if text.strip().startswith("<!") or text.strip().startswith("<html"):
                    log("WARN", f"citizen.md URL returned HTML, not markdown: {url}")
                else:
                    self.citizen_md = text
                    fs_write("citizen.md", self.citizen_md)
                    self._extract_api_url_from_docs(self.citizen_md)
                    log("INFO", "citizen.md fetched", {"url": url, "length": len(self.citizen_md)})
                    return
            except Exception as exc:
                log("WARN", f"Failed to fetch citizen.md from {url}: {exc}")

        # Fallback: try convention paths on the platform base URL
        base = settings.platform_url.rstrip("/")
        for path in [f"{base}/citizen.md", f"{base}/docs/citizen.md"]:
            try:
                resp = await http_get_page(path)
                text = resp.text
                if text.strip().startswith("<!") or text.strip().startswith("<html"):
                    continue
                self.citizen_md = text
                fs_write("citizen.md", self.citizen_md)
                self._extract_api_url_from_docs(self.citizen_md)
                log("INFO", "citizen.md fetched", {"url": path, "length": len(self.citizen_md)})
                return
            except Exception:
                continue

        cached = fs_read("citizen.md")
        if cached and isinstance(cached, str) and not cached.strip().startswith("<!"):
            self.citizen_md = cached
            log("WARN", "Using cached citizen.md")
        else:
            log("WARN", "No citizen.md available")

    def _extract_api_url_from_docs(self, text: str) -> None:
        # Only use docs to derive API base if we don't already have one from OpenAPI
        if self.api_base_url:
            return
        urls = re.findall(r'https?://[^\s"\'<>`)]+', text)
        for url in urls:
            clean = url.rstrip("/.,;:)")
            if any(seg in clean.lower() for seg in ["/api/", "/v1/", "/v2/"]):
                # Extract scheme + host only (don't include /v1 path to avoid double-prefix)
                m = re.match(r'(https?://[^/]+)', clean)
                if m:
                    self.api_base_url = m.group(1)
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

                sse_events = self._drain_sse_queue()
                if sse_events:
                    state["sse_events"] = sse_events

                self._append_history({
                    "role": "state",
                    "content": f"## Current State (tick {tick})\n{json.dumps(state, indent=2, default=str)}\n\nWhat should I do next?",
                })

                await self._run_tool_loop(tick)

            except Exception as exc:
                import traceback
                log("ERROR", f"Tick {tick} error: {exc}\n{traceback.format_exc()}")
                self._cleanup_history()

            await sleep_ms(settings.poll_interval_ms)

    async def _run_tool_loop(self, tick: int) -> None:
        max_rounds = 10
        for round_num in range(max_rounds):
            state = await self._gather_state()
            try:
                thinking, tool_calls = await asyncio.wait_for(
                    self.planner.decide(state, self._history), timeout=120
                )
            except asyncio.TimeoutError:
                log("WARN", f"Planner timed out on tick {tick} round {round_num}, skipping")
                break

            if thinking:
                log("INFO", f"Planner: {thinking[:200]}")

            if not tool_calls:
                if thinking:
                    self._append_history({"role": "thinking", "content": thinking})
                break

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

            for tc in tool_calls:
                result = await self._execute_tool(tc)
                log("INFO", f"Tool {tc.name} → {json.dumps(result, default=str)[:200]}")
                self._append_history({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(result, default=str),
                })
                await self._persist_event(f"tool.{tc.name}", {"tick": tick, "args": tc.arguments, "result": result})

    # ── Tool Execution ───────────────────────────────────────────────

    async def _execute_tool(self, tc: ToolCall) -> dict[str, Any]:
        try:
            # Try agent-specific tools first
            custom_result = await self._execute_custom_tool(tc)
            if custom_result is not None:
                return custom_result

            # Common tools
            match tc.name:
                case "http_request":
                    return await self._tool_http_request(tc.arguments)
                case "solana_transfer":
                    return await self._tool_solana_transfer(tc.arguments)
                case "sign_payment":
                    return await self._tool_sign_payment(tc.arguments)
                case "sign_and_send_transaction":
                    return await self._tool_sign_and_send_transaction(tc.arguments)
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

        if self.openapi_validator and path.startswith("/"):
            valid, reason = self.openapi_validator.validate_action(method, path)
            if not valid:
                return {"error": f"OpenAPI validation failed: {reason}. Check the spec for valid endpoints."}

        if path.startswith("/"):
            url = f"{self.api_base_url.rstrip('/')}{path}"
        else:
            url = path

        headers = args.get("headers") or {}
        if self.api_key:
            headers.setdefault("Authorization", f"Bearer {self.api_key}")
        headers["Idempotency-Key"] = generate_id()

        resp = await http_request(method=method, url=url, headers=headers, query_params=args.get("query_params"), body=args.get("body"))
        assert isinstance(resp, HttpResponse)
        metrics_inc("http_requests", {"method": method, "status": str(resp.status)})

        result: dict[str, Any] = {"status": resp.status}
        if resp.json_body is not None:
            result["body"] = resp.json_body
        else:
            result["text"] = resp.text[:2000]

        self._maybe_capture_api_key(resp.json_body)
        return result

    async def _tool_solana_transfer(self, args: dict[str, Any]) -> dict[str, Any]:
        log("INFO", f"Solana transfer: {args['amount']} base units → {args['to_address'][:16]}...")
        try:
            result = await solana_transfer(from_keypair=self.keypair, to_address=args["to_address"], amount=args["amount"])
        except Exception as exc:
            log("ERROR", f"Solana transfer exception: {exc}")
            return {"error": str(exc), "confirmed": False, "rpc_url": settings.solana_rpc_url}
        metrics_inc("solana_transfers", {"confirmed": str(result.confirmed)})

        out: dict[str, Any] = {"tx_signature": result.tx_signature, "confirmed": result.confirmed}
        if not result.confirmed:
            out["error"] = result.error or "Transfer failed"
            out["rpc_url"] = settings.solana_rpc_url
        if result.confirmed:
            out["x_payment_header"] = encode_payment_proof(tx_signature=result.tx_signature, payer=self.address, amount_usdc=args["amount"] / 1_000_000)
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
        if name == "AGIC_API_KEY" and (not value or len(value) < 20 or value.startswith("fake")):
            return {"error": "Refusing to store invalid API key. Only store the real apiKey from /v1/auth/verify."}
        secret_set(name, value)
        if name == "AGIC_API_KEY":
            self.api_key = value
            asyncio.create_task(self._start_sse(), name="sse")
        return {"stored": name}

    async def _tool_sign_payment(self, args: dict[str, Any]) -> dict[str, Any]:
        is_ata = args.get("recipient_is_ata", False)
        log("INFO", f"Sign payment: {args['amount']} base units → {args['to_address'][:16]}... (ata={is_ata})")
        result = await sign_payment(from_keypair=self.keypair, to_address=args["to_address"], amount=args["amount"], recipient_is_ata=is_ata)
        if result.error:
            return {"error": result.error}
        return {"x_payment": result.x_payment, "instructions": "Use this value as the x-payment header in your API request."}

    async def _tool_sign_and_send_transaction(self, args: dict[str, Any]) -> dict[str, Any]:
        """Sign a base64-encoded unsigned transaction and send it to Solana."""
        from base64 import b64decode
        from solana.rpc.async_api import AsyncClient
        from solana.rpc.commitment import Confirmed
        from solders.transaction import VersionedTransaction
        from solders.message import to_bytes_versioned
        from solders.signature import Signature as SolSignature

        raw_tx = args["transaction"]
        log("INFO", f"Signing prepared transaction ({len(raw_tx)} chars)")
        try:
            tx_bytes = b64decode(raw_tx)
            tx = VersionedTransaction.from_bytes(tx_bytes)
            msg = tx.message
            msg_bytes = to_bytes_versioned(msg)
            sig = self.keypair.sign_message(msg_bytes)
            signed_tx = VersionedTransaction.populate(msg, [sig])

            async with AsyncClient(settings.solana_rpc_url) as client:
                result = await client.send_transaction(signed_tx)
                tx_sig = str(result.value)
                await client.confirm_transaction(SolSignature.from_string(tx_sig), commitment=Confirmed)
                return {"tx_signature": tx_sig, "confirmed": True}
        except Exception as exc:
            log("ERROR", f"Sign-and-send failed: {exc}")
            return {"error": str(exc), "confirmed": False}

    def _tool_sign_message(self, args: dict[str, Any]) -> dict[str, Any]:
        msg = args["message"]
        log("INFO", f"Signing message: {msg[:80]}...")
        signature = sign_message(self.keypair, msg)
        return {"signature": signature, "wallet": self.address}

    def _tool_search_docs(self, args: dict[str, Any]) -> dict[str, Any]:
        query = args.get("query", "").lower()
        if not query:
            return {"error": "query is required"}

        content = fs_read("citizen.md")
        if not content or not isinstance(content, str):
            return {"error": "citizen.md not available"}

        sections = re.split(r'(^#{1,3}\s+.+$)', content, flags=re.MULTILINE)
        paired: list[tuple[str, str]] = []
        i = 0
        while i < len(sections):
            if re.match(r'^#{1,3}\s+', sections[i]):
                header = sections[i]
                body = sections[i + 1] if i + 1 < len(sections) else ""
                paired.append((header, body))
                i += 2
            else:
                if sections[i].strip():
                    paired.append(("", sections[i]))
                i += 1

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
        custom = await self._gather_custom_state()
        state.update(custom)
        return state

    # ── SSE ──────────────────────────────────────────────────────────

    async def _start_sse(self) -> None:
        if not self.api_key:
            return
        # Cancel any existing SSE task to avoid duplicates
        for task in asyncio.all_tasks():
            if task.get_name() == "sse" and task is not asyncio.current_task() and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
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
        if not self._history:
            return
        cleaned = list(self._history)
        while cleaned:
            last = cleaned[-1]
            if last.get("role") == "assistant" and last.get("tool_calls"):
                tc_ids = {tc["id"] for tc in last["tool_calls"]}
                result_ids = {e.get("tool_call_id") for e in cleaned if e.get("role") == "tool"}
                if not tc_ids.issubset(result_ids):
                    cleaned.pop()
                    continue
            break
        self._history = cleaned

    def _maybe_capture_api_key(self, body: Any) -> None:
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
            async with get_session()() as session:
                session.add(EventRecord(event_type=event_type, payload=payload))
                await session.commit()
        except Exception:
            pass
