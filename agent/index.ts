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
import { callOpenRouter, parseAction } from "./brain";
import type { BrainConfig } from "./brain";
import { executeResearch } from "./bot";

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

// ── LLM-Driven Registration ────────────────────────────────

async function runPlatformAction(
  task: string,
  platformSpec: string,
  state: BotState | null,
  config: BrainConfig,
): Promise<string> {
  const stateContext = state
    ? `You are already registered. Your API key is: ${state.apiKey}\nYour agent name is: ${state.agentName}`
    : "You are NOT registered yet.";

  const messages: Array<{ role: string; content: string }> = [
    {
      role: "system",
      content: `You are an autonomous AI agent. You interact with a platform API using HTTP requests.

## Your State
${stateContext}

## Platform API Base URL
${PLATFORM_API}

## Platform Spec (citizen.md)
${platformSpec}

## Tools
1. http_request — {"method": "GET|POST|PATCH|DELETE", "url": "full URL", "body": "JSON string", "headers": "JSON string of extra headers"}
2. done — {"result": "what happened"}

## Rules
- Respond with ONE JSON object: {"reasoning": "...", "tool": "...", "input": {...}}
- For auth requests: {"Authorization": "Bearer ${state?.apiKey ?? "<api_key>"}"}
- Read error responses carefully — they contain hints on what to fix
- The payment header is lowercase: x-payment (not X-Payment)
- Payment info is at GET /payments/info (not /x402/info)`,
    },
    { role: "user", content: task },
  ];

  for (let i = 0; i < 10; i++) {
    const raw = await callOpenRouter(messages, config);
    const action = parseAction(raw);

    if (!action) {
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: 'Respond with valid JSON: {"reasoning": "...", "tool": "...", "input": {...}}' });
      continue;
    }

    if (action.tool === "done") return action.input.result ?? "Done";

    if (action.tool === "http_request") {
      const { method = "GET", url, body, headers: rawHeaders } = action.input;
      console.log(`   [${method}] ${url}`);

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (rawHeaders) {
          try { Object.assign(headers, JSON.parse(rawHeaders)); } catch {}
        }
        const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) };
        if (body && method !== "GET") opts.body = body;

        const res = await fetch(url, opts);
        const text = await res.text();
        const truncated = text.length > 3000 ? text.slice(0, 3000) + "...(truncated)" : text;

        console.log(`   → ${res.status} (${text.length} bytes)`);

        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: `HTTP ${res.status}\n${truncated}\n\nNext action?` });
      } catch (err: any) {
        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: `Request failed: ${err.message}\n\nNext action?` });
      }
      continue;
    }

    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: `Unknown tool "${action.tool}". Use http_request or done.` });
  }

  return "Max iterations reached";
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
      console.log("⟳ Not registered. Asking the brain to register...\n");
      const result = await runPlatformAction(
        `Register as a new agent on the platform.

Agent details:
- name: "${AGENT_NAME}"
- categories: ["research"]
- description: "Autonomous crypto research agent. Fetches live market data from CoinGecko and DeFiLlama, runs LLM analysis, and delivers structured research reports with risk scoring and sentiment analysis."
- basePrice: "2.00"

Steps to follow (from citizen.md):
1. POST /agents/check-availability to verify name is free
2. GET /payments/info to see payment requirements
3. For now, try registering and report what the API returns. If payment is required, report the payment details.

Report back the full API response.`,
        platformSpec,
        state,
        config,
      );

      console.log(`\n   Registration result: ${result}\n`);
      state = loadState();
      if (!state) {
        console.log("⚠ Registration incomplete. Set AGICITIZENS_API_KEY in .env to skip.\n");
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

  const biddedTasks = new Set<string>();   // tasks we already bid on
  const deliveredTasks = new Set<string>(); // tasks we already delivered

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
          console.warn(`   ⚠ Bid failed (${bidRes.status}): ${JSON.stringify(bidRes.data).slice(0, 100)}`);
        }
        biddedTasks.add(taskId);
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
