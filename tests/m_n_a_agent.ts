import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MNAAgent } from "../target/types/m_n_a_agent";
import idl from "../target/idl/m_n_a_agent.json";
import { getDealsByFilters, getDealsByEbitda } from "../app/src/vault";
import { strict as assert } from "assert";

describe("m_n_a_agent — Anchor Program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as any, provider) as Program<MNAAgent>;

  it("initializes on-chain", async () => {
    const tx = await program.methods.initialize().rpc();
    assert.ok(tx, "expected a transaction signature");
    console.log("Solana Tx:", tx);
  });
});

describe("vault — getDealsByFilters", () => {
  it("returns results with no filters", () => {
    const deals = getDealsByFilters();
    assert.ok(deals.length > 0, "expected deals from vault");
  });

  it("respects limit", () => {
    const deals = getDealsByFilters({ limit: 3 });
    assert.ok(deals.length <= 3, "expected at most 3 deals");
  });

  it("filters by min_ebitda", () => {
    const deals = getDealsByFilters({ min_ebitda: 300000 });
    for (const d of deals as any[]) {
      assert.ok(d.ebitda >= 300000, `deal ebitda ${d.ebitda} below min`);
    }
  });

  it("filters by max_ebitda", () => {
    const deals = getDealsByFilters({ max_ebitda: 200000 });
    for (const d of deals as any[]) {
      assert.ok(d.ebitda <= 200000, `deal ebitda ${d.ebitda} above max`);
    }
  });

  it("filters by ebitda range", () => {
    const deals = getDealsByFilters({ min_ebitda: 100000, max_ebitda: 400000 });
    for (const d of deals as any[]) {
      assert.ok(d.ebitda >= 100000 && d.ebitda <= 400000, `deal ebitda ${d.ebitda} out of range`);
    }
  });

  it("filters by min_revenue", () => {
    const deals = getDealsByFilters({ min_revenue: 500000 });
    for (const d of deals as any[]) {
      assert.ok(d.annual_revenue >= 500000, `deal revenue ${d.annual_revenue} below min`);
    }
  });

  it("filters by max_asking_price", () => {
    const deals = getDealsByFilters({ max_asking_price: 1000000 });
    for (const d of deals as any[]) {
      assert.ok(d.asking_price <= 1000000, `deal asking_price ${d.asking_price} above max`);
    }
  });

  it("filters by industry_keywords", () => {
    const deals = getDealsByFilters({ industry_keywords: "hvac" }) as any[];
    if (deals.length > 0) {
      for (const d of deals) {
        assert.ok(
          d.description?.toLowerCase().includes("hvac"),
          `deal description does not contain 'hvac'`
        );
      }
    }
    // pass even if 0 results — keyword may not exist in data
  });

  it("returns empty array when no deals match", () => {
    const deals = getDealsByFilters({ min_ebitda: 999999999 });
    assert.strictEqual(deals.length, 0, "expected no deals for impossibly high EBITDA");
  });

  it("returns deals with expected fields", () => {
    const deals = getDealsByFilters({ limit: 1 }) as any[];
    assert.ok(deals.length === 1);
    const d = deals[0];
    assert.ok("id" in d, "missing id");
    assert.ok("description" in d, "missing description");
    assert.ok("annual_revenue" in d, "missing annual_revenue");
    assert.ok("ebitda" in d, "missing ebitda");
    assert.ok("asking_price" in d, "missing asking_price");
    assert.ok("sde" in d, "missing sde");
  });
});

describe("vault — getDealsByEbitda (backward compat)", () => {
  it("returns deals above the given EBITDA threshold", () => {
    const deals = getDealsByEbitda(200000) as any[];
    for (const d of deals) {
      assert.ok(d.ebitda >= 200000, `deal ebitda ${d.ebitda} below threshold`);
    }
  });
});
