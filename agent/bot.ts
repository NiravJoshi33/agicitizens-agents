/**
 * bot.ts — Research data fetchers and types.
 *
 * Pure research logic — no platform coupling.
 * The brain uses these as tools for crypto research.
 */

import { runResearchLoop } from "./brain";

// ── Types ───────────────────────────────────────────────────

export interface ResearchInput {
  query: string;
  token_address?: string;
  chain?: string;
  depth?: string;
}

export interface MarketData {
  price: number;
  market_cap: string;
  volume_24h: string;
  price_change_24h: string;
}

export interface DefiProtocol {
  protocol: string;
  tvl: string;
}

export interface ResearchOutput {
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

export async function fetchCoinGeckoSearch(query: string): Promise<string | null> {
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

export async function fetchCoinGeckoData(tokenId: string): Promise<MarketData | null> {
  try {
    const params = new URLSearchParams({
      localization: "false",
      tickers: "false",
      community_data: "false",
      developer_data: "false",
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
  } catch (err: any) {
    console.warn(`[research] CoinGecko fetch failed for ${tokenId}:`, err.message);
    return null;
  }
}

export async function fetchDefiLlamaData(protocol: string): Promise<DefiProtocol[]> {
  try {
    const res = await fetch("https://api.llama.fi/protocols", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return data
      .filter((p: any) => p.name.toLowerCase().includes(protocol.toLowerCase()))
      .slice(0, 5)
      .map((p: any) => ({ protocol: p.name, tvl: formatLargeNumber(p.tvl) }));
  } catch (err: any) {
    console.warn(`[research] DeFiLlama fetch failed:`, err.message);
    return [];
  }
}

// ── Research ────────────────────────────────────────────────

/**
 * Execute crypto research.
 *
 * With LLM: autonomous reasoning loop (brain decides tools to call).
 * Without LLM: deterministic pipeline fallback.
 */
export async function executeResearch(
  input: ResearchInput,
  llmConfig?: { apiKey: string; model?: string },
): Promise<ResearchOutput> {
  const { query, chain = "solana", depth = "standard" } = input;

  if (llmConfig?.apiKey) {
    const maxIterations = depth === "quick" ? 3 : depth === "deep" ? 7 : 5;
    return runResearchLoop(query, chain, depth, {
      apiKey: llmConfig.apiKey,
      model: llmConfig.model,
      maxIterations,
    });
  }

  // Deterministic fallback
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

// ── Helpers ─────────────────────────────────────────────────

function formatLargeNumber(n: number | null | undefined): string {
  if (n == null) return "N/A";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

