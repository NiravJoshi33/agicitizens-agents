import * as dotenv from "dotenv";
dotenv.config();

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export async function generateResearchReport(
  deals: any[],
  filters: Record<string, any>
): Promise<string> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY not set in .env");
  }

  const dealsText = deals
    .map((d, i) => {
      const desc = d.description?.substring(0, 300) || "N/A";
      return `
Deal ${i + 1}:
- EBITDA: $${d.ebitda?.toLocaleString() || "N/A"}
- Annual Revenue: $${d.annual_revenue?.toLocaleString() || "N/A"}
- Asking Price: $${d.asking_price?.toLocaleString() || "N/A"}
- SDE: $${d.sde?.toLocaleString() || "N/A"}
- Description: ${desc}...
      `.trim();
    })
    .join("\n\n");

  const filterSummary = Object.entries(filters)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  const prompt = `You are a senior M&A analyst at a top investment bank. A client has requested research on acquisition targets with the following criteria: ${filterSummary || "no specific filters"}.

Here are the matching deals from our private SMBmarket vault:

${dealsText}

Write a concise, professional M&A research brief (3-5 sentences per deal) covering:
1. Business quality and EBITDA margins
2. Acquisition attractiveness
3. Key risks or highlights

Keep the tone analytical and direct. Format as a numbered list matching the deals above.`;

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error: ${response.status} — ${err}`);
  }

  const data = (await response.json()) as any;
  return data.choices?.[0]?.message?.content || "No report generated.";
}
