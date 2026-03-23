"""Decision engine — uses OpenAI-compatible tool calling (works with OpenRouter).

The planner exposes generic tools (http_request, solana_transfer, etc.) as
function definitions. The LLM decides which tools to call and with what args.
The orchestrator executes the tool calls and feeds results back.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageToolCall

from pathlib import Path

from requester_agent.config import settings
from requester_agent.tools.storage import fs_read

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are an autonomous **requester agent** on the AGICitizens platform.

## Your role
You post tasks, evaluate bids, fund escrow, review deliveries, rate providers, \
and handle disputes — the full requester lifecycle.

## How you work
Every tick you receive your current state (wallet, balances, API key status), \
recent history, and any SSE events. You use the tools provided to interact \
with the platform.

## Rules
1. **Only call API endpoints that exist in the OpenAPI spec** (provided below). \
   Never guess or hallucinate paths.
2. If you are not registered yet (no API key), your first priority is registration.
3. For Solana payments (registration fee, escrow), use the `solana_transfer` tool.
4. After a successful Solana transfer, use the tx_signature in subsequent API calls \
   (e.g. X-Payment header for registration, escrow confirmation).
5. Respect budget limits.
6. Learn from past results — if something failed, adapt your approach.
7. Follow behavioral norms from citizen.md.
8. If nothing needs doing, say so — don't make unnecessary calls.
9. You can call multiple tools in parallel if they are independent.
"""

# ── Tool Definitions (OpenAI function-calling format) ────────────────

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
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "DELETE", "PATCH"],
                        "description": "HTTP method",
                    },
                    "path": {
                        "type": "string",
                        "description": "API path (e.g. /agents/check-availability) or full URL",
                    },
                    "headers": {
                        "type": "object",
                        "description": "Additional HTTP headers (auth is auto-added)",
                        "additionalProperties": {"type": "string"},
                    },
                    "query_params": {
                        "type": "object",
                        "description": "URL query parameters",
                        "additionalProperties": {},
                    },
                    "body": {
                        "description": "Request body (JSON object or null)",
                    },
                },
                "required": ["method", "path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "solana_transfer",
            "description": (
                "Transfer SPL USDC tokens on Solana. Use for registration payments, "
                "escrow funding, or any on-chain transfer. Returns tx_signature on success."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to_address": {
                        "type": "string",
                        "description": "Recipient Solana address (vault, escrow, or wallet)",
                    },
                    "amount": {
                        "type": "integer",
                        "description": "Amount in base units (1 USDC = 1,000,000)",
                    },
                },
                "required": ["to_address", "amount"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_balance",
            "description": "Check current USDC and SOL balances of the agent wallet.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
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
            "description": "Read a cached file from the state directory (e.g. citizen.md, openapi.json).",
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


class ToolCall:
    """Represents a tool call the LLM wants to make."""

    def __init__(self, id: str, name: str, arguments: dict[str, Any]) -> None:
        self.id = id
        self.name = name
        self.arguments = arguments

    @classmethod
    def from_openai(cls, tc: ChatCompletionMessageToolCall) -> "ToolCall":
        return cls(
            id=tc.id,
            name=tc.function.name,
            arguments=json.loads(tc.function.arguments),
        )


class Planner:
    """LLM-backed planner using native tool calling."""

    def __init__(self) -> None:
        self._client = AsyncOpenAI(
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
        )
        self._model = settings.llm_model

    async def decide(
        self,
        state: dict[str, Any],
        history: list[dict[str, Any]],
    ) -> tuple[str, list[ToolCall]]:
        """Ask the LLM what to do. Returns (thinking_text, tool_calls).

        If the LLM returns text without tool calls, it means "no action needed".
        """
        messages = self._build_messages(state, history)
        logger.debug("Planner messages: %d", len(messages))

        response = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            temperature=0.4,
        )

        msg = response.choices[0].message
        thinking = msg.content or ""
        tool_calls: list[ToolCall] = []

        if msg.tool_calls:
            for tc in msg.tool_calls:
                tool_calls.append(ToolCall.from_openai(tc))

        return thinking, tool_calls

    def _load_persona(self) -> str:
        """Load persona.md from the configured path."""
        p = Path(settings.persona_path)
        if p.exists():
            return p.read_text(encoding="utf-8").strip()
        # Also check state dir
        cached = fs_read("persona.md")
        if cached and isinstance(cached, str):
            return cached.strip()
        return ""

    def _build_messages(
        self,
        state: dict[str, Any],
        history: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        # Persona goes first — it defines WHO you are and WHAT you do
        persona = self._load_persona()
        system_content = ""
        if persona:
            system_content = f"## Your Persona & Mission\n{persona}\n\n"
        system_content += SYSTEM_PROMPT

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_content},
        ]

        # Inject OpenAPI spec summary
        openapi_text = self._load_openapi_summary()
        if openapi_text:
            messages.append({
                "role": "system",
                "content": f"## Available API Endpoints (from OpenAPI spec)\n{openapi_text}",
            })

        # Inject citizen.md
        citizen = fs_read("citizen.md")
        if citizen and isinstance(citizen, str):
            excerpt = citizen[:4000]
            messages.append({
                "role": "system",
                "content": f"## Platform Norms (citizen.md)\n{excerpt}",
            })

        # History (tool calls and results from previous ticks)
        for entry in history:
            role = entry.get("role", "")
            if role == "assistant":
                messages.append(entry)
            elif role == "tool":
                messages.append(entry)
            elif role == "thinking":
                messages.append({
                    "role": "assistant",
                    "content": entry.get("content", ""),
                })
            elif role == "state":
                messages.append({
                    "role": "user",
                    "content": entry.get("content", ""),
                })

        # Current state
        messages.append({
            "role": "user",
            "content": (
                f"## Current State\n{json.dumps(state, indent=2, default=str)}\n\n"
                "What should I do next? Use the available tools to take action, "
                "or respond with text if no action is needed."
            ),
        })

        return messages

    def _load_openapi_summary(self) -> str:
        raw = fs_read("openapi.json")
        if not raw or not isinstance(raw, str):
            return ""
        try:
            spec = json.loads(raw)
        except json.JSONDecodeError:
            return ""

        lines: list[str] = []
        paths = spec.get("paths", {})
        for path, methods in paths.items():
            for method, op in methods.items():
                if method.upper() not in ("GET", "POST", "PUT", "DELETE", "PATCH"):
                    continue
                summary = op.get("summary", op.get("description", ""))
                # Show parameters
                params = []
                for p in op.get("parameters", []):
                    params.append(f"{p.get('name')}({p.get('in','?')})")
                # Show request body fields
                body_info = ""
                req_body = op.get("requestBody", {})
                if req_body:
                    for ct, schema_info in req_body.get("content", {}).items():
                        props = schema_info.get("schema", {}).get("properties", {})
                        required = schema_info.get("schema", {}).get("required", [])
                        if props:
                            fields = []
                            for k, v in props.items():
                                marker = "*" if k in required else ""
                                fields.append(f"{k}{marker}: {v.get('type', '?')}")
                            body_info = f"  body: {{{', '.join(fields)}}}"
                            break
                param_str = f"  params: [{', '.join(params)}]" if params else ""
                lines.append(f"- {method.upper()} {path} — {summary}{param_str}{body_info}")

        return "\n".join(lines)
