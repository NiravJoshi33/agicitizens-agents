"""Task Creator Agent — NanoClaw-style (Anthropic API + shell tools).

Claude reads CLAUDE.md as its system prompt, then autonomously:
1. Fetches platform docs
2. Registers itself
3. Discovers workers and creates tasks for them

This captures the NanoClaw pattern: Claude in a container with tool use,
figuring everything out from docs alone.
"""

import asyncio
import json
import logging
import os
import subprocess
from pathlib import Path

import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
TOOLS_DIR = Path(__file__).parent / "tools"


def load_system_prompt() -> str:
    """Load CLAUDE.md and inject the platform URL."""
    claude_md = (Path(__file__).parent / "CLAUDE.md").read_text()
    platform_url = os.environ.get(
        "PLATFORM_URL", "https://api-beta.agicitizens.com/api/v1"
    )
    return claude_md.replace("{PLATFORM_URL}", platform_url)


# Tool definitions for Claude's tool use
TOOLS = [
    {
        "name": "bash",
        "description": "Execute a bash command in the container. Use this for: curl to fetch docs/APIs, python scripts in /app/tools/, file operations, etc.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute",
                }
            },
            "required": ["command"],
        },
    },
    {
        "name": "save_file",
        "description": "Save content to a file path.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to write to"},
                "content": {"type": "string", "description": "Content to write"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "read_file",
        "description": "Read content from a file path.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to read"},
            },
            "required": ["path"],
        },
    },
]


def execute_bash(command: str) -> str:
    """Execute a bash command and return output."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=120,
            cwd="/app",
        )
        output = result.stdout
        if result.stderr:
            output += f"\nSTDERR: {result.stderr}"
        if result.returncode != 0:
            output += f"\nExit code: {result.returncode}"
        return output[:10000]  # cap output length
    except subprocess.TimeoutExpired:
        return "ERROR: Command timed out after 120 seconds"
    except Exception as e:
        return f"ERROR: {e}"


def execute_tool(name: str, input_data: dict) -> str:
    """Execute a tool and return the result."""
    if name == "bash":
        return execute_bash(input_data["command"])
    elif name == "save_file":
        path = Path(input_data["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(input_data["content"])
        return f"Saved to {path}"
    elif name == "read_file":
        path = Path(input_data["path"])
        if not path.exists():
            return f"ERROR: File not found: {path}"
        return path.read_text()[:10000]
    return f"ERROR: Unknown tool: {name}"


async def run_agent():
    """Run the Claude-powered task creator in an autonomous loop."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        log.error("ANTHROPIC_API_KEY not set")
        return

    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
    system_prompt = load_system_prompt()

    # Emit boot event
    execute_bash(
        "python /app/src/agents/task_creator/tools/emit_event.py BOOT "
        "'{\"agent_name\": \"task-creator-001\", \"framework\": \"nanoclaw\"}'"
    )

    messages = [
        {
            "role": "user",
            "content": (
                "You are now live. Your PLATFORM_URL is set in the environment. "
                "Start by reading the platform docs, registering yourself, then "
                "begin your task creation loop. Use the bash tool for all operations. "
                "Remember to emit events for the dashboard, maintain heartbeat, "
                "and persist your API key."
            ),
        }
    ]

    # Autonomous agentic loop — Claude keeps acting until it decides to wait
    while True:
        try:
            async with httpx.AsyncClient(timeout=300) as client:
                resp = await client.post(
                    ANTHROPIC_API_URL,
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": model,
                        "max_tokens": 4096,
                        "system": system_prompt,
                        "tools": TOOLS,
                        "messages": messages,
                    },
                )
                resp.raise_for_status()
                response = resp.json()

            # Process the response
            assistant_content = response["content"]
            stop_reason = response.get("stop_reason", "end_turn")

            # Add assistant message to history
            messages.append({"role": "assistant", "content": assistant_content})

            # Handle tool use
            if stop_reason == "tool_use":
                tool_results = []
                for block in assistant_content:
                    if block["type"] == "tool_use":
                        log.info("Tool call: %s(%s)", block["name"], block["id"])

                        # Emit action event
                        action_data = json.dumps({
                            "action": block["name"],
                            "input_summary": str(block["input"])[:200],
                        })
                        execute_bash(
                            f"python /app/src/agents/task_creator/tools/emit_event.py ACTION '{action_data}'"
                        )

                        result = execute_tool(block["name"], block["input"])
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block["id"],
                            "content": result,
                        })

                        # Emit observation
                        obs_data = json.dumps({"result_summary": result[:200]})
                        execute_bash(
                            f"python /app/src/agents/task_creator/tools/emit_event.py OBSERVATION '{obs_data}'"
                        )

                messages.append({"role": "user", "content": tool_results})

            elif stop_reason == "end_turn":
                # Claude decided to pause — extract any text for logging
                for block in assistant_content:
                    if block["type"] == "text" and block["text"]:
                        log.info("Claude: %s", block["text"][:500])

                # Wait before next iteration (Claude will manage its own timing
                # via sleep commands in bash, but we add a floor)
                await asyncio.sleep(30)

                # Prompt next action
                messages.append({
                    "role": "user",
                    "content": (
                        "Continue your task creation loop. Check for task updates, "
                        "create new tasks if appropriate, and maintain your heartbeat."
                    ),
                })

            # Keep conversation history manageable
            if len(messages) > 40:
                # Keep system context + last 20 messages
                messages = messages[:1] + messages[-20:]

        except httpx.HTTPStatusError as e:
            log.error("API error: %s %s", e.response.status_code, e.response.text[:500])
            await asyncio.sleep(60)
        except Exception as e:
            log.exception("Agent loop error: %s", e)
            err_data = json.dumps({"error": str(e)[:200]})
            execute_bash(
                f"python /app/src/agents/task_creator/tools/emit_event.py ERROR '{err_data}'"
            )
            await asyncio.sleep(60)


if __name__ == "__main__":
    asyncio.run(run_agent())
