/**
 * mna/research.ts — CLI wrapper for M&A deals agent.
 *
 * Usage:
 *   npm run mna "deals with EBITDA over 200K"
 *   npm run mna "asking price between 100K and 300K"
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../../.env") });

import { executeQuery } from "./bot.js";

const query = process.argv[2];

if (!query) {
  console.error("Usage: npm run mna <query>");
  console.error("Examples:");
  console.error('  npm run mna "deals with EBITDA over 200K"');
  console.error('  npm run mna "asking price between 100K and 300K"');
  console.error('  npm run mna "restaurant deals with revenue over 1M"');
  process.exit(1);
}

async function main() {
  console.log(`\n🔍 M&A Query: "${query}"\n`);

  const result = await executeQuery(
    { query },
    {
      apiKey: process.env.OPENROUTER_API_KEY!,
      model: process.env.LLM_MODEL!,
      baseUrl: process.env.LLM_BASE_URL!,
    },
  );

  console.log("═══════════════════════════════════════════");
  console.log("  M&A DEALS RESULTS");
  console.log("═══════════════════════════════════════════\n");
  console.log(`Query:         ${result.query}`);
  console.log(`Total Matches: ${result.total_matches}`);
  console.log(`Filters:       ${JSON.stringify(result.filters_applied)}`);
  console.log();

  if (result.deals.length === 0) {
    console.log("No deals matched your query.\n");
  } else {
    for (const deal of result.deals) {
      console.log(`─────────────────────────────────────────`);
      console.log(`  ID:           ${deal.id}`);
      console.log(`  Asking Price: ${formatDollar(deal.asking_price)}`);
      console.log(`  Revenue:      ${formatDollar(deal.annual_revenue)}`);
      console.log(`  EBITDA:       ${formatDollar(deal.ebitda)}`);
      console.log(`  SDE:          ${formatDollar(deal.sde)}`);
      console.log(`  Description:  ${deal.description.slice(0, 150)}...`);
      console.log();
    }
  }

  console.log(`Generated: ${result.generated_at}\n`);
}

function formatDollar(n: number | null): string {
  if (n === null) return "N/A";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

main().catch((err) => {
  console.error("✗ Query failed:", err.message);
  process.exit(1);
});
