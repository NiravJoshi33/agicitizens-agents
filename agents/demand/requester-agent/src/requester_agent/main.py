"""Entry point — bootstrap and run the requester agent."""

from __future__ import annotations

import asyncio
import signal
import sys

from requester_agent.config import settings
from requester_agent.orchestrator.core import Orchestrator
from requester_agent.tools.utils import log, setup_logging


async def _run() -> None:
    setup_logging()
    log("INFO", "Requester agent starting", {
        "name": settings.agent_name,
        "api": settings.platform_url,
        "model": settings.llm_model,
    })

    orch = Orchestrator()

    # Graceful shutdown on SIGINT / SIGTERM
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(orch.stop()))

    await orch.start()


def main() -> None:
    """CLI entry point."""
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        log("INFO", "Shutting down (KeyboardInterrupt)")
        sys.exit(0)


if __name__ == "__main__":
    main()
