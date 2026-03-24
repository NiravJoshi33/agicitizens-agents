"""Shared LLM planner — uses OpenAI-compatible tool calling.

Each agent provides its own SYSTEM_PROMPT and TOOLS list.
The Planner handles LLM communication, history building, and tool call parsing.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageToolCall
from pathlib import Path

from agic_core.config import settings
from agic_core.tools.storage import fs_read

logger = logging.getLogger(__name__)


class ToolCall:
    """Represents a tool call the LLM wants to make."""

    def __init__(self, id: str, name: str, arguments: dict[str, Any]) -> None:
        self.id = id
        self.name = name
        self.arguments = arguments

    @classmethod
    def from_openai(cls, tc: ChatCompletionMessageToolCall) -> "ToolCall":
        args_str = tc.function.arguments or "{}"
        try:
            arguments = json.loads(args_str)
        except (json.JSONDecodeError, TypeError):
            arguments = {}
        return cls(id=tc.id, name=tc.function.name, arguments=arguments)


# Type for functions that return extra system messages: list of (title, content)
ExtraDocsProvider = Callable[[], list[tuple[str, str]]]


class Planner:
    """LLM-backed planner using native tool calling.

    Parameters
    ----------
    system_prompt : str
        Agent-specific system prompt (injected after persona).
    tools : list[dict]
        OpenAI function-calling tool definitions.
    extra_docs_provider : ExtraDocsProvider | None
        Optional callable returning extra (title, content) pairs to inject
        as system messages (e.g. Moltbook skill.md).
    """

    def __init__(
        self,
        system_prompt: str,
        tools: list[dict[str, Any]],
        extra_docs_provider: ExtraDocsProvider | None = None,
    ) -> None:
        self._client = AsyncOpenAI(
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
        )
        self._model = settings.llm_model
        self._system_prompt = system_prompt
        self._tools = tools
        self._extra_docs_provider = extra_docs_provider

    async def decide(
        self,
        state: dict[str, Any],
        history: list[dict[str, Any]],
    ) -> tuple[str, list[ToolCall]]:
        messages = self._build_messages(state, history)
        logger.debug("Planner messages: %d", len(messages))

        response = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            tools=self._tools,
            tool_choice="auto",
            temperature=0.4,
        )

        if not response.choices:
            logger.warning("LLM returned empty choices")
            return "", []

        msg = response.choices[0].message
        if msg is None:
            logger.warning("LLM returned None message")
            return "", []

        thinking = msg.content or ""
        tool_calls: list[ToolCall] = []
        if msg.tool_calls:
            for tc in msg.tool_calls:
                try:
                    tool_calls.append(ToolCall.from_openai(tc))
                except Exception as exc:
                    logger.warning("Skipping malformed tool call: %s", exc)

        return thinking, tool_calls

    def _load_persona(self) -> str:
        p = Path(settings.persona_path)
        if p.exists():
            return p.read_text(encoding="utf-8").strip()
        cached = fs_read("persona.md")
        if cached and isinstance(cached, str):
            return cached.strip()
        return ""

    def _build_messages(
        self,
        state: dict[str, Any],
        history: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        persona = self._load_persona()
        system_content = ""
        if persona:
            system_content = f"## Your Persona & Mission\n{persona}\n\n"
        system_content += self._system_prompt

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_content},
        ]

        # OpenAPI spec summary
        openapi_text = self._load_openapi_summary()
        if openapi_text:
            messages.append({
                "role": "system",
                "content": f"## Available API Endpoints (from OpenAPI spec)\n{openapi_text}",
            })

        # citizen.md
        citizen = fs_read("citizen.md")
        if citizen and isinstance(citizen, str):
            excerpt = citizen[:1500]
            messages.append({
                "role": "system",
                "content": (
                    f"## Platform Norms (citizen.md — first 1500 chars)\n{excerpt}\n\n"
                    "**Note:** Use the `search_docs` tool to look up specific topics."
                ),
            })

        # Agent-specific extra docs
        if self._extra_docs_provider:
            for title, content in self._extra_docs_provider():
                messages.append({"role": "system", "content": f"## {title}\n{content}"})

        # History
        for entry in history:
            role = entry.get("role", "")
            if role == "assistant":
                messages.append(entry)
            elif role == "tool":
                messages.append(entry)
            elif role == "thinking":
                messages.append({"role": "assistant", "content": entry.get("content", "")})
            elif role == "state":
                messages.append({"role": "user", "content": entry.get("content", "")})

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
                params = []
                for p in op.get("parameters", []):
                    params.append(f"{p.get('name')}({p.get('in','?')})")
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
