/**
 * researchbot — AGICitizens Crypto Research agent.
 *
 * Accepts research tasks from the platform, fetches market data from
 * CoinGecko + DeFiLlama, uses an LLM for analysis, and delivers structured
 * research output.
 *
 * Usage:
 *   OPENROUTER_API_KEY=or-xxx pnpm start
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

// Load .env from repo root
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });
import { Connection, PublicKey } from "@solana/web3.js";
import {
  AgentClient,
  createResearchbotRegistration,
  executeResearch,
  buildDeliveryOutput,
  sha256,
  requestFaucet,
  payRegistration,
  buildPaymentProof,
  keypairFromEnv,
} from "./bot.js";
import type { ResearchInput } from "./bot.js";

// ── Config ──────────────────────────────────────────────────

// Use production API (devnet) — local API can't verify devnet transactions
const AGICITIZENS_API = "https://api-beta.agicitizens.com/api/v1";
// Platform runs on devnet — override localnet RPC from .env
const SOLANA_RPC = "https://api.devnet.solana.com";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL ?? "openai/gpt-oss-120b";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 20_000;
const HEARTBEAT_INTERVAL_MS = 55_000;

const STATE_FILE = resolve(import.meta.dirname ?? ".", ".researchbot-state.json");

if (!OPENROUTER_API_KEY) {
  console.error("✗ OPENROUTER_API_KEY is required");
  process.exit(1);
}

// ── State persistence ───────────────────────────────────────

interface BotState {
  apiKey: string;
  agentId: string;
}

function loadState(): BotState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveState(state: BotState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Task Processing ─────────────────────────────────────────

async function processTask(
  client: AgentClient,
  taskId: string,
  task: any,
) {
  console.log(`🔬 Processing task ${taskId}...`);
  console.log(`   Input: ${JSON.stringify(task.input).slice(0, 100)}...`);

  // Execute research via LLM + data APIs
  const input = task.input as ResearchInput;
  const research = await executeResearch(input, {
    apiKey: OPENROUTER_API_KEY!,
    model: LLM_MODEL,
  });

  console.log(`   Summary: "${research.summary.slice(0, 80)}..."`);
  console.log(`   Risk score: ${research.risk_score}/10 | Sentiment: ${research.sentiment}`);
  console.log(`   Sources: ${research.sources.join(", ")}`);

  // Build delivery output
  const output = buildDeliveryOutput(research);
  const outputHash = sha256(JSON.stringify(output));

  // Deliver to AGICitizens
  await client.deliverTask(taskId, output, outputHash);
  console.log(`   ✓ Delivered to AGICitizens (hash: ${outputHash.slice(0, 16)}...)\n`);
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   researchbot — AGICitizens Research     ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log();

  // Initialize AGICitizens client
  const savedState = loadState();
  const apiKey = process.env.AGICITIZENS_API_KEY ?? savedState?.apiKey;

  const client = new AgentClient({
    baseUrl: AGICITIZENS_API,
    apiKey: apiKey ?? undefined,
  });

  if (!client.isAuthenticated) {
    console.log("⟳ Registering as new citizen...");

    // Load wallet keypair
    const walletKeypair = keypairFromEnv("SERVER_WALLET_KEYPAIR");
    const walletAddress = walletKeypair.publicKey.toBase58();
    console.log(`  Wallet: ${walletAddress}`);

    // Get X402 payment info
    const x402 = await client.getX402Info();
    console.log(`  Registration fee: $${x402.fees.registration_usdc} USDC`);

    // Request faucet funds
    await requestFaucet(walletAddress);
    await new Promise(r => setTimeout(r, 5000)); // wait for devnet confirmation

    // Transfer USDC to platform
    const connection = new Connection(SOLANA_RPC, "confirmed");
    console.log("  Transferring USDC to platform...");
    const txSig = await payRegistration(
      connection,
      walletKeypair,
      new PublicKey(x402.usdc_mint),
      new PublicKey(x402.platform_wallet),
      x402.fees.registration_usdc,
    );
    console.log(`  ✓ Payment tx: ${txSig}`);

    // Build proof and register
    const proof = buildPaymentProof(txSig, walletAddress, x402.fees.registration_usdc);
    const result = await client.register(
      createResearchbotRegistration(walletAddress),
      proof,
    );

    saveState({ apiKey: result.api_key, agentId: result.agent_id });
    console.log(`✓ Registered as ${result.agent_id}`);
  } else {
    console.log(`✓ AGICitizens authenticated (key: ${apiKey!.slice(0, 12)}...)`);
  }

  console.log(`  LLM model: ${LLM_MODEL}`);
  console.log();

  // Heartbeat
  const heartbeatLoop = setInterval(async () => {
    try { await client.heartbeat(); } catch {}
  }, HEARTBEAT_INTERVAL_MS);
  await client.heartbeat();
  console.log("♥ Online\n");

  // Polling loop
  const processedTasks = new Set<string>();

  const poll = async () => {
    try {
      const tasks = await client.getTasks({ status: "OPEN", category: "research" });

      for (const task of tasks) {
        if (processedTasks.has(task.id)) continue;

        try {
          // Accept if OPEN
          if (task.status === "OPEN") {
            await client.acceptTask(task.id);
            console.log(`✓ Accepted task ${task.id}`);
          }

          // Refetch to confirm IN_PROGRESS
          const updated = await client.getTask(task.id);
          if (!updated) continue;

          if (updated.status === "IN_PROGRESS" && updated.agent_id === "researchbot.agicitizens") {
            await processTask(client, task.id, updated);
            processedTasks.add(task.id);
          }
        } catch (err: any) {
          console.error(`⚠ Error on ${task.id}:`, err.message);
          if (err.code === "TASK_NOT_OPEN" || err.code === "INVALID_STATUS") {
            processedTasks.add(task.id);
          }
        }
      }
    } catch (err: any) {
      console.error(`⚠ Poll error:`, err.message);
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);

  process.on("SIGINT", () => {
    console.log("\n⏻ Shutting down researchbot...");
    clearInterval(heartbeatLoop);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("✗ researchbot crashed:", err);
  process.exit(1);
});
