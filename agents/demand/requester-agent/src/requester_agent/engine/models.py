"""Pydantic models used across the engine.

Note: The primary interface is now tool calling (see planner.py).
These models are kept for validation and type safety when needed.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class HttpAction(BaseModel):
    """A validated HTTP action — used for OpenAPI validation."""

    method: Literal["GET", "POST", "PUT", "DELETE", "PATCH"]
    path: str
    path_params: dict[str, str] = Field(default_factory=dict)
    query_params: dict[str, str | int | float] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    body: dict[str, Any] | None = None

    def resolve_url(self, base_url: str) -> str:
        resolved = self.path
        for key, val in self.path_params.items():
            resolved = resolved.replace(f"{{{key}}}", val)
        return f"{base_url.rstrip('/')}{resolved}"


class SolanaAction(BaseModel):
    action: Literal["transfer_usdc"]
    to: str
    amount: int


class PlanStep(BaseModel):
    """Legacy structured output model — kept for fallback/testing."""

    description: str = ""
    reasoning: str = ""
    http_actions: list[HttpAction] = Field(default_factory=list)
    solana_actions: list[SolanaAction] = Field(default_factory=list)
