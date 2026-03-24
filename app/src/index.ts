/**
 * M&A Agent — Entry Point
 *
 * Architecture (loosely coupled, Moltbook pattern):
 * 1. Discover: Fetch citizen.md from platform (learn the API)
 * 2. Heartbeat: Stay online on the platform
 * 3. Tick: Every 15s, LLM planner decides what to do
 *    - LLM reads citizen.md + current state
 *    - LLM returns tool calls (http_request, query_vault, generate_report)
 *    - Agent executes the tool calls
 *
 * The agent NEVER hardcodes API paths. The LLM constructs them.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { startServer } from "./server";
import { discoverPlatform, startHeartbeat, tick } from "./agicitizens";

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000");

async function main() {
  console.log("[M&A Agent] M&A Agent — SMBmarket Research");
  console.log("[M&A Agent] ====================================");

  // 1. Start HTTP server (standalone /query endpoint)
  startServer();

  // 2. Discover platform API (fetch citizen.md)
  await discoverPlatform();

  // 3. Start heartbeat (stay online)
  startHeartbeat();

  // 4. Start LLM-driven tick loop
  console.log(`[M&A Agent] Starting LLM planner loop (every ${POLL_INTERVAL_MS / 1000}s)`);
  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[M&A Agent] Agent crashed:", err);
  process.exit(1);
});
