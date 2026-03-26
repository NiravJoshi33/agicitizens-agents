import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseQuery } from "./brain.js";

export interface Deal {
  id: string;
  description: string;
  asking_price: number | null;
  annual_revenue: number | null;
  ebitda: number | null;
  sde: number | null;
}

export interface DealFilter {
  field: "asking_price" | "annual_revenue" | "ebitda" | "sde";
  operator: "gt" | "gte" | "lt" | "lte" | "eq" | "between";
  value: number;
  value2?: number;
}

export interface ParsedQuery {
  filters: DealFilter[];
  keyword?: string;
  sort_by?: string;
  sort_order?: "asc" | "desc";
  limit?: number;
}

export interface MnaInput {
  query: string;
}

export interface MnaOutput {
  query: string;
  total_matches: number;
  filters_applied: DealFilter[];
  deals: Deal[];
  generated_at: string;
}

let cachedDeals: Deal[] | null = null;

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseNumber(val: string): number | null {
  if (!val || val.trim() === "" || val.trim().toLowerCase() === "null")
    return null;
  const cleaned = val.replace(/[$,\s]/g, "");
  const num = Number(cleaned);
  return isNaN(num) ? null : num;
}

export function loadDeals(csvPath?: string): Deal[] {
  if (cachedDeals) return cachedDeals;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const path = csvPath ?? resolve(__dirname, process.env.CSV_PATH!);
  if (!path) throw new Error("CSV_PATH env var is required");
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const deals: Deal[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 6) continue;

    deals.push({
      id: fields[0].trim(),
      description: fields[1].trim(),
      asking_price: parseNumber(fields[2]),
      annual_revenue: parseNumber(fields[3]),
      ebitda: parseNumber(fields[4]),
      sde: parseNumber(fields[5]),
    });
  }

  cachedDeals = deals;
  console.log(`   ✓ Loaded ${deals.length} deals from CSV`);
  return deals;
}

function applyFilter(deal: Deal, filter: DealFilter): boolean {
  const val = deal[filter.field];
  if (val === null) return false;

  switch (filter.operator) {
    case "gt":
      return val > filter.value;
    case "gte":
      return val >= filter.value;
    case "lt":
      return val < filter.value;
    case "lte":
      return val <= filter.value;
    case "eq":
      return val === filter.value;
    case "between":
      return val >= filter.value && val <= (filter.value2 ?? filter.value);
    default:
      return true;
  }
}

export function filterDeals(deals: Deal[], parsed: ParsedQuery): Deal[] {
  let results = deals;

  for (const filter of parsed.filters) {
    results = results.filter((d) => applyFilter(d, filter));
  }

  if (parsed.keyword) {
    const kw = parsed.keyword.toLowerCase();
    results = results.filter((d) => d.description.toLowerCase().includes(kw));
  }

  if (parsed.sort_by) {
    const field = parsed.sort_by as keyof Deal;
    const order = parsed.sort_order === "desc" ? -1 : 1;
    results.sort((a, b) => {
      const va = (a[field] as number) ?? 0;
      const vb = (b[field] as number) ?? 0;
      return (va - vb) * order;
    });
  }

  if (parsed.limit && parsed.limit > 0) {
    results = results.slice(0, parsed.limit);
  }

  return results;
}

export async function executeQuery(
  input: MnaInput,
  llmConfig?: { apiKey: string; model?: string; baseUrl?: string },
): Promise<MnaOutput> {
  const { query } = input;
  const deals = loadDeals();

  if (!llmConfig?.apiKey) {
    return {
      query,
      total_matches: 0,
      filters_applied: [],
      deals: [],
      generated_at: new Date().toISOString(),
    };
  }

  const parsed = await parseQuery(query, llmConfig);

  console.log(`   Filters: ${JSON.stringify(parsed.filters)}`);
  if (parsed.keyword) console.log(`   Keyword: "${parsed.keyword}"`);

  const matched = filterDeals(deals, parsed);

  return {
    query,
    total_matches: matched.length,
    filters_applied: parsed.filters,
    deals: matched,
    generated_at: new Date().toISOString(),
  };
}
