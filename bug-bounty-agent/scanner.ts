/**
 * scanner.ts — Security scanning tools and types.
 *
 * Pure security analysis logic — no platform coupling.
 * The brain uses these as tools for vulnerability scanning.
 */

import { runScanLoop } from "./brain";

// ── Types ───────────────────────────────────────────────────

export interface ScanInput {
  target: string; // repo URL or contract address
  type?: "repo" | "contract";
  chain?: string;
  depth?: string;
}

export interface VulnerabilityFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  location?: string;
  recommendation: string;
}

export interface ScanOutput {
  target: string;
  scan_type: string;
  summary: string;
  risk_score: number;
  findings: VulnerabilityFinding[];
  contracts_analyzed?: number;
  files_analyzed?: number;
  sources: string[];
  generated_at: string;
}

// ── GitHub Repo Fetching ────────────────────────────────────

export async function fetchRepoContents(
  owner: string,
  repo: string,
  path = "",
): Promise<any[]> {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    return (await res.json()) as any[];
  } catch {
    return [];
  }
}

export async function fetchFileContent(rawUrl: string): Promise<string | null> {
  try {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 10_000
      ? text.slice(0, 10_000) + "\n...(truncated)"
      : text;
  } catch {
    return null;
  }
}

export async function fetchRepoTree(
  owner: string,
  repo: string,
  branch = "main",
): Promise<any[]> {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return data.tree ?? [];
  } catch {
    return [];
  }
}

// ── Contract Source Fetching (Etherscan / Solscan) ──────────

