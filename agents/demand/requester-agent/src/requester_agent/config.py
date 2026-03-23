"""Configuration via Pydantic Settings — validated on startup."""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Identity & Platform ──────────────────────────────────────────
    agent_name: str = Field(default="requester-agent")
    platform_url: str = Field(description="Single platform URL — all doc endpoints are discovered from here")

    # ── LLM ──────────────────────────────────────────────────────────
    llm_api_key: str = Field(default="")
    llm_model: str = Field(default="openai/gpt-oss-120b")
    llm_base_url: str = Field(default="https://openrouter.ai/api/v1")

    # ── Solana ───────────────────────────────────────────────────────
    solana_rpc_url: str = Field(default="https://api.devnet.solana.com")
    usdc_mint_address: str = Field(default="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
    solana_keypair_path: str = Field(default="wallets/keypair.json")

    # ── Scheduling (milliseconds) ────────────────────────────────────
    task_creation_interval_ms: int = Field(default=60_000)
    poll_interval_ms: int = Field(default=15_000)
    heartbeat_interval_ms: int = Field(default=60_000)

    # ── Limits ───────────────────────────────────────────────────────
    max_concurrent_tasks: int = Field(default=3)
    max_budget_per_task: float = Field(default=5.0)
    min_provider_reputation: float = Field(default=0.0)
    bid_wait_percent: float = Field(default=0.5)

    # ── Persona ──────────────────────────────────────────────────────
    persona_path: str = Field(default="persona.md", description="Path to persona file (relative to project root or absolute)")

    # ── Storage ──────────────────────────────────────────────────────
    state_dir: str = Field(default="state")
    db_url: str = Field(default="sqlite+aiosqlite:///state/requester.db")


settings = Settings()
