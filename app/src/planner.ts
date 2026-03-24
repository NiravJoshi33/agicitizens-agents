import * as dotenv from "dotenv";
dotenv.config();

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

import {
  TOOL_DEFINITIONS,
  httpRequest,
  queryVault,
  generateReport,
} from "./tools";

interface PlannerConfig {
  apiBaseUrl: string;
  apiKey: string;
  citizenMd: string;
  agentName: string;
}

interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

// Track tasks we've already acted on to avoid duplicate bids/deliveries
const bidTaskIds = new Set<string>();
const deliveredTaskIds = new Set<string>();

export async function runPlannerTick(config: PlannerConfig) {
  const systemPrompt = buildSystemPrompt(config);
  const userPrompt = buildTickPrompt(config);

  // Round 1: Check platform state
  const response = await callLLM(systemPrompt, userPrompt);

  if (!response.tool_calls || response.tool_calls.length === 0) {
    const content = response.content || "";
    if (content) console.log(`[Planner] LLM says: ${content}`);
    return;
  }

  // Execute round 1 tool calls and collect results
  const results: string[] = [];
  for (const toolCall of response.tool_calls) {
    const result = await executeToolCall(toolCall, config);
    if (result) results.push(result);
  }

  // Round 2: If we found tasks, ask LLM what to do with them
  if (results.length > 0) {
    const followUp = results.join("\n");
    const round2 = await callLLM(
      systemPrompt,
      `Here are the results from checking the platform:\n\n${followUp}\n\nBased on these results, take the appropriate actions: bid on OPEN tasks (price = 80% of budget), deliver for IN_PROGRESS tasks (use query_vault first, then generate_report, then deliver via http_request), rate VERIFIED tasks 5/5. Only act if there are tasks to act on.`
    );

    if (round2.tool_calls) {
      for (const toolCall of round2.tool_calls) {
        await executeToolCall(toolCall, config);
      }
    }
  }
}

function buildSystemPrompt(config: PlannerConfig): string {
  return `You are "mna-agent", an autonomous M&A research agent on the AGICitizens platform.

## Your Capabilities
- You have a proprietary vault of 200+ real M&A business listings (use query_vault tool)
- You can generate professional research reports using LLM analysis (use generate_report tool)
- You can make HTTP requests to the AGICitizens platform API (use http_request tool)

## Your API Key
Use this in Authorization header: Bearer ${config.apiKey}

## Platform API Base URL
${config.apiBaseUrl}

## How You Work
Every 15 seconds, you check the platform and take appropriate actions:

1. **Find work**: Check for OPEN tasks in your categories (research, analysis)
   - If you find an open task, bid on it (price = 80% of budget)
2. **Deliver work**: Check for IN_PROGRESS tasks assigned to you
   - Query your vault with the task's filters
   - Generate a research report from the deals
   - Deliver the output to the platform
3. **Complete work**: Check for VERIFIED tasks assigned to you
   - Rate the requester 5/5 to trigger settlement
4. **Stay online**: Send heartbeat to show you're active

## Important Rules
- Always construct API URLs using the base URL: ${config.apiBaseUrl}
- Always include Authorization header with your API key
- When delivering, first use query_vault to get deals, then generate_report for analysis
- Bid at 80% of the task budget
- Rate requesters 5/5 after task is verified

## Key API Endpoints (from citizen.md)
- POST /agents/me/heartbeat — send heartbeat (auth required)
- GET /tasks?status=OPEN&category=research — find open tasks
- GET /tasks?status=IN_PROGRESS&provider=mna-agent — find assigned tasks
- GET /tasks?status=VERIFIED&provider=mna-agent — find tasks to rate
- POST /bids/{taskId} — bid on a task: {"price":"8.00","message":"..."}
- POST /tasks/{taskId}/deliver — deliver output: {"output":{...}}
- POST /tasks/{taskId}/rate — rate requester: {"rating":5}
All endpoints need Authorization: Bearer header.
`;
}

function buildTickPrompt(config: PlannerConfig): string {
  return `Execute ALL of these tool calls now (not just the first one):

1. http_request: POST ${config.apiBaseUrl}/agents/me/heartbeat
2. http_request: GET ${config.apiBaseUrl}/tasks?status=OPEN&category=research
3. http_request: GET ${config.apiBaseUrl}/tasks?status=IN_PROGRESS&provider=${config.agentName}
4. http_request: GET ${config.apiBaseUrl}/tasks?status=VERIFIED&provider=${config.agentName}

Call all 4 http_requests. After getting results from #2, if tasks exist, bid on each (POST /bids/{taskId} with price=80% of budget). After #3, if tasks exist, use query_vault and generate_report then deliver.`;
}

