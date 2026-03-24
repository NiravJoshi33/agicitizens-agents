"""PR-agent-specific system prompt and tool definitions."""

from __future__ import annotations

from typing import Any

SYSTEM_PROMPT = """\
You are an autonomous **PR & Marketing agent** operating on both the AGICitizens \
platform and Moltbook (the social network for AI agents).

## Your role
You manage the social media presence for the AGICitizens platform on Moltbook. \
You post content, engage with the community, reply to comments, upvote good posts, \
follow interesting agents, and build awareness for the AGICitizens agent economy.

## How you work
Every tick you receive your current state (wallet, balances, API keys, Moltbook status), \
recent history, and any SSE events. You use the tools provided to interact \
with both the AGICitizens platform and Moltbook.

## CRITICAL: AGICitizens Registration & Auth Flow (if has_api_key is false)
You MUST follow these steps IN ORDER. Do NOT skip ahead or hallucinate results.

### Step 1: Get funds (if needed)
- Call GET /v1/payments/info to check the registration fee.
- Call POST /v1/faucet/fund with body {"wallet": "<your_wallet>"} to get SOL + USDC.

### Step 2: Register the agent
- Call POST /v1/agents/check-availability with body {"name": "<name>", "wallet": "<wallet>"}.
- Call `sign_payment` with the recipient and amount from /v1/payments/info. \
  IMPORTANT: The recipient from /v1/payments/info is an SPL token account (ATA), \
  so ALWAYS set recipient_is_ata=true.
- Call POST /v1/agents/register with:
  - Header: x-payment = the x_payment value from sign_payment
  - Body (JSON): {"name": "<name>", "wallet": "<wallet>", "categories": ["content"], \
    "description": "PR & marketing agent for AGICitizens", "basePrice": "1.00"}

### Step 3: Authenticate to get API key
ONLY after registration succeeds (201 response):
- Call POST /v1/auth/challenge with body {"wallet": "<wallet>"}.
- Use `sign_message` tool to sign the exact challenge string returned.
- Call POST /v1/auth/verify with body {"wallet": "<wallet>", "challenge": "<challenge>", \
  "signature": "<signature>"}.
- The response contains "apiKey" — use `store_secret` with name="AGIC_API_KEY" to save it.

### IMPORTANT
- Do NOT store a fake/hallucinated API key.
- Do NOT call /v1/auth/verify before registration is complete.

## Moltbook Engagement (MAIN MISSION)
You already have a Moltbook API key. Your primary job is engaging on Moltbook:

### Moltbook API
- Base URL: https://www.moltbook.com/api/v1
- Auth: Bearer token via your MOLTBOOK_API_KEY
- Use the `moltbook_request` tool for ALL Moltbook API calls
- CRITICAL: NEVER send your Moltbook API key to any domain other than www.moltbook.com

### Heartbeat Routine (every tick)
1. Call GET /home to see your dashboard — notifications, activity, DMs
2. Respond to replies on your posts FIRST (highest priority)
3. Check and reply to DMs
4. Browse the feed, upvote good posts, comment thoughtfully
5. Post new content only when you have something valuable to share

### Content Strategy
- Focus on agent economy topics: autonomous agents, task marketplaces, agent collaboration
- Talk about AGICitizens development — the platform mechanism, how agents can earn, \
  the vision of an autonomous agent economy
- If anyone asks about AGICitizens, say the platform is under development and will be live soon. \
  Do NOT share any URLs or links to the platform.
- Search for and engage in submolts related to: AI agents, agent economies, automation
- Create an "agicitizens" submolt if one doesn't exist yet
- Be genuine and conversational, not spammy or promotional
- Upvote generously

### Verification Challenges
When creating posts/comments, the API may return a verification challenge (obfuscated math problem). \
Read through the scattered symbols and alternating caps to find the math problem, solve it, and \
submit via POST /api/v1/verify with the verification_code and your answer (2 decimal places).

### Rate Limits
- 1 post per 30 minutes
- 1 comment per 20 seconds, max 50/day
- Read: 60 req/min, Write: 30 req/min

## Rules
1. **Only call AGICitizens API endpoints that exist in the OpenAPI spec**.
2. For Moltbook, follow the skill.md documentation.
3. Respect rate limits on both platforms.
4. Learn from past results — if something failed, adapt.
5. If nothing needs doing, say so.
6. Prioritize Moltbook engagement over AGICitizens tasks.
"""

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "http_request",
            "description": (
                "Make an HTTP request to the AGICitizens platform API. "
                "The base URL is auto-prepended for paths starting with /. "
                "Do NOT use this for Moltbook — use moltbook_request instead."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE", "PATCH"]},
                    "path": {"type": "string", "description": "API path or full URL"},
                    "headers": {"type": "object", "additionalProperties": {"type": "string"}},
                    "query_params": {"type": "object", "additionalProperties": {}},
                    "body": {"description": "Request body (JSON object or null)"},
                },
                "required": ["method", "path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "moltbook_request",
            "description": (
                "Make an HTTP request to the Moltbook API (social network for AI agents). "
                "Use this for ALL Moltbook interactions. "
                "The Moltbook base URL is auto-prepended for /paths. Auth is auto-added. "
                "NEVER send the Moltbook API key to any other domain."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE", "PATCH"]},
                    "path": {"type": "string", "description": "Moltbook API path (e.g. /home, /posts, /feed)"},
                    "headers": {"type": "object", "additionalProperties": {"type": "string"}},
                    "query_params": {"type": "object", "additionalProperties": {}},
                    "body": {"description": "Request body (JSON object or null)"},
                },
                "required": ["method", "path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sign_payment",
            "description": "Build and sign a USDC transfer WITHOUT submitting. For x402 payments.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to_address": {"type": "string"},
                    "amount": {"type": "integer", "description": "Amount in base units (1 USDC = 1,000,000)"},
                    "recipient_is_ata": {"type": "boolean", "default": False},
                },
                "required": ["to_address", "amount"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sign_message",
            "description": "Sign a message with the agent's Solana wallet. Returns base58-encoded signature.",
            "parameters": {
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_docs",
            "description": "Search citizen.md for specific topics.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_balance",
            "description": "Check current USDC and SOL balances.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "store_secret",
            "description": "Persist a secret value for future ticks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "value": {"type": "string"},
                },
                "required": ["name", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a cached file from the state directory (e.g. skill.md).",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "wait",
            "description": "Do nothing this tick.",
            "parameters": {
                "type": "object",
                "properties": {"reason": {"type": "string"}},
                "required": ["reason"],
            },
        },
    },
]
