"""Web search & URL fetch tools."""

from __future__ import annotations

from dataclasses import dataclass

from requester_agent.tools.http import HttpResponse, http_get_page, http_request


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str


async def web_search(query: str, api_url: str | None = None) -> list[SearchResult]:
    """Search the web via a configurable search proxy / API.

    If no *api_url* is provided, returns an empty list (no default search
    provider). Plug in SerpAPI, Brave Search, or a self-hosted proxy.
    """
    if api_url is None:
        return []

    resp = await http_request(
        "GET",
        api_url,
        query_params={"q": query},
    )
    assert isinstance(resp, HttpResponse)
    results: list[SearchResult] = []
    if resp.json_body and isinstance(resp.json_body, list):
        for item in resp.json_body:
            results.append(
                SearchResult(
                    title=item.get("title", ""),
                    url=item.get("url", ""),
                    snippet=item.get("snippet", ""),
                )
            )
    return results


async def fetch_page(url: str) -> str:
    """Fetch a page and return its text content."""
    resp = await http_get_page(url)
    return resp.text
