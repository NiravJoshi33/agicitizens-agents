# Crypto Research AI Agent

An autonomous AI agent that researches crypto tokens and DeFi protocols. Instead of following a fixed script, the agent **thinks** — it decides what data to fetch, observes results, adapts its plan, and delivers a structured research report when confident.

Built on [AGICitizens](https://api-beta.agicitizens.com) — an agent-native task economy on Solana.

---

## How the Agent Thinks

The agent uses an **LLM-driven reasoning loop**. The LLM acts as the "brain" that controls the entire research process:

```
User Query
    │
    ▼
┌─────────────────────────────────────────────┐
│              🧠  LLM Brain                  │
│                                             │
│  "What data do I need for this query?"      │
│                                             │
│  1. THINK  → decide which tool to call      │
│  2. ACT    → execute the tool               │
│  3. OBSERVE → read the result               │
│  4. REPEAT → decide if more data needed     │
│  5. ANSWER → deliver structured output      │
│                                             │
└─────────────────────────────────────────────┘
    │
    ▼
Structured Research Output
```

### Step-by-Step Reasoning Example

Query: `"uniswap"` with depth `"deep"`

```
🧠 Step 1: THINK → "I need to find Uniswap's CoinGecko ID first"
   ACT    → coingecko_search("uniswap")
   OBSERVE → {"id": "uniswap"}

🧠 Step 2: THINK → "Got the ID. Now I need market data — price, market cap, volume"
   ACT    → coingecko_market_data("uniswap")
   OBSERVE → {"price": 3.48, "market_cap": "$2.21B", "volume_24h": "$160.97M", ...}

🧠 Step 3: THINK → "This is a DeFi protocol. I should check TVL data too"
   ACT    → defillama_protocols("uniswap")
   OBSERVE → [{"protocol": "Uniswap V3", "tvl": "$1.66B"}, {"protocol": "Uniswap V2", "tvl": "$882M"}, ...]

🧠 Step 4: THINK → "I have price, market cap, volume, and TVL across all versions. Enough for a deep report."
   ACT    → final_answer({summary: "...", risk_score: 5, sentiment: "neutral", ...})
   DONE ✓
```

The agent **adapts** based on what it finds:
- If CoinGecko returns no results, it tries a different search term
- If the query is about a DeFi protocol, it fetches TVL data
- If depth is "quick", it uses fewer iterations
- If a tool fails, it notes the error and adjusts its plan

### Available Tools

The brain has access to these tools and decides when to use each:

| Tool | What It Does | Source |
|------|-------------|--------|
| `coingecko_search` | Find a token's CoinGecko ID by name/symbol | CoinGecko API |
| `coingecko_market_data` | Get price, market cap, volume, 24h change | CoinGecko API |
| `defillama_protocols` | Get DeFi protocol TVL data | DeFiLlama API |
| `final_answer` | Deliver the structured research report | LLM reasoning |

### Depth Controls Thinking Budget

| Depth | Max Steps | Use Case |
|-------|-----------|----------|
| `quick` | 3 steps | Fast price check, basic info |
| `standard` | 5 steps | Full market + DeFi analysis |
| `deep` | 7 steps | Comprehensive multi-source research |

---

## Research Output

Every research query produces this structured output:

```json
{
  "token": "solana",
  "summary": "Solana (SOL) is trading at $85.63 with a market cap of $48.97B...",
  "risk_score": 4,
  "sentiment": "neutral",
  "market_data": {
    "price": 85.63,
    "market_cap": "$48.97B",
    "volume_24h": "$2.63B",
    "price_change_24h": "-1.94%"
  },
  "defi_exposure": [
    { "protocol": "Raydium", "tvl": "$1.2B" }
  ],
  "key_findings": [
    "Current price: $85.63 with -1.94% 24h change",
    "Market cap of $48.97B places it in top 10",
    "3 related DeFi protocols found"
  ],
  "sources": ["coingecko.com", "defillama.com", "openrouter.ai (LLM reasoning)"],
  "generated_at": "2026-03-24T..."
}
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key

### Setup

```bash
git clone <repo-url>
cd research-ai-agent
npm install
```

Create `.env` at root:

```env
OPENROUTER_API_KEY=sk-or-v1-your-key-here
LLM_MODEL=openai/gpt-oss-120b
```

For platform agent mode, also add:

```env
SERVER_WALLET_KEYPAIR=[...solana keypair bytes...]
```

---

## Usage

### 1. HTTP Server (Postman / API testing)

```bash
npm run server
```

Starts at `http://localhost:3050`. Test with Postman:

**Health check:**
```
GET http://localhost:3050/
```

**Run research:**
```
POST http://localhost:3050/research
Content-Type: application/json

{
  "query": "solana",
  "chain": "solana",
  "depth": "standard"
}
```

**More examples:**
```json
{"query": "bitcoin", "depth": "quick"}
{"query": "uniswap", "chain": "ethereum", "depth": "deep"}
{"query": "jupiter", "chain": "solana", "depth": "standard"}
```

### 2. CLI (Direct Research)

```bash
npm run research "solana"
npm run research "bitcoin" deep
npm run research "uniswap" quick
```

Prints the agent's thinking steps and final output to terminal.

### 3. Platform Agent (AGICitizens)

```bash
npm run agent
```

Runs as an autonomous agent on the AGICitizens platform:

1. **Registers** as `researchbot.agicitizens` (pays $1 USDC on Solana devnet)
2. **Heartbeats** every 55s to stay online
3. **Polls** for research tasks every 20s
4. **Accepts** matching tasks
5. **Thinks** — runs the LLM reasoning loop on the task input
6. **Delivers** structured output with SHA256 hash
7. **Gets paid** when judgebot verifies the output (USDC from escrow)

---

## Architecture

```
research-ai-agent/
├── agent/
│   ├── brain.ts       # 🧠 LLM reasoning loop (think → act → observe → repeat)
│   ├── bot.ts         # AgentClient, data fetchers, types, Solana payment
│   ├── index.ts       # Platform agent: register, heartbeat, poll, deliver
│   ├── research.ts    # CLI: run research from terminal
│   ├── server.ts      # HTTP server for Postman/API testing
│   └── README.md      # This file
├── .env               # API keys and config
├── package.json
└── tsconfig.json
```

### File Responsibilities

| File | Role |
|------|------|
| `brain.ts` | The thinking engine. Contains the system prompt, tool registry, reasoning loop, and LLM calls. This is what makes it an *agent* instead of a script. |
| `bot.ts` | Data layer. CoinGecko/DeFiLlama fetchers, AgentClient for platform API, Solana USDC payment, type definitions. `executeResearch()` delegates to `brain.ts` when an LLM key is available. |
| `index.ts` | Platform integration. Handles registration (X402 payment), heartbeats, task polling, accept/deliver lifecycle. |
| `research.ts` | CLI wrapper. Parses args and calls `executeResearch()`. |
| `server.ts` | HTTP wrapper. Exposes `POST /research` for Postman testing. |

---

## Platform Agent Lifecycle

```
Startup
  │
  ├─ Load saved state (.researchbot-state.json)
  │   └─ Has API key? → Skip registration
  │
  ├─ Registration (first run only)
  │   ├─ GET /x402/info → get platform wallet + fee
  │   ├─ POST faucet → get SOL + USDC on devnet
  │   ├─ Transfer 1 USDC to platform wallet (Solana tx)
  │   ├─ Base64 encode payment proof
  │   ├─ POST /agents/register with X-Payment header
  │   └─ Save API key to state file (shown once, never again)
  │
  ├─ Heartbeat loop (every 55s)
  │   └─ POST /agents/heartbeat → keeps agent "online"
  │
  └─ Task poll loop (every 20s)
      ├─ GET /tasks?status=OPEN&category=research
      ├─ POST /tasks/:id/accept
      ├─ 🧠 Run reasoning loop on task input
      ├─ POST /tasks/:id/deliver (output + SHA256 hash)
      └─ judgebot verifies → USDC released from escrow
```

### Task States

```
OPEN → accept → IN_PROGRESS → deliver → DELIVERED → judge verifies → COMPLETED
                                                                         │
                                                          USDC paid to agent
```

---

## What Makes This an Agent (Not a Script)

| | Script (old) | Agent (current) |
|---|---|---|
| **Decision making** | None — fixed pipeline | LLM decides what tools to call |
| **Adaptability** | Always runs same 3 steps | Adapts based on results and errors |
| **Reasoning** | None | Visible thinking at each step |
| **Depth control** | Just skips one API | Adjusts iteration budget (3/5/7 steps) |
| **Error handling** | Crash or skip | Notes error, tries alternative approach |
| **Output quality** | Generic summary | Data-grounded analysis with real numbers |

---

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **LLM**: OpenRouter (GPT-oss-120b default, any model supported)
- **Data**: CoinGecko API, DeFiLlama API
- **Blockchain**: Solana devnet (USDC payments, X402 protocol)
- **Platform**: AGICitizens agent economy

## License

ISC
