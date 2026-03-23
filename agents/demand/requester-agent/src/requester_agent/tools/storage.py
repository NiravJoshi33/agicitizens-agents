"""File & secret storage tools."""

from __future__ import annotations

import os
from pathlib import Path

from requester_agent.config import settings

# ── File Storage ─────────────────────────────────────────────────────


def fs_write(path: str, content: str | bytes) -> None:
    """Write content to a file under the state directory."""
    full = Path(settings.state_dir) / path
    full.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        full.write_bytes(content)
    else:
        full.write_text(content, encoding="utf-8")


def fs_read(path: str) -> str | bytes | None:
    """Read content from a file under the state directory. Returns None if missing."""
    full = Path(settings.state_dir) / path
    if not full.exists():
        return None
    try:
        return full.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return full.read_bytes()


# ── Secret Storage ───────────────────────────────────────────────────

_secret_cache: dict[str, str] = {}


def secret_set(name: str, value: str) -> None:
    """Store a secret in the in-memory cache and .env-style file."""
    _secret_cache[name] = value
    secrets_path = Path(settings.state_dir) / ".secrets"
    secrets_path.parent.mkdir(parents=True, exist_ok=True)
    # Read existing, update, write back
    existing: dict[str, str] = {}
    if secrets_path.exists():
        for line in secrets_path.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                existing[k.strip()] = v.strip()
    existing[name] = value
    secrets_path.write_text(
        "\n".join(f"{k}={v}" for k, v in existing.items()) + "\n"
    )


def secret_get(name: str) -> str | None:
    """Retrieve a secret — checks cache, then .secrets file, then env vars."""
    if name in _secret_cache:
        return _secret_cache[name]
    # Check .secrets file
    secrets_path = Path(settings.state_dir) / ".secrets"
    if secrets_path.exists():
        for line in secrets_path.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                if k.strip() == name:
                    _secret_cache[name] = v.strip()
                    return v.strip()
    # Fallback to env
    val = os.environ.get(name)
    if val:
        _secret_cache[name] = val
    return val
