import { NextRequest, NextResponse } from "next/server";

// ── Types ───────────────────────────────────────────────────

interface ResearchInput {
  query: string;
  chain?: string;
  depth?: string;
}

interface MarketData {
  price: number;
  market_cap: string;
  volume_24h: string;
  price_change_24h: string;
}

interface DefiProtocol {
  protocol: string;
  tvl: string;
}

interface ResearchOutput {
  token?: string;
  summary: string;
  risk_score: number;
  market_data?: MarketData;
  defi_exposure?: DefiProtocol[];
  sentiment?: string;
  key_findings: string[];
  sources: string[];
  generated_at: string;
}

// ── Data Fetching ───────────────────────────────────────────

function formatLargeNumber(n: number | null | undefined): string {
  if (n == null) return "N/A";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

async function fetchCoinGeckoSearch(query: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/search?${new URLSearchParams({ query })}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return data.coins?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function fetchCoinGeckoData(tokenId: string): Promise<MarketData | null> {
  try {
    const params = new URLSearchParams({
      localization: "false", tickers: "false", community_data: "false", developer_data: "false",
    });
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${tokenId}?${params}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return {
      price: data.market_data?.current_price?.usd ?? 0,
      market_cap: formatLargeNumber(data.market_data?.market_cap?.usd),
      volume_24h: formatLargeNumber(data.market_data?.total_volume?.usd),
      price_change_24h: `${(data.market_data?.price_change_percentage_24h ?? 0).toFixed(2)}%`,
    };
  } catch {
    return null;
  }
}

async function fetchDefiLlamaData(protocol: string): Promise<DefiProtocol[]> {
  try {
    const res = await fetch("https://api.llama.fi/protocols", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return data
      .filter((p: any) => p.name.toLowerCase().includes(protocol.toLowerCase()))
      .slice(0, 5)
      .map((p: any) => ({ protocol: p.name, tvl: formatLargeNumber(p.tvl) }));
  } catch {
    return [];
  }
}

// ── Research Logic ──────────────────────────────────────────

async function executeResearch(input: ResearchInput): Promise<ResearchOutput> {
  const { query, chain = "solana", depth = "standard" } = input;
  const sources: string[] = [];
  const keyFindings: string[] = [];

  const coinGeckoId = await fetchCoinGeckoSearch(query);

  let marketData: MarketData | null = null;
  if (coinGeckoId) {
    marketData = await fetchCoinGeckoData(coinGeckoId);
    if (marketData) {
      sources.push("coingecko.com");
      keyFindings.push(`Current price: $${marketData.price}, 24h change: ${marketData.price_change_24h}`);
    }
  }

  let defiExposure: DefiProtocol[] = [];
  if (depth !== "quick") {
    defiExposure = await fetchDefiLlamaData(query);
    if (defiExposure.length > 0) {
      sources.push("defillama.com");
      keyFindings.push(`Found ${defiExposure.length} related DeFi protocol(s)`);
    }
  }

  // LLM analysis
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      token: coinGeckoId || query,
      summary: `Research analysis for "${query}" on ${chain}. Market data ${marketData ? "available" : "unavailable"}.`,
      risk_score: 5,
      market_data: marketData ?? undefined,
      defi_exposure: defiExposure.length > 0 ? defiExposure : undefined,
      sentiment: "neutral",
      key_findings: keyFindings,
      sources,
      generated_at: new Date().toISOString(),
    };
  }

  const systemPrompt = `You are a crypto research analyst. Provide concise, factual analysis.
Output your analysis as JSON with these fields:
- summary: 2-3 sentence overview
- risk_score: 1 (lowest risk) to 10 (highest risk)
- sentiment: one of "very_bearish", "bearish", "neutral", "bullish", "very_bullish"
- key_findings: array of 3-5 key bullet points
Only respond with valid JSON, no markdown.`;

  const contextParts: string[] = [`Research query: ${query}`, `Chain: ${chain}`];
  if (marketData) {
    contextParts.push(
      `Market data: Price $${marketData.price}, MCap ${marketData.market_cap}, Vol ${marketData.volume_24h}, 24h change ${marketData.price_change_24h}`,
    );
  }
  if (defiExposure.length > 0) {
    contextParts.push(
      `DeFi protocols: ${defiExposure.map((d) => `${d.protocol} (TVL: ${d.tvl})`).join(", ")}`,
    );
  }

  let llmAnalysis: { summary?: string; risk_score?: number; sentiment?: string; key_findings?: string[] } = {};

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.LLM_MODEL ?? "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: contextParts.join("\n") },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter error (${res.status})`);
    const data = (await res.json()) as any;
    const raw = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) llmAnalysis = JSON.parse(jsonMatch[0]);
  } catch (err: any) {
    console.warn("[research] LLM failed:", err.message);
    llmAnalysis = { summary: `Research analysis for "${query}" on ${chain}.`, risk_score: 5, sentiment: "neutral" };
  }

  sources.push("openrouter.ai (LLM analysis)");

  return {
    token: coinGeckoId || query,
    summary: llmAnalysis.summary || `Research completed for "${query}" on ${chain}.`,
    risk_score: Math.min(10, Math.max(1, llmAnalysis.risk_score || 5)),
    market_data: marketData ?? undefined,
    defi_exposure: defiExposure.length > 0 ? defiExposure : undefined,
    sentiment: llmAnalysis.sentiment || "neutral",
    key_findings: [...keyFindings, ...(llmAnalysis.key_findings || [])],
    sources,
    generated_at: new Date().toISOString(),
  };
}

// ── API Route ───────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { query, chain, depth } = body as ResearchInput;

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const validChains = ["solana", "ethereum", "base", "arbitrum"];
    const validDepths = ["quick", "standard", "deep"];

    console.log(`🔬 Research: "${query}" (chain: ${chain}, depth: ${depth})`);

    const result = await executeResearch({
      query: query.trim(),
      chain: validChains.includes(chain ?? "") ? chain : "solana",
      depth: validDepths.includes(depth ?? "") ? depth : "standard",
    });

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[research API]", err);
    return NextResponse.json({ error: err.message || "Research failed" }, { status: 500 });
  }
}
