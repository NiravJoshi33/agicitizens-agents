/**
 * index.ts — Spec-driven platform agent.
 *
 * Reads citizen.md on startup, uses LLM brain for registration,
 * then runs a bid→deliver loop matching the current API:
 *
 *   Poll OPEN tasks → Bid → Wait for IN_PROGRESS → Deliver → Rate
 *
 * Usage:
 *   OPENROUTER_API_KEY=or-xxx npm run agent
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { BrainConfig } from "./brain";
import { executeResearch } from "./bot";
import {
  loadKeypairFromEnv,
  requestFaucet,
  signPayment,
  signMessage,
  getBalances,
} from "./solana";

// ── Config ──────────────────────────────────────────────────

const PLATFORM_API = process.env.AGICITIZENS_API_URL ?? "https://api-beta.agicitizens.com/api/v1";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL ?? "openai/gpt-oss-120b";
const AGENT_NAME = process.env.AGENT_NAME ?? "researchbot";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

const STATE_FILE = resolve(import.meta.dirname ?? ".", `.${AGENT_NAME}-state.json`);

if (!OPENROUTER_API_KEY) {
  console.error("✗ OPENROUTER_API_KEY is required");
  process.exit(1);
}

// ── State ───────────────────────────────────────────────────

interface BotState {
  apiKey: string;
  agentName: string;
  biddedTaskIds?: string[];
  deliveredTaskIds?: string[];
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

// ── Platform HTTP helpers ───────────────────────────────────

let cachedCitizenVersion: string | null = null;

function authHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function checkVersionHeader(headers: Headers): void {
  const version = headers.get("x-citizen-version");
  if (version && cachedCitizenVersion && version !== cachedCitizenVersion) {
    console.log(`📋 Platform spec updated: ${cachedCitizenVersion} → ${version} (will re-fetch next cycle)`);
    cachedCitizenVersion = version;
  } else if (version && !cachedCitizenVersion) {
    cachedCitizenVersion = version;
  }
}

async function platformGet(path: string, apiKey: string): Promise<any> {
  const res = await fetch(`${PLATFORM_API}${path}`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  checkVersionHeader(res.headers);
  if (!res.ok) return null;
  return res.json();
}

async function platformPost(path: string, body: any, apiKey: string, retries = 1): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${PLATFORM_API}${path}`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  checkVersionHeader(res.headers);

  // Retry on 429 with Retry-After
  if (res.status === 429 && retries > 0) {
    const retryAfter = Number(res.headers.get("retry-after") ?? 5);
    console.log(`   ⏳ Rate limited — retrying in ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return platformPost(path, body, apiKey, retries - 1);
  }

  // Retry once on 5xx
  if (res.status >= 500 && retries > 0) {
    await new Promise(r => setTimeout(r, 2000));
    return platformPost(path, body, apiKey, retries - 1);
  }

  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// ── Fetch Platform Spec ─────────────────────────────────────

async function fetchPlatformSpec(): Promise<string> {
  try {
    const res = await fetch(`${PLATFORM_API}/citizen.md`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const text = await res.text();
    return text.length > 8000 ? text.slice(0, 8000) + "\n...(truncated)" : text;
  } catch (err: any) {
    console.warn(`⚠ Could not fetch citizen.md: ${err.message}`);
    return "(Platform spec unavailable)";
  }
}

// ── Deterministic Registration (Solana x-payment) ──────────

async function registerAgent(): Promise<BotState | null> {
  const keypair = loadKeypairFromEnv();
  if (!keypair) {
    console.error("✗ AGENT_WALLET_KEYPAIR is required in .env for registration");
    return null;
  }

  const wallet = keypair.publicKey.toBase58();
  console.log(`   Wallet: ${wallet}`);

  // Step 1: Check balances
  const balances = await getBalances(keypair.publicKey);
  console.log(`   Balances: ${balances.sol} SOL, ${balances.usdc} USDC`);

  // Step 2: Request faucet if needed
  if (balances.usdc < 1) {
    console.log("   Requesting faucet USDC...");
    const faucetRes = await requestFaucet(wallet, PLATFORM_API);
    console.log(`   ${faucetRes.message}`);
    if (!faucetRes.ok) {
      console.warn("   ⚠ Faucet failed — you may need to fund the wallet manually");
    }
    // Wait for faucet tx to confirm
    await new Promise(r => setTimeout(r, 3000));
    const newBalances = await getBalances(keypair.publicKey);
    console.log(`   Updated balances: ${newBalances.sol} SOL, ${newBalances.usdc} USDC`);
  }

  // Step 3: Check name availability
  console.log(`   Checking availability for "${AGENT_NAME}"...`);
  const checkRes = await fetch(`${PLATFORM_API}/agents/check-availability`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: AGENT_NAME, wallet }),
    signal: AbortSignal.timeout(15_000),
  });
  const checkData = await checkRes.json().catch(() => ({})) as any;

  if (!checkRes.ok) {
    console.error(`   ✗ Availability check failed (${checkRes.status}): ${JSON.stringify(checkData)}`);
    return null;
  }

  if (checkData.nameTaken || checkData.walletTaken) {
    console.log(`   Name/wallet already registered — attempting auth challenge...`);
    return await challengeAuth(keypair, wallet);
  }

  console.log("   ✓ Name available");

  // Step 4: Get payment info
  console.log("   Fetching payment info...");
  const payRes = await fetch(`${PLATFORM_API}/payments/info`, {
    signal: AbortSignal.timeout(15_000),
  });
  const payInfo = await payRes.json().catch(() => ({})) as any;
  console.log(`   Payment: ${payInfo.amount} ${payInfo.currency} → ${payInfo.recipient}`);

  const amountBaseUnits = Math.round(parseFloat(payInfo.amount || "1") * 1e6);

  // Step 5: Sign USDC transfer (x-payment) using platform's mint
  console.log("   Signing USDC payment transaction...");
  const { xPayment, error: signError } = await signPayment(
    keypair,
    payInfo.recipient,
    amountBaseUnits,
    true, // recipient is ATA
    payInfo.mint, // use the mint from platform's /payments/info
  );

  if (signError || !xPayment) {
    console.error(`   ✗ ${signError}`);
    return null;
  }
  console.log(`   ✓ Signed (${xPayment.length} chars base64)`);

  // Step 6: Register with x-payment header
  console.log("   Registering agent...");
  const regRes = await fetch(`${PLATFORM_API}/agents/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-payment": xPayment,
    },
    body: JSON.stringify({
      name: AGENT_NAME,
      wallet,
      categories: ["research"],
      description: "Autonomous crypto research agent. Fetches live market data from CoinGecko and DeFiLlama, runs LLM analysis, and delivers structured research reports with risk scoring and sentiment analysis.",
      basePrice: "2.00",
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const regData = await regRes.json().catch(() => ({})) as any;

  if (!regRes.ok) {
    console.error(`   ✗ Registration failed (${regRes.status}): ${JSON.stringify(regData)}`);
    return null;
  }

  const apiKey = regData.apiKey;
  if (!apiKey) {
    console.error("   ✗ No apiKey in registration response");
    console.log(`   Response: ${JSON.stringify(regData)}`);
    return null;
  }

  console.log(`   ✓ Registered! API key: ${apiKey.slice(0, 12)}...`);
  const state: BotState = { apiKey, agentName: AGENT_NAME };
  saveState(state);
  return state;
}

// ── Challenge-Response Auth (for already-registered wallets) ─

async function challengeAuth(keypair: ReturnType<typeof loadKeypairFromEnv>, wallet: string): Promise<BotState | null> {
  if (!keypair) return null;

  try {
    // Request challenge
    const challengeRes = await fetch(`${PLATFORM_API}/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
      signal: AbortSignal.timeout(15_000),
    });
    const challengeData = await challengeRes.json().catch(() => ({})) as any;
    const challenge = challengeData.challenge;
    if (!challenge) {
      console.error("   ✗ No challenge received");
      return null;
    }

    // Sign challenge
    const signature = signMessage(keypair, challenge);

    // Verify
    const verifyRes = await fetch(`${PLATFORM_API}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, challenge, signature }),
      signal: AbortSignal.timeout(15_000),
    });
    const verifyData = await verifyRes.json().catch(() => ({})) as any;

    if (!verifyRes.ok || !verifyData.apiKey) {
      console.error(`   ✗ Auth failed (${verifyRes.status}): ${JSON.stringify(verifyData)}`);
      return null;
    }

    console.log(`   ✓ Authenticated via challenge! API key: ${verifyData.apiKey.slice(0, 12)}...`);
    const state: BotState = { apiKey: verifyData.apiKey, agentName: AGENT_NAME };
    saveState(state);
    return state;
  } catch (err: any) {
    console.error(`   ✗ Challenge auth error: ${err.message}`);
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   research-ai-agent — AGICitizens        ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log();

  const config: BrainConfig = { apiKey: OPENROUTER_API_KEY!, model: LLM_MODEL };

  // Load platform spec
  console.log("📖 Reading platform spec...");
  const platformSpec = await fetchPlatformSpec();
  console.log(`   ✓ Loaded (${platformSpec.length} chars)\n`);

  // Load or register
  let state = loadState();

  if (!state) {
    // Check env for pre-existing key
    if (process.env.AGICITIZENS_API_KEY) {
      state = { apiKey: process.env.AGICITIZENS_API_KEY, agentName: AGENT_NAME };
      saveState(state);
      console.log(`✓ Using API key from .env\n`);
    } else {
      console.log("⟳ Not registered. Starting Solana-based registration...\n");
      state = await registerAgent();
      if (!state) {
        console.log("⚠ Registration failed. Set AGICITIZENS_API_KEY in .env to skip.\n");
        return;
      }
    }
  } else {
    console.log(`✓ Authenticated (agent: ${state.agentName})\n`);
  }

  console.log(`  LLM: ${LLM_MODEL}`);
  console.log(`  Platform: ${PLATFORM_API}`);
  console.log(`  Poll: ${POLL_INTERVAL_MS / 1000}s | Heartbeat: ${HEARTBEAT_INTERVAL_MS / 1000}s\n`);

  // ── Heartbeat loop ──────────────────────────────────────

  const sendHeartbeat = async () => {
    try {
      const res = await fetch(`${PLATFORM_API}/agents/me/heartbeat`, {
        method: "POST",
        headers: authHeaders(state!.apiKey),
      });
      if (!res.ok) console.warn(`⚠ Heartbeat: ${res.status}`);
    } catch {}
  };

  await sendHeartbeat();
  const heartbeatLoop = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  console.log("♥ Online\n");

  // ── Task loop: poll → bid → deliver ─────────────────────

  // Restore bid/deliver tracking from persisted state
  const biddedTasks = new Set<string>(state!.biddedTaskIds ?? []);
  const deliveredTasks = new Set<string>(state!.deliveredTaskIds ?? []);

  const persistTracking = () => {
    state!.biddedTaskIds = [...biddedTasks];
    state!.deliveredTaskIds = [...deliveredTasks];
    saveState(state!);
  };

  const poll = async () => {
    // ── Phase 1: Find OPEN tasks and bid ──────────────────
    try {
      const openData = await platformGet("/tasks?status=OPEN&category=research&limit=5", state!.apiKey);
      const openTasks = openData?.data ?? openData?.tasks ?? [];

      for (const task of openTasks) {
        const taskId = task.taskId ?? task.task_id ?? task.id;
        if (!taskId || biddedTasks.has(taskId)) continue;

        console.log(`🔍 Open task: ${taskId} — "${task.title ?? "research"}" (${task.budget ?? task.amountUsdc} USDC)`);

        // Place a bid
        const bidPrice = task.budget ?? task.amountUsdc ?? "2.00";
        const bidRes = await platformPost(`/bids/${taskId}`, {
          price: bidPrice,
          message: `Research agent ready. I fetch live data from CoinGecko + DeFiLlama and run LLM analysis to deliver structured reports with risk scoring and sentiment.`,
        }, state!.apiKey);

        if (bidRes.ok) {
          console.log(`   ✓ Bid placed: ${bidPrice} USDC`);
        } else {
          const msg = JSON.stringify(bidRes.data).slice(0, 120);
          if (msg.includes("pending bid")) {
            console.log(`   ℹ Already bid on ${taskId} — skipping`);
          } else {
            console.warn(`   ⚠ Bid failed (${bidRes.status}): ${msg}`);
          }
        }
        biddedTasks.add(taskId);
        persistTracking();
      }
    } catch (err: any) {
      console.error(`⚠ Poll (open tasks) error: ${err.message}`);
    }

    // ── Phase 2: Check tasks assigned to us (IN_PROGRESS) ─
    try {
      const myData = await platformGet(`/tasks?status=IN_PROGRESS&provider=${AGENT_NAME}&limit=10`, state!.apiKey);
      const myTasks = myData?.data ?? myData?.tasks ?? [];

      for (const task of myTasks) {
        const taskId = task.taskId ?? task.task_id ?? task.id;
        if (!taskId || deliveredTasks.has(taskId)) continue;

        console.log(`🔬 Assigned task: ${taskId} — "${task.title ?? "research"}"`);

        // Execute research
        try {
          const input = task.input ?? { query: task.title ?? task.description ?? "crypto" };
          const output = await executeResearch(input, config);

          // Deliver — server computes outputHash
          const deliverRes = await platformPost(`/tasks/${taskId}/deliver`, {
            output,
          }, state!.apiKey);

          if (deliverRes.ok) {
            console.log(`   ✓ Delivered\n`);
          } else {
            console.warn(`   ⚠ Deliver failed (${deliverRes.status}): ${JSON.stringify(deliverRes.data).slice(0, 100)}`);
          }
        } catch (err: any) {
          console.error(`   ✗ Research failed: ${err.message}`);
        }

        deliveredTasks.add(taskId);
        persistTracking();
      }
    } catch (err: any) {
      console.error(`⚠ Poll (my tasks) error: ${err.message}`);
    }

    // ── Phase 3: Handle DISPUTED tasks (re-deliver) ───────
    try {
      const disputedData = await platformGet(`/tasks?status=DISPUTED&provider=${AGENT_NAME}&limit=5`, state!.apiKey);
      const disputedTasks = disputedData?.data ?? disputedData?.tasks ?? [];

      for (const task of disputedTasks) {
        const taskId = task.taskId ?? task.task_id ?? task.id;
        if (!taskId || deliveredTasks.has(`disputed-${taskId}`)) continue;

        console.log(`⚠ Disputed task: ${taskId} — re-researching...`);

        try {
          const input = task.input ?? { query: task.title ?? task.description ?? "crypto" };
          // Re-research with deeper depth
          const output = await executeResearch({ ...input, depth: "deep" }, config);

          const redeliverRes = await platformPost(`/tasks/${taskId}/deliver`, {
            output,
          }, state!.apiKey);

          if (redeliverRes.ok) {
            console.log(`   ✓ Re-delivered (dispute response)\n`);
          } else {
            console.warn(`   ⚠ Re-deliver failed (${redeliverRes.status})`);
          }
        } catch (err: any) {
          console.error(`   ✗ Re-research failed: ${err.message}`);
        }

        deliveredTasks.add(`disputed-${taskId}`);
        persistTracking();
      }
    } catch {}

    // ── Phase 4: Rate verified tasks ──────────────────────
    try {
      const verifiedData = await platformGet(`/tasks?status=VERIFIED&provider=${AGENT_NAME}&limit=10`, state!.apiKey);
      const verifiedTasks = verifiedData?.data ?? verifiedData?.tasks ?? [];

      for (const task of verifiedTasks) {
        const taskId = task.taskId ?? task.task_id ?? task.id;
        if (!taskId) continue;

        const rateRes = await platformPost(`/tasks/${taskId}/rate`, {
          rating: 4,
        }, state!.apiKey);

        if (rateRes.ok) {
          console.log(`⭐ Rated requester on task ${taskId}`);
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
