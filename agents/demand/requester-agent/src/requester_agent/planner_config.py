"""Requester-agent-specific system prompt and tool definitions."""

from __future__ import annotations

from typing import Any

SYSTEM_PROMPT = """\
You are an autonomous **requester agent** on the AGICitizens platform.

## Your role
You post tasks, evaluate bids, fund escrow, review deliveries, rate providers, \
and handle disputes — the full requester lifecycle.

## How you work
Every tick you receive your current state (wallet, balances, API key status), \
recent history, and any SSE events. You use the tools provided to interact \
with the platform.

## Onboarding (if has_api_key is false)
Use `search_docs` and the OpenAPI spec to discover the platform's onboarding flow. \
Follow the steps described in citizen.md IN ORDER. Do NOT skip ahead or hallucinate results.

Key principles:
- Check your balances first. If you need funds, look for a faucet endpoint in the API spec.
- The payment recipient from the payments info endpoint is an SPL token account (ATA) — \
  ALWAYS set recipient_is_ata=true when signing registration payments.
- Do NOT store a fake/hallucinated API key. Only store a real apiKey from a verified auth response.
- After EACH tool call, WAIT for the actual result before deciding next steps.

## Escrow Flow
When you accept a bid and the task moves to AWAITING_ESCROW, consult the OpenAPI spec \
for the escrow endpoints. The flow involves preparing, signing, and confirming \
the escrow transaction on-chain.

## Rules
1. **Only call API endpoints that exist in the OpenAPI spec** (provided below). \
   Never guess or hallucinate paths.
2. Respect budget limits.
3. Learn from past results — if something failed, adapt your approach.
4. Follow behavioral norms from citizen.md.
5. If nothing needs doing, say so — don't make unnecessary calls.
6. You can call multiple tools in parallel if they are independent.
"""

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "http_request",
            "description": (
                "Make an HTTP request to the AGICitizens platform API or any URL. "
                "Use this for all REST API interactions. The base URL is auto-prepended "
                "for paths starting with /."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE", "PATCH"], "description": "HTTP method"},
                    "path": {"type": "string", "description": "API path (e.g. /agents/check-availability) or full URL"},
                    "headers": {"type": "object", "description": "Additional HTTP headers (auth is auto-added)", "additionalProperties": {"type": "string"}},
                    "query_params": {"type": "object", "description": "URL query parameters", "additionalProperties": {}},
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
            "description": (
                "Build and sign a USDC transfer transaction WITHOUT submitting it. "
                "Returns base64-encoded raw signed transaction bytes. Use this for "
                "x402 payments — put the returned value in the x-payment header. "
                "IMPORTANT: If the recipient is an SPL token account (ATA), set recipient_is_ata=true."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to_address": {"type": "string", "description": "Recipient address"},
                    "amount": {"type": "integer", "description": "Amount in base units (1 USDC = 1,000,000)"},
                    "recipient_is_ata": {"type": "boolean", "description": "Set true if the recipient address is already an SPL token account (ATA).", "default": False},
                },
                "required": ["to_address", "amount"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sign_message",
            "description": "Sign an arbitrary message with the agent's Solana wallet private key. Returns base58-encoded signature.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "The exact message string to sign"},
                },
                "required": ["message"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_docs",
            "description": "Search the platform documentation (citizen.md) for specific topics.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query (e.g. 'registration', 'escrow')"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_balance",
            "description": "Check current USDC and SOL balances of the agent wallet.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "store_secret",
            "description": "Persist a secret value (e.g. API key) for future ticks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Secret name (e.g. AGIC_API_KEY)"},
                    "value": {"type": "string", "description": "Secret value"},
                },
                "required": ["name", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a cached file from the state directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path relative to state dir"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sign_and_send_transaction",
            "description": (
                "Sign a base64-encoded unsigned transaction with the agent's wallet and send it to Solana. "
                "Use this for escrow or any on-chain operation where the platform provides an unsigned transaction. "
                "Returns the transaction signature."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "transaction": {"type": "string", "description": "Base64-encoded unsigned transaction"},
                },
                "required": ["transaction"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "wait",
            "description": "Do nothing this tick. Use when no action is needed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {"type": "string", "description": "Why we're waiting"},
                },
                "required": ["reason"],
            },
        },
    },
]
