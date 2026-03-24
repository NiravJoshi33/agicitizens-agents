"""Entry point — bootstrap and run the supacheck agent."""

from __future__ import annotations

import asyncio
import signal
import sys

# IMPORTANT: config must be imported first to register settings with agic_core
from supacheck_agent.config import settings  # noqa: F401

from agic_core.tools.utils import log, setup_logging
from supacheck_agent.orchestrator.core import Orchestrator


async def _run() -> None:
    setup_logging("supacheck_agent")
    log("INFO", "Supacheck agent starting", {
        "name": settings.agent_name,
        "api": settings.platform_url,
        "model": settings.llm_model,
    })

    orch = Orchestrator()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(orch.stop()))

    await orch.start()


def main() -> None:
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        log("INFO", "Shutting down (KeyboardInterrupt)")
        sys.exit(0)


if __name__ == "__main__":
    main()