export async function fetchContractSource(
  address: string,
  chain = "ethereum",
): Promise<{ source: string; name: string } | null> {
  const explorerApis: Record<string, string> = {
    ethereum: "https://api.etherscan.io/api",
    bsc: "https://api.bscscan.com/api",
    polygon: "https://api.polygonscan.com/api",
    arbitrum: "https://api.arbiscan.io/api",
    optimism: "https://api-optimistic.etherscan.io/api",
  };

  const baseUrl = explorerApis[chain];
  if (!baseUrl) return null;

  try {
    const params = new URLSearchParams({
      module: "contract",
      action: "getsourcecode",
      address,
    });
    const res = await fetch(`${baseUrl}?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const result = data.result?.[0];
    if (!result?.SourceCode) return null;
    return { source: result.SourceCode, name: result.ContractName ?? "Unknown" };
  } catch {
    return null;
  }
}

// ── Known Vulnerability Patterns ────────────────────────────

export interface VulnPattern {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  regex: RegExp;
  description: string;
  recommendation: string;
  language: "solidity" | "rust" | "any";
}

export const SOLIDITY_PATTERNS: VulnPattern[] = [
  {
    id: "SOL-001",
    severity: "critical",
    title: "Reentrancy vulnerability",
    regex: /\.call\{value:.*\}\(.*\)[\s\S]{0,200}(?:balances|balance)\[/,
    description: "External call made before state update — classic reentrancy pattern.",
    recommendation: "Use checks-effects-interactions pattern or ReentrancyGuard.",
    language: "solidity",
  },
  {
    id: "SOL-002",
    severity: "high",
    title: "Unchecked external call",
    regex: /\.call\{.*\}\(.*\)(?![\s\S]{0,30}require)/,
    description: "External call return value not checked.",
    recommendation: "Always check return value of .call() or use Address.sendValue().",
    language: "solidity",
  },
  {
    id: "SOL-003",
    severity: "high",
    title: "tx.origin used for authorization",
    regex: /tx\.origin/,
    description: "tx.origin used — vulnerable to phishing attacks.",
    recommendation: "Use msg.sender instead of tx.origin for auth.",
    language: "solidity",
  },
  {
    id: "SOL-004",
    severity: "medium",
    title: "Uninitialized storage pointer",
    regex: /\bstorage\b\s+\w+\s*;/,
    description: "Uninitialized storage variable may point to unexpected slot.",
    recommendation: "Always initialize storage variables explicitly.",
    language: "solidity",
  },
  {
    id: "SOL-005",
    severity: "medium",
    title: "Delegatecall to untrusted contract",
    regex: /delegatecall\(/,
    description: "delegatecall can allow arbitrary code execution in caller context.",
    recommendation: "Only delegatecall to trusted, immutable contracts.",
    language: "solidity",
  },
  {
    id: "SOL-006",
    severity: "medium",
    title: "Integer overflow/underflow risk",
    regex: /pragma solidity\s+(?:0\.[0-6]\.|0\.7\.[0-5])/,
    description: "Solidity version < 0.8.0 has no built-in overflow protection.",
    recommendation: "Upgrade to Solidity ^0.8.0 or use SafeMath.",
    language: "solidity",
  },
  {
    id: "SOL-007",
    severity: "high",
    title: "selfdestruct present",
    regex: /selfdestruct\(|suicide\(/,
    description: "Contract can be destroyed, potentially locking user funds.",
    recommendation: "Remove selfdestruct or restrict access tightly.",
    language: "solidity",
  },
  {
    id: "SOL-008",
    severity: "low",
    title: "Floating pragma",
    regex: /pragma solidity\s*\^/,
    description: "Floating pragma allows compilation with different compiler versions.",
    recommendation: "Lock pragma to a specific version (e.g., pragma solidity 0.8.20).",
    language: "solidity",
  },
  {
    id: "SOL-009",
    severity: "medium",
    title: "Missing access control",
    regex: /function\s+\w+\s*\([^)]*\)\s+(external|public)\s+(?!.*(?:onlyOwner|onlyRole|require|modifier))/,
    description: "Public/external function without visible access control.",
    recommendation: "Add appropriate access control modifiers.",
    language: "solidity",
  },
  {
    id: "SOL-010",
    severity: "high",
    title: "Unprotected ETH withdrawal",
    regex: /function\s+withdraw[\s\S]{0,200}\.transfer\(|\.send\(/,
    description: "Withdrawal function may lack proper authorization checks.",
    recommendation: "Add onlyOwner or role-based access to withdrawal functions.",
    language: "solidity",
  },
];

export const RUST_ANCHOR_PATTERNS: VulnPattern[] = [
  {
    id: "ANCHOR-001",
    severity: "critical",
    title: "Missing signer check",
    regex: /AccountInfo[\s\S]{0,100}(?!.*is_signer)/,
    description: "Account used without verifying it signed the transaction.",
    recommendation: "Add Signer constraint or check is_signer manually.",
    language: "rust",
  },
  {
    id: "ANCHOR-002",
    severity: "critical",
    title: "Missing owner check",
    regex: /AccountInfo[\s\S]{0,100}(?!.*owner\s*==)/,
    description: "Account used without verifying program ownership.",
    recommendation: "Add owner constraint or verify account.owner matches expected program.",
    language: "rust",
  },
  {
    id: "ANCHOR-003",
    severity: "high",
    title: "Arithmetic overflow risk",
    regex: /\b(?:checked_add|checked_sub|checked_mul)\b/,
    description: "Some arithmetic uses checked operations — verify ALL arithmetic is safe.",
    recommendation: "Use checked_* or saturating_* operations for all arithmetic.",
    language: "rust",
  },
  {
    id: "ANCHOR-004",
    severity: "medium",
    title: "Unvalidated PDA seeds",
    regex: /Pubkey::find_program_address\(/,
    description: "PDA derivation found — ensure seeds are validated.",
    recommendation: "Verify PDA seeds include all necessary unique identifiers.",
    language: "rust",
  },
  {
    id: "ANCHOR-005",
    severity: "high",
    title: "Missing close constraint",
    regex: /#\[account\([\s\S]*?mut[\s\S]*?\)\][\s\S]{0,200}(?!.*close)/,
    description: "Mutable account without close constraint may leak lamports.",
    recommendation: "Add close constraint to reclaim rent on account cleanup.",
    language: "rust",
  },
];

// ── Static Pattern Scanner ──────────────────────────────────

export function scanForPatterns(
  code: string,
  language: "solidity" | "rust",
): VulnerabilityFinding[] {
  const patterns =
    language === "solidity" ? SOLIDITY_PATTERNS : RUST_ANCHOR_PATTERNS;
  const findings: VulnerabilityFinding[] = [];

  for (const pattern of patterns) {
    const match = pattern.regex.exec(code);
    if (match) {
      // Find approximate line number
      const beforeMatch = code.slice(0, match.index);
      const lineNumber = beforeMatch.split("\n").length;

      findings.push({
        id: pattern.id,
        severity: pattern.severity,
        title: pattern.title,
        description: pattern.description,
        location: `Line ~${lineNumber}`,
        recommendation: pattern.recommendation,
      });
    }
  }

  return findings;
}

// ── Main Scanner Entry Point ────────────────────────────────

export async function executeScan(
  input: ScanInput,
  llmConfig?: { apiKey: string; model?: string },
): Promise<ScanOutput> {
  const { target, type = "repo", chain = "ethereum", depth = "standard" } = input;

  if (llmConfig?.apiKey) {
    const maxIterations = depth === "quick" ? 4 : depth === "deep" ? 10 : 6;
    return runScanLoop(target, type, chain, depth, {
      apiKey: llmConfig.apiKey,
      model: llmConfig.model,
      maxIterations,
    });
  }

  // Deterministic fallback (no LLM)
  const findings: VulnerabilityFinding[] = [];
  const sources: string[] = [];

  if (type === "contract") {
    const contract = await fetchContractSource(target, chain);
    if (contract) {
      sources.push(`${chain} block explorer`);
      const lang = contract.source.includes("pragma solidity")
        ? "solidity" as const
        : "rust" as const;
      findings.push(...scanForPatterns(contract.source, lang));
    }
  }

  return {
    target,
    scan_type: type,
    summary: `Static scan of "${target}" found ${findings.length} potential issue(s).`,
    risk_score: calculateRiskScore(findings),
    findings,
    sources,
    generated_at: new Date().toISOString(),
  };
}

function calculateRiskScore(findings: VulnerabilityFinding[]): number {
  if (findings.length === 0) return 1;
  const weights = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  const total = findings.reduce((sum, f) => sum + weights[f.severity], 0);
  return Math.min(10, Math.max(1, Math.round(total / 2)));
}
