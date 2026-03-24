"""Requester orchestrator — extends BaseOrchestrator with no custom tools."""

from __future__ import annotations

from agic_core.orchestrator import BaseOrchestrator
from agic_core.planner import Planner

from requester_agent.planner_config import SYSTEM_PROMPT, TOOLS


class Orchestrator(BaseOrchestrator):

    def _create_planner(self) -> Planner:
        return Planner(system_prompt=SYSTEM_PROMPT, tools=TOOLS)
