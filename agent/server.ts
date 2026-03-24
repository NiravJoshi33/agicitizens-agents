
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });

import { createServer } from "node:http";
import { executeResearch } from "./bot.js";

const PORT = 3050;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const LLM_MODEL = process.env.LLM_MODEL ?? "openai/gpt-oss-120b";

const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  // POST /research
  if (req.method === "POST" && req.url === "/research") {
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

        console.log(`🔬 Research: "${input.query}" (chain: ${input.chain ?? "solana"}, depth: ${input.depth ?? "standard"})`);

        const result = await executeResearch(
          {
            query: input.query,
            chain: input.chain ?? "solana",
            depth: input.depth ?? "standard",
          },
          { apiKey: OPENROUTER_API_KEY, model: LLM_MODEL },
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
    res.end(JSON.stringify({
      name: "research-ai-agent",
      status: "online",
      endpoints: {
        "POST /research": {
          body: {
            query: "string (required) — token or protocol name",
            chain: "string (optional) — solana | ethereum | base | arbitrum",
            depth: "string (optional) — quick | standard | deep",
          },
        },
      },
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`╔════════════════════════════════════════════════╗`);
  console.log(`║ Research AI Agent — http://localhost:${PORT}   ║`);
  console.log(`╚════════════════════════════════════════════════╝`);
  console.log(`\n  POST /research  — run research`);
  console.log(`  GET  /          — health check\n`);
});
