"use client";

import { useState } from "react";

interface MarketData {
  price: number;
  market_cap: string;
  volume_24h: string;
  price_change_24h: string;
}

interface DefiProtocol {
  protocol: string;
  tvl: string;
}

interface ResearchResult {
  token?: string;
  summary: string;
  risk_score: number;
  market_data?: MarketData;
  defi_exposure?: DefiProtocol[];
  sentiment?: string;
  key_findings: string[];
  sources: string[];
  generated_at: string;
}

function riskColor(score: number) {
  if (score <= 3) return "text-accent-green";
  if (score <= 6) return "text-accent-amber";
  return "text-accent-red";
}

function riskBg(score: number) {
  if (score <= 3) return "bg-accent-green/10 border-accent-green/30";
  if (score <= 6) return "bg-accent-amber/10 border-accent-amber/30";
  return "bg-accent-red/10 border-accent-red/30";
}

function sentimentColor(s: string) {
  if (s.includes("bullish")) return "text-accent-green bg-accent-green/10 border-accent-green/30";
  if (s.includes("bearish")) return "text-accent-red bg-accent-red/10 border-accent-red/30";
  return "text-accent-amber bg-accent-amber/10 border-accent-amber/30";
}

function sentimentLabel(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [chain, setChain] = useState("solana");
  const [depth, setDepth] = useState("standard");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), chain, depth }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Research failed");
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          <span className="text-accent">Crypto</span> Research AI Agent
        </h1>
        <p className="text-gray-500 mt-1">
          AI agent powered analysis with live market data, DeFi analytics &amp; LLM insights
        </p>
      </div>

      {/* Search Form */}
      <form onSubmit={handleSubmit} className="mb-8">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search token or protocol... (e.g. solana, bitcoin, uniswap)"
            className="flex-1 bg-surface-card border border-surface-border rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 transition-colors"
          />
          <select
            value={chain}
            onChange={(e) => setChain(e.target.value)}
            className="bg-surface-card border border-surface-border rounded-lg px-3 py-3 text-gray-300 focus:outline-none focus:border-accent/50 cursor-pointer"
          >
            <option value="solana">Solana</option>
            <option value="ethereum">Ethereum</option>
            <option value="base">Base</option>
            <option value="arbitrum">Arbitrum</option>
          </select>
          <select
            value={depth}
            onChange={(e) => setDepth(e.target.value)}
            className="bg-surface-card border border-surface-border rounded-lg px-3 py-3 text-gray-300 focus:outline-none focus:border-accent/50 cursor-pointer"
          >
            <option value="quick">Quick</option>
            <option value="standard">Standard</option>
            <option value="deep">Deep</option>
          </select>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="bg-accent hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium px-6 py-3 rounded-lg transition-colors whitespace-nowrap"
          >
            {loading ? "Analyzing..." : "Research"}
          </button>
        </div>
      </form>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="w-10 h-10 border-2 border-accent/30 border-t-accent rounded-full animate-spin mb-4" />
          <p className="text-gray-400">AI agent fetching market data &amp; running analysis...</p>
          <p className="text-gray-600 text-sm mt-1">This may take 10-30 seconds</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-accent-red/10 border border-accent-red/30 rounded-lg p-4 mb-6">
          <p className="text-accent-red font-medium">Research Failed</p>
          <p className="text-gray-400 text-sm mt-1">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-6 animate-in fade-in">
          {/* Token Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold capitalize">{result.token}</h2>
            <span className="text-gray-500 text-sm">
              {new Date(result.generated_at).toLocaleString()}
            </span>
          </div>

          {/* Summary */}
          <div className="bg-surface-card border border-surface-border rounded-xl p-5">
            <p className="text-gray-300 leading-relaxed">{result.summary}</p>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Risk Score */}
            <div className={`rounded-xl border p-4 ${riskBg(result.risk_score)}`}>
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Risk Score</p>
              <p className={`text-3xl font-bold ${riskColor(result.risk_score)}`}>
                {result.risk_score}<span className="text-lg text-gray-500">/10</span>
              </p>
            </div>

            {/* Sentiment */}
            {result.sentiment && (
              <div className={`rounded-xl border p-4 ${sentimentColor(result.sentiment)}`}>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Sentiment</p>
                <p className="text-xl font-bold">{sentimentLabel(result.sentiment)}</p>
              </div>
            )}

            {/* Price */}
            {result.market_data && (
              <>
                <div className="bg-surface-card border border-surface-border rounded-xl p-4">
                  <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Price</p>
                  <p className="text-2xl font-bold text-white">
                    ${result.market_data.price.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </p>
                  <p className={`text-sm mt-1 ${
                    result.market_data.price_change_24h.startsWith("-")
                      ? "text-accent-red"
                      : "text-accent-green"
                  }`}>
                    {result.market_data.price_change_24h} (24h)
                  </p>
                </div>

                <div className="bg-surface-card border border-surface-border rounded-xl p-4">
                  <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Market Cap</p>
                  <p className="text-xl font-bold text-white">{result.market_data.market_cap}</p>
                  <p className="text-gray-500 text-sm mt-1">Vol: {result.market_data.volume_24h}</p>
                </div>
              </>
            )}
          </div>

          {/* DeFi Exposure */}
          {result.defi_exposure && result.defi_exposure.length > 0 && (
            <div className="bg-surface-card border border-surface-border rounded-xl p-5">
              <h3 className="text-sm uppercase tracking-wider text-gray-400 mb-3">DeFi Exposure</h3>
              <div className="space-y-2">
                {result.defi_exposure.map((d, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface hover:bg-surface-hover transition-colors"
                  >
                    <span className="text-white font-medium">{d.protocol}</span>
                    <span className="text-accent-cyan font-mono text-sm">{d.tvl}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Key Findings */}
          {result.key_findings.length > 0 && (
            <div className="bg-surface-card border border-surface-border rounded-xl p-5">
              <h3 className="text-sm uppercase tracking-wider text-gray-400 mb-3">Key Findings</h3>
              <ul className="space-y-2">
                {result.key_findings.map((f, i) => (
                  <li key={i} className="flex gap-3 text-gray-300">
                    <span className="text-accent mt-0.5 shrink-0">&#9679;</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Sources */}
          <div className="flex flex-wrap gap-2">
            {result.sources.map((s, i) => (
              <span
                key={i}
                className="text-xs bg-surface-card border border-surface-border rounded-full px-3 py-1 text-gray-400"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
