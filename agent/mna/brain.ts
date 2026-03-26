import type { ParsedQuery, DealFilter } from "./bot.js";

export interface BrainConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const LLM_BASE_URL = process.env.LLM_BASE_URL;

const SEARCH_DEALS_TOOL = {
  type: "function" as const,
  function: {
    name: "search_deals",
    description:
      "Search M&A business listings by financial criteria. Call this function with the appropriate filters to find matching deals.",
    parameters: {
      type: "object",
      properties: {
        filters: {
          type: "array",
          description: "Financial filters to apply",
          items: {
            type: "object",
            properties: {
              field: {
                type: "string",
                enum: ["asking_price", "annual_revenue", "ebitda", "sde"],
                description:
                  "asking_price = listing price, annual_revenue = gross revenue, ebitda = EBITDA / cash flow, sde = seller discretionary earnings / owner benefit",
              },
              operator: {
                type: "string",
                enum: ["gt", "gte", "lt", "lte", "eq", "between"],
                description:
                  "gt = greater than, gte = greater than or equal, lt = less than, lte = less than or equal, eq = equal, between = range (use with value and value2)",
              },
              value: {
                type: "number",
                description:
                  "Numeric value in USD. Convert shorthand: $200K = 200000, $1M = 1000000, $1.5B = 1500000000",
              },
              value2: {
                type: "number",
                description:
                  "Upper bound for 'between' operator. Only required when operator is 'between'.",
              },
            },
            required: ["field", "operator", "value"],
          },
        },
        keyword: {
          type: "string",
          description:
            "Optional keyword to search in deal descriptions (e.g. 'restaurant', 'HVAC', 'roofing', 'pizza'). Only set if user mentions a specific business type.",
        },
        sort_by: {
          type: "string",
          enum: ["asking_price", "annual_revenue", "ebitda", "sde"],
          description: "Field to sort results by. Defaults to the primary filter field.",
        },
        sort_order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction. Default: desc",
        },
        limit: {
          type: "number",
          description: "Max number of results to return. Default: 20",
        },
      },
      required: ["filters"],
    },
  },
};

const SYSTEM_PROMPT = `You are an M&A deals search assistant. When a user asks about business deals, call the search_deals function with the right filters.

Rules:
- "more than" / "above" / "over" → operator: "gt"
- "less than" / "below" / "under" → operator: "lt"
- "at least" / "minimum" → operator: "gte"
- "at most" / "maximum" → operator: "lte"
- "between X and Y" → operator: "between" with value and value2
- Convert dollar amounts: "$200K" = 200000, "$1M" = 1000000
- "EBITDA" / "cash flow" → field: "ebitda"
- "revenue" / "sales" → field: "annual_revenue"
- "asking price" / "price" → field: "asking_price"
- "SDE" / "owner benefit" → field: "sde"
- Always call search_deals. Never respond with plain text.`;

export async function callOpenRouter(
  messages: Array<{ role: string; content: string }>,
  config: BrainConfig,
): Promise<string> {
  const res = await fetch(`${config.baseUrl ?? LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model ?? process.env.LLM_MODEL!,
      messages,
      temperature: 0.1,
      max_tokens: 500,
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter error (${res.status})`);
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}

async function callWithTools(
  messages: Array<{ role: string; content: string }>,
  config: BrainConfig,
): Promise<any> {
  const res = await fetch(`${config.baseUrl ?? LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model ?? process.env.LLM_MODEL!,
      messages,
      tools: [SEARCH_DEALS_TOOL],
      tool_choice: { type: "function", function: { name: "search_deals" } },
      temperature: 0.1,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  return data.choices?.[0]?.message;
}

interface AgentAction {
  reasoning: string;
  tool: string;
  input: Record<string, string>;
}

export function parseAction(raw: string): AgentAction | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed.tool) return parsed as AgentAction;
  } catch {}

  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.tool) return parsed as AgentAction;
    } catch {}
  }

  return null;
}

export async function parseQuery(
  query: string,
  config: BrainConfig,
): Promise<ParsedQuery> {
  console.log(`\n🧠 Parsing query: "${query}"`);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: query },
  ];

  try {
    const message = await callWithTools(messages, config);

    const toolCall = message?.tool_calls?.[0];
    if (toolCall?.function?.name === "search_deals") {
      const args = JSON.parse(toolCall.function.arguments);

      console.log(`   ✓ Function called: search_deals(${JSON.stringify(args)})`);

      const filters: DealFilter[] = (args.filters || []).filter(
        (f: any) =>
          ["asking_price", "annual_revenue", "ebitda", "sde"].includes(f.field) &&
          ["gt", "gte", "lt", "lte", "eq", "between"].includes(f.operator) &&
          typeof f.value === "number",
      );

      return {
        filters,
        keyword: args.keyword || undefined,
        sort_by: args.sort_by || undefined,
        sort_order: args.sort_order || "desc",
        limit: args.limit || 20,
      };
    }

    if (message?.content) {
      console.log(`   ⚠ No function call, falling back to content parse`);
      const match = message.content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed.filters) {
          return {
            filters: parsed.filters,
            keyword: parsed.keyword,
            sort_by: parsed.sort_by,
            sort_order: parsed.sort_order || "desc",
            limit: parsed.limit || 20,
          };
        }
      }
    }
  } catch (err: any) {
    console.error(`   ✗ Function calling failed: ${err.message}`);
  }

  return { filters: [], limit: 20 };
}
