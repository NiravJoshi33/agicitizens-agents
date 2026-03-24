"""Supacheck agent orchestrator — extends BaseOrchestrator with scan tools."""

from __future__ import annotations

import asyncio
from typing import Any

from agic_core.orchestrator import BaseOrchestrator
from agic_core.planner import Planner, ToolCall
from agic_core.tools.utils import log

from supacheck_agent.config import settings
from supacheck_agent.planner_config import SYSTEM_PROMPT, TOOLS
from supacheck_agent.supacheck import scan_website, run_probes, print_report


class Orchestrator(BaseOrchestrator):

    def _create_planner(self) -> Planner:
        return Planner(
            system_prompt=SYSTEM_PROMPT,
            tools=TOOLS,
        )

    # -- Custom tools ----------------------------------------------------

    async def _execute_custom_tool(self, tc: ToolCall) -> dict[str, Any] | None:
        if tc.name == "scan_website":
            return await self._tool_scan_website(tc.arguments)
        if tc.name == "probe_credentials":
            return await self._tool_probe_credentials(tc.arguments)
        return None

    async def _tool_scan_website(self, args: dict[str, Any]) -> dict[str, Any]:
        """Phase 1: Scan a website for exposed Supabase credentials."""
        target_url = args.get("url", "").strip()
        if not target_url:
            return {"error": "url is required"}
        if not target_url.startswith("http"):
            target_url = f"https://{target_url}"

        deep = args.get("deep", False)

        try:
            findings = await asyncio.to_thread(scan_website, target_url, deep=deep)
        except Exception as exc:
            log("ERROR", f"Scan failed: {exc}")
            return {"error": str(exc)}

        result: dict[str, Any] = {
            "target": target_url,
            "deep": deep,
            "supabase_urls": [f["value"] for f in findings["urls"]],
            "exposed_keys": [f["value"] for f in findings["keys"]],
            "hints": [
                {"variable": f["value"], "context": f["context"], "source": f["source"]}
                for f in findings["hints"]
            ],
        }

        if findings["urls"] or findings["keys"]:
            result["severity"] = "HIGH" if findings["keys"] else "MEDIUM"
            result["summary"] = (
                f"Found {len(findings['urls'])} Supabase URL(s) and "
                f"{len(findings['keys'])} exposed key(s)"
            )
        else:
            result["severity"] = "NONE"
            result["summary"] = "No Supabase credentials found in client-side code"

        # Store full keys internally for probe phase
        result["_full_keys"] = findings["full_keys"]

        return result

    async def _tool_probe_credentials(self, args: dict[str, Any]) -> dict[str, Any]:
        """Phase 2: Probe discovered credentials for RLS / auth misconfigurations."""
        supabase_url = args.get("supabase_url", "").strip()
        anon_key = args.get("anon_key", "").strip()

        if not supabase_url or not anon_key:
            return {"error": "supabase_url and anon_key are required"}

        try:
            report = await asyncio.to_thread(run_probes, supabase_url, anon_key)
        except Exception as exc:
            log("ERROR", f"Probe failed: {exc}")
            return {"error": str(exc)}

        return {
            "supabase_url": supabase_url,
            "probed": True,
            "vulnerabilities": report if report else [],
            "summary": (
                f"Found {len(report)} vulnerable table(s)"
                if report
                else "No RLS vulnerabilities detected"
            ),
        }
