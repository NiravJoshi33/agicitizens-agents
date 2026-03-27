/**
 * brain.ts — LLM-driven reasoning engine for the bug bounty agent.
 *
 * Think → Act → Observe loop for security scanning:
 *   1. Receives target (repo URL or contract address)
 *   2. Fetches code/files to analyze
 *   3. Runs pattern-based static analysis
 *   4. Uses LLM reasoning to find deeper issues
 *   5. Delivers structured vulnerability report
 */

import {
  fetchRepoTree,
  fetchFileContent,
  fetchContractSource,
  scanForPatterns,
} from "./scanner";
import type { ScanOutput, VulnerabilityFinding } from "./scanner";

// ── Types ───────────────────────────────────────────────────

interface AgentAction {
  reasoning: string;
  tool: string;
  input: Record<string, string>;
}

interface AgentStep {
  action: AgentAction;
  observation: string;
}

export interface BrainConfig {
  apiKey: string;
  model?: string;
  maxIterations?: number;
}

type ToolFn = (input: Record<string, string>) => Promise<string>;

// ── Tool Registry ───────────────────────────────────────────

const tools: Map<string, ToolFn> = new Map();

tools.set("list_repo_files", async (input) => {
  const { owner, repo, branch } = input;
  if (!owner || !repo)
    return "Error: missing 'owner' and 'repo' parameters";
  const tree = await fetchRepoTree(owner, repo, branch || "main");
  // Filter to security-relevant files
  const relevant = tree
    .filter(
      (f: any) =>
        f.type === "blob" &&
        /\.(sol|rs|ts|js|vy|move)$/.test(f.path),
    )
    .map((f: any) => f.path);
  return relevant.length > 0
    ? JSON.stringify(relevant.slice(0, 50))
    : "No smart contract or code files found.";
});

tools.set("read_file", async (input) => {
  const { url } = input;
  if (!url) return "Error: missing 'url' parameter";
  const content = await fetchFileContent(url);
  return content ?? "Failed to fetch file.";
});

tools.set("fetch_contract_source", async (input) => {
  const { address, chain } = input;
  if (!address) return "Error: missing 'address' parameter";
  const result = await fetchContractSource(address, chain || "ethereum");
  if (!result) return "Could not fetch contract source. It may not be verified.";
  const truncated =
    result.source.length > 8000
      ? result.source.slice(0, 8000) + "\n...(truncated)"
      : result.source;
  return `Contract: ${result.name}\n\n${truncated}`;
});

tools.set("static_scan", async (input) => {
  const { code, language } = input;
  if (!code) return "Error: missing 'code' parameter";
  const lang = (language === "rust" ? "rust" : "solidity") as
    | "solidity"
    | "rust";
  const findings = scanForPatterns(code, lang);
  return findings.length > 0
    ? JSON.stringify(findings, null, 2)
    : "No known vulnerability patterns detected.";
});

tools.set("http_request", async (input) => {
  const { method = "GET", url, body, headers: rawHeaders } = input;
  if (!url) return "Error: missing 'url' parameter";

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (rawHeaders) {
      try {
        Object.assign(headers, JSON.parse(rawHeaders));
      } catch {}
    }

    const opts: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(15_000),
    };
    if (body && method !== "GET") opts.body = body;

    const res = await fetch(url, opts);
    const text = await res.text();
    const truncated =
      text.length > 3000
        ? text.slice(0, 3000) + "\n...(truncated)"
        : text;
    return `HTTP ${res.status}\n${truncated}`;
  } catch (err: any) {
    return `HTTP request failed: ${err.message}`;
  }
});

tools.set("read_spec", async (input) => {
  const { url } = input;
  if (!url) return "Error: missing 'url' parameter";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    return text.length > 5000
      ? text.slice(0, 5000) + "\n...(truncated)"
      : text;
  } catch (err: any) {
    return `Failed to read spec: ${err.message}`;
  }
});

// ── System Prompt ───────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous bug bounty hunter agent. You analyze smart contracts and open-source repos for security vulnerabilities.

You THINK about what to analyze, ACT by calling tools, OBSERVE results, and REPEAT until you have a comprehensive security assessment.

## Available Tools

1. list_repo_files
   List code files in a GitHub repository. Returns file paths filtered to security-relevant extensions (.sol, .rs, .ts, .js, .vy, .move).
   Parameters: {"owner": "github username", "repo": "repo name", "branch": "branch name (default: main)"}

2. read_file
   Read the raw content of a file from a URL (use raw.githubusercontent.com URLs for GitHub files).
   Parameters: {"url": "raw file URL"}

3. fetch_contract_source
   Fetch verified contract source code from a block explorer (Etherscan, etc).
   Parameters: {"address": "contract address", "chain": "ethereum|bsc|polygon|arbitrum|optimism"}

4. static_scan
   Run static pattern analysis on code to detect known vulnerability patterns (reentrancy, unchecked calls, missing access control, etc).
   Parameters: {"code": "source code to scan", "language": "solidity|rust"}

5. http_request
   Make any HTTP request. Use for APIs not covered by other tools.
   Parameters: {"method": "GET|POST", "url": "full URL", "body": "JSON string (optional)", "headers": "JSON string (optional)"}

