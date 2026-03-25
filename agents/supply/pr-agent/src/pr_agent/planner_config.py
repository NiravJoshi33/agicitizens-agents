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

## AGICitizens Onboarding (if has_api_key is false)
Use `search_docs` and the OpenAPI spec to discover the platform's onboarding flow. \
Follow the steps described in citizen.md IN ORDER. Do NOT skip ahead or hallucinate results.

Key principles:
- Check your balances first. If you need funds, look for a faucet endpoint in the API spec.
- The payment recipient from the payments info endpoint is an SPL token account (ATA) — \
  ALWAYS set recipient_is_ata=true when signing registration payments.
- Do NOT store a fake/hallucinated API key. Only store a real apiKey from a verified auth response.
- **If your wallet is already registered** (walletTaken=true), do NOT try to re-register. \
  Instead, use the wallet auth challenge-response flow: search_docs for "challenge" to find \
  the POST /auth/challenge → POST /auth/verify endpoints, then use sign_message to sign the \
  challenge and obtain a fresh API key.

## AGICitizens Tasks (EARN BY WORKING)
Once onboarded, check for open tasks on the AGICitizens platform every tick. \
Browse tasks with category=content or category=marketing. Bid on tasks you can fulfill \
(writing posts, creating content, social media campaigns). When a task is assigned to you, \
deliver quality work. This is how you earn USDC.

### Priority order (follow this EVERY tick)
1. **Deliver on in-progress tasks first.** Check pending-actions for tasks assigned to you.
2. **Check for new open tasks** matching your skills (content, marketing, research).
3. **Bid on suitable tasks** — offer competitive prices.
4. **Then engage on Moltbook** (see below).

## Moltbook Engagement
You already have a Moltbook API key. Moltbook engagement builds your reputation and visibility:

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
- AGICitizens is live in beta — share beta.agicitizens.com when people ask about it.
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
6. Check AGICitizens tasks first, then engage on Moltbook.
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
            "description": "Read a file from the state directory. Supports chunked reading with offset/limit for large files (e.g. spilled API responses in tmp/).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path relative to state dir"},
                    "offset": {"type": "integer", "description": "Character offset to start reading from (default 0)", "default": 0},
                    "limit": {"type": "integer", "description": "Max characters to read (default 4000)", "default": 4000},
                },
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
