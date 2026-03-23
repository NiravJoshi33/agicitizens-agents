# Crypto Research AI Agent

AI-powered crypto research agent built on [AGICitizens](https://api-beta.agicitizens.com) — an agent-native task economy on Solana. Fetches live market data, DeFi analytics, and runs LLM analysis to deliver structured research output.

## How It Works

```
Query → CoinGecko (market data) → DeFiLlama (DeFi/TVL) → LLM Analysis → Structured Output
```

The agent collects real-time data from multiple sources, feeds it to an LLM for analysis, and returns a structured research report with risk scoring, sentiment analysis, and key findings.

### Data Sources

- **CoinGecko** — token search, price, market cap, volume, 24h change
- **DeFiLlama** — DeFi protocol TVL and exposure
- **OpenRouter LLM** — risk scoring, sentiment analysis, key findings

### Research Output

```json
{
  "token": "solana",
  "summary": "...",
  "risk_score": 3,
  "market_data": { "price": 150.2, "market_cap": "$75.2B", "volume_24h": "$3.1B", "price_change_24h": "2.45%" },
  "defi_exposure": [{ "protocol": "Raydium", "tvl": "$1.2B" }],
  "sentiment": "bullish",
  "key_findings": ["...", "..."],
  "sources": ["coingecko.com", "defillama.com", "openrouter.ai (LLM analysis)"],
  "generated_at": "2026-03-23T..."
}
```

## Quick Start

### Prerequisites

- Node.js 18+
- An [OpenRouter](https://openrouter.ai) API key

### Setup

```bash
git clone <repo-url>
cd research-ai-agent
npm install
```

Create `.env` at root (or `.env.local` for the UI):

```
OPENROUTER_API_KEY=sk-or-v1-your-key-here
LLM_MODEL=openai/gpt-oss-120b
```

## Usage

### 1. Web UI

```bash
npm run dev
```

Open http://localhost:3050 — enter a token/protocol name, select chain and depth, hit Research.

### 2. CLI (Standalone Research)

```bash
npm run research "solana"
npm run research "bitcoin" deep
npm run research "uniswap" quick
```

Runs research directly from terminal and prints the output. No platform connection needed.

### 3. Platform Agent (AGICitizens)

```bash
npm run agent
```

Connects to the AGICitizens platform as an autonomous agent:

- Registers as `researchbot.agicitizens` (pays $1 USDC on Solana devnet)
- Sends heartbeats every 55s to stay online
- Polls for `research` category tasks every 20s
- Accepts tasks, runs research, delivers output
- Gets paid in USDC when a judge verifies the output

Requires additional `.env` vars for platform mode:

```
AGICITIZENS_API_URL=https://api-beta.agicitizens.com/api/v1
SERVER_WALLET_KEYPAIR=[...solana keypair bytes...]
```

## Project Structure

```
research-ai-agent/
├── agent/
│   ├── bot.ts             # AgentClient, research logic, data fetchers, Solana payment
│   ├── index.ts           # Platform agent: register, heartbeat, poll, accept, deliver
│   └── research.ts        # Standalone CLI for direct research
├── app/
│   ├── api/research/
│   │   └── route.ts       # Next.js API route (POST /api/research)
│   ├── globals.css         # Dark theme styles
│   ├── layout.tsx          # Root layout
│   └── page.tsx            # Web UI: search form + results dashboard
├── package.json
├── next.config.mjs
├── tailwind.config.ts
└── tsconfig.json
```

## Research Depth Levels

| Depth | CoinGecko | DeFiLlama | LLM Analysis |
|-------|-----------|-----------|--------------|
| Quick | Yes | No | Yes |
| Standard | Yes | Yes | Yes |
| Deep | Yes | Yes | Yes |

## Platform Agent Lifecycle

```
Startup
  ├─ Load saved state (.researchbot-state.json)
  ├─ Registration (first run only)
  │   ├─ Get X402 payment info
  │   ├─ Request faucet (SOL + USDC on devnet)
  │   ├─ Transfer 1 USDC to platform
  │   └─ Save API key
  ├─ Heartbeat (every 55s)
  └─ Poll Loop (every 20s)
      ├─ GET /tasks?status=OPEN&category=research
      ├─ Accept → Research → Deliver
      └─ Judge verifies → USDC released from escrow
```

## Task Lifecycle on AGICitizens

```
OPEN → accept → IN_PROGRESS → deliver → DELIVERED → judge verifies → COMPLETED
```

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **UI**: Next.js 14, Tailwind CSS
- **Blockchain**: Solana devnet (USDC payments, X402 protocol)
- **APIs**: CoinGecko, DeFiLlama, OpenRouter
- **Platform**: AGICitizens agent economy

## License

ISC
