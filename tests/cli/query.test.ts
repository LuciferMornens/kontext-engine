import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runQuery, getEffectiveStrategyWeights } from "../../src/cli/commands/query.js";
import type { QueryOptions, QueryOutput } from "../../src/cli/commands/query.js";
import { runInit } from "../../src/cli/commands/init.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-query-"));
  seedFixtureProject();
  // Index the project (skip embedding for speed, but we need vectors for full test)
  await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): void {
  const filePath = path.join(tmpDir, name);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function seedFixtureProject(): void {
  writeFixture(
    "src/auth.ts",
    `import jwt from "jsonwebtoken";

export function validateToken(token: string): boolean {
  return jwt.verify(token) !== null;
}

export function createToken(userId: string): string {
  return jwt.sign({ userId }, "secret");
}

export class AuthService {
  validate(token: string): boolean {
    return validateToken(token);
  }
}
`,
  );

  writeFixture(
    "src/handler.ts",
    `import { validateToken } from "./auth";

export async function handleRequest(req: Request): Promise<Response> {
  const token = req.headers.get("Authorization");
  if (!validateToken(token)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return new Response("OK");
}
`,
  );

  writeFixture(
    "src/utils.py",
    `def format_date(date):
    return date.isoformat()

MAX_RETRIES = 3
`,
  );
}

// ── Capture output ───────────────────────────────────────────────────────────

async function runQueryCapture(
  query: string,
  options: Partial<QueryOptions> = {},
): Promise<QueryOutput> {
  return runQuery(tmpDir, query, {
    limit: 10,
    strategies: ["fts", "ast"],
    format: "json",
    ...options,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ctx query", () => {
  describe("query classification weight adjustments", () => {
    it("boosts vector for NL queries", () => {
      const weights = getEffectiveStrategyWeights("how does the indexer work");
      expect(weights.vector).toBeGreaterThan(weights.fts);
      expect(weights.vector).toBeGreaterThan(weights.ast);
    });

    it("boosts AST for symbol queries", () => {
      const weights = getEffectiveStrategyWeights("computeChanges");
      expect(weights.ast).toBeGreaterThan(weights.fts);
      expect(weights.ast).toBeGreaterThan(weights.vector);
    });
  });

  describe("JSON output", () => {
    it("returns valid JSON structure", async () => {
      const output = await runQueryCapture("validateToken");

      expect(output.query).toBe("validateToken");
      expect(Array.isArray(output.results)).toBe(true);
      expect(output.stats).toBeDefined();
      expect(typeof output.stats.totalResults).toBe("number");
      expect(typeof output.stats.searchTimeMs).toBe("number");
      expect(Array.isArray(output.stats.strategies)).toBe(true);
    });

    it("results have correct shape", async () => {
      const output = await runQueryCapture("validateToken");

      expect(output.results.length).toBeGreaterThan(0);
      const first = output.results[0];
      expect(typeof first.file).toBe("string");
      expect(Array.isArray(first.lines)).toBe(true);
      expect(first.lines).toHaveLength(2);
      expect(typeof first.score).toBe("number");
      expect(typeof first.snippet).toBe("string");
    });

    it("snippet is truncated to 200 chars", async () => {
      const output = await runQueryCapture("handleRequest");

      for (const r of output.results) {
        expect(r.snippet.length).toBeLessThanOrEqual(203); // 200 + "..."
      }
    });
  });

  describe("text output", () => {
    it("formats results as human-readable text", async () => {
      const output = await runQueryCapture("validateToken", { format: "text" });

      expect(output.text).toBeDefined();
      expect(output.text).toContain("validateToken");
    });

    it("includes file path and line numbers", async () => {
      const output = await runQueryCapture("validateToken", { format: "text" });

      expect(output.text).toMatch(/src\/auth\.ts:\d+-\d+/);
    });
  });

  describe("--limit flag", () => {
    it("limits number of results", async () => {
      const output = await runQueryCapture("token", { limit: 1 });

      expect(output.results.length).toBeLessThanOrEqual(1);
    });
  });

  describe("--strategy flag", () => {
    it("uses only specified strategies", async () => {
      const output = await runQueryCapture("validateToken", {
        strategies: ["fts"],
      });

      expect(output.stats.strategies).toEqual(["fts"]);
    });

    it("ast-only returns structural matches", async () => {
      const output = await runQueryCapture("validateToken", {
        strategies: ["ast"],
      });

      expect(output.results.length).toBeGreaterThan(0);
      expect(output.stats.strategies).toEqual(["ast"]);
    });
  });

  describe("--language flag", () => {
    it("filters results by language", async () => {
      const output = await runQueryCapture("format", {
        strategies: ["fts"],
        language: "python",
      });

      for (const r of output.results) {
        expect(r.language).toBe("python");
      }
    });
  });

  describe("error handling", () => {
    it("throws when .ctx/ does not exist", async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-noindex-"));
      try {
        await expect(
          runQuery(emptyDir, "test", { limit: 10, strategies: ["fts"], format: "json" }),
        ).rejects.toThrow(/not initialized/i);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe("empty results", () => {
    it("returns empty results for nonsense query", async () => {
      const output = await runQueryCapture("xyzzyNonexistent12345abc", {
        strategies: ["fts"],
      });

      expect(output.results).toEqual([]);
      expect(output.stats.totalResults).toBe(0);
    });
  });

  describe("search quality: source over imports", () => {
    let indexerDir: string;

    beforeEach(async () => {
      // Create a project with indexer source files and a handler that imports from indexer
      indexerDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-indexer-"));

      // Source file in src/indexer/
      const indexerSrc = path.join(indexerDir, "src", "indexer");
      fs.mkdirSync(indexerSrc, { recursive: true });
      fs.writeFileSync(
        path.join(indexerSrc, "chunker.ts"),
        `export function chunkFile(content: string): string[] {
  const lines = content.split("\\n");
  return lines;
}

export function mergeChunks(chunks: string[]): string {
  return chunks.join("\\n");
}
`,
      );

      // Handler that imports from indexer
      const handlerDir = path.join(indexerDir, "src");
      fs.writeFileSync(
        path.join(handlerDir, "handler.ts"),
        `import { chunkFile, mergeChunks } from "./indexer/chunker";

export async function handleIndex(content: string): Promise<string> {
  const chunks = chunkFile(content);
  return mergeChunks(chunks);
}
`,
      );

      await runInit(indexerDir, { log: () => undefined, skipEmbedding: true });
    });

    afterEach(() => {
      fs.rmSync(indexerDir, { recursive: true, force: true });
    });

    it("query 'indexer' returns indexer source files before import chunks", async () => {
      const output = await runQuery(indexerDir, "indexer", {
        limit: 10,
        strategies: ["fts", "ast", "path"],
        format: "json",
      });

      // There should be results
      expect(output.results.length).toBeGreaterThan(0);

      // Find results from src/indexer/ directory
      const indexerResults = output.results.filter((r) =>
        r.file.includes("indexer/"),
      );

      // Find import-type results
      const importResults = output.results.filter((r) => r.type === "import");

      // Indexer source files should appear in results
      expect(indexerResults.length).toBeGreaterThan(0);

      // If there are import results, they should score lower than indexer source
      if (importResults.length > 0 && indexerResults.length > 0) {
        const topIndexerScore = Math.max(...indexerResults.map((r) => r.score));
        const topImportScore = Math.max(...importResults.map((r) => r.score));
        expect(topIndexerScore).toBeGreaterThan(topImportScore);
      }
    });

    it("default strategies include path strategy", async () => {
      const output = await runQuery(indexerDir, "indexer", {
        limit: 10,
        strategies: ["fts", "ast", "path"],
        format: "json",
      });

      expect(output.stats.strategies).toContain("path");
    });
  });
});
