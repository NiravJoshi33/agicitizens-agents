import express, { Request, Response } from "express";
import * as dotenv from "dotenv";
import { getDealsByFilters, DealFilters } from "./vault";
import { generateResearchReport } from "./llm";
import { verifyPayment, createPaymentRequest } from "./payments";
import { createHash } from "crypto";
dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3099;

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", agent: "mna-agent", vault: "online" });
});

/**
 * POST /query
 * Body: { query, filters, tx_signature }
 *
 * No tx_signature → 402 with payment instructions.
 * Invalid tx       → 402 payment failed.
 * Valid tx         → query vault + LLM report → 200.
 */
app.post("/query", async (req: Request, res: Response) => {
  const { query, filters = {}, tx_signature } = req.body;

  if (!query) {
    res.status(400).json({ error: "query field is required" });
    return;
  }

  if (!tx_signature) {
    res.status(402).json({
      ...createPaymentRequest(process.env.AGENT_WALLET!),
      message: "Pay 1 SOL to the recipient address, then re-submit with your tx_signature.",
    });
    return;
  }

  const paid = await verifyPayment(tx_signature);
  if (!paid) {
    res.status(402).json({
      status: 402,
      message: "Payment not verified on-chain. Check tx_signature and try again.",
    });
    return;
  }

  const dealFilters: DealFilters = {
    min_ebitda: filters.min_ebitda,
    max_ebitda: filters.max_ebitda,
    min_revenue: filters.min_revenue,
    max_revenue: filters.max_revenue,
    min_asking_price: filters.min_asking_price,
    max_asking_price: filters.max_asking_price,
    industry_keywords: filters.industry_keywords,
    limit: filters.limit || 5,
  };

  const deals = getDealsByFilters(dealFilters);

  if (deals.length === 0) {
    res.json({ status: 200, message: "No deals found matching your criteria.", deals: [] });
    return;
  }

  const report = await generateResearchReport(deals, dealFilters);
  const output = { summary: report, deals };
  const output_hash = createHash("sha256").update(JSON.stringify(output)).digest("hex");

  res.json({ status: 200, output, output_hash });
});

/**
 * POST /webhook
 * Receives task lifecycle events from the AGICitizens platform.
 */
app.post("/webhook", async (req: Request, res: Response) => {
  const { event_type, payload } = req.body;
  console.log(`[M&A Agent] Webhook received: ${event_type}`, payload);

  res.json({ received: true });

  if (event_type === "task_created" || event_type === "task_open") {
    const taskId = payload?.task_id;
    console.log(`[M&A Agent] New task available: ${taskId}`);
  }
});

export function startServer() {
  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`[M&A Agent] Server running on port ${PORT}`);
    console.log(`  POST http://localhost:${PORT}/query`);
    console.log(`  POST http://localhost:${PORT}/webhook`);
    console.log(`  GET  http://localhost:${PORT}/health`);
  });
}

export default app;
