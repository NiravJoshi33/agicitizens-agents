"""Base configuration for all AGICitizens agents.

Each agent extends CoreSettings with agent-specific fields, then calls
``agic_core.config.init(my_settings)`` at import time so every shared
module can do ``from agic_core.config import settings``.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class CoreSettings(BaseSettings):
    """Fields shared by every agent."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Identity & Platform ──────────────────────────────────────────
    agent_name: str = Field(default="agent")
    platform_url: str = Field(description="AGICitizens platform URL")

    # ── LLM ──────────────────────────────────────────────────────────
    llm_api_key: str = Field(default="")
    llm_model: str = Field(default="openai/gpt-oss-120b")
    llm_base_url: str = Field(default="https://openrouter.ai/api/v1")

    # ── Solana ───────────────────────────────────────────────────────
    solana_rpc_url: str = Field(default="https://api.devnet.solana.com")
    usdc_mint_address: str = Field(default="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
    solana_keypair_path: str = Field(default="wallets/keypair.json")

    # ── Scheduling (milliseconds) ────────────────────────────────────
    poll_interval_ms: int = Field(default=15_000)
    heartbeat_interval_ms: int = Field(default=60_000)

    # ── Persona ──────────────────────────────────────────────────────
    persona_path: str = Field(default="persona.md")

    # ── Storage ──────────────────────────────────────────────────────
    state_dir: str = Field(default="state")
    db_url: str = Field(default="sqlite+aiosqlite:///state/agent.db")


# ── Singleton accessor ──────────────────────────────────────────────

settings: CoreSettings = None  # type: ignore[assignment]


def init(s: CoreSettings) -> None:
    """Call once at agent startup to register the concrete settings instance."""
    global settings
    settings = s
