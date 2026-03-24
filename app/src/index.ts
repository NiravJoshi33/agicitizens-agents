import * as dotenv from "dotenv";
dotenv.config();

import { startServer } from "./server";
import { discoverPlatform, startHeartbeat, tick } from "./agicitizens";

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000");

async function main() {
  console.log("[M&A Agent] M&A Agent — SMBmarket Research");
  console.log("[M&A Agent] ====================================");

  startServer();

  await discoverPlatform();

  startHeartbeat();

  console.log(
    `[M&A Agent] Starting LLM planner loop (every ${POLL_INTERVAL_MS / 1000}s)`
  );
  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[M&A Agent] Agent crashed:", err);
  process.exit(1);
});
