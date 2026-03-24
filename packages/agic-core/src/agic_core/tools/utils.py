"""Utility tools — logging, ID generation, time."""

from __future__ import annotations

import asyncio
import logging
import sys
import uuid
from datetime import datetime, timezone

_COLORS = {
    "DEBUG": "\033[90m",
    "INFO": "\033[36m",
    "WARN": "\033[33m",
    "WARNING": "\033[33m",
    "ERROR": "\033[31m",
    "RESET": "\033[0m",
    "DIM": "\033[2m",
    "BOLD": "\033[1m",
}


def now() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now().isoformat()


async def sleep_ms(ms: int) -> None:
    await asyncio.sleep(ms / 1000)


def generate_id() -> str:
    return str(uuid.uuid4())


def log(level: str, message: str, context: dict | None = None) -> None:
    lvl = level.upper()
    color = _COLORS.get(lvl, "")
    reset = _COLORS["RESET"]
    dim = _COLORS["DIM"]
    ts = now().strftime("%H:%M:%S")
    line = f"{dim}{ts}{reset} {color}{lvl:5s}{reset}  {message}"
    if context:
        pairs = " ".join(f"{dim}{k}{reset}={v}" for k, v in context.items())
        line += f"  {pairs}"
    print(line, file=sys.stderr, flush=True)


def setup_logging(logger_name: str = "agic_core", debug: bool = False) -> None:
    level = logging.DEBUG if debug else logging.INFO

    class _Formatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            lvl = record.levelname
            color = _COLORS.get(lvl, "")
            reset = _COLORS["RESET"]
            dim = _COLORS["DIM"]
            ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
            return f"{dim}{ts}{reset} {color}{lvl:5s}{reset}  {record.getMessage()}"

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(_Formatter())
    root = logging.getLogger(logger_name)
    root.setLevel(level)
    root.handlers.clear()
    root.addHandler(handler)
