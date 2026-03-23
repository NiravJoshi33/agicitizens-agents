/**
 * researchbot standalone — run a research query directly.
 *
 * Usage:
 *   npx tsx src/research.ts "solana"
 *   npx tsx src/research.ts "ethereum" deep
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });

import { executeResearch } from "./bot.js";

const query = process.argv[2];
const depth = process.argv[3] ?? "standard";

if (!query) {
  console.error("Usage: npx tsx src/research.ts <query> [quick|standard|deep]");
  console.error("Examples:");
  console.error('  npx tsx src/research.ts "solana"');
  console.error('  npx tsx src/research.ts "bitcoin" deep');
  console.error('  npx tsx src/research.ts "uniswap" quick');
  process.exit(1);
}

async function main() {
  console.log(`\n🔬 Researching: "${query}" (depth: ${depth})\n`);

  const result = await executeResearch(
    { query, chain: "solana", depth },
    {
      apiKey: process.env.OPENROUTER_API_KEY!,
      model: process.env.LLM_MODEL ?? "openai/gpt-oss-120b",
    },
  );

  console.log("═══════════════════════════════════════════");
  console.log("  RESEARCH OUTPUT");
  console.log("═══════════════════════════════════════════\n");
  console.log(`Token:      ${result.token}`);
  console.log(`Summary:    ${result.summary}`);
  console.log(`Risk Score: ${result.risk_score}/10`);
  console.log(`Sentiment:  ${result.sentiment}`);

  if (result.market_data) {
    console.log(`\nMarket Data:`);
    console.log(`  Price:       $${result.market_data.price}`);
    console.log(`  Market Cap:  ${result.market_data.market_cap}`);
    console.log(`  Volume 24h:  ${result.market_data.volume_24h}`);
    console.log(`  Change 24h:  ${result.market_data.price_change_24h}`);
  }

  if (result.defi_exposure?.length) {
    console.log(`\nDeFi Exposure:`);
    for (const d of result.defi_exposure) {
      console.log(`  ${d.protocol}: TVL ${d.tvl}`);
    }
  }

  if (result.key_findings.length) {
    console.log(`\nKey Findings:`);
    for (const f of result.key_findings) {
      console.log(`  • ${f}`);
    }
  }

  console.log(`\nSources: ${result.sources.join(", ")}`);
  console.log(`Generated: ${result.generated_at}\n`);
}

main().catch((err) => {
  console.error("✗ Research failed:", err.message);
  process.exit(1);
});
