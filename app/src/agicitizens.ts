/**
 * AGICitizens Platform Client — Loosely Coupled
 *
 * This module does NOT hardcode any API paths or response formats.
 * Instead, it:
 * 1. Fetches citizen.md from the platform (API discovery)
 * 2. Passes it to the LLM planner
 * 3. The LLM constructs API requests on the fly using generic http_request tool
 *
 * Following the Moltbook pattern: agents use generic HTTP tools,
 * not per-endpoint functions.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { runPlannerTick } from "./planner";
import { httpRequest } from "./tools";

const API_BASE_URL = process.env.AGICITIZENS_API_URL!;
const API_KEY = process.env.MNA_AGENT_API_KEY || "";
const AGENT_NAME = "mna-agent";

let citizenMd: string = "";

// ─── Discovery: Fetch citizen.md at startup ─────────────────────────────────

/**
 * Fetch the platform's citizen.md — the agent-facing API documentation.
 * This is how the agent learns about the platform dynamically,
 * without hardcoding any endpoints.
 */
export async function discoverPlatform(): Promise<string> {
  // citizen.md is served at the root of the API (without /v1)
  const baseWithoutVersion = API_BASE_URL.replace(/\/v1\/?$/, "");
  const citizenUrl = `${baseWithoutVersion}/citizen.md`;

  console.log(`[Discovery] Fetching citizen.md from ${citizenUrl}`);

  try {
    const res = await fetch(citizenUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    citizenMd = await res.text();
    console.log(`[Discovery] citizen.md loaded (${citizenMd.length} chars, v${extractVersion(citizenMd)})`);
    return citizenMd;
  } catch (err: any) {
    console.error(`[Discovery] Failed to fetch citizen.md: ${err.message}`);
    console.log(`[Discovery] Agent will work with minimal API knowledge`);
    citizenMd = "citizen.md unavailable — use standard REST patterns with the base URL.";
    return citizenMd;
  }
}

function extractVersion(md: string): string {
  const match = md.match(/version:\s*"?([^"\n]+)"?/);
  return match?.[1] || "unknown";
}

// ─── Heartbeat (minimal — just keeps agent online) ──────────────────────────

export async function sendHeartbeat() {
  try {
    await httpRequest({
      method: "POST",
      url: `${API_BASE_URL}/agents/me/heartbeat`,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  } catch (err) {
    // Silent — heartbeat failures are non-critical
  }
}

export function startHeartbeat() {
  console.log("[Heartbeat] Starting heartbeat loop (every 55s)");
  sendHeartbeat();
  return setInterval(sendHeartbeat, 55000);
}

// ─── Main Tick: LLM Planner decides what to do ─────────────────────────────

export async function tick() {
  console.log(`\n[Agent] Tick at ${new Date().toLocaleTimeString()}`);

  await runPlannerTick({
    apiBaseUrl: API_BASE_URL,
    apiKey: API_KEY,
    citizenMd,
    agentName: AGENT_NAME,
  });
}

// ─── Registration (uses generic HTTP — no hardcoded response parsing) ───────

/**
 * Register the M&A agent on the platform.
 * Uses the x402 payment flow:
 *   1. POST /agents/register → 402 with payment details
 *   2. Build + sign USDC transfer
 *   3. Retry with x-payment header
 */
export async function registerAgent(keypairSecretKey: Uint8Array) {
  const { Keypair, VersionedTransaction } = await import("@solana/web3.js");
  const keypair = Keypair.fromSecretKey(keypairSecretKey);
  const wallet = keypair.publicKey.toBase58();

  const body = {
    name: AGENT_NAME,
    wallet,
    categories: ["research", "analysis"],
    description:
      "M&A research agent specializing in deal sourcing, financial analysis, and acquisition research using SMBmarket data.",
    basePrice: "10.00",
  };

  // Step 1: Try to register (expect 402)
  const firstRes = await httpRequest({
    method: "POST",
    url: `${API_BASE_URL}/agents/register`,
    body,
  });

  if (firstRes.status === 402) {
    console.log("[Register] Got 402, signing USDC payment...");
    const details = firstRes.data.details || firstRes.data.error?.details || firstRes.data;

    if (!details.transaction) {
      // Platform returns payment info without unsigned tx — build it ourselves
      console.log("[Register] Building payment transaction...");
      // Registration requires platform-specific payment handling
      // This is the one place where we need platform-specific code
      throw new Error(
        "Registration requires USDC payment. Use 'npm run register' script which handles the payment flow.",
      );
    }

    const txBytes = Buffer.from(details.transaction, "base64");
    const unsignedTx = VersionedTransaction.deserialize(txBytes);
    unsignedTx.sign([keypair]);
    const signedTxBase64 = Buffer.from(unsignedTx.serialize()).toString("base64");

    const secondRes = await httpRequest({
      method: "POST",
      url: `${API_BASE_URL}/agents/register`,
      headers: { "x-payment": signedTxBase64 },
      body,
    });

    if (secondRes.status >= 400) {
      throw new Error(`Registration failed: ${JSON.stringify(secondRes.data)}`);
    }

    console.log("[Register] Agent registered!");
    console.log(`   API Key: ${secondRes.data.apiKey} ← save in .env as MNA_AGENT_API_KEY`);
    return secondRes.data;
  }

  if (firstRes.status >= 400) {
    throw new Error(`Registration failed: ${JSON.stringify(firstRes.data)}`);
  }

  console.log("[Register] Agent registered!");
  return firstRes.data;
}
