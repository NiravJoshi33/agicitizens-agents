/**
 * index.ts — Fully spec-driven platform agent.
 *
 * Reads citizen.md on startup, uses LLM to parse it into a "playbook"
 * covering endpoints, query params, request body shapes, response field
 * names, and agent config — then runs a bid→deliver loop driven
 * entirely by the playbook. No hardcoded API paths, field names, or
 * magic constants.
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
import { callOpenRouter, type BrainConfig } from "./brain";
import { executeResearch } from "./bot";
import {
  loadKeypairFromEnv,
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

// ── Playbook: fully dynamic config from platform spec ───────

interface PlatformPlaybook {
  endpoints: {
    checkAvailability: string;
    paymentInfo: string;
    register: string;
    authChallenge: string;
    authVerify: string;
    heartbeat: string;
    faucet: string;
    tasks: string;
    bid: string;
    deliver: string;
    rate: string;
  };

  taskFilters: {
    open: Record<string, string>;
    assigned: Record<string, string>;
    disputed: Record<string, string>;
    verified: Record<string, string>;
  };

  // Request body templates — keys are API field names, values are
  // "{varName}" placeholders resolved at runtime, or literal strings.
  requestBodies: {
    checkAvailability: Record<string, string>;
    register: Record<string, string>;
    authChallenge: Record<string, string>;
    authVerify: Record<string, string>;
    bid: Record<string, string>;
    deliver: Record<string, string>;
    rate: Record<string, string>;
    faucet: Record<string, string>;
  };

  // Response field names — where to find specific values in API responses.
  responseKeys: {
    taskList: string;        // key containing the task array in list response
    taskId: string;          // task identifier field
    taskTitle: string;       // task title field
    taskBudget: string;      // task budget / price field
    taskInput: string;       // task input payload field
    taskDescription: string; // task description field
    apiKey: string;          // API key field in registration/auth response
    challenge: string;       // challenge string in auth challenge response
    nameTaken: string;       // boolean field: name already registered
    walletTaken: string;     // boolean field: wallet already registered
    paymentAmount: string;   // payment amount field in payment info
    paymentCurrency: string; // payment currency field
    paymentRecipient: string;// recipient address field
    paymentMint: string;     // token mint field
  };

  // Agent identity & config
  registration: {
    categories: string[];
    description: string;
    basePrice: string;
  };
  bidMessage: string;
  ratingValue: number;
  faucetThreshold: number;
  paymentHeader: string;     // header name for signed transaction
}

const DEFAULT_PLAYBOOK: PlatformPlaybook = {
  endpoints: {
    checkAvailability: "/agents/check-availability",
    paymentInfo: "/payments/info",
    register: "/agents/register",
    authChallenge: "/auth/challenge",
    authVerify: "/auth/verify",
    heartbeat: "/agents/me/heartbeat",
    faucet: "/faucet",
    tasks: "/tasks",
    bid: "/bids/{taskId}",
    deliver: "/tasks/{taskId}/deliver",
    rate: "/tasks/{taskId}/rate",
  },
  taskFilters: {
    open: { status: "OPEN", category: "research", limit: "5" },
    assigned: { status: "IN_PROGRESS", provider: "{agentName}", limit: "10" },
    disputed: { status: "DISPUTED", provider: "{agentName}", limit: "5" },
    verified: { status: "VERIFIED", provider: "{agentName}", limit: "10" },
  },
  requestBodies: {
    checkAvailability: { name: "{agentName}", wallet: "{wallet}" },
    register: {
      name: "{agentName}",
      wallet: "{wallet}",
      categories: "{categories}",
      description: "{description}",
      basePrice: "{basePrice}",
    },
    authChallenge: { wallet: "{wallet}" },
    authVerify: { wallet: "{wallet}", challenge: "{challenge}", signature: "{signature}" },
    bid: { price: "{price}", message: "{message}" },
    deliver: { output: "{output}" },
    rate: { rating: "{rating}" },
    faucet: { wallet: "{wallet}" },
  },
  responseKeys: {
    taskList: "data",
    taskId: "taskId",
    taskTitle: "title",
    taskBudget: "budget",
    taskInput: "input",
    taskDescription: "description",
    apiKey: "apiKey",
    challenge: "challenge",
    nameTaken: "nameTaken",
    walletTaken: "walletTaken",
    paymentAmount: "amount",
    paymentCurrency: "currency",
    paymentRecipient: "recipient",
    paymentMint: "mint",
  },
  registration: {
    categories: ["research"],
    description:
      "Autonomous crypto research agent. Fetches live market data from CoinGecko and DeFiLlama, runs LLM analysis, and delivers structured research reports with risk scoring and sentiment analysis.",
    basePrice: "2.00",
  },
  bidMessage:
    "Research agent ready. I fetch live data from CoinGecko + DeFiLlama and run LLM analysis to deliver structured reports with risk scoring and sentiment.",
  ratingValue: 4,
  faucetThreshold: 1,
  paymentHeader: "x-payment",
};

// ── Template resolution ─────────────────────────────────────

function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

function resolveParams(
  params: Record<string, string>,
  vars: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    resolved[k] = resolveTemplate(v, vars);
  }
  return resolved;
}

function buildPath(
  pathTemplate: string,
  vars: Record<string, string>,
  queryParams?: Record<string, string>,
): string {
  const path = resolveTemplate(pathTemplate, vars);
  if (!queryParams || Object.keys(queryParams).length === 0) return path;
  const resolved = resolveParams(queryParams, vars);
  return `${path}?${new URLSearchParams(resolved).toString()}`;
}

/**
 * Build a request body from a playbook template + runtime variables.
 * Template values like "{wallet}" are replaced with vars.wallet.
 * Template values like "{categories}" can resolve to any type (array, number).
 */
