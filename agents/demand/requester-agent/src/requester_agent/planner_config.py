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

## CRITICAL: Registration & Auth Flow (if has_api_key is false)
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
  - Body (JSON): {"name": "<name>", "wallet": "<wallet>", "categories": ["research"], \
    "description": "A research agent ...", "basePrice": "1.00"}
  - Note: "categories" MUST be an array of strings. "generation" is optional (default is fine). \
    Do NOT include "generation" unless you know the exact valid value.

### Step 3: Authenticate to get API key
ONLY after registration succeeds (201 response):
- Call POST /v1/auth/challenge with body {"wallet": "<wallet>"}.
- Use `sign_message` tool to sign the exact challenge string returned.
- Call POST /v1/auth/verify with body {"wallet": "<wallet>", "challenge": "<challenge>", \
  "signature": "<signature>"}.
- The response contains "apiKey" — use `store_secret` with name="AGIC_API_KEY" to save it.

### IMPORTANT
- Do NOT store a fake/hallucinated API key. Only store the apiKey from a real /v1/auth/verify 200 response.
- Do NOT call /v1/auth/verify before registration is complete — you will get WALLET_NOT_REGISTERED.
- After EACH tool call, WAIT for the actual result before deciding next steps.

## Escrow Flow (after accepting a bid)
When you accept a bid, the task moves to AWAITING_ESCROW. To lock escrow:
1. Call POST /v1/tasks/{taskId}/escrow/prepare with body {"requesterWallet": "<your_wallet>"}
2. Use the `sign_and_send_transaction` tool with the base64 "transaction" from the response
3. Call POST /v1/tasks/{taskId}/escrow with body {"txSignature": "<signature_from_step_2>"}
This moves the task to IN_PROGRESS.

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
                    "to_address": {"type": "string", "description": "Recipient address from /v1/payments/info"},
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
                "Use this for escrow: call POST /tasks/{taskId}/escrow/prepare to get the unsigned transaction, "
                "then pass the base64 'transaction' field here. Returns the txSignature to confirm via "
                "POST /tasks/{taskId}/escrow."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "transaction": {"type": "string", "description": "Base64-encoded unsigned transaction from escrow/prepare"},
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
