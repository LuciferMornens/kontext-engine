import { describe, it, expect } from "vitest";
import { fusionMerge } from "../../src/search/fusion.js";
import type { StrategyResult } from "../../src/search/fusion.js";
import type { SearchResult } from "../../src/search/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(
  chunkId: number,
  name: string,
  score = 0.5,
): SearchResult {
  return {
    chunkId,
    filePath: `src/${name}.ts`,
    lineStart: 1,
    lineEnd: 10,
    name,
    type: "function",
    text: `function ${name}() {}`,
    score,
    language: "typescript",
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("fusionMerge", () => {
  it("single strategy passthrough preserves order", () => {
    const input: StrategyResult[] = [
      {
        strategy: "vector",
        weight: 1.0,
        results: [
          makeResult(1, "alpha", 0.9),
          makeResult(2, "beta", 0.7),
          makeResult(3, "gamma", 0.5),
        ],
      },
    ];

    const results = fusionMerge(input, 10);

    expect(results).toHaveLength(3);
    // Order should be preserved (rank 1 gets highest RRF score)
    expect(results[0].name).toBe("alpha");
    expect(results[1].name).toBe("beta");
    expect(results[2].name).toBe("gamma");
  });

  it("chunk appearing in multiple strategies gets higher score", () => {
    const input: StrategyResult[] = [
      {
        strategy: "vector",
        weight: 1.0,
        results: [
          makeResult(1, "shared", 0.9),
          makeResult(2, "vectorOnly", 0.8),
        ],
      },
      {
        strategy: "fts",
        weight: 1.0,
        results: [
          makeResult(1, "shared", 0.9),
          makeResult(3, "ftsOnly", 0.8),
        ],
      },
    ];

    const results = fusionMerge(input, 10);

    // "shared" (chunkId=1) appears in both → should be ranked first
    expect(results[0].chunkId).toBe(1);
    expect(results[0].name).toBe("shared");

    // Its score should be higher than single-strategy results
    const sharedScore = results[0].score;
    const singleScores = results.filter((r) => r.chunkId !== 1).map((r) => r.score);
    for (const s of singleScores) {
      expect(sharedScore).toBeGreaterThan(s);
    }
  });

  it("weights affect ranking", () => {
    const input: StrategyResult[] = [
      {
        strategy: "vector",
        weight: 1.0,
        results: [makeResult(1, "vectorTop", 0.9)],
      },
      {
        strategy: "fts",
        weight: 3.0,
        results: [makeResult(2, "ftsTop", 0.9)],
      },
    ];

    const results = fusionMerge(input, 10);

    // FTS has 3x weight, so ftsTop should rank higher
    expect(results[0].chunkId).toBe(2);
    expect(results[0].name).toBe("ftsTop");
  });

  it("deduplicates: same chunkId from 3 strategies appears once", () => {
    const input: StrategyResult[] = [
      {
        strategy: "vector",
        weight: 1.0,
        results: [makeResult(42, "shared")],
      },
      {
        strategy: "fts",
        weight: 1.0,
        results: [makeResult(42, "shared")],
      },
      {
        strategy: "ast",
        weight: 1.0,
        results: [makeResult(42, "shared")],
      },
    ];

    const results = fusionMerge(input, 10);

    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe(42);
  });

  it("respects limit parameter", () => {
    const input: StrategyResult[] = [
      {
        strategy: "vector",
        weight: 1.0,
        results: [
          makeResult(1, "a"),
          makeResult(2, "b"),
          makeResult(3, "c"),
          makeResult(4, "d"),
          makeResult(5, "e"),
        ],
      },
    ];

    const results = fusionMerge(input, 2);

    expect(results).toHaveLength(2);
  });

  it("scores are normalized to 0-1 range", () => {
    const input: StrategyResult[] = [
      {
        strategy: "vector",
        weight: 1.0,
        results: [
          makeResult(1, "first", 0.9),
          makeResult(2, "second", 0.5),
        ],
      },
      {
        strategy: "fts",
        weight: 1.0,
        results: [
          makeResult(1, "first", 0.8),
          makeResult(3, "third", 0.6),
        ],
      },
    ];

    const results = fusionMerge(input, 10);

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }

    // Top result should have score = 1.0 (normalized max)
    expect(results[0].score).toBe(1.0);
  });

  it("returns empty for empty input", () => {
    expect(fusionMerge([], 10)).toEqual([]);
  });

  it("returns empty when all strategies have empty results", () => {
    const input: StrategyResult[] = [
      { strategy: "vector", weight: 1.0, results: [] },
      { strategy: "fts", weight: 1.0, results: [] },
    ];

    expect(fusionMerge(input, 10)).toEqual([]);
  });

  it("handles single result correctly", () => {
    const input: StrategyResult[] = [
      {
        strategy: "vector",
        weight: 1.0,
        results: [makeResult(1, "only")],
      },
    ];

    const results = fusionMerge(input, 10);

    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(1.0);
    expect(results[0].name).toBe("only");
  });

  it("RRF rank position matters more than original score", () => {
    // In strategy A, chunk 1 is rank 1; in strategy B, chunk 2 is rank 1
    // Both at rank 1 in their strategy → equal RRF contribution
    // But chunk 1 also appears at rank 2 in strategy B → higher combined
    const input: StrategyResult[] = [
      {
        strategy: "vector",
        weight: 1.0,
        results: [
          makeResult(1, "both_strats", 0.9),
          makeResult(3, "vector_r2", 0.5),
        ],
      },
      {
        strategy: "fts",
        weight: 1.0,
        results: [
          makeResult(2, "fts_r1", 0.95),
          makeResult(1, "both_strats", 0.4),
        ],
      },
    ];

    const results = fusionMerge(input, 10);

    // chunk 1 appears in both strategies → should be #1
    expect(results[0].chunkId).toBe(1);
  });

  it("zero-weight strategy contributes nothing", () => {
    const input: StrategyResult[] = [
      {
        strategy: "vector",
        weight: 1.0,
        results: [makeResult(1, "weighted")],
      },
      {
        strategy: "fts",
        weight: 0,
        results: [makeResult(2, "zero_weight")],
      },
    ];

    const results = fusionMerge(input, 10);

    // chunk 2 gets 0 score from its strategy
    expect(results[0].chunkId).toBe(1);
    // chunk 2 should still appear but with score 0 (or near 0 normalized)
    const chunk2 = results.find((r) => r.chunkId === 2);
    expect(chunk2?.score).toBe(0);
  });
});
