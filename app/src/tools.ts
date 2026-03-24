import { getDealsByFilters, DealFilters } from "./vault";
import { generateResearchReport } from "./llm";

// ─── Tool: HTTP Request (generic — no hardcoded paths) ──────────────────────

export async function httpRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };

  const res = await fetch(opts.url, {
    method: opts.method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { status: res.status, data };
}

// ─── Tool: Query Vault (agent's own capability) ─────────────────────────────

export function queryVault(filters: DealFilters): any[] {
  return getDealsByFilters(filters);
}

// ─── Tool: Generate Research Report (agent's own capability) ─────────────────

export async function generateReport(
  deals: any[],
  filters: Record<string, any>
): Promise<string> {
  return generateResearchReport(deals, filters);
}

// ─── Tool Definitions (for LLM function calling) ────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "http_request",
      description:
        "Make an HTTP request to any URL. Use this to interact with the AGICitizens platform API. Construct the URL, method, headers, and body based on the citizen.md documentation.",
      parameters: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PATCH", "DELETE"],
            description: "HTTP method",
          },
          url: {
            type: "string",
            description:
              "Full URL including base URL and path (e.g., http://localhost:3099/v1/tasks)",
          },
          headers: {
            type: "object",
            description:
              "Additional HTTP headers (Authorization is added automatically)",
          },
          body: {
            type: "object",
            description: "JSON request body (for POST/PATCH)",
          },
        },
        required: ["method", "url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "query_vault",
      description:
        "Query the M&A deal vault (SQLite database with 200+ real business listings). Returns matching deals based on filters. This is your proprietary data source.",
      parameters: {
        type: "object",
        properties: {
          min_ebitda: { type: "number", description: "Minimum EBITDA" },
          max_ebitda: { type: "number", description: "Maximum EBITDA" },
          min_revenue: {
            type: "number",
            description: "Minimum annual revenue",
          },
          max_revenue: {
            type: "number",
            description: "Maximum annual revenue",
          },
          min_asking_price: {
            type: "number",
            description: "Minimum asking price",
          },
          max_asking_price: {
            type: "number",
            description: "Maximum asking price",
          },
          industry_keywords: {
            type: "string",
            description: "Search keywords in deal description",
          },
          limit: { type: "number", description: "Max results (default: 5)" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "generate_report",
      description:
        "Generate a professional M&A research report using LLM. Takes deal data from query_vault and produces an analyst-quality brief covering business quality, acquisition attractiveness, and key risks.",
      parameters: {
        type: "object",
        properties: {
          deals: {
            type: "array",
            description: "Array of deal objects from query_vault",
          },
          filters: {
            type: "object",
            description: "The filters that were used to find these deals",
          },
        },
        required: ["deals"],
      },
    },
  },
];
