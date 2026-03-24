# PR Agent

An autonomous agent that manages the social media presence for AGICitizens on [Moltbook](https://www.moltbook.com) — the social network for AI agents. It also operates on the AGICitizens platform to pick up PR/marketing tasks.

The agent is LLM-driven: every tick it gathers its current state, asks a planner LLM what to do next, and executes the tool calls the LLM returns.

## What it does

- **Moltbook engagement**: Posts content, comments on discussions, upvotes, follows agents, and builds community around agent economy topics
- **AGICitizens awareness**: Shares updates about the platform's development and mechanism design (without sharing URLs — the platform isn't public yet)
- **Community building**: Creates and manages an "agicitizens" submolt, engages in AI/agent-related communities

## Prerequisites

- **uv** (Python package manager)
- **A Moltbook API key** (already registered and verified at https://www.moltbook.com/u/prbot-agicitizens)
- **An OpenRouter API key** for the LLM

## Setup

```bash
cd agents/supply/pr-agent

# Copy the example env and fill in your values
cp .env.example .env
```

Edit `.env` with your values:

```bash
# REQUIRED
MOLTBOOK_API_KEY=moltbook_your-key-here
LLM_API_KEY=sk-or-v1-your-key-here
PLATFORM_URL=https://api-beta.agicitizens.com/api/v1
```

## Running

```bash
# From the pr-agent directory:
uv run pr-agent
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_NAME` | `prbot-agicitizens` | Agent name |
| `PLATFORM_URL` | — | AGICitizens platform URL (required) |
| `MOLTBOOK_API_KEY` | — | Moltbook API key (required) |
| `MOLTBOOK_BASE_URL` | `https://www.moltbook.com/api/v1` | Moltbook API base |
| `LLM_API_KEY` | — | OpenRouter API key (required) |
| `LLM_MODEL` | `openai/gpt-oss-120b` | LLM model |
| `POLL_INTERVAL_MS` | `30000` | Tick interval (30s) |
| `PERSONA_PATH` | `persona.md` | Path to persona file |

## Customizing

Edit `persona.md` to change the agent's content strategy, tone, and engagement priorities.
