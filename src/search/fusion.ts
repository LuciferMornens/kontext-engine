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
const TEST_FILE_PENALTY = 0.65;
const SMALL_SNIPPET_PENALTY = 0.75;
const PUBLIC_API_BOOST = 1.12;

const TEST_FILE_DIRECTORY_PATTERN = /(?:^|\/)(?:tests|__tests__)(?:\/|$)/;
const TEST_FILE_NAME_PATTERN = /(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SMALL_SNIPPET_MAX_LINES = 3;

// ── Path boost term extraction ───────────────────────────────────────────────

/** Extract terms from a query for path-based boosting. Splits on whitespace and drops short tokens. */
export function extractPathBoostTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

// ── Fusion with path boost + deprioritization ────────────────────────────────

/**
 * Merge results with RRF, then apply:
 * 1. Path-based boosting for results matching boost terms
 * 2. Import chunk deprioritization when non-import alternatives exist
 * 3. Test file deprioritization when non-test alternatives exist
 * 4. Tiny snippet deprioritization (1–3 lines) when larger alternatives exist
 * 5. Mild public API boost for exported symbols
 * 6. File diversity diminishing returns to avoid over-concentration per file
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

  // 2. Apply import + test-file + tiny-snippet deprioritization
  const importAdjusted = applyImportDeprioritization(boosted);
  const testAdjusted = applyTestFileDeprioritization(importAdjusted);
  const snippetAdjusted = applySmallSnippetDeprioritization(testAdjusted);

  // 3. Boost likely public API symbols
  const boostedApi = applyPublicApiBoost(snippetAdjusted);

  // 4. Apply file diversity diminishing returns based on current ranking
  const adjusted = applyFileDiversityDiminishingReturns(boostedApi);

  // 5. Re-sort by adjusted score
  adjusted.sort((a, b) => b.score - a.score);

  // 6. Re-normalize to 0–1
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

/** Penalize test-file chunks when non-test alternatives exist. */
function applyTestFileDeprioritization(results: SearchResult[]): SearchResult[] {
  const hasNonTestFile = results.some((r) => !isTestFilePath(r.filePath));
  if (!hasNonTestFile) return results; // All test files → no penalty

  const maxNonTestScore = Math.max(
    ...results.filter((r) => !isTestFilePath(r.filePath)).map((r) => r.score),
    0,
  );

  if (maxNonTestScore === 0) return results;

  return results.map((r) => {
    if (isTestFilePath(r.filePath)) {
      return { ...r, score: r.score * TEST_FILE_PENALTY };
    }
    return r;
  });
}

/** Penalize tiny snippets when larger alternatives exist. */
function applySmallSnippetDeprioritization(results: SearchResult[]): SearchResult[] {
  const hasNonSmallSnippet = results.some((r) => !isSmallSnippet(r));
  if (!hasNonSmallSnippet) return results; // All snippets are tiny → no penalty

  const maxNonSmallScore = Math.max(
    ...results.filter((r) => !isSmallSnippet(r)).map((r) => r.score),
    0,
  );
  if (maxNonSmallScore === 0) return results;

  return results.map((r) => {
    if (isSmallSnippet(r)) {
      return { ...r, score: r.score * SMALL_SNIPPET_PENALTY };
    }
    return r;
  });
}

/** Apply mild boost to exported symbols that are likely part of the public API. */
function applyPublicApiBoost(results: SearchResult[]): SearchResult[] {
  return results.map((r) => {
    if (isPublicApiSymbol(r)) {
      return { ...r, score: r.score * PUBLIC_API_BOOST };
    }
    return r;
  });
}

/** Reduce score for repeated hits from the same file to improve result diversity. */
function applyFileDiversityDiminishingReturns(
  results: SearchResult[],
): SearchResult[] {
  if (results.length <= 1) return results;

  const ranked = [...results].sort((a, b) => b.score - a.score);
  const seenPerFile = new Map<string, number>();

  return ranked.map((r) => {
    const count = (seenPerFile.get(r.filePath) ?? 0) + 1;
    seenPerFile.set(r.filePath, count);
    return {
      ...r,
      score: r.score * getFileDiversityFactor(count),
    };
  });
}

/** Identify common test file paths across JS/TS repos. */
function isTestFilePath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase().replace(/\\/g, "/");
  return (
    TEST_FILE_DIRECTORY_PATTERN.test(normalizedPath) ||
    TEST_FILE_NAME_PATTERN.test(normalizedPath)
  );
}

/** Check if a chunk is very small (1–3 lines). */
function isSmallSnippet(result: SearchResult): boolean {
  const lineCount = Math.max(1, result.lineEnd - result.lineStart + 1);
  return lineCount <= SMALL_SNIPPET_MAX_LINES;
}

/** Detect symbols that look like public API declarations. */
function isPublicApiSymbol(result: SearchResult): boolean {
  if (result.exported === true) return true;

  const textStart = result.text.trimStart().toLowerCase();
  return textStart.startsWith("export ");
}

/** Score factor by Nth occurrence from the same file. */
function getFileDiversityFactor(fileOccurrence: number): number {
  if (fileOccurrence <= 1) return 1.0;
  if (fileOccurrence === 2) return 0.9;
  if (fileOccurrence === 3) return 0.8;
  return 0.7;
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
