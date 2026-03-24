/**
 * brain.ts — LLM-driven reasoning engine for the research agent.
 *
 * Instead of a fixed pipeline, the LLM acts as a "brain" that:
 *   1. Receives a query
 *   2. Decides which tool to call
 *   3. Observes the result
 *   4. Decides next action
 *   5. Repeats until confident
 *   6. Delivers structured output
 */

import {
  fetchCoinGeckoSearch,
  fetchCoinGeckoData,
  fetchDefiLlamaData,
} from "./bot";
import type { ResearchOutput } from "./bot";

// ── Types ───────────────────────────────────────────────────

interface AgentAction {
  reasoning: string;
  tool: string;
  input: Record<string, string>;
}

interface AgentStep {
  action: AgentAction;
  observation: string;
}

export interface BrainConfig {
  apiKey: string;
  model?: string;
  maxIterations?: number;
}

type ToolFn = (input: Record<string, string>) => Promise<string>;

// ── Tool Registry ───────────────────────────────────────────

const tools: Map<string, ToolFn> = new Map();

tools.set("coingecko_search", async (input) => {
  const query = input.query;
  if (!query) return "Error: missing 'query' parameter";
  const result = await fetchCoinGeckoSearch(query);
  return result ? JSON.stringify({ id: result }) : "No results found.";
});

tools.set("coingecko_market_data", async (input) => {
  const tokenId = input.token_id;
  if (!tokenId) return "Error: missing 'token_id' parameter";
  const result = await fetchCoinGeckoData(tokenId);
  return result ? JSON.stringify(result) : "No market data available for this token.";
});

tools.set("defillama_protocols", async (input) => {
  const protocol = input.protocol;
  if (!protocol) return "Error: missing 'protocol' parameter";
  const result = await fetchDefiLlamaData(protocol);
  return result.length > 0
    ? JSON.stringify(result)
    : "No DeFi protocols found matching this query.";
});

tools.set("http_request", async (input) => {
  const { method = "GET", url, body, headers: rawHeaders } = input;
  if (!url) return "Error: missing 'url' parameter";

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (rawHeaders) {
      try { Object.assign(headers, JSON.parse(rawHeaders)); } catch {}
    }

    const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) };
    if (body && method !== "GET") opts.body = body;

    const res = await fetch(url, opts);
    const text = await res.text();

    // Truncate large responses
    const truncated = text.length > 3000 ? text.slice(0, 3000) + "\n...(truncated)" : text;
    return `HTTP ${res.status}\n${truncated}`;
  } catch (err: any) {
    return `HTTP request failed: ${err.message}`;
  }
});

tools.set("read_spec", async (input) => {
  const { url } = input;
  if (!url) return "Error: missing 'url' parameter";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    return text.length > 5000 ? text.slice(0, 5000) + "\n...(truncated)" : text;
  } catch (err: any) {
    return `Failed to read spec: ${err.message}`;
  }
});

// ── System Prompt ───────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous crypto research agent. You THINK about what data you need, then ACT by calling tools, then OBSERVE results, and REPEAT until you have enough information.

## Available Tools

1. coingecko_search
   Search CoinGecko for a token/coin by name or symbol. Returns the CoinGecko ID.
   Parameters: {"query": "token name or symbol, e.g. 'solana' or 'btc'"}

2. coingecko_market_data
   Get detailed market data for a token by its CoinGecko ID. Returns price, market cap, volume, and 24h change.
   Parameters: {"token_id": "CoinGecko ID from coingecko_search, e.g. 'solana'"}

3. defillama_protocols
   Search DeFi protocols by name. Returns TVL data for matching protocols.
   Parameters: {"protocol": "protocol name to search, e.g. 'uniswap'"}

4. http_request
   Make any HTTP request. Use this to interact with any API.
   Parameters: {"method": "GET|POST|PUT|PATCH|DELETE", "url": "full URL", "body": "JSON string (optional)", "headers": "JSON string of extra headers (optional)"}

5. read_spec
   Read an API specification or documentation from a URL. Use this to learn how an unfamiliar API works before calling it.
   Parameters: {"url": "URL to the spec/docs, e.g. 'https://api.example.com/docs'"}

6. final_answer
   Call this ONLY when you have gathered enough data and are ready to deliver your research report.
   Parameters: {
     "token": "token identifier",
     "summary": "2-3 sentence factual overview based on data you collected",
     "risk_score": "integer 1-10 (1=lowest risk, 10=highest)",
     "sentiment": "very_bearish|bearish|neutral|bullish|very_bullish",
     "key_findings": "JSON array of 3-5 key findings as strings"
   }