async function callLLM(
  systemPrompt: string,
  userPrompt: string
): Promise<{ content?: string; tool_calls?: ToolCall[] }> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
      max_tokens: 1500,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[Planner] LLM error: ${response.status} — ${err}`);
    return {};
  }

  const data = (await response.json()) as any;
  const message = data.choices?.[0]?.message;

  return {
    content: message?.content,
    tool_calls: message?.tool_calls,
  };
}

async function executeToolCall(
  toolCall: ToolCall,
  config: PlannerConfig
): Promise<string | null> {
  const { name, arguments: argsStr } = toolCall.function;
  let args: any;

  try {
    args = JSON.parse(argsStr);
  } catch {
    console.error(`[Planner] Failed to parse tool args: ${argsStr}`);
    return;
  }

  console.log(
    `[Planner] Executing: ${name}(${JSON.stringify(args).substring(0, 200)})`
  );

  try {
    switch (name) {
      case "http_request": {
        // Skip duplicate bids and deliveries
        const urlStr: string = args.url || "";
        if (args.method === "POST" && urlStr.includes("/bids/")) {
          const m = urlStr.match(/\/bids\/([^/]+)/);
          if (m && bidTaskIds.has(m[1])) {
            console.log(`[Planner] Already bid on ${m[1]}, skipping`);
            return null;
          }
        }
        if (args.method === "POST" && urlStr.includes("/deliver")) {
          const m = urlStr.match(/\/tasks\/([^/]+)\/deliver/);
          if (m && deliveredTaskIds.has(m[1])) {
            console.log(`[Planner] Already delivered ${m[1]}, skipping`);
            return null;
          }
        }

        const headers = {
          ...(args.headers || {}),
          Authorization: `Bearer ${config.apiKey}`,
        };

        // Auto-inject vault output when delivering (LLM forgets to include body)
        let body = args.body;
        if (
          args.method === "POST" &&
          args.url?.includes("/deliver") &&
          !body?.output
        ) {
          const lastDeals = (globalThis as any).__lastVaultDeals;
          if (lastDeals && lastDeals.length > 0) {
            const lastFilters = (globalThis as any).__lastVaultFilters || {};
            console.log(
              `[Planner] Auto-generating report for ${lastDeals.length} deals...`
            );
            const report = await generateReport(lastDeals, lastFilters);
            body = { output: { summary: report, deals: lastDeals } };
            console.log(`[Planner] Report ready (${report.length} chars)`);
          }
        }

        const result = await httpRequest({
          method: args.method,
          url: args.url,
          headers,
          body,
        });
        console.log(
          `[Planner] HTTP ${args.method} ${args.url} → ${result.status}`
        );

        if (result.data?.data && Array.isArray(result.data.data)) {
          console.log(`[Planner]   Found ${result.data.data.length} items`);
        }
        if (result.data?.taskId) {
          console.log(
            `[Planner]   Task: ${result.data.taskId} | Status: ${result.data.status}`
          );
        }
        if (result.data?.bidId) {
          console.log(
            `[Planner]   Bid: ${result.data.bidId} | Price: ${result.data.price}`
          );
          // Track successful bid
          const bidMatch = urlStr.match(/\/bids\/([^/]+)/);
          if (bidMatch) bidTaskIds.add(bidMatch[1]);
        }
        // Track successful delivery
        if (result.status === 200 && urlStr.includes("/deliver")) {
          const delMatch = urlStr.match(/\/tasks\/([^/]+)\/deliver/);
          if (delMatch) deliveredTaskIds.add(delMatch[1]);
        }
        if (result.data?.txSignature) {
          console.log(`[Planner]   Settlement TX: ${result.data.txSignature}`);
        }
        return `${args.method} ${args.url} → ${result.status}: ${JSON.stringify(
          result.data
        ).substring(0, 500)}`;
      }

      case "query_vault": {
        const deals = queryVault(args);
        console.log(`[Planner] Vault returned ${deals.length} deals`);

        (globalThis as any).__lastVaultDeals = deals;
        (globalThis as any).__lastVaultFilters = args;
        break;
      }

      case "generate_report": {
        const deals = args.deals || (globalThis as any).__lastVaultDeals || [];
        const filters =
          args.filters || (globalThis as any).__lastVaultFilters || {};

        if (deals.length === 0) {
          console.log(`[Planner] No deals to generate report for`);
          break;
        }

        const report = await generateReport(deals, filters);
        console.log(`[Planner] Report generated (${report.length} chars)`);

        (globalThis as any).__lastReport = report;
        (globalThis as any).__lastOutput = { summary: report, deals };
        break;
      }

      default:
        console.log(`[Planner] Unknown tool: ${name}`);
    }
  } catch (err: any) {
    console.error(`[Planner] Tool ${name} failed: ${err.message}`);
  }
  return null;
}
