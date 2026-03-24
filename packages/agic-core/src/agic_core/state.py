"""Shared state persistence — SQLAlchemy async + SQLite.

Provides the declarative Base, common models (EventRecord), and lazy
engine/session factories.  Agents import Base and define their own
models before calling ``init_db()``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import JSON, DateTime, Integer, String
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class EventRecord(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


# ── Lazy engine / session ────────────────────────────────────────────

_engine = None
_async_session = None


def get_engine():
    global _engine
    if _engine is None:
        from agic_core.config import settings
        _engine = create_async_engine(settings.db_url, echo=False)
    return _engine


def get_session() -> async_sessionmaker[AsyncSession]:
    global _async_session
    if _async_session is None:
        _async_session = async_sessionmaker(
            get_engine(), class_=AsyncSession, expire_on_commit=False
        )
    return _async_session


async def init_db() -> None:
    """Create all tables registered on Base (including agent-specific ones)."""
    from agic_core.config import settings
    Path(settings.state_dir).mkdir(parents=True, exist_ok=True)
    async with get_engine().begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
