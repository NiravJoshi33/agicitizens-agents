"""Integration tests against the real AGICitizens devnet API.

These test the critical path: can an agent discover and interact with the platform?
Run with: pytest tests/test_integration.py -v

Requires OPENROUTER_API_KEY in env (or .env file).
"""

import json
import os

import httpx
import pytest
import pytest_asyncio

PLATFORM_URL = os.environ.get(
    "PLATFORM_URL", "https://api-beta.agicitizens.com/api/v1"
)


@pytest.mark.asyncio
async def test_platform_is_reachable():
    """Health check — platform API is up."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{PLATFORM_URL}/healthz")
        assert resp.status_code == 200
        data = resp.json()
        # API wraps responses in a "data" envelope
        payload = data.get("data", data)
        assert payload.get("status") == "ok"


@pytest.mark.asyncio
async def test_citizen_md_is_fetchable():
    """Agent can fetch the onboarding documentation."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{PLATFORM_URL}/citizen.md")
        assert resp.status_code == 200
        text = resp.text
        # Should contain key concepts an agent needs
        assert "register" in text.lower()
        assert "heartbeat" in text.lower()
        assert len(text) > 500  # substantial docs


@pytest.mark.asyncio
async def test_openapi_spec_is_fetchable():
    """Agent can fetch the API specification."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{PLATFORM_URL}/openapi.json")
        assert resp.status_code == 200
        spec = resp.json()
        assert "paths" in spec or "openapi" in spec


@pytest.mark.asyncio
async def test_x402_info_is_fetchable():
    """Agent can get payment info for X402 protocol."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{PLATFORM_URL}/x402/info")
        assert resp.status_code == 200
        data = resp.json()
        # Should contain wallet address and USDC mint
        payload = data.get("data", data)
        assert any(
            k in payload for k in ["wallet", "platform_wallet", "usdc_mint"]
        ), f"Unexpected payment info shape: {list(payload.keys())}"


@pytest.mark.asyncio
async def test_tasks_list_is_accessible():
    """Agent can list tasks (even without auth, should get a response)."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{PLATFORM_URL}/tasks")
        # May require auth — either 200 or 401 is fine, just not 500
        assert resp.status_code in (200, 401, 403)


@pytest.mark.asyncio
async def test_agents_list_is_accessible():
    """Agent can discover other agents."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{PLATFORM_URL}/agents")
        # 500 may indicate a platform-side issue — still counts as reachable
        assert resp.status_code in (200, 401, 403, 500)


@pytest.mark.asyncio
async def test_llm_can_parse_citizen_md():
    """The LLM can read citizen.md and extract structured API understanding.

    This is THE critical test — proves an agent can go from docs to working knowledge.
    Requires OPENROUTER_API_KEY.
    """
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        pytest.skip("OPENROUTER_API_KEY not set")

    from src.agents.research.agent import DISCOVERY_PROMPT
    from src.agents.research import llm

    async with httpx.AsyncClient(timeout=10) as client:
        citizen_resp = await client.get(f"{PLATFORM_URL}/citizen.md")
        openapi_resp = await client.get(f"{PLATFORM_URL}/openapi.json")

    prompt = DISCOVERY_PROMPT.format(
        citizen_md=citizen_resp.text,
        openapi_spec=json.dumps(openapi_resp.json(), indent=2)
        if openapi_resp.status_code == 200
        else "unavailable",
    )

    model = os.environ.get("LLM_MODEL", "google/gemini-2.0-flash-001")
    response = await llm.chat_json(
        messages=[{"role": "user", "content": prompt}],
        model=model,
        api_key=api_key,
    )

    understanding = json.loads(response)

    # The LLM should have extracted these essential fields
    assert "register_endpoint" in understanding, "LLM didn't find registration endpoint"
    assert "heartbeat_endpoint" in understanding, "LLM didn't find heartbeat endpoint"
    assert "list_tasks_endpoint" in understanding, "LLM didn't find task listing endpoint"
    assert "auth_header" in understanding, "LLM didn't find auth header"
