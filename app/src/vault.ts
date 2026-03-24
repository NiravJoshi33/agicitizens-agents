import Database from "better-sqlite3";
import path from "path";
import * as dotenv from "dotenv";
import { PublicKey } from "@solana/web3.js";

dotenv.config();

export const MNA_PROGRAM_ID = new PublicKey(process.env.MNA_PROGRAM_ID!);

const dbPath = path.resolve(__dirname, "../../data/mna_vault.db");
const db = new Database(dbPath);

export interface DealFilters {
  min_ebitda?: number;
  max_ebitda?: number;
  min_revenue?: number;
  max_revenue?: number;
  max_asking_price?: number;
  min_asking_price?: number;
  industry_keywords?: string;
  limit?: number;
}

export function getDealsByFilters(filters: DealFilters = {}) {
  const {
    min_ebitda = 0,
    max_ebitda,
    min_revenue = 0,
    max_revenue,
    max_asking_price,
    min_asking_price,
    industry_keywords,
    limit = 5,
  } = filters;

  const conditions: string[] = [];
  const params: (number | string)[] = [];

  conditions.push("ebitda >= ?");
  params.push(min_ebitda);

  if (max_ebitda !== undefined) {
    conditions.push("ebitda <= ?");
    params.push(max_ebitda);
  }

  conditions.push("annual_revenue >= ?");
  params.push(min_revenue);

  if (max_revenue !== undefined) {
    conditions.push("annual_revenue <= ?");
    params.push(max_revenue);
  }

  if (min_asking_price !== undefined) {
    conditions.push("asking_price >= ?");
    params.push(min_asking_price);
  }

  if (max_asking_price !== undefined) {
    conditions.push("asking_price <= ?");
    params.push(max_asking_price);
  }

  if (industry_keywords) {
    conditions.push("LOWER(description) LIKE ?");
    params.push(`%${industry_keywords.toLowerCase()}%`);
  }

  const where = conditions.join(" AND ");
  const query = `
    SELECT id, description, annual_revenue, ebitda, asking_price, sde
    FROM listings
    WHERE ${where}
    ORDER BY ebitda DESC
    LIMIT ?
  `;
  params.push(limit);

  return db.prepare(query).all(...params);
}

export function getDealsByEbitda(minEbitda: number) {
  return getDealsByFilters({ min_ebitda: minEbitda });
}

console.log(`[M&A Agent] Vault Online. Program ID: ${MNA_PROGRAM_ID.toBase58()}`);
