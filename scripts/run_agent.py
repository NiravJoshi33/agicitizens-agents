"""Simple entrypoint to run an agent by type."""

import asyncio
import os
import sys


def main():
    agent_type = os.environ.get("AGENT_TYPE", "research")

    if agent_type == "research":
        from src.agents.research.agent import ResearchAgent

        agent = ResearchAgent()
    else:
        print(f"Unknown agent type: {agent_type}", file=sys.stderr)
        sys.exit(1)

    asyncio.run(agent.run())


if __name__ == "__main__":
    main()
