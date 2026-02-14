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

// ── Path boost constants ─────────────────────────────────────────────────────

const PATH_BOOST_DIR_EXACT = 1.5;
const PATH_BOOST_FILENAME = 1.4;
const PATH_BOOST_PARTIAL = 1.2;

const IMPORT_PENALTY = 0.5;

// ── Fusion with path boost + import deprioritization ─────────────────────────

/**
 * Merge results with RRF, then apply:
 * 1. Path-based boosting for results matching boost terms
 * 2. Import chunk deprioritization when non-import alternatives exist
 * Re-normalizes scores to 0–1 after all adjustments.
 */
export function fusionMergeWithPathBoost(
  strategyResults: StrategyResult[],
  limit: number,
  pathBoostTerms: string[],
): SearchResult[] {
  // Start with standard RRF fusion
  const fused = fusionMerge(strategyResults, limit * 3); // over-fetch for re-ranking

  if (fused.length === 0) return [];

  // 1. Apply path boost
  const boosted = applyPathBoost(fused, pathBoostTerms);

  // 2. Apply import deprioritization
  const adjusted = applyImportDeprioritization(boosted);

  // 3. Re-sort by adjusted score
  adjusted.sort((a, b) => b.score - a.score);

  // 4. Re-normalize to 0–1
  const sliced = adjusted.slice(0, limit);
  return renormalize(sliced);
}

/** Apply path-based boost multipliers to results. */
function applyPathBoost(
  results: SearchResult[],
  terms: string[],
): SearchResult[] {
  if (terms.length === 0) return results;

  return results.map((r) => {
    const boost = getPathBoostFactor(r.filePath, terms);
    return { ...r, score: r.score * boost };
  });
}

/** Get the highest boost factor for a file path given boost terms. */
function getPathBoostFactor(filePath: string, terms: string[]): number {
  let maxBoost = 1.0;

  const pathLower = filePath.toLowerCase();
  const segments = pathLower.split("/");
  const dirSegments = segments.slice(0, -1);
  const fileName = segments[segments.length - 1];
  const fileNameNoExt = fileName.replace(/\.[^.]+$/, "");

  for (const term of terms) {
    const termLower = term.toLowerCase();

    // Directory segment exact match → highest boost
    for (const seg of dirSegments) {
      if (seg === termLower) {
        maxBoost = Math.max(maxBoost, PATH_BOOST_DIR_EXACT);
      }
    }

    // Filename (without extension) match
    if (fileNameNoExt === termLower) {
      maxBoost = Math.max(maxBoost, PATH_BOOST_FILENAME);
    }

    // Partial path match (substring anywhere)
    if (maxBoost < PATH_BOOST_PARTIAL && pathLower.includes(termLower)) {
      maxBoost = Math.max(maxBoost, PATH_BOOST_PARTIAL);
    }
  }

  return maxBoost;
}

/** Penalize import chunks when non-import alternatives exist. */
function applyImportDeprioritization(results: SearchResult[]): SearchResult[] {
  const hasNonImport = results.some((r) => r.type !== "import");
  if (!hasNonImport) return results; // All imports → no penalty

  // Check if there are non-import results with positive scores
  const maxNonImportScore = Math.max(
    ...results.filter((r) => r.type !== "import").map((r) => r.score),
    0,
  );

  if (maxNonImportScore === 0) return results;

  return results.map((r) => {
    if (r.type === "import") {
      return { ...r, score: r.score * IMPORT_PENALTY };
    }
    return r;
  });
}

/** Re-normalize scores so the maximum is 1.0. */
function renormalize(results: SearchResult[]): SearchResult[] {
  if (results.length === 0) return results;

  const maxScore = Math.max(...results.map((r) => r.score));
  if (maxScore === 0) return results;

  return results.map((r) => ({
    ...r,
    score: r.score / maxScore,
  }));
}
