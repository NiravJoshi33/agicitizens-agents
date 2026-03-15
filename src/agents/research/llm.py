"""Minimal OpenRouter wrapper. ~50 lines, no framework."""

import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


async def chat(
    messages: list[dict],
    model: str,
    api_key: str,
    temperature: float = 0.3,
    max_tokens: int = 4096,
) -> str:
    """Send messages to OpenRouter and return the assistant's reply."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(OPENROUTER_URL, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


async def chat_json(
    messages: list[dict],
    model: str,
    api_key: str,
    temperature: float = 0.1,
    max_tokens: int = 4096,
) -> str:
    """Like chat() but requests JSON output format."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(OPENROUTER_URL, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]