function buildBody(
  template: Record<string, string>,
  vars: Record<string, any>,
): Record<string, any> {
  const body: Record<string, any> = {};
  for (const [key, tpl] of Object.entries(template)) {
    const match = tpl.match(/^\{(\w+)\}$/);
    if (match) {
      const varName = match[1];
      body[key] = vars[varName] ?? tpl;
    } else {
      // Literal value or mixed template
      body[key] = resolveTemplate(tpl, vars as Record<string, string>);
    }
  }
  return body;
}

/**
 * Read a field from an API response using the playbook key.
 * Falls back to common alternatives if the primary key misses.
 */
function readField(data: any, key: string, ...fallbacks: string[]): any {
  if (data?.[key] !== undefined) return data[key];
  for (const fb of fallbacks) {
    if (data?.[fb] !== undefined) return data[fb];
  }
  return undefined;
}

// ── Build playbook from spec via LLM ────────────────────────

async function buildPlaybookFromSpec(
  specText: string,
  config: BrainConfig,
): Promise<PlatformPlaybook> {
  if (!specText || specText === "(Platform spec unavailable)") {
    console.log("   ⚠ No spec available, using default playbook");
    return DEFAULT_PLAYBOOK;
  }

  try {
    const messages = [
      {
        role: "system",
        content:
          "You extract structured API configuration from a platform specification document. Return ONLY valid JSON — no markdown fences, no explanation, no trailing text.",
      },
      {
        role: "user",
        content: `Parse this platform API spec and extract the FULL configuration an autonomous agent needs.

SPEC:
${specText}

Return JSON matching this schema. Use {taskId} and {agentName} as placeholders for dynamic path/query values.
For request body templates, use {varName} placeholders for values the agent fills at runtime.

{
  "endpoints": {
    "checkAvailability": "/path",
    "paymentInfo": "/path",
    "register": "/path",
    "authChallenge": "/path",
    "authVerify": "/path",
    "heartbeat": "/path",
    "faucet": "/path",
    "tasks": "/base-path",
    "bid": "/path/{taskId}",
    "deliver": "/path/{taskId}/action",
    "rate": "/path/{taskId}/action"
  },
  "taskFilters": {
    "open": {"queryParam": "value", "...": "..."},
    "assigned": {"queryParam": "{agentName}", "...": "..."},
    "disputed": {"queryParam": "{agentName}", "...": "..."},
    "verified": {"queryParam": "{agentName}", "...": "..."}
  },
  "requestBodies": {
    "checkAvailability": {"fieldName": "{agentName}", "fieldName2": "{wallet}"},
    "register": {"fieldName": "{agentName}", "fieldName2": "{wallet}", "fieldName3": "{categories}", "fieldName4": "{description}", "fieldName5": "{basePrice}"},
    "authChallenge": {"fieldName": "{wallet}"},
    "authVerify": {"fieldName": "{wallet}", "fieldName2": "{challenge}", "fieldName3": "{signature}"},
    "bid": {"fieldName": "{price}", "fieldName2": "{message}"},
    "deliver": {"fieldName": "{output}"},
    "rate": {"fieldName": "{rating}"},
    "faucet": {"fieldName": "{wallet}"}
  },
  "responseKeys": {
    "taskList": "fieldName containing task array in list response",
    "taskId": "field name for task ID",
    "taskTitle": "field name for task title",
    "taskBudget": "field name for task budget/price",
    "taskInput": "field name for task input payload",
    "taskDescription": "field name for task description",
    "apiKey": "field name for API key in auth/register response",
    "challenge": "field name for challenge string",
    "nameTaken": "field name for name-taken boolean",
    "walletTaken": "field name for wallet-taken boolean",
    "paymentAmount": "field for payment amount",
    "paymentCurrency": "field for payment currency",
    "paymentRecipient": "field for recipient address",
    "paymentMint": "field for token mint address"
  },
  "registration": {
    "categories": ["category ids or names for a research agent"],
    "description": "appropriate agent description",
    "basePrice": "price string"
  },
  "bidMessage": "default bid message",
  "ratingValue": 4,
  "faucetThreshold": 1,
  "paymentHeader": "header name for signed payment transaction"
}

Only include fields you can confidently extract. Omit any you are unsure about.`,
      },
    ];

    const raw = await callOpenRouter(messages, config);

    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) json = JSON.parse(match[0]);
    }

    if (!json) {
      console.log("   ⚠ Could not parse LLM playbook response, using defaults");
      return DEFAULT_PLAYBOOK;
    }

    // Deep merge: LLM output overrides defaults where present
    const playbook: PlatformPlaybook = {
      endpoints: { ...DEFAULT_PLAYBOOK.endpoints, ...json.endpoints },
      taskFilters: {
        open: { ...DEFAULT_PLAYBOOK.taskFilters.open, ...json.taskFilters?.open },
        assigned: { ...DEFAULT_PLAYBOOK.taskFilters.assigned, ...json.taskFilters?.assigned },
        disputed: { ...DEFAULT_PLAYBOOK.taskFilters.disputed, ...json.taskFilters?.disputed },
        verified: { ...DEFAULT_PLAYBOOK.taskFilters.verified, ...json.taskFilters?.verified },
      },
      requestBodies: {
        checkAvailability: { ...DEFAULT_PLAYBOOK.requestBodies.checkAvailability, ...json.requestBodies?.checkAvailability },
        register: { ...DEFAULT_PLAYBOOK.requestBodies.register, ...json.requestBodies?.register },
        authChallenge: { ...DEFAULT_PLAYBOOK.requestBodies.authChallenge, ...json.requestBodies?.authChallenge },
        authVerify: { ...DEFAULT_PLAYBOOK.requestBodies.authVerify, ...json.requestBodies?.authVerify },
        bid: { ...DEFAULT_PLAYBOOK.requestBodies.bid, ...json.requestBodies?.bid },
        deliver: { ...DEFAULT_PLAYBOOK.requestBodies.deliver, ...json.requestBodies?.deliver },
        rate: { ...DEFAULT_PLAYBOOK.requestBodies.rate, ...json.requestBodies?.rate },
        faucet: { ...DEFAULT_PLAYBOOK.requestBodies.faucet, ...json.requestBodies?.faucet },
      },
      responseKeys: { ...DEFAULT_PLAYBOOK.responseKeys, ...json.responseKeys },
      registration: { ...DEFAULT_PLAYBOOK.registration, ...json.registration },
      bidMessage: json.bidMessage ?? DEFAULT_PLAYBOOK.bidMessage,
      ratingValue: json.ratingValue ?? DEFAULT_PLAYBOOK.ratingValue,
      faucetThreshold: json.faucetThreshold ?? DEFAULT_PLAYBOOK.faucetThreshold,
      paymentHeader: json.paymentHeader ?? DEFAULT_PLAYBOOK.paymentHeader,
    };

    console.log("   ✓ Playbook built from spec");
    return playbook;
  } catch (err: any) {
    console.warn(`   ⚠ Playbook extraction failed: ${err.message} — using defaults`);
    return DEFAULT_PLAYBOOK;
  }
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

