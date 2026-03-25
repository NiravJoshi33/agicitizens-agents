"""PR agent orchestrator — extends BaseOrchestrator with Moltbook tools."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from agic_core.orchestrator import BaseOrchestrator
from agic_core.planner import Planner, ToolCall
from agic_core.tools.http import HttpResponse, http_get_page, http_request
from agic_core.tools.metrics import metrics_inc
from agic_core.tools.storage import fs_read, fs_write
from agic_core.tools.utils import log

from pr_agent.config import settings
from pr_agent.planner_config import SYSTEM_PROMPT, TOOLS


class Orchestrator(BaseOrchestrator):

    def __init__(self) -> None:
        self.moltbook_api_key: str | None = settings.moltbook_api_key or None
        super().__init__()

    def _create_planner(self) -> Planner:
        return Planner(
            system_prompt=SYSTEM_PROMPT,
            tools=TOOLS,
            extra_docs_provider=self._moltbook_docs,
        )

    def _moltbook_docs(self) -> list[tuple[str, str]]:
        """Provide Moltbook skill.md as extra context for the planner."""
        skill_md = fs_read("skill.md")
        if skill_md and isinstance(skill_md, str):
            excerpt = skill_md[:3000]
            return [(
                "Moltbook API Reference (skill.md — first 3000 chars)",
                f"{excerpt}\n\n**Note:** Use `read_file` with path='skill.md' for the full reference.",
            )]
        return []

    # ── Custom docs ──────────────────────────────────────────────────

    async def _fetch_custom_docs(self) -> None:
        """Fetch Moltbook skill.md at startup."""
        url = "https://www.moltbook.com/skill.md"
        try:
            resp = await http_get_page(url)
            fs_write("skill.md", resp.text)
            log("INFO", "Moltbook skill.md fetched", {"length": len(resp.text)})
        except Exception as exc:
            log("WARN", f"Failed to fetch Moltbook skill.md: {exc}")
            cached = fs_read("skill.md")
            if cached:
                log("WARN", "Using cached Moltbook skill.md")

    # ── Custom state ─────────────────────────────────────────────────

    async def _gather_custom_state(self) -> dict[str, Any]:
        return {
            "has_moltbook_api_key": self.moltbook_api_key is not None,
            "moltbook_base_url": settings.moltbook_base_url,
        }

    # ── Custom tools ─────────────────────────────────────────────────

    async def _execute_custom_tool(self, tc: ToolCall) -> dict[str, Any] | None:
        if tc.name == "moltbook_request":
            return await self._tool_moltbook_request(tc.arguments)
        return None

    async def _tool_moltbook_request(self, args: dict[str, Any]) -> dict[str, Any]:
        """Execute a request against the Moltbook API."""
        if not self.moltbook_api_key:
            return {"error": "Moltbook API key not configured. Set MOLTBOOK_API_KEY in .env"}

        method = args["method"]
        path = args["path"]

        if path.startswith("/"):
            # Strip duplicate /api/v1 prefix if the LLM includes it and base URL already has it
            base = settings.moltbook_base_url.rstrip("/")
            prefix = urlparse(base).path  # e.g. /api/v1
            if prefix and path.startswith(prefix):
                path = path[len(prefix):]
            url = f"{base}{path}"
        else:
            url = path

        # Security: only send Moltbook key to www.moltbook.com
        parsed = urlparse(url)
        if parsed.hostname != "www.moltbook.com":
            return {"error": f"Refusing to send Moltbook API key to {parsed.hostname}. Only www.moltbook.com is allowed."}

        headers = args.get("headers") or {}
        headers["Authorization"] = f"Bearer {self.moltbook_api_key}"

        resp = await http_request(
            method=method, url=url, headers=headers,
            query_params=args.get("query_params"), body=args.get("body"),
        )
        assert isinstance(resp, HttpResponse)
        metrics_inc("moltbook_requests", {"method": method, "status": str(resp.status)})

        result: dict[str, Any] = {"status": resp.status}
        if resp.json_body is not None:
            result["body"] = resp.json_body
        else:
            result["text"] = resp.text[:2000]

        for header in ["x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]:
            val = resp.headers.get(header)
            if val:
                result[header] = val

        return result
