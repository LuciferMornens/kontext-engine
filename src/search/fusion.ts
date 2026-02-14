import type { SearchResult } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Names of available search strategies. */
export type StrategyName = "vector" | "fts" | "ast" | "path" | "dependency";

/** Results from a single search strategy, ready for fusion. */
export interface StrategyResult {
  strategy: StrategyName;
  weight: number;
  results: SearchResult[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Standard RRF damping constant */
const K = 60;

// ── Reciprocal Rank Fusion ───────────────────────────────────────────────────

/** Merge results from multiple strategies using Reciprocal Rank Fusion (K=60). */
export function fusionMerge(
  strategyResults: StrategyResult[],
  limit: number,
): SearchResult[] {
  // Accumulate RRF scores per chunkId
  const scoreMap = new Map<number, number>();
  const resultMap = new Map<number, SearchResult>();

  for (const { weight, results } of strategyResults) {
    for (let rank = 0; rank < results.length; rank++) {
      const result = results[rank];
      const rrfScore = weight * (1 / (K + rank + 1)); // rank is 1-indexed in formula

      const existing = scoreMap.get(result.chunkId) ?? 0;
      scoreMap.set(result.chunkId, existing + rrfScore);

      // Keep the first occurrence's metadata
      if (!resultMap.has(result.chunkId)) {
        resultMap.set(result.chunkId, result);
      }
    }
  }

  if (scoreMap.size === 0) return [];

  // Build sorted results
  const entries = [...scoreMap.entries()].sort((a, b) => b[1] - a[1]);

  // Normalize scores to 0-1
  const maxScore = entries[0][1];

  const results: SearchResult[] = [];
  for (const [chunkId, rawScore] of entries.slice(0, limit)) {
    const base = resultMap.get(chunkId);
    if (!base) continue;
    results.push({
      ...base,
      score: maxScore > 0 ? rawScore / maxScore : 0,
    });
  }
  return results;
}