async function platformPost(
  path: string,
  body: any,
  apiKey: string,
  extraHeaders?: Record<string, string>,
  retries = 1,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${PLATFORM_API}${path}`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  checkVersionHeader(res.headers);

  if (res.status === 429 && retries > 0) {
    const retryAfter = Number(res.headers.get("retry-after") ?? 5);
    console.log(`   ⏳ Rate limited — retrying in ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return platformPost(path, body, apiKey, extraHeaders, retries - 1);
  }

  if (res.status >= 500 && retries > 0) {
    await new Promise((r) => setTimeout(r, 2000));
    return platformPost(path, body, apiKey, extraHeaders, retries - 1);
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

// Raw POST/GET without auth — used for registration/auth/faucet flows
async function rawPost(
  path: string,
  body: any,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${PLATFORM_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

async function rawGet(path: string): Promise<any> {
  const res = await fetch(`${PLATFORM_API}${path}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
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

// ── Registration (Solana x-payment) ─────────────────────────

async function registerAgent(playbook: PlatformPlaybook): Promise<BotState | null> {
  const keypair = loadKeypairFromEnv();
  if (!keypair) {
    console.error("✗ AGENT_WALLET_KEYPAIR is required in .env for registration");
    return null;
  }

  const wallet = keypair.publicKey.toBase58();
  const rk = playbook.responseKeys;
  console.log(`   Wallet: ${wallet}`);

  // Check balances & faucet if needed
  const balances = await getBalances(keypair.publicKey);
  console.log(`   Balances: ${balances.sol} SOL, ${balances.usdc} USDC`);

  if (balances.usdc < playbook.faucetThreshold) {
    console.log("   Requesting faucet USDC...");
    const faucetBody = buildBody(playbook.requestBodies.faucet, { wallet });
    const faucetRes = await rawPost(playbook.endpoints.faucet, faucetBody);
    if (faucetRes.ok) {
      console.log(`   Faucet funded: ${JSON.stringify(faucetRes.data)}`);
    } else {
      console.warn(`   ⚠ Faucet failed (${faucetRes.status}) — you may need to fund the wallet manually`);
    }
    await new Promise((r) => setTimeout(r, 3000));
    const newBalances = await getBalances(keypair.publicKey);
    console.log(`   Updated balances: ${newBalances.sol} SOL, ${newBalances.usdc} USDC`);
  }

  // Check name availability
  console.log(`   Checking availability for "${AGENT_NAME}"...`);
  const checkBody = buildBody(playbook.requestBodies.checkAvailability, {
    agentName: AGENT_NAME,
    wallet,
  });
  const checkRes = await rawPost(playbook.endpoints.checkAvailability, checkBody);

  if (!checkRes.ok) {
    console.error(`   ✗ Availability check failed (${checkRes.status}): ${JSON.stringify(checkRes.data)}`);
    return null;
  }

  const nameTaken = readField(checkRes.data, rk.nameTaken);
  const walletTaken = readField(checkRes.data, rk.walletTaken);
  if (nameTaken || walletTaken) {
    console.log("   Name/wallet already registered — attempting auth challenge...");
    return await challengeAuth(keypair, wallet, playbook);
  }

  console.log("   ✓ Name available");

  // Get payment info
  console.log("   Fetching payment info...");
  const payInfo = await rawGet(playbook.endpoints.paymentInfo);
  const payAmount = readField(payInfo, rk.paymentAmount);
  const payCurrency = readField(payInfo, rk.paymentCurrency);
  const payRecipient = readField(payInfo, rk.paymentRecipient);
  const payMint = readField(payInfo, rk.paymentMint);
  console.log(`   Payment: ${payAmount} ${payCurrency} → ${payRecipient}`);

  const amountBaseUnits = Math.round(parseFloat(payAmount || "1") * 1e6);

  // Sign USDC transfer
  console.log("   Signing USDC payment transaction...");
  const { xPayment, error: signError } = await signPayment(
    keypair,
    payRecipient,
    amountBaseUnits,
    true,
    payMint,
  );

  if (signError || !xPayment) {
    console.error(`   ✗ ${signError}`);
    return null;
  }
  console.log(`   ✓ Signed (${xPayment.length} chars base64)`);

  // Register with payment header
  console.log("   Registering agent...");
  const regBody = buildBody(playbook.requestBodies.register, {
    agentName: AGENT_NAME,
    wallet,
    categories: playbook.registration.categories,
    description: playbook.registration.description,
    basePrice: playbook.registration.basePrice,
  });
  const regRes = await rawPost(
    playbook.endpoints.register,
    regBody,
    { [playbook.paymentHeader]: xPayment },
  );

  if (!regRes.ok) {
    console.error(`   ✗ Registration failed (${regRes.status}): ${JSON.stringify(regRes.data)}`);
    return null;
  }

  const apiKey = readField(regRes.data, rk.apiKey);
  if (!apiKey) {
    console.error("   ✗ No apiKey in registration response");
    console.log(`   Response: ${JSON.stringify(regRes.data)}`);
    return null;
  }

  console.log(`   ✓ Registered! API key: ${apiKey.slice(0, 12)}...`);
  const state: BotState = { apiKey, agentName: AGENT_NAME };
  saveState(state);
  return state;
}

// ── Challenge-Response Auth ─────────────────────────────────

async function challengeAuth(
  keypair: ReturnType<typeof loadKeypairFromEnv>,
  wallet: string,
  playbook: PlatformPlaybook,
): Promise<BotState | null> {
  if (!keypair) return null;
  const rk = playbook.responseKeys;

  try {
    const challengeBody = buildBody(playbook.requestBodies.authChallenge, { wallet });
    const challengeRes = await rawPost(playbook.endpoints.authChallenge, challengeBody);
    const challenge = readField(challengeRes.data, rk.challenge);
    if (!challenge) {
      console.error("   ✗ No challenge received");
      return null;
    }

    const signature = signMessage(keypair, challenge);

    const verifyBody = buildBody(playbook.requestBodies.authVerify, {
      wallet,
      challenge,
      signature,
    });
    const verifyRes = await rawPost(playbook.endpoints.authVerify, verifyBody);
    const apiKey = readField(verifyRes.data, rk.apiKey);

    if (!verifyRes.ok || !apiKey) {
      console.error(`   ✗ Auth failed (${verifyRes.status}): ${JSON.stringify(verifyRes.data)}`);
      return null;
    }

    console.log(`   ✓ Authenticated via challenge! API key: ${apiKey.slice(0, 12)}...`);
    const state: BotState = { apiKey, agentName: AGENT_NAME };
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

  // Build playbook from spec
  console.log("🧩 Building playbook from spec...");
  const playbook = await buildPlaybookFromSpec(platformSpec, config);
  console.log(`   Endpoints: ${Object.keys(playbook.endpoints).length} configured`);
  console.log(`   Categories: ${playbook.registration.categories.join(", ")}\n`);

  // Load or register
  let state = loadState();

  if (!state) {
    if (process.env.AGICITIZENS_API_KEY) {
      state = { apiKey: process.env.AGICITIZENS_API_KEY, agentName: AGENT_NAME };
      saveState(state);
      console.log(`✓ Using API key from .env\n`);
    } else {
      console.log("⟳ Not registered. Starting Solana-based registration...\n");
      state = await registerAgent(playbook);
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

  // Template vars shared across all path resolution
  const vars: Record<string, string> = { agentName: state.agentName };
  const rk = playbook.responseKeys;

  // ── Heartbeat loop ──────────────────────────────────────

  const sendHeartbeat = async () => {
    try {
      const res = await fetch(`${PLATFORM_API}${playbook.endpoints.heartbeat}`, {
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

  const biddedTasks = new Set<string>(state!.biddedTaskIds ?? []);
  const deliveredTasks = new Set<string>(state!.deliveredTaskIds ?? []);

  const persistTracking = () => {
    state!.biddedTaskIds = [...biddedTasks];
    state!.deliveredTaskIds = [...deliveredTasks];
    saveState(state!);
  };

  const extractTaskId = (task: any): string | undefined =>
    readField(task, rk.taskId, "task_id", "id");

  const extractTaskTitle = (task: any): string =>
    readField(task, rk.taskTitle, "name") ?? "research";

  const extractTaskBudget = (task: any): string =>
    readField(task, rk.taskBudget, "amountUsdc", "price") ?? playbook.registration.basePrice;

  const extractTaskInput = (task: any): any =>
    readField(task, rk.taskInput) ?? {
      query: extractTaskTitle(task) ?? readField(task, rk.taskDescription, "desc") ?? "crypto",
    };

  const extractTaskList = (data: any): any[] =>
    readField(data, rk.taskList, "tasks", "items", "results") ?? [];

  const poll = async () => {
    // ── Phase 1: Find OPEN tasks and bid ──────────────────
    try {
      const openPath = buildPath(playbook.endpoints.tasks, vars, playbook.taskFilters.open);
      const openData = await platformGet(openPath, state!.apiKey);
      const openTasks = extractTaskList(openData);

      for (const task of openTasks) {
        const taskId = extractTaskId(task);
        if (!taskId || biddedTasks.has(taskId)) continue;

        const title = extractTaskTitle(task);
        const budget = extractTaskBudget(task);
        console.log(`🔍 Open task: ${taskId} — "${title}" (${budget} USDC)`);

        const bidPath = resolveTemplate(playbook.endpoints.bid, { ...vars, taskId });
        const bidBody = buildBody(playbook.requestBodies.bid, {
          price: budget,
          message: playbook.bidMessage,
        });
        const bidRes = await platformPost(bidPath, bidBody, state!.apiKey);

        if (bidRes.ok) {
          console.log(`   ✓ Bid placed: ${budget} USDC`);
        } else {
          const msg = JSON.stringify(bidRes.data).slice(0, 120);
          if (msg.includes("pending bid") || msg.includes("already")) {
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
      const assignedPath = buildPath(playbook.endpoints.tasks, vars, playbook.taskFilters.assigned);
      const myData = await platformGet(assignedPath, state!.apiKey);
      const myTasks = extractTaskList(myData);

      for (const task of myTasks) {
        const taskId = extractTaskId(task);
        if (!taskId || deliveredTasks.has(taskId)) continue;

        console.log(`🔬 Assigned task: ${taskId} — "${extractTaskTitle(task)}"`);

        try {
          const input = extractTaskInput(task);
          const output = await executeResearch(input, config);

          const deliverPath = resolveTemplate(playbook.endpoints.deliver, { ...vars, taskId });
          const deliverBody = buildBody(playbook.requestBodies.deliver, { output });
          const deliverRes = await platformPost(deliverPath, deliverBody, state!.apiKey);

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
      const disputedPath = buildPath(playbook.endpoints.tasks, vars, playbook.taskFilters.disputed);
      const disputedData = await platformGet(disputedPath, state!.apiKey);
      const disputedTaskList = extractTaskList(disputedData);

      for (const task of disputedTaskList) {
        const taskId = extractTaskId(task);
        if (!taskId || deliveredTasks.has(`disputed-${taskId}`)) continue;

        console.log(`⚠ Disputed task: ${taskId} — re-researching...`);

        try {
          const input = extractTaskInput(task);
          const output = await executeResearch({ ...input, depth: "deep" }, config);

          const deliverPath = resolveTemplate(playbook.endpoints.deliver, { ...vars, taskId });
          const deliverBody = buildBody(playbook.requestBodies.deliver, { output });
          const redeliverRes = await platformPost(deliverPath, deliverBody, state!.apiKey);

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
      const verifiedPath = buildPath(playbook.endpoints.tasks, vars, playbook.taskFilters.verified);
      const verifiedData = await platformGet(verifiedPath, state!.apiKey);
      const verifiedTaskList = extractTaskList(verifiedData);

      for (const task of verifiedTaskList) {
        const taskId = extractTaskId(task);
        if (!taskId) continue;

        const ratePath = resolveTemplate(playbook.endpoints.rate, { ...vars, taskId });
        const rateBody = buildBody(playbook.requestBodies.rate, {
          rating: playbook.ratingValue,
        });
        const rateRes = await platformPost(ratePath, rateBody, state!.apiKey);

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
