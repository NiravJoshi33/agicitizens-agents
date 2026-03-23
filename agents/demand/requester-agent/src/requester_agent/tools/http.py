"""Generic HTTP / curl tool — async via httpx."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import httpx


@dataclass
class HttpResponse:
    status: int
    headers: dict[str, str]
    text: str
    json_body: Any | None = None


@dataclass
class SSEEvent:
    event: str = ""
    data: str = ""
    id: str = ""
    retry: int | None = None


_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
    return _client


async def http_request(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    query_params: dict[str, str | int | float] | None = None,
    body: dict | str | bytes | None = None,
    timeout_ms: int | None = None,
    stream: bool = False,
) -> HttpResponse | AsyncIterator[SSEEvent]:
    """Execute an arbitrary HTTP request.

    When *stream=True*, returns an async generator of SSEEvent objects.
    Otherwise returns an HttpResponse.
    """
    client = _get_client()
    timeout = httpx.Timeout(timeout_ms / 1000) if timeout_ms else None
    kwargs: dict[str, Any] = {
        "method": method,
        "url": url,
        "headers": headers or {},
        "params": query_params,
        "timeout": timeout,
    }
    if isinstance(body, (dict,)):
        kwargs["json"] = body
    elif body is not None:
        kwargs["content"] = body

    if stream:
        return _stream_sse(client, kwargs)

    resp = await client.request(**kwargs)
    json_body = None
    try:
        json_body = resp.json()
    except Exception:
        pass
    return HttpResponse(
        status=resp.status_code,
        headers=dict(resp.headers),
        text=resp.text,
        json_body=json_body,
    )


async def _stream_sse(
    client: httpx.AsyncClient, kwargs: dict[str, Any]
) -> AsyncIterator[SSEEvent]:
    """Consume an SSE stream and yield parsed events."""
    async with client.stream(**kwargs) as resp:
        event = SSEEvent()
        async for line in resp.aiter_lines():
            if not line:
                if event.data:
                    yield event
                event = SSEEvent()
                continue
            if line.startswith("event:"):
                event.event = line[6:].strip()
            elif line.startswith("data:"):
                event.data = line[5:].strip()
            elif line.startswith("id:"):
                event.id = line[3:].strip()
            elif line.startswith("retry:"):
                try:
                    event.retry = int(line[6:].strip())
                except ValueError:
                    pass


async def http_get_page(url: str) -> HttpResponse:
    """Convenience GET for fetching docs/pages — no auth, text expected."""
    resp = await http_request("GET", url)
    assert isinstance(resp, HttpResponse)
    return resp


async def close_client() -> None:
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None
