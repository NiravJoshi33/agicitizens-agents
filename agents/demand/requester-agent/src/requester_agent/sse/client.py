"""SSE listener with auto-reconnect and exponential backoff."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Coroutine

import httpx

from requester_agent.tools.utils import log

logger = logging.getLogger(__name__)

EventHandler = Callable[[str, dict[str, Any]], Coroutine[Any, Any, None]]


class SSEListener:
    """Consume server-sent events from the platform's /events/stream endpoint."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        max_retries: int = 0,  # 0 = infinite
        base_backoff_s: float = 1.0,
        max_backoff_s: float = 60.0,
    ) -> None:
        self._url = f"{base_url.rstrip('/')}/events/stream"
        self._api_key = api_key
        self._max_retries = max_retries
        self._base_backoff = base_backoff_s
        self._max_backoff = max_backoff_s
        self._running = True
        self._handlers: list[EventHandler] = []
        self._last_event_id: str = ""

    def on_event(self, handler: EventHandler) -> None:
        """Register an async callback for incoming events."""
        self._handlers.append(handler)

    def stop(self) -> None:
        self._running = False

    async def listen(self) -> None:
        """Connect to the SSE stream and dispatch events. Auto-reconnects on failure."""
        retries = 0
        while self._running:
            try:
                await self._consume_stream()
                retries = 0  # Reset on clean disconnect
            except (httpx.HTTPError, httpx.StreamError, ConnectionError) as exc:
                retries += 1
                if self._max_retries and retries > self._max_retries:
                    log("ERROR", f"SSE max retries ({self._max_retries}) exceeded")
                    break
                backoff = min(self._base_backoff * (2 ** (retries - 1)), self._max_backoff)
                log("WARN", f"SSE disconnected, retrying in {backoff:.1f}s", {"error": str(exc), "retry": retries})
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log("ERROR", f"SSE unexpected error: {exc}")
                await asyncio.sleep(self._base_backoff)

    async def _consume_stream(self) -> None:
        """Open the SSE connection and process events."""
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache",
        }
        if self._last_event_id:
            headers["Last-Event-ID"] = self._last_event_id

        async with httpx.AsyncClient(timeout=httpx.Timeout(None)) as client:
            async with client.stream("GET", self._url, headers=headers) as resp:
                resp.raise_for_status()
                log("INFO", "SSE stream connected", {"url": self._url})

                event_type = ""
                data_lines: list[str] = []
                event_id = ""

                async for line in resp.aiter_lines():
                    if not self._running:
                        break

                    if not line:
                        # Empty line = event boundary
                        if data_lines:
                            data_str = "\n".join(data_lines)
                            await self._dispatch(event_type or "message", data_str, event_id)
                        event_type = ""
                        data_lines = []
                        event_id = ""
                        continue

                    if line.startswith("event:"):
                        event_type = line[6:].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].strip())
                    elif line.startswith("id:"):
                        event_id = line[3:].strip()
                        self._last_event_id = event_id
                    elif line.startswith(":"):
                        pass  # Comment / keepalive

    async def _dispatch(self, event_type: str, data_str: str, event_id: str) -> None:
        """Parse and dispatch an SSE event to registered handlers."""
        try:
            payload = json.loads(data_str)
        except json.JSONDecodeError:
            payload = {"raw": data_str}

        log("DEBUG", f"SSE event: {event_type}", {"id": event_id})

        for handler in self._handlers:
            try:
                await handler(event_type, payload)
            except Exception as exc:
                log("ERROR", f"SSE handler error: {exc}", {"event_type": event_type})
