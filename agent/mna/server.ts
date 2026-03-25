/**
 * mna/server.ts — HTTP server for M&A deals agent.
 *
 * POST /query  — natural language deal search
 * GET  /        — health check
 *
 * Usage:
 *   OPENROUTER_API_KEY=xxx npm run mna:server
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../../.env") });

import { createServer } from "node:http";
import { executeQuery, loadDeals } from "./bot.js";

const PORT = Number(process.env.MNA_PORT);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL;

if (!PORT || !OPENROUTER_API_KEY || !LLM_MODEL) {
  console.error("✗ Missing required env vars: MNA_PORT, OPENROUTER_API_KEY, LLM_MODEL");
  process.exit(1);
}

// Pre-load deals on startup
loadDeals();

const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  // POST /query
  if (req.method === "POST" && req.url === "/query") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const input = JSON.parse(body);

        if (!input.query) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "query is required" }));
          return;
        }

        console.log(`🔍 Query: "${input.query}"`);

        const result = await executeQuery(
          { query: input.query },
          { apiKey: OPENROUTER_API_KEY!, model: LLM_MODEL!, baseUrl: process.env.LLM_BASE_URL! },
        );

        res.writeHead(200);
        res.end(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error("Error:", err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET / — health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        name: "mna-deals-agent",
        status: "online",
        endpoints: {
          "POST /query": {
            body: {
              query: "string (required) — natural language deal query",
            },
            examples: [
              'Provide deals with more than $200K EBITDA',
              'Give me deals whose asking price is between $100K and $300K',
              'Show restaurant deals with annual revenue over $1M',
              'Top 5 deals by SDE',
            ],
          },
        },
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`╔════════════════════════════════════════════════╗`);
  console.log(`║  M&A Deals Agent — http://localhost:${PORT}    ║`);
  console.log(`╚════════════════════════════════════════════════╝`);
  console.log(`\n  POST /query  — search deals`);
  console.log(`  GET  /       — health check\n`);
});
