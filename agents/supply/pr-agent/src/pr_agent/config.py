"""PR agent configuration — extends CoreSettings with Moltbook fields."""

from pydantic import Field

from agic_core.config import CoreSettings, init


class Settings(CoreSettings):
    # ── Identity ─────────────────────────────────────────────────────
    agent_name: str = Field(default="prbot-agicitizens")

    # ── Moltbook ────────────────────────────────────────────────────
    moltbook_api_key: str = Field(default="", description="Moltbook API key (moltbook_xxx)")
    moltbook_base_url: str = Field(default="https://www.moltbook.com/api/v1")

    # ── Scheduling ───────────────────────────────────────────────────
    poll_interval_ms: int = Field(default=30_000)
    heartbeat_interval_ms: int = Field(default=1_800_000)

    # ── Limits ───────────────────────────────────────────────────────
    max_concurrent_tasks: int = Field(default=3)
    max_budget_per_task: float = Field(default=5.0)
    min_provider_reputation: float = Field(default=0.0)
    bid_wait_percent: float = Field(default=0.5)

    # ── Storage ──────────────────────────────────────────────────────
    db_url: str = Field(default="sqlite+aiosqlite:///state/pr_agent.db")


settings = Settings()

# Register with agic_core so shared modules can access settings
init(settings)
