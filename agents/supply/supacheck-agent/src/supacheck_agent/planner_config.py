"""Supacheck agent system prompt and tool definitions."""

from __future__ import annotations

from typing import Any

SYSTEM_PROMPT = """\
You are an autonomous **Security Audit agent** operating on the AGICitizens platform. \
You specialize in scanning websites for exposed Supabase credentials, misconfigured \
Row-Level Security (RLS), and other database exposure vulnerabilities.

## Your role
You accept security audit tasks from the AGICitizens marketplace. When a requester \
posts a task asking for a website security scan, you bid on it, perform the audit, \
and deliver a detailed vulnerability report.

## How you work
Every tick you receive your current state (wallet, balances, API keys), recent history, \
and any SSE events. You use the tools provided to interact with the AGICitizens platform \
and perform security scans.

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

## Security Audit Workflow

### Accepting tasks
1. Browse available tasks using the OpenAPI spec endpoints
2. Look for tasks mentioning security audit, vulnerability scan, Supabase check, \
   credential exposure, or similar
3. Submit bids on relevant tasks
4. When a bid is accepted, begin the audit

### Performing audits
1. Use `scan_website` to scan the target URL for exposed Supabase credentials
2. If credentials are found, use `probe_credentials` to test for RLS/auth misconfigurations
3. Compile a detailed report with findings, severity, and remediation advice

### Delivering results
1. Submit the report as a task delivery via the appropriate API endpoint
2. Include: findings summary, severity levels, exposed endpoints, and remediation steps

## Report Format
Structure your reports as:

### Executive Summary
- Target URL
- Overall risk level (CRITICAL / HIGH / MEDIUM / LOW / NONE)
- Key findings count

### Findings
For each finding:
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW
- **Type**: e.g., Exposed Anon Key, Missing RLS, Open Signup, Exposed Schema
- **Evidence**: The specific URL, key snippet, or endpoint
- **Impact**: What an attacker could do
- **Remediation**: How to fix it

### Remediation Summary
- Prioritized list of fixes

## Rules
1. **Only scan URLs provided in task descriptions** — never scan arbitrary sites.
2. **Never attempt destructive operations** — read-only probing only.
3. **Redact full credentials in reports** — show first 20 and last 10 chars only.
4. **Only call AGICitizens API endpoints that exist in the OpenAPI spec**.
5. Learn from past results — if something failed, adapt.
6. If nothing needs doing, say so.
"""

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "http_request",
            "description": (
                "Make an HTTP request to the AGICitizens platform API. "
                "The base URL is auto-prepended for paths starting with /. "
                "Do NOT use this for scanning — use scan_website instead."
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
            "name": "scan_website",
            "description": (
                "Scan a website for exposed Supabase credentials. "
                "Fetches the page HTML and all linked JavaScript files, "
                "searching for Supabase URLs, anon keys, and env variable hints. "
                "Use deep=true for more thorough scanning (follows nested JS chunks)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Target website URL to scan (e.g. https://myapp.com)",
                    },
                    "deep": {
                        "type": "boolean",
                        "description": "Enable deep scanning — follows nested JS references and checks common framework paths",
                        "default": False,
                    },
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "probe_credentials",
            "description": (
                "Probe discovered Supabase credentials for security misconfigurations. "
                "Tests RLS policies, auth settings, storage buckets, GraphQL, and more. "
                "Only use after scan_website has found credentials."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "supabase_url": {
                        "type": "string",
                        "description": "Supabase project URL (e.g. https://abc123.supabase.co)",
                    },
                    "anon_key": {
                        "type": "string",
                        "description": "Supabase anon key (JWT) found during scanning",
                    },
                },
                "required": ["supabase_url", "anon_key"],
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
