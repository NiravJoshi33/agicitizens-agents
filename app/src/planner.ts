/**
 * LLM Planner — decides what the agent should do each tick.
 *
 * The planner:
 * 1. Receives current state (what tasks exist, what's pending, etc.)
 * 2. Has access to citizen.md (platform API docs)
 * 3. Decides what actions to take
 * 4. Returns tool calls (http_request, query_vault, generate_report)
 *
 * The agent NEVER hardcodes API paths — the LLM constructs them
 * based on citizen.md, just like Moltbook agents do.
 */

import * as dotenv from "dotenv";
dotenv.config();

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

import { TOOL_DEFINITIONS, httpRequest, queryVault, generateReport } from "./tools";

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

/**
 * Ask the LLM planner what to do, then execute the tool calls it returns.
 */
export async function runPlannerTick(config: PlannerConfig) {
  const systemPrompt = buildSystemPrompt(config);
  const userPrompt = buildTickPrompt(config);

  // Ask LLM what to do
  const response = await callLLM(systemPrompt, userPrompt);

  if (!response.tool_calls || response.tool_calls.length === 0) {
    // LLM decided there's nothing to do
    const content = response.content || "";
    if (content) console.log(`[Planner] LLM says: ${content}`);
    return;
  }

  // Execute each tool call the LLM requested
  for (const toolCall of response.tool_calls) {
    await executeToolCall(toolCall, config);
  }
}

/**
 * System prompt — tells the LLM who it is and what it can do.
 * Includes citizen.md so the LLM knows the platform API.
 */
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

## Platform API Documentation (citizen.md)
${config.citizenMd}
`;
}

/**
 * Tick prompt — tells the LLM to check for work and act.
 */
function buildTickPrompt(config: PlannerConfig): string {
  return `It's time for a routine check. Please do the following in order:

1. Send a heartbeat: POST ${config.apiBaseUrl}/agents/me/heartbeat
2. Check for OPEN research tasks: GET ${config.apiBaseUrl}/tasks?status=OPEN&category=research
   - If any found, bid on them
3. Check for IN_PROGRESS tasks assigned to me: GET ${config.apiBaseUrl}/tasks?status=IN_PROGRESS&provider=${config.agentName}
   - If any found, query the vault with task filters, generate a report, and deliver
4. Check for VERIFIED tasks assigned to me: GET ${config.apiBaseUrl}/tasks?status=VERIFIED&provider=${config.agentName}
   - If any found, rate the requester 5/5

Execute the appropriate tool calls now. Start with the heartbeat, then check tasks.`;
}

/**
 * Call OpenRouter LLM with tools.
 */
async function callLLM(
  systemPrompt: string,
  userPrompt: string,
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
      max_tokens: 4000,
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

/**
 * Execute a single tool call returned by the LLM.
 */
async function executeToolCall(toolCall: ToolCall, config: PlannerConfig) {
  const { name, arguments: argsStr } = toolCall.function;
  let args: any;

  try {
    args = JSON.parse(argsStr);
  } catch {
    console.error(`[Planner] Failed to parse tool args: ${argsStr}`);
    return;
  }

  console.log(`[Planner] Executing: ${name}(${JSON.stringify(args).substring(0, 200)})`);

  try {
    switch (name) {
      case "http_request": {
        // Add auth header automatically
        const headers = {
          ...(args.headers || {}),
          Authorization: `Bearer ${config.apiKey}`,
        };
        const result = await httpRequest({
          method: args.method,
          url: args.url,
          headers,
          body: args.body,
        });
        console.log(`[Planner] HTTP ${args.method} ${args.url} → ${result.status}`);

        // Log important responses
        if (result.data?.data && Array.isArray(result.data.data)) {
          console.log(`[Planner]   Found ${result.data.data.length} items`);
        }
        if (result.data?.taskId) {
          console.log(`[Planner]   Task: ${result.data.taskId} | Status: ${result.data.status}`);
        }
        if (result.data?.bidId) {
          console.log(`[Planner]   Bid: ${result.data.bidId} | Price: ${result.data.price}`);
        }
        if (result.data?.txSignature) {
          console.log(`[Planner]   Settlement TX: ${result.data.txSignature}`);
        }
        break;
      }

      case "query_vault": {
        const deals = queryVault(args);
        console.log(`[Planner] Vault returned ${deals.length} deals`);

        // Store deals in memory for generate_report to use
        (globalThis as any).__lastVaultDeals = deals;
        (globalThis as any).__lastVaultFilters = args;
        break;
      }

      case "generate_report": {
        const deals = args.deals || (globalThis as any).__lastVaultDeals || [];
        const filters = args.filters || (globalThis as any).__lastVaultFilters || {};

        if (deals.length === 0) {
          console.log(`[Planner] No deals to generate report for`);
          break;
        }

        const report = await generateReport(deals, filters);
        console.log(`[Planner] Report generated (${report.length} chars)`);

        // Store for delivery
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
}
