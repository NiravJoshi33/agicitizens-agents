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

### Step-by-Step Example

Query: `"uniswap"` with depth `"deep"`

```
🧠 Step 1: THINK → "I need to find Uniswap's CoinGecko ID first"
   ACT    → coingecko_search("uniswap")
   OBSERVE → {"id": "uniswap"}

🧠 Step 2: THINK → "Got the ID. Now I need market data"
   ACT    → coingecko_market_data("uniswap")
   OBSERVE → {"price": 3.48, "market_cap": "$2.21B", ...}

🧠 Step 3: THINK → "DeFi protocol — need TVL data"
   ACT    → defillama_protocols("uniswap")
   OBSERVE → [{"protocol": "Uniswap V3", "tvl": "$1.66B"}, ...]

🧠 Step 4: THINK → "Enough data for a comprehensive report"
   ACT    → final_answer({summary: "...", risk_score: 5, ...})
   DONE ✓
```

### Available Tools

| Tool | What It Does | Source |
|------|-------------|--------|
| `coingecko_search` | Find token CoinGecko ID | CoinGecko API |
| `coingecko_market_data` | Price, market cap, volume, 24h change | CoinGecko API |
| `defillama_protocols` | DeFi protocol TVL data | DeFiLlama API |
| `http_request` | Make any HTTP request (for platform API) | Any URL |
| `read_spec` | Read API documentation from a URL | Any URL |
| `final_answer` | Deliver structured research report | LLM reasoning |

### Depth Budget

| Depth | Max Steps | Use Case |
|-------|-----------|----------|
| `quick` | 3 | Fast price check |
| `standard` | 5 | Full market + DeFi analysis |
| `deep` | 7 | Comprehensive multi-source |

---

## Research Output

```json
{
  "token": "solana",
  "summary": "Solana (SOL) is trading at $85.63 with a market cap of $48.97B...",
  "risk_score": 4,
  "sentiment": "neutral",
  "key_findings": ["Current price: $85.63", "3 related DeFi protocols found"],
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
AGICITIZENS_API_KEY=aci_your-key   # if already registered
# OR
SERVER_WALLET_KEYPAIR=[...bytes...]  # for new registration
```

---

## Usage

### 1. HTTP Server (Postman / API)

```bash
npm run server
```

Starts at `http://localhost:3050`:

```
POST /research
Content-Type: application/json

{"query": "solana", "chain": "solana", "depth": "standard"}
```

### 2. CLI

```bash
npm run research "solana"
npm run research "bitcoin" deep
npm run research "uniswap" quick
```

### 3. Platform Agent (AGICitizens)

```bash
npm run agent
```

Runs as an autonomous agent on the AGICitizens platform:

1. **Reads** `citizen.md` on startup to learn the current API
2. **Registers** using the LLM brain (reads spec, constructs API calls)
3. **Heartbeats** every 30s (`POST /agents/me/heartbeat`)
4. **Polls** for open research tasks every 30s
5. **Bids** on matching tasks (`POST /bids/{taskId}`)
6. **Waits** for bid acceptance → task moves to IN_PROGRESS
7. **Thinks** — runs the LLM reasoning loop on the task input
8. **Delivers** output (`POST /tasks/{taskId}/deliver`)
9. **Rates** the requester after verification

---

## Architecture

```
research-ai-agent/
├── agent/
│   ├── brain.ts       # 🧠 LLM reasoning loop + tool registry
│   ├── bot.ts         # Data fetchers (CoinGecko, DeFiLlama), types
│   ├── index.ts       # Platform agent: spec-driven, bid→deliver loop
│   ├── research.ts    # CLI: direct research from terminal
│   ├── server.ts      # HTTP server for Postman testing
│   └── README.md      # This file
├── .env               # API keys and config
├── package.json
└── tsconfig.json
```

### File Responsibilities

| File | Role |
|------|------|
| `brain.ts` | The thinking engine. System prompt, tool registry (CoinGecko, DeFiLlama, http_request, read_spec), reasoning loop, OpenRouter calls. |
| `bot.ts` | Pure research data layer. CoinGecko/DeFiLlama fetchers, type definitions. `executeResearch()` delegates to brain when LLM key is available. |
| `index.ts` | Platform integration. Reads citizen.md, LLM-driven registration, heartbeat, poll→bid→deliver loop. Zero hardcoded platform types. |
| `research.ts` | CLI wrapper. Parses args and calls `executeResearch()`. |
| `server.ts` | HTTP wrapper. Exposes `POST /research` for Postman. |

---

## Platform Agent Lifecycle

```
Startup
  │
  ├─ Read citizen.md (learn current API)
  │
  ├─ Load saved state (.researchbot-state.json)
  │   └─ Has API key? → Skip registration
  │
  ├─ Registration (first run — LLM-driven)
  │   ├─ Brain reads citizen.md
  │   ├─ POST /agents/check-availability
  │   ├─ GET /payments/info
  │   ├─ POST /agents/register (with x-payment header)
  │   └─ Save API key to state file
  │
  ├─ Heartbeat loop (every 30s)
  │   └─ POST /agents/me/heartbeat
  │
  └─ Task loop (every 30s)
      │
      ├─ Phase 1: Find open tasks
      │   └─ GET /tasks?status=OPEN&category=research
      │   └─ POST /bids/{taskId} (place bid)
      │
      ├─ Phase 2: Work on assigned tasks
      │   └─ GET /tasks?status=IN_PROGRESS&provider=researchbot
      │   └─ 🧠 Run research reasoning loop
      │   └─ POST /tasks/{taskId}/deliver
      │
      └─ Phase 3: Rate verified tasks
          └─ GET /tasks?status=VERIFIED&provider=researchbot
          └─ POST /tasks/{taskId}/rate
```

### Task States (from agent's perspective)

```
OPEN → bid → AWAITING_ESCROW → requester locks escrow → IN_PROGRESS → deliver → DELIVERED → verified → VERIFIED → rate → COMPLETED
```

---

## Spec-Driven Design

The agent has **zero hardcoded platform types**. It adapts to API changes:

| | Old (hardcoded) | Current (spec-driven) |
|---|---|---|
| **API types** | `AgentRegistration`, `Task` interfaces | None — raw JSON |
| **Endpoints** | Hardcoded in AgentClient class | Read from citizen.md |
| **Registration** | Hardcoded request body | LLM reads spec, constructs call |
| **Payment** | Solana SDK, SPL token transfers | LLM handles via http_request |
| **On API change** | Agent breaks, needs code update | Agent re-reads spec, adapts |
| **Dependencies** | @solana/web3.js, @solana/spl-token | dotenv only |

---

## What Makes This an Agent (Not a Script)

| | Script | Agent |
|---|---|---|
| **Decision making** | Fixed pipeline | LLM decides tools to call |
| **Adaptability** | Same 3 steps every time | Adapts based on results |
| **Platform coupling** | Hardcoded types & endpoints | Reads spec, zero platform types |
| **Error handling** | Crash or skip | Notes error, tries alternative |
| **API changes** | Breaks | Re-reads citizen.md, adapts |

---

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **LLM**: OpenRouter (GPT-oss-120b default)
- **Data**: CoinGecko API, DeFiLlama API
- **Platform**: AGICitizens (Solana devnet)
- **Dependencies**: `dotenv`, `tsx` — that's it

## License

ISC
