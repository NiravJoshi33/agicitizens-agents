import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../../.env") });

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { executeQuery, loadDeals } from "./bot.js";
import { loadOrCreateKeypair, registerAgent } from "./wallet.js";
import type { BrainConfig } from "./brain.js";

const PLATFORM_API = process.env.AGICITIZENS_API_URL;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL;
const AGENT_NAME = process.env.MNA_AGENT_NAME;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS);
const KEYPAIR_PATH = process.env.KEYPAIR_PATH;

const missing = [
  !OPENROUTER_API_KEY && "OPENROUTER_API_KEY",
  !PLATFORM_API && "AGICITIZENS_API_URL",
  !SOLANA_RPC_URL && "SOLANA_RPC_URL",
  !LLM_MODEL && "LLM_MODEL",
  !AGENT_NAME && "MNA_AGENT_NAME",
  !POLL_INTERVAL_MS && "POLL_INTERVAL_MS",
  !HEARTBEAT_INTERVAL_MS && "HEARTBEAT_INTERVAL_MS",
  !KEYPAIR_PATH && "KEYPAIR_PATH",
].filter(Boolean);

if (missing.length) {
  console.error(`✗ Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const platformApi = PLATFORM_API!;
const solanaRpcUrl = SOLANA_RPC_URL!;
const agentName = AGENT_NAME!;
const keypairPath = resolve(KEYPAIR_PATH!);
const STATE_FILE = resolve(__dirname, `../../.${agentName}-state.json`);

interface BotState {
  apiKey: string;
  agentName: string;
  wallet: string;
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

function authHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function platformGet(path: string, apiKey: string): Promise<any> {
  const res = await fetch(`${platformApi}${path}`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function platformPost(
  path: string,
  body: any,
  apiKey: string,
  retries = 1
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${platformApi}${path}`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 429 && retries > 0) {
    const retryAfter = Number(res.headers.get("retry-after") ?? 5);
    console.log(`   ⏳ Rate limited — retrying in ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return platformPost(path, body, apiKey, retries - 1);
  }

  if (res.status >= 500 && retries > 0) {
    await new Promise((r) => setTimeout(r, 2000));
    return platformPost(path, body, apiKey, retries - 1);
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║          M&A DEALS AGENT — AUTONOMOUS            ║`);
  console.log(`║   Searches 200+ business listings on demand       ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  const config: BrainConfig = {
    apiKey: OPENROUTER_API_KEY!,
    model: LLM_MODEL!,
    baseUrl: process.env.LLM_BASE_URL!,
  };

  console.log(`[STARTUP] Loading deals CSV...`);
  loadDeals();

  console.log(`[STARTUP] Loading wallet...`);
  const keypair = loadOrCreateKeypair(keypairPath);
  const wallet = keypair.publicKey.toBase58();
  console.log(`[STARTUP] Wallet: ${wallet}`);

  let state = loadState();

  if (state?.apiKey) {
    console.log(`[STARTUP] Authenticated as "${state.agentName}"`);
  } else if (process.env.AGIC_API_KEY) {
    state = { apiKey: process.env.AGIC_API_KEY, agentName: agentName, wallet };
    saveState(state);
    console.log(`[STARTUP] Using API key from .env`);
  } else {
    console.log(`[STARTUP] No API key found. Self-registering...\n`);
    try {
      const apiKey = await registerAgent(platformApi, keypair, solanaRpcUrl, {
        name: agentName,
        categories: ["research", "analysis", "data"],
        description:
          "M&A Deals Agent. Searches and filters business acquisition listings " +
          "by financial criteria (EBITDA, revenue, asking price, SDE). " +
          "Supports natural language queries.",
        basePrice: process.env.MNA_BASE_PRICE!,
      });

      state = { apiKey, agentName: agentName, wallet };
      saveState(state);
      console.log(`\n✓ Registration complete!\n`);
    } catch (err: any) {
      console.error(`\n✗ Registration failed: ${err.message}`);
      console.log("\nTroubleshooting:");
      console.log("  1. Is the platform API running at", platformApi, "?");
      console.log("  2. Is Solana localnet running at", solanaRpcUrl, "?");
      console.log("  3. Or set AGIC_API_KEY in .env to skip registration.\n");
      process.exit(1);
    }
  }

  console.log(`\n┌─ Config ─────────────────────────────────────────┐`);
  console.log(`│  Platform:  ${platformApi}`);
  console.log(`│  Solana:    ${solanaRpcUrl}`);
  console.log(`│  LLM:       ${LLM_MODEL}`);
  console.log(`│  Poll:      every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`│  Heartbeat: every ${HEARTBEAT_INTERVAL_MS / 1000}s`);
  console.log(`└──────────────────────────────────────────────────┘`);

  const sendHeartbeat = async () => {
    try {
      const res = await fetch(`${platformApi}/agents/me/heartbeat`, {
        method: "POST",
        headers: authHeaders(state!.apiKey),
      });
      if (!res.ok) console.warn(`⚠ Heartbeat: ${res.status}`);
    } catch {}
  };

  await sendHeartbeat();
  const heartbeatLoop = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  console.log(`\n[AGENT ONLINE] Polling for tasks...\n`);

  const biddedTasks = new Set<string>();
  const deliveredTasks = new Set<string>();

  const poll = async () => {
    try {
      const openData = await platformGet(
        "/tasks?status=OPEN&category=research&limit=5",
        state!.apiKey
      );
      const openTasks = openData?.data ?? openData?.tasks ?? [];

      for (const task of openTasks) {
        const taskId = task.taskId ?? task.task_id ?? task.id;
        if (!taskId || biddedTasks.has(taskId)) continue;

        console.log(`\n════════════════════════════════════════════`);
        console.log(`  OPEN TASK FOUND`);
        console.log(`════════════════════════════════════════════`);
        console.log(`  Task ID:  ${taskId}`);
        console.log(`  Title:    ${task.title ?? "N/A"}`);
        console.log(`  Budget:   ${task.budget ?? task.amountUsdc} USDC`);
        console.log(`  Category: ${task.category ?? "N/A"}`);
        console.log(`────────────────────────────────────────────`);
        console.log(`  ACTION: Placing bid...`);

        const bidPrice =
          task.budget ?? task.amountUsdc ?? process.env.MNA_BASE_PRICE!;
        const bidRes = await platformPost(
          `/bids/${taskId}`,
          {
            price: bidPrice,
            message:
              "M&A Deals Agent ready. I search 200+ business listings by financial criteria and deliver structured JSON results.",
          },
          state!.apiKey
        );

        if (bidRes.ok) {
          console.log(`  ✓ BID PLACED: ${bidPrice} USDC`);
          console.log(`  Waiting for requester to accept...`);
        } else {
          console.warn(
            `  ⚠ BID FAILED (${bidRes.status}): ${JSON.stringify(
              bidRes.data
            ).slice(0, 100)}`
          );
        }
        console.log(`════════════════════════════════════════════\n`);
        biddedTasks.add(taskId);
      }
    } catch (err: any) {
      console.error(`⚠ Poll (open tasks) error: ${err.message}`);
    }

    try {
      const myData = await platformGet(
        `/tasks?status=IN_PROGRESS&provider=${agentName}&limit=10`,
        state!.apiKey
      );
      const myTasks = myData?.data ?? myData?.tasks ?? [];

      for (const task of myTasks) {
        const taskId = task.taskId ?? task.task_id ?? task.id;
        if (!taskId || deliveredTasks.has(taskId)) continue;

        console.log(`\n════════════════════════════════════════════`);
        console.log(`  TASK ASSIGNED — WORKING`);
        console.log(`════════════════════════════════════════════`);
        console.log(`  Task ID: ${taskId}`);
        console.log(`  Title:   ${task.title ?? "N/A"}`);
        console.log(`────────────────────────────────────────────`);

        try {
          const input = task.input ?? {
            query: task.title ?? task.description ?? "deals",
          };
          console.log(`  ACTION: Running deal query...`);
          console.log(`  Query:  "${input.query}"`);
          const output = await executeQuery(input, config);
          console.log(
            `  ✓ QUERY COMPLETE: ${output.total_matches} deals found`
          );

          console.log(`  ACTION: Delivering results...`);
          const deliverRes = await platformPost(
            `/tasks/${taskId}/deliver`,
            { output },
            state!.apiKey
          );

          if (deliverRes.ok) {
            console.log(
              `  ✓ DELIVERED — ${output.total_matches} deals sent to requester`
            );
            console.log(`  Waiting for requester to accept...`);
          } else {
            console.warn(
              `  ⚠ DELIVER FAILED (${deliverRes.status}): ${JSON.stringify(
                deliverRes.data
              ).slice(0, 100)}`
            );
          }
        } catch (err: any) {
          console.error(`  ✗ QUERY FAILED: ${err.message}`);
        }
        console.log(`════════════════════════════════════════════\n`);

        deliveredTasks.add(taskId);
      }
    } catch (err: any) {
      console.error(`⚠ Poll (my tasks) error: ${err.message}`);
    }

    try {
      const disputedData = await platformGet(
        `/tasks?status=DISPUTED&provider=${agentName}&limit=5`,
        state!.apiKey
      );
      const disputedTasks = disputedData?.data ?? disputedData?.tasks ?? [];

      for (const task of disputedTasks) {
        const taskId = task.taskId ?? task.task_id ?? task.id;
        if (!taskId || deliveredTasks.has(`disputed-${taskId}`)) continue;

        console.log(`\n════════════════════════════════════════════`);
        console.log(`  TASK DISPUTED — RE-DELIVERING`);
        console.log(`════════════════════════════════════════════`);
        console.log(`  Task ID: ${taskId}`);

        try {
          const input = task.input ?? {
            query: task.title ?? task.description ?? "deals",
          };
          const output = await executeQuery(input, config);

          const redeliverRes = await platformPost(
            `/tasks/${taskId}/deliver`,
            { output },
            state!.apiKey
          );

          if (redeliverRes.ok) {
            console.log(`   ✓ Re-delivered (${output.total_matches} deals)\n`);
          } else {
            console.warn(
              `   ⚠ Re-deliver failed (${
                redeliverRes.status
              }): ${JSON.stringify(redeliverRes.data).slice(0, 100)}`
            );
          }
        } catch (err: any) {
          console.error(`   ✗ Re-delivery failed: ${err.message}`);
        }

        deliveredTasks.add(`disputed-${taskId}`);
      }
    } catch (err: any) {
      console.error(`⚠ Poll (disputed tasks) error: ${err.message}`);
    }

    try {
      const verifiedData = await platformGet(
        `/tasks?status=VERIFIED&provider=${agentName}&limit=10`,
        state!.apiKey
      );
      const verifiedTasks = verifiedData?.data ?? verifiedData?.tasks ?? [];

      for (const task of verifiedTasks) {
        const taskId = task.taskId ?? task.task_id ?? task.id;
        if (!taskId) continue;

        const rateRes = await platformPost(
          `/tasks/${taskId}/rate`,
          { rating: 4 },
          state!.apiKey
        );
        if (rateRes.ok) {
          console.log(`\n════════════════════════════════════════════`);
          console.log(`  TASK RATED`);
          console.log(`════════════════════════════════════════════`);
          console.log(`  Task ID: ${taskId}`);
          console.log(`  Rating:  4/5`);
          console.log(`  ✓ Escrow settlement triggered`);
          console.log(`════════════════════════════════════════════\n`);
        }
      }
    } catch {}
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);

  process.on("SIGINT", () => {
    console.log("\n⏻ Shutting down...");
    clearInterval(heartbeatLoop);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("✗ Agent crashed:", err);
  process.exit(1);
});
