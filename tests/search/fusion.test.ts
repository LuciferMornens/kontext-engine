import { describe, it, expect } from "vitest";
import { fusionMerge, fusionMergeWithPathBoost } from "../../src/search/fusion.js";
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

// ── Helpers for path boost / import deprioritization ─────────────────────────

function makeResultEx(
  chunkId: number,
  opts: {
    name: string;
    filePath: string;
    type?: string;
    score?: number;
    lineStart?: number;
    lineEnd?: number;
    text?: string;
  },
): SearchResult {
  return {
    chunkId,
    filePath: opts.filePath,
    lineStart: opts.lineStart ?? 1,
    lineEnd: opts.lineEnd ?? 10,
    name: opts.name,
    type: opts.type ?? "function",
    text: opts.text ?? `function ${opts.name}() {}`,
    score: opts.score ?? 0.5,
    language: "typescript",
  };
}

// ── fusionMergeWithPathBoost tests ───────────────────────────────────────────

describe("fusionMergeWithPathBoost", () => {
  describe("path boosting", () => {
    it("boosts results whose directory matches a boost term", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "handleAuth", filePath: "src/handler.ts" }),
            makeResultEx(2, { name: "validateToken", filePath: "src/indexer/token.ts" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, ["indexer"]);

      // indexer/token.ts should be boosted above handler.ts
      expect(results[0].chunkId).toBe(2);
      expect(results[0].filePath).toContain("indexer");
    });

    it("directory segment exact match gets 1.5x boost", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "a", filePath: "src/other/a.ts" }),
            makeResultEx(2, { name: "b", filePath: "src/indexer/b.ts" }),
          ],
        },
      ];

      const withBoost = fusionMergeWithPathBoost(input, 10, ["indexer"]);
      const without = fusionMerge(input, 10);

      // Both should have the same items but different ordering
      const boostedResult = withBoost.find((r) => r.chunkId === 2);
      const unboostedResult = without.find((r) => r.chunkId === 2);
      expect(boostedResult).toBeDefined();
      expect(unboostedResult).toBeDefined();
      const boostedScore = boostedResult?.score ?? 0;
      const unboostedScore = unboostedResult?.score ?? 0;

      // Boosted score relative to unboosted should be higher
      expect(boostedScore).toBeGreaterThan(unboostedScore);
    });

    it("filename match gets 1.4x boost", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "a", filePath: "src/other/a.ts" }),
            makeResultEx(2, { name: "indexer", filePath: "src/utils/indexer.ts" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, ["indexer"]);

      // indexer.ts should be boosted
      expect(results[0].chunkId).toBe(2);
    });

    it("partial path match gets 1.2x boost", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "a", filePath: "src/other/a.ts" }),
            makeResultEx(2, { name: "b", filePath: "src/my-indexer-lib/b.ts" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, ["indexer"]);

      // my-indexer-lib contains "indexer" as substring → 1.2x
      expect(results[0].chunkId).toBe(2);
    });

    it("no boost applied when no terms match any path", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "alpha", filePath: "src/alpha.ts" }),
            makeResultEx(2, { name: "beta", filePath: "src/beta.ts" }),
          ],
        },
      ];

      const withBoost = fusionMergeWithPathBoost(input, 10, ["zzz"]);
      const without = fusionMerge(input, 10);

      // Scores should be identical
      expect(withBoost[0].score).toBe(without[0].score);
      expect(withBoost[1].score).toBe(without[1].score);
    });

    it("empty boost terms behaves like fusionMerge", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [makeResult(1, "alpha"), makeResult(2, "beta")],
        },
      ];

      const withBoost = fusionMergeWithPathBoost(input, 10, []);
      const without = fusionMerge(input, 10);

      expect(withBoost).toEqual(without);
    });
  });

  describe("import deprioritization", () => {
    it("penalizes import chunks when non-import results exist", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "imports", filePath: "src/handler.ts", type: "import" }),
            makeResultEx(2, { name: "validateToken", filePath: "src/auth.ts", type: "function" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, []);

      // The function chunk should rank above the import chunk
      expect(results[0].chunkId).toBe(2);
      expect(results[0].type).toBe("function");
    });

    it("does NOT penalize imports when they are the only results", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "imports", filePath: "src/a.ts", type: "import" }),
            makeResultEx(2, { name: "imports", filePath: "src/b.ts", type: "import" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, []);

      // Both are imports, no penalty should be applied — scores stay normalized
      expect(results[0].score).toBe(1.0);
    });

    it("import chunk from the same file as a non-import is penalized", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "imports", filePath: "src/auth.ts", type: "import" }),
            makeResultEx(2, { name: "validateToken", filePath: "src/auth.ts", type: "function" }),
            makeResultEx(3, { name: "imports", filePath: "src/other.ts", type: "import" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, []);

      // Function should be first, then imports penalized
      expect(results[0].type).toBe("function");
      // Import from same file or imports with higher-scored non-imports should be penalized
      const importScores = results.filter((r) => r.type === "import").map((r) => r.score);
      const functionResult = results.find((r) => r.type === "function");
      expect(functionResult).toBeDefined();
      const functionScore = functionResult?.score ?? 0;
      for (const s of importScores) {
        expect(s).toBeLessThan(functionScore);
      }
    });

    it("combined path boost and import deprioritization", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "imports", filePath: "src/handler.ts", type: "import" }),
            makeResultEx(2, { name: "chunker", filePath: "src/indexer/chunker.ts", type: "function" }),
            makeResultEx(3, { name: "other", filePath: "src/other.ts", type: "function" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, ["indexer"]);

      // indexer/chunker.ts should be first (path boost + function type)
      expect(results[0].chunkId).toBe(2);
      expect(results[0].filePath).toContain("indexer");
      // import chunk should be last
      const importResult = results.find((r) => r.type === "import");
      expect(importResult).toBeDefined();
      expect(results[results.length - 1].type).toBe("import");
    });
  });

  describe("test file deprioritization", () => {
    it("penalizes test files when non-test results exist", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, {
              name: "tmpDir",
              filePath: "tests/indexer/incremental.test.ts",
              type: "constant",
            }),
            makeResultEx(2, {
              name: "runIndexer",
              filePath: "src/indexer/runner.ts",
              type: "function",
            }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, ["indexer"]);

      // Even with path boost on the test file, production code should rank above it.
      expect(results[0].chunkId).toBe(2);
      expect(results[0].filePath).toBe("src/indexer/runner.ts");
    });

    it("does NOT penalize when all results are test files", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "a", filePath: "tests/indexer/a.test.ts" }),
            makeResultEx(2, { name: "b", filePath: "src/__tests__/indexer.spec.ts" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, []);

      expect(results[0].score).toBe(1.0);
      expect(results).toHaveLength(2);
    });

    it("matches __tests__ directories and *.spec.ts filenames", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "suite", filePath: "src/__tests__/indexer.ts" }),
            makeResultEx(2, { name: "core", filePath: "src/indexer/core.ts" }),
            makeResultEx(3, { name: "specCase", filePath: "src/indexer/parser.spec.ts" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, []);
      const nonTest = results.find((r) => r.chunkId === 2);
      const tests = results.filter((r) => r.chunkId !== 2);

      expect(nonTest).toBeDefined();
      for (const testResult of tests) {
        expect(testResult.score).toBeLessThan(nonTest?.score ?? 0);
      }
    });
  });

  describe("additional reranking", () => {
    it("penalizes tiny 1-3 line snippets when larger alternatives exist", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, {
              name: "DEFAULT_MAX_TOKENS",
              filePath: "src/indexer/chunker.ts",
              type: "constant",
              lineStart: 29,
              lineEnd: 31,
            }),
            makeResultEx(2, {
              name: "computeChanges",
              filePath: "src/indexer/incremental.ts",
              type: "function",
              lineStart: 35,
              lineEnd: 85,
            }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, ["indexer"]);

      expect(results[0].chunkId).toBe(2);
      expect(results[0].name).toBe("computeChanges");
    });

    it("applies diminishing returns to repeated results from the same file", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "a1", filePath: "src/indexer/chunker.ts" }),
            makeResultEx(2, { name: "a2", filePath: "src/indexer/chunker.ts" }),
            makeResultEx(3, { name: "a3", filePath: "src/indexer/chunker.ts" }),
            makeResultEx(4, { name: "b1", filePath: "src/indexer/parser.ts" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, ["indexer"]);

      // parser.ts result should bubble above chunker.ts second/third results.
      expect(results[1].chunkId).toBe(4);
      expect(results[1].filePath).toBe("src/indexer/parser.ts");
    });

    it("boosts exported/public API symbols over nearby internal helpers", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, {
              name: "collectImportTexts",
              filePath: "src/indexer/chunker.ts",
              type: "function",
              text: "function collectImportTexts(nodes: ASTNode[]): string[] { return []; }",
            }),
            makeResultEx(2, {
              name: "computeChanges",
              filePath: "src/indexer/incremental.ts",
              type: "function",
              text: "export async function computeChanges(): Promise<void> {}",
            }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, ["indexer"]);

      expect(results[0].chunkId).toBe(2);
      expect(results[0].name).toBe("computeChanges");
    });
  });

  describe("re-normalization", () => {
    it("scores are normalized to 0-1 after boosting", () => {
      const input: StrategyResult[] = [
        {
          strategy: "fts",
          weight: 1.0,
          results: [
            makeResultEx(1, { name: "a", filePath: "src/indexer/a.ts" }),
            makeResultEx(2, { name: "b", filePath: "src/other/b.ts" }),
          ],
        },
      ];

      const results = fusionMergeWithPathBoost(input, 10, ["indexer"]);

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
      expect(results[0].score).toBe(1.0);
    });
  });
});
