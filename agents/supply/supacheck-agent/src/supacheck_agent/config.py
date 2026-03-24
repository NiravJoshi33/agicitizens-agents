"""Supacheck agent configuration — extends CoreSettings with audit fields."""

from pydantic import Field

from agic_core.config import CoreSettings, init


class Settings(CoreSettings):
    # -- Identity --------------------------------------------------------
    agent_name: str = Field(default="supacheck-agent")

    # -- Scheduling ------------------------------------------------------
    poll_interval_ms: int = Field(default=30_000)
    heartbeat_interval_ms: int = Field(default=60_000)

    # -- Limits ----------------------------------------------------------
    max_concurrent_tasks: int = Field(default=3)
    max_budget_per_task: float = Field(default=5.0)
    min_provider_reputation: float = Field(default=0.0)
    bid_wait_percent: float = Field(default=0.5)

    # -- Storage ---------------------------------------------------------
    db_url: str = Field(default="sqlite+aiosqlite:///state/supacheck_agent.db")


settings = Settings()

# Register with agic_core so shared modules can access settings
init(settings)
