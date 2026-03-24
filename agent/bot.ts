/**
 * researchbot core — registration config, AgentClient, and research logic.
 *
 * Imported by the main loop (index.ts). Separates research execution
 * from the task lifecycle so logic can be tested independently.
 */

import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from "@solana/spl-token";

// ── Types ───────────────────────────────────────────────────

export interface AgentRegistration {
  name: string;
  category: string;
  wallet: string;
  capabilities: string[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  pricing: { base_price: number; model: string };
  sla: { max_duration_seconds: number; callback_url?: string };
}

export interface Task {
  id: string;
  category: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  status: string;
  reward_amount: number;
  creator_id: string;
  agent_id?: string;
  created_at: string;
  updated_at: string;
}

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

// ── AgentClient ─────────────────────────────────────────────

export class AgentClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: { baseUrl: string; apiKey?: string }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  get isAuthenticated(): boolean {
    return !!this.apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async getX402Info(): Promise<{
    platform_wallet: string;
    usdc_mint: string;
    platform_usdc_ata: string;
    fees: { registration_usdc: number };
  }> {
    const res = await fetch(`${this.baseUrl}/x402/info`);
    if (!res.ok) throw new Error(`x402/info failed (${res.status})`);
    const json = (await res.json()) as any;
    return json.data;
  }

  async register(
    registration: AgentRegistration,
    paymentProof: string,
  ): Promise<{ agent_id: string; api_key: string }> {
    const headers = this.headers();
    headers["X-Payment"] = paymentProof;

    const res = await fetch(`${this.baseUrl}/agents/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(registration),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Registration failed (${res.status}): ${err}`);
    }

    const json = (await res.json()) as any;
    const data = json.data ?? json;
    this.apiKey = data.api_key;
    return data;
  }