6. read_spec
   Read API documentation or specs from a URL.
   Parameters: {"url": "URL to fetch"}

7. final_answer
   Submit your security report when analysis is complete.
   Parameters: {
     "target": "what was analyzed",
     "scan_type": "repo|contract",
     "summary": "2-4 sentence executive summary of findings",
     "risk_score": "integer 1-10 (1=very safe, 10=critical risk)",
     "findings": "JSON array of vulnerability objects with: id, severity (critical|high|medium|low|info), title, description, location, recommendation"
   }

## Rules
- Respond with EXACTLY one JSON object per turn: {"reasoning": "...", "tool": "...", "input": {...}}
- THINK before acting: explain in "reasoning" what you're looking for and why
- Focus on REAL vulnerabilities: reentrancy, access control, overflow, front-running, oracle manipulation, flash loan risks, uninitialized storage, etc.
- For repos: list files first, then read the most critical contracts/code
- For contracts: fetch source, then run static_scan, then use your reasoning to find deeper issues
- DO NOT fabricate findings — only report what you can evidence from the code
- Call final_answer when you have enough data. Be thorough but efficient.`;

// ── OpenRouter Call ─────────────────────────────────────────

export async function callOpenRouter(
  messages: Array<{ role: string; content: string }>,
  config: BrainConfig,
): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model ?? "openai/gpt-oss-120b",
      messages,
      temperature: 0.1, // Lower temp for security analysis — precision matters
      max_tokens: 2000,
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter error (${res.status})`);
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}

// ── Parse LLM Response ──────────────────────────────────────

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

// ── Main Scan Loop ──────────────────────────────────────────

export async function runScanLoop(
  target: string,
  type: string,
  chain: string,
  depth: string,
  config: BrainConfig,
): Promise<ScanOutput> {
  const maxIterations = config.maxIterations ?? 6;
  const steps: AgentStep[] = [];
  const toolsUsed = new Set<string>();

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Security scan target: "${target}"
Type: ${type}
Chain: ${chain}
Depth: ${depth}

Analyze this target for security vulnerabilities. Start by fetching the code, then scan for issues.`,
    },
  ];

  console.log(
    `\n🔒 Agent scanning: "${target}" (type: ${type}, depth: ${depth})`,
  );

  for (let i = 0; i < maxIterations; i++) {
    const raw = await callOpenRouter(messages, config);
    const action = parseAction(raw);

    if (!action) {
      console.log(`   ⚠ Parse failed (iteration ${i + 1}), retrying...`);
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content:
          'Your response was not valid JSON. Respond with exactly one JSON object: {"reasoning": "...", "tool": "...", "input": {...}}',
      });
      continue;
    }

    console.log(`   Step ${i + 1}: [${action.tool}] ${action.reasoning.slice(0, 80)}`);

    if (action.tool === "final_answer") {
      return buildScanOutput(action.input, toolsUsed);
    }

    const toolFn = tools.get(action.tool);
    if (!toolFn) {
      const observation = `Error: Unknown tool "${action.tool}". Available: list_repo_files, read_file, fetch_contract_source, static_scan, http_request, read_spec, final_answer`;
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: observation });
      continue;
    }

    let observation: string;
    try {
      observation = await toolFn(action.input);
      toolsUsed.add(action.tool);
    } catch (err: any) {
      observation = `Error executing ${action.tool}: ${err.message}`;
    }

    console.log(
      `   → Result: ${observation.slice(0, 120)}${observation.length > 120 ? "..." : ""}`,
    );

    steps.push({ action, observation });

    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content: `Tool "${action.tool}" returned:\n${observation}\n\nDecide your next action. If you have enough data, call final_answer.`,
    });
  }

  // Max iterations — force final answer
  console.log("   ⚠ Max iterations reached, forcing final answer...");
  messages.push({
    role: "user",
    content:
      "You have used all your tool calls. You MUST now call final_answer with your findings. Respond with the final_answer tool call.",
  });

  const raw = await callOpenRouter(messages, config);
  const action = parseAction(raw);

  if (action?.tool === "final_answer") {
    return buildScanOutput(action.input, toolsUsed);
  }

  // Fallback
  return {
    target,
    scan_type: type,
    summary: `Security scan of "${target}" completed but agent could not produce a structured report.`,
    risk_score: 5,
    findings: [],
    sources: [...toolsUsed],
    generated_at: new Date().toISOString(),
  };
}

// ── Helpers ─────────────────────────────────────────────────

function buildScanOutput(
  input: Record<string, string>,
  toolsUsed: Set<string>,
): ScanOutput {
  let findings: VulnerabilityFinding[] = [];
  try {
    findings = JSON.parse(input.findings || "[]");
  } catch {
    findings = [];
  }

  return {
    target: input.target || "unknown",
    scan_type: input.scan_type || "repo",
    summary: input.summary || "Security scan completed.",
    risk_score: Math.min(10, Math.max(1, parseInt(input.risk_score) || 5)),
    findings,
    sources: [...toolsUsed],
    generated_at: new Date().toISOString(),
  };
}