## Rules
- Respond with EXACTLY one JSON object per turn: {"reasoning": "your thought process", "tool": "tool_name", "input": {...}}
- THINK before acting: explain in "reasoning" why you chose this tool and what you expect to learn
- Use REAL data from tool results. NEVER fabricate prices, market caps, or TVL numbers.
- If a tool returns an error or no data, adapt your plan — try a different approach or move on.
- Call final_answer once you have sufficient data. Do not over-gather.
- Your final summary must reference actual numbers from the tools, not made-up values.
- When interacting with an unfamiliar API, use read_spec first to learn the endpoints, then use http_request to call them.`;

// ── OpenRouter Call ─────────────────────────────────────────

export async function callOpenRouter(
  messages: Array<{ role: string; content: string }>,
  config: BrainConfig,
): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model ?? "openai/gpt-oss-120b",
      messages,
      temperature: 0.2,
      max_tokens: 1000,
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter error (${res.status})`);
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}

// ── Parse LLM Response ──────────────────────────────────────

export function parseAction(raw: string): AgentAction | null {
  try {
    // Try direct parse
    const parsed = JSON.parse(raw);
    if (parsed.tool) return parsed as AgentAction;
  } catch {}

  // Fallback: extract JSON from response
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.tool) return parsed as AgentAction;
    } catch {}
  }

  return null;
}

// ── Main Reasoning Loop ─────────────────────────────────────

export async function runResearchLoop(
  query: string,
  chain: string,
  depth: string,
  config: BrainConfig,
): Promise<ResearchOutput> {
  const maxIterations = config.maxIterations ?? 5;
  const steps: AgentStep[] = [];
  const toolsUsed = new Set<string>();

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Research query: "${query}"\nChain: ${chain}\nDepth: ${depth}\n\nThink about what data you need and call your first tool.`,
    },
  ];

  console.log(`\n🧠 Agent thinking about: "${query}" (depth: ${depth})`);

  for (let i = 0; i < maxIterations; i++) {
    // Ask LLM what to do next
    const raw = await callOpenRouter(messages, config);
    const action = parseAction(raw);

    if (!action) {
      // Parse failure — ask LLM to retry
      console.log(`   ⚠ Parse failed (iteration ${i + 1}), retrying...`);
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content:
          'Your response was not valid JSON. Respond with exactly one JSON object: {"reasoning": "...", "tool": "...", "input": {...}}',
      });
      continue;
    }

    console.log(`   Step ${i + 1}: [${action.tool}] ${action.reasoning}`);

    // Final answer — agent is done thinking
    if (action.tool === "final_answer") {
      return buildFinalOutput(action.input, toolsUsed);
    }

    // Execute tool
    const toolFn = tools.get(action.tool);
    if (!toolFn) {
      const observation = `Error: Unknown tool "${action.tool}". Available: coingecko_search, coingecko_market_data, defillama_protocols, final_answer`;
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: observation });
      continue;
    }

    let observation: string;
    try {
      observation = await toolFn(action.input);
      toolsUsed.add(action.tool);
    } catch (err: any) {
      observation = `Error executing ${action.tool}: ${err.message}`;
    }

    console.log(`   → Result: ${observation.slice(0, 100)}${observation.length > 100 ? "..." : ""}`);

    steps.push({ action, observation });

    // Feed result back to LLM
    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content: `Tool "${action.tool}" returned:\n${observation}\n\nDecide your next action. If you have enough data, call final_answer.`,
    });
  }

  // Max iterations reached — force final answer
  console.log("   ⚠ Max iterations reached, forcing final answer...");
  messages.push({
    role: "user",
    content:
      "You have used all your tool calls. You MUST now call final_answer with the data you have collected. Respond with the final_answer tool call.",
  });

  const raw = await callOpenRouter(messages, config);
  const action = parseAction(raw);

  if (action?.tool === "final_answer") {
    return buildFinalOutput(action.input, toolsUsed);
  }

  // Absolute fallback
  return {
    token: query,
    summary: `Research completed for "${query}" but the agent could not produce a structured answer.`,
    risk_score: 5,
    sentiment: "neutral",
    key_findings: steps.map((s) => `[${s.action.tool}] ${s.observation.slice(0, 100)}`),
    sources: [...toolsUsed].map(toolToSource),
    generated_at: new Date().toISOString(),
  };
}

// ── Helpers ─────────────────────────────────────────────────

function buildFinalOutput(
  input: Record<string, string>,
  toolsUsed: Set<string>,
): ResearchOutput {
  let keyFindings: string[] = [];
  try {
    keyFindings = JSON.parse(input.key_findings || "[]");
  } catch {
    keyFindings = input.key_findings ? [input.key_findings] : [];
  }

  const sources = [...new Set([...toolsUsed].map(toolToSource))];
  sources.push("openrouter.ai (LLM reasoning)");

  return {
    token: input.token || undefined,
    summary: input.summary || "Research completed.",
    risk_score: Math.min(10, Math.max(1, parseInt(input.risk_score) || 5)),
    sentiment: input.sentiment || "neutral",
    key_findings: keyFindings,
    sources,
    generated_at: new Date().toISOString(),
  };
}

function toolToSource(tool: string): string {
  switch (tool) {
    case "coingecko_search":
    case "coingecko_market_data":
      return "coingecko.com";
    case "defillama_protocols":
      return "defillama.com";
    default:
      return tool;
  }
}