  async heartbeat(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agents/heartbeat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ timestamp: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`Heartbeat failed (${res.status})`);
  }

  async getTasks(params?: Record<string, string>): Promise<Task[]> {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    const res = await fetch(`${this.baseUrl}/tasks${qs}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`getTasks failed (${res.status})`);
    const data = (await res.json()) as { tasks?: Task[] };
    return data.tasks ?? [];
  }

  async getTask(taskId: string): Promise<Task | null> {
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
      headers: this.headers(),
    });
    if (!res.ok) return null;
    return (await res.json()) as Task;
  }

  async acceptTask(taskId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}/accept`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as any;
      const error = new Error(`Accept failed (${res.status})`);
      (error as any).code = err.code;
      throw error;
    }
  }

  async deliverTask(
    taskId: string,
    output: Record<string, unknown>,
    outputHash: string,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}/deliver`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ output, output_hash: outputHash }),
    });
    if (!res.ok) {
      throw new Error(`Deliver failed (${res.status}): ${await res.text()}`);
    }
  }
}

// ── Registration ────────────────────────────────────────────

export function createResearchbotRegistration(wallet: string): AgentRegistration {
  return {
    name: "researchbot",
    category: "research",
    wallet,
    capabilities: [
      "crypto-research",
      "token-analysis",
      "market-data",
      "onchain-analytics",
      "defi-research",
    ],
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The research question or token/protocol to analyze" },
        token_address: { type: "string", description: "Optional: Solana token mint address" },
        chain: { type: "string", enum: ["solana", "ethereum", "base", "arbitrum"], default: "solana" },
        depth: { type: "string", enum: ["quick", "standard", "deep"], default: "standard" },
      },
      required: ["query"],
    },
    output_schema: {
      type: "object",
      properties: {
        token: { type: "string" },
        summary: { type: "string" },
        risk_score: { type: "number", minimum: 1, maximum: 10 },
        market_data: {
          type: "object",
          properties: {
            price: { type: "number" },
            market_cap: { type: "string" },
            volume_24h: { type: "string" },
            price_change_24h: { type: "string" },
          },
        },
        defi_exposure: {
          type: "array",
          items: {
            type: "object",
            properties: { protocol: { type: "string" }, tvl: { type: "string" } },
          },
        },
        sentiment: { type: "string", enum: ["very_bearish", "bearish", "neutral", "bullish", "very_bullish"] },
        key_findings: { type: "array", items: { type: "string" } },
        sources: { type: "array", items: { type: "string" } },
        generated_at: { type: "string", format: "date-time" },
      },
      required: ["summary", "risk_score", "sources", "generated_at"],
    },
    pricing: { base_price: 2, model: "per-task" },
    sla: { max_duration_seconds: 300, callback_url: "http://localhost:3002/callback" },
  };
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
    console.warn(`[researchbot] CoinGecko fetch failed for ${tokenId}:`, err.message);
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
    console.warn(`[researchbot] DeFiLlama fetch failed:`, err.message);
    return [];
  }
}

// ── Research (Smart Agent) ───────────────────────────────────

import { runResearchLoop } from "./brain";

/**
 * Execute crypto research.
 *
 * With LLM: runs an autonomous reasoning loop — the LLM decides
 * which tools to call, observes results, and repeats until confident.
 *
 * Without LLM: runs a deterministic pipeline (for testing).
 */
export async function executeResearch(
  input: ResearchInput,
  llmConfig?: { apiKey: string; model?: string },
): Promise<ResearchOutput> {
  const { query, chain = "solana", depth = "standard" } = input;

  // LLM mode: autonomous reasoning loop
  if (llmConfig?.apiKey) {
    const maxIterations = depth === "quick" ? 3 : depth === "deep" ? 7 : 5;
    return runResearchLoop(query, chain, depth, {
      apiKey: llmConfig.apiKey,
      model: llmConfig.model,
      maxIterations,
    });
  }

  // Deterministic fallback (no LLM)
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

// ── Solana X402 Payment ─────────────────────────────────────

export async function requestFaucet(wallet: string): Promise<void> {
  console.log(`   Requesting faucet for ${wallet.slice(0, 8)}...`);
  const res = await fetch("https://faucet-beta.agicitizens.com/faucet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn(`   ⚠ Faucet request failed (${res.status}): ${text}`);
    return;
  }
  console.log("   ✓ Faucet funded (SOL + USDC)");
}

export async function payRegistration(
  connection: Connection,
  payer: Keypair,
  usdcMint: PublicKey,
  platformWallet: PublicKey,
  amountUsdc: number,
): Promise<string> {
  // Check SOL balance
  const solBalance = await connection.getBalance(payer.publicKey);
  console.log(`   SOL balance: ${(solBalance / 1e9).toFixed(4)}`);
  if (solBalance === 0) {
    throw new Error("Wallet has no SOL — faucet may not have funded this wallet on devnet");
  }

  // Get or create sender ATA
  const senderAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, usdcMint, payer.publicKey,
  );
  console.log(`   Sender USDC ATA: ${senderAta.address.toBase58()}`);
  console.log(`   USDC balance: ${Number(senderAta.amount) / 1e6}`);

  if (Number(senderAta.amount) < amountUsdc * 1e6) {
    throw new Error(
      `Insufficient USDC: have ${Number(senderAta.amount) / 1e6}, need ${amountUsdc}. ` +
      `Check that faucet uses mint ${usdcMint.toBase58()}`
    );
  }

  // Derive platform ATA and create if it doesn't exist
  const platformAta = await getAssociatedTokenAddress(usdcMint, platformWallet);
  console.log(`   Platform USDC ATA: ${platformAta.toBase58()}`);

  const tx = new Transaction();

  // Check if platform ATA exists, create it if not
  try {
    await getAccount(connection, platformAta);
  } catch (e: any) {
    if (e instanceof TokenAccountNotFoundError || e instanceof TokenInvalidAccountOwnerError) {
      console.log("   Creating platform ATA...");
      tx.add(
        createAssociatedTokenAccountInstruction(payer.publicKey, platformAta, platformWallet, usdcMint),
      );
    } else {
      throw e;
    }
  }

  const amountLamports = Math.round(amountUsdc * 1_000_000);
  tx.add(
    createTransferInstruction(senderAta.address, platformAta, payer.publicKey, amountLamports),
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  return sig;
}

export function buildPaymentProof(txSignature: string, payer: string, amountUsdc: number): string {
  return Buffer.from(
    JSON.stringify({
      tx_signature: txSignature,
      payer,
      amount_usdc: amountUsdc,
    }),
  ).toString("base64");
}

export function keypairFromEnv(envVar: string): Keypair {
  const raw = process.env[envVar];
  if (!raw) throw new Error(`Missing env var: ${envVar}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Build a delivery output object from research results.
 */
export function buildDeliveryOutput(research: ResearchOutput) {
  return { ...research };
}
