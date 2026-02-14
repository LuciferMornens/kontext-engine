import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase } from "../../src/storage/db.js";
import type { KontextDatabase } from "../../src/storage/db.js";
import { ftsSearch, sanitizeFtsQuery } from "../../src/search/fts.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

let db: KontextDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-fts-"));
  db = createDatabase(path.join(tmpDir, "index.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedTestData(): void {
  const fileId1 = db.upsertFile({
    path: "src/auth.ts",
    language: "typescript",
    hash: "h1",
    size: 500,
  });
  const fileId2 = db.upsertFile({
    path: "src/pool.py",
    language: "python",
    hash: "h2",
    size: 300,
  });
  const fileId3 = db.upsertFile({
    path: "src/handler.ts",
    language: "typescript",
    hash: "h3",
    size: 400,
  });

  db.insertChunks(fileId1, [
    {
      lineStart: 1,
      lineEnd: 10,
      type: "function",
      name: "validateToken",
      parent: "AuthService",
      text: "function validateToken(token: string): boolean { return jwt.verify(token); }",
      imports: ["jsonwebtoken"],
      exports: true,
      hash: "c1",
    },
    {
      lineStart: 12,
      lineEnd: 20,
      type: "function",
      name: "refreshToken",
      parent: "AuthService",
      text: "function refreshToken(oldToken: string): string { return jwt.sign(decode(oldToken)); }",
      imports: ["jsonwebtoken"],
      exports: true,
      hash: "c1b",
    },
  ]);

  db.insertChunks(fileId2, [
    {
      lineStart: 1,
      lineEnd: 8,
      type: "function",
      name: "create_pool",
      parent: null,
      text: "def create_pool(url: str) -> Pool: return Pool(url, max_size=10)",
      imports: [],
      exports: false,
      hash: "c2",
    },
  ]);

  db.insertChunks(fileId3, [
    {
      lineStart: 1,
      lineEnd: 12,
      type: "method",
      name: "handleRequest",
      parent: "RequestHandler",
      text: "async handleRequest(req: Request, res: Response) { res.json(await this.service.process(req)); }",
      imports: [],
      exports: true,
      hash: "c3",
    },
  ]);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ftsSearch", () => {
  it("finds exact keyword match", () => {
    seedTestData();

    const results = ftsSearch(db, "validateToken", 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("validateToken");
    expect(results[0].filePath).toBe("src/auth.ts");
  });

  it("returns full metadata in results", () => {
    seedTestData();

    const results = ftsSearch(db, "validateToken", 10);

    const first = results[0];
    expect(first.chunkId).toBeDefined();
    expect(first.filePath).toBe("src/auth.ts");
    expect(first.lineStart).toBe(1);
    expect(first.lineEnd).toBe(10);
    expect(first.name).toBe("validateToken");
    expect(first.type).toBe("function");
    expect(first.text).toContain("validateToken");
    expect(first.language).toBe("typescript");
    expect(typeof first.score).toBe("number");
  });

  it("searches by text content", () => {
    seedTestData();

    const results = ftsSearch(db, "Pool", 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("create_pool");
  });

  it("searches by parent class name", () => {
    seedTestData();

    const results = ftsSearch(db, "RequestHandler", 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("handleRequest");
  });

  it("prefix search works", () => {
    seedTestData();

    const results = ftsSearch(db, "auth*", 10);

    // Should match AuthService parent
    expect(results.length).toBeGreaterThan(0);
  });

  it("BM25 scores rank results in descending order", () => {
    seedTestData();

    // "jwt" appears in both auth chunks' text
    const results = ftsSearch(db, "jwt", 10);

    expect(results.length).toBeGreaterThanOrEqual(2);

    // Scores should be sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it("score is in 0-1 range", () => {
    seedTestData();

    const results = ftsSearch(db, "token", 10);

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("filters by language", () => {
    seedTestData();

    const results = ftsSearch(db, "Pool", 10, { language: "python" });

    for (const r of results) {
      expect(r.language).toBe("python");
    }
  });

  it("language filter can exclude all results", () => {
    seedTestData();

    const results = ftsSearch(db, "token", 10, { language: "rust" });

    expect(results).toEqual([]);
  });

  it("returns empty for no matches", () => {
    seedTestData();

    const results = ftsSearch(db, "xyzzyNonexistent12345", 10);

    expect(results).toEqual([]);
  });

  it("returns empty on empty DB", () => {
    const results = ftsSearch(db, "anything", 10);

    expect(results).toEqual([]);
  });

  it("respects limit parameter", () => {
    seedTestData();

    const results = ftsSearch(db, "token", 1);

    expect(results).toHaveLength(1);
  });

  describe("special character handling", () => {
    it("does not crash on question mark in query", () => {
      seedTestData();

      // "how does token work?" → "how does token work" — FTS5 AND means all must match,
      // but the key assertion is that it does NOT throw a syntax error.
      expect(() => ftsSearch(db, "how does token work?", 10)).not.toThrow();
    });

    it("handles parentheses in query", () => {
      seedTestData();

      // "Pool(url)" → "Pool url" — both tokens exist in create_pool's text
      const results = ftsSearch(db, "Pool(url)", 10);

      expect(results.length).toBeGreaterThan(0);
    });

    it("does not crash on double quotes in query", () => {
      seedTestData();

      expect(() => ftsSearch(db, 'the "token" handler', 10)).not.toThrow();
    });

    it("does not crash on mixed special characters", () => {
      seedTestData();

      expect(() => ftsSearch(db, "validate+token? (auth) -test", 10)).not.toThrow();
    });

    it("returns empty for query that is ONLY special characters", () => {
      seedTestData();

      const results = ftsSearch(db, "???()\"\"+-:", 10);

      expect(results).toEqual([]);
    });

    it("does not crash on colon and caret", () => {
      seedTestData();

      expect(() => ftsSearch(db, "name:token ^important", 10)).not.toThrow();
    });

    it("finds results after stripping tilde and exclamation", () => {
      seedTestData();

      // "~token !jwt" → "token jwt" — both exist in validateToken and refreshToken text
      const results = ftsSearch(db, "~token !jwt", 10);

      expect(results.length).toBeGreaterThan(0);
    });

    it("preserves prefix wildcard (*) at end of word", () => {
      seedTestData();

      const results = ftsSearch(db, "auth*", 10);

      expect(results.length).toBeGreaterThan(0);
    });
  });
});

// ── sanitizeFtsQuery tests ───────────────────────────────────────────────────

describe("sanitizeFtsQuery", () => {
  it("passes through simple words unchanged", () => {
    expect(sanitizeFtsQuery("hello world")).toBe("hello world");
  });

  it("strips question marks", () => {
    expect(sanitizeFtsQuery("how does it work?")).toBe("how does it work");
  });

  it("strips parentheses", () => {
    expect(sanitizeFtsQuery("Pool(url)")).toBe("Pool url");
  });

  it("strips double quotes", () => {
    expect(sanitizeFtsQuery('the "token" handler')).toBe("the token handler");
  });

  it("strips colons", () => {
    expect(sanitizeFtsQuery("name:value")).toBe("name value");
  });

  it("strips plus and minus operators", () => {
    expect(sanitizeFtsQuery("+required -excluded")).toBe("required excluded");
  });

  it("strips carets and tildes", () => {
    expect(sanitizeFtsQuery("^boost ~near")).toBe("boost near");
  });

  it("strips exclamation marks", () => {
    expect(sanitizeFtsQuery("NOT!this")).toBe("NOT this");
  });

  it("collapses multiple spaces", () => {
    expect(sanitizeFtsQuery("hello   ?   world")).toBe("hello world");
  });

  it("returns empty string for only special characters", () => {
    expect(sanitizeFtsQuery("???()\"\"+-:")).toBe("");
  });

  it("preserves trailing * for prefix search", () => {
    expect(sanitizeFtsQuery("auth*")).toBe("auth*");
  });

  it("strips standalone * not at end of a word", () => {
    expect(sanitizeFtsQuery("* token")).toBe("token");
  });

  it("preserves underscores", () => {
    expect(sanitizeFtsQuery("my_function")).toBe("my_function");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeFtsQuery("  hello  ")).toBe("hello");
  });

  it("handles curly braces", () => {
    expect(sanitizeFtsQuery("{hello}")).toBe("hello");
  });

  it("handles backslashes", () => {
    expect(sanitizeFtsQuery("path\\to\\file")).toBe("path to file");
  });
});
