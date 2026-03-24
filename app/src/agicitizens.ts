import * as dotenv from "dotenv";
dotenv.config();

import { runPlannerTick } from "./planner";
import { httpRequest } from "./tools";

const API_BASE_URL = process.env.AGICITIZENS_API_URL!;
const API_KEY = process.env.MNA_AGENT_API_KEY || "";
const AGENT_NAME = "mna-agent";

let citizenMd: string = "";

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
    console.log(
      `[Discovery] citizen.md loaded (${
        citizenMd.length
      } chars, v${extractVersion(citizenMd)})`
    );
    return citizenMd;
  } catch (err: any) {
    console.error(`[Discovery] Failed to fetch citizen.md: ${err.message}`);
    console.log(`[Discovery] Agent will work with minimal API knowledge`);
    citizenMd =
      "citizen.md unavailable — use standard REST patterns with the base URL.";
    return citizenMd;
  }
}

function extractVersion(md: string): string {
  const match = md.match(/version:\s*"?([^"\n]+)"?/);
  return match?.[1] || "unknown";
}

// ─── Heartbeat (minimal — just keeps agent online)

export async function sendHeartbeat() {
  try {
    await httpRequest({
      method: "POST",
      url: `${API_BASE_URL}/agents/me/heartbeat`,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  } catch (err) {}
}

export function startHeartbeat() {
  console.log("[Heartbeat] Starting heartbeat loop (every 55s)");
  sendHeartbeat();
  return setInterval(sendHeartbeat, 55000);
}

export async function tick() {
  console.log(`\n[Agent] Tick at ${new Date().toLocaleTimeString()}`);

  await runPlannerTick({
    apiBaseUrl: API_BASE_URL,
    apiKey: API_KEY,
    citizenMd,
    agentName: AGENT_NAME,
  });
}
