import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase } from "../../src/storage/db.js";
import type { KontextDatabase } from "../../src/storage/db.js";
import { pathSearch, pathKeywordSearch, dependencyTrace } from "../../src/search/path.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

let db: KontextDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-path-"));
  db = createDatabase(path.join(tmpDir, "index.db"));
  seedTestData();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// chunkIds stored so dependency tests can reference them
let chunkA: number; // validateToken in src/auth/token.ts
let chunkB: number; // AuthService  in src/auth/service.ts
let chunkC: number; // handleAuth   in src/middleware/auth.ts
let chunkD: number; // appRouter    in src/routes/index.ts
let chunkE: number; // create_pool  in src/db/pool.py

function seedTestData(): void {
  const f1 = db.upsertFile({ path: "src/auth/token.ts", language: "typescript", hash: "h1", size: 200 });
  const f2 = db.upsertFile({ path: "src/auth/service.ts", language: "typescript", hash: "h2", size: 300 });
  const f3 = db.upsertFile({ path: "src/middleware/auth.ts", language: "typescript", hash: "h3", size: 250 });
  const f4 = db.upsertFile({ path: "src/routes/index.ts", language: "typescript", hash: "h4", size: 150 });
  const f5 = db.upsertFile({ path: "src/db/pool.py", language: "python", hash: "h5", size: 180 });

  [chunkA] = db.insertChunks(f1, [{
    lineStart: 1, lineEnd: 10, type: "function", name: "validateToken",
    parent: null, text: "function validateToken() {}", imports: [], exports: true, hash: "ca",
  }]);

  [chunkB] = db.insertChunks(f2, [{
    lineStart: 1, lineEnd: 20, type: "class", name: "AuthService",
    parent: null, text: "class AuthService {}", imports: [], exports: true, hash: "cb",
  }]);

  [chunkC] = db.insertChunks(f3, [{
    lineStart: 1, lineEnd: 15, type: "function", name: "handleAuth",
    parent: null, text: "function handleAuth() {}", imports: [], exports: true, hash: "cc",
  }]);

  [chunkD] = db.insertChunks(f4, [{
    lineStart: 1, lineEnd: 8, type: "constant", name: "appRouter",
    parent: null, text: "const appRouter = Router();", imports: [], exports: true, hash: "cd",
  }]);

  [chunkE] = db.insertChunks(f5, [{
    lineStart: 1, lineEnd: 10, type: "function", name: "create_pool",
    parent: null, text: "def create_pool(): pass", imports: [], exports: false, hash: "ce",
  }]);

  // Dependency chain: D → C → B → A
  // appRouter imports handleAuth, handleAuth imports AuthService, AuthService imports validateToken
  db.insertDependency(chunkD, chunkC, "import");
  db.insertDependency(chunkC, chunkB, "import");
  db.insertDependency(chunkB, chunkA, "import");
}

// ── pathSearch tests ─────────────────────────────────────────────────────────

describe("pathSearch", () => {
  it("matches exact file path", () => {
    const results = pathSearch(db, "src/auth/token.ts", 10);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("validateToken");
    expect(results[0].filePath).toBe("src/auth/token.ts");
  });

  it("matches directory wildcard with *", () => {
    const results = pathSearch(db, "src/auth/*", 10);

    expect(results).toHaveLength(2);
    const files = results.map((r) => r.filePath);
    expect(files).toContain("src/auth/token.ts");
    expect(files).toContain("src/auth/service.ts");
  });

  it("matches deep wildcard with **", () => {
    const results = pathSearch(db, "**/*.ts", 10);

    expect(results).toHaveLength(4); // all .ts chunks
    for (const r of results) {
      expect(r.filePath.endsWith(".ts")).toBe(true);
    }
  });

  it("matches extension pattern", () => {
    const results = pathSearch(db, "**/*.py", 10);

    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe("src/db/pool.py");
    expect(results[0].language).toBe("python");
  });

  it("matches partial directory name", () => {
    const results = pathSearch(db, "src/middle*/*", 10);

    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe("src/middleware/auth.ts");
  });

  it("returns empty for non-matching pattern", () => {
    const results = pathSearch(db, "lib/**/*", 10);

    expect(results).toEqual([]);
  });

  it("respects limit parameter", () => {
    const results = pathSearch(db, "**/*", 2);

    expect(results).toHaveLength(2);
  });

  it("assigns score of 1.0 to all path matches", () => {
    const results = pathSearch(db, "src/auth/*", 10);

    for (const r of results) {
      expect(r.score).toBe(1.0);
    }
  });

  it("returns full metadata", () => {
    const results = pathSearch(db, "src/auth/token.ts", 10);

    const r = results[0];
    expect(r.chunkId).toBeDefined();
    expect(r.filePath).toBe("src/auth/token.ts");
    expect(r.lineStart).toBe(1);
    expect(r.lineEnd).toBe(10);
    expect(r.name).toBe("validateToken");
    expect(r.type).toBe("function");
    expect(r.language).toBe("typescript");
  });
});

// ── pathKeywordSearch tests ───────────────────────────────────────────────────

describe("pathKeywordSearch", () => {
  it("returns chunks from files whose directory matches the query", () => {
    const results = pathKeywordSearch(db, "auth", 10);

    expect(results.length).toBeGreaterThan(0);
    const files = results.map((r) => r.filePath);
    expect(files).toContain("src/auth/token.ts");
    expect(files).toContain("src/auth/service.ts");
  });

  it("also matches files in other directories that contain the term in their path", () => {
    // src/middleware/auth.ts has "auth" in the filename
    const results = pathKeywordSearch(db, "auth", 10);

    const files = results.map((r) => r.filePath);
    expect(files).toContain("src/middleware/auth.ts");
  });

  it("directory name exact match scores highest (1.0)", () => {
    const results = pathKeywordSearch(db, "auth", 10);

    // src/auth/* files have the directory segment exactly matching "auth"
    const authDirResult = results.find((r) => r.filePath === "src/auth/token.ts");
    expect(authDirResult).toBeDefined();
    expect(authDirResult?.score).toBe(1.0);
  });

  it("filename match scores 0.9", () => {
    // src/middleware/auth.ts has "auth" as filename (without extension)
    const results = pathKeywordSearch(db, "auth", 10);

    const middlewareResult = results.find((r) => r.filePath === "src/middleware/auth.ts");
    expect(middlewareResult).toBeDefined();
    expect(middlewareResult?.score).toBe(0.9);
  });

  it("partial path match scores 0.7", () => {
    // "middle" partially matches "middleware" in the path
    const results = pathKeywordSearch(db, "middle", 10);

    expect(results.length).toBeGreaterThan(0);
    const middlewareResult = results.find((r) => r.filePath === "src/middleware/auth.ts");
    expect(middlewareResult).toBeDefined();
    expect(middlewareResult?.score).toBe(0.7);
  });

  it("returns empty for non-matching term", () => {
    const results = pathKeywordSearch(db, "nonexistent", 10);

    expect(results).toEqual([]);
  });

  it("is case-insensitive", () => {
    const results = pathKeywordSearch(db, "AUTH", 10);

    expect(results.length).toBeGreaterThan(0);
  });

  it("respects limit parameter", () => {
    const results = pathKeywordSearch(db, "auth", 1);

    expect(results).toHaveLength(1);
  });

  it("returns results sorted by score descending", () => {
    const results = pathKeywordSearch(db, "auth", 10);

    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it("matches filename without extension", () => {
    const results = pathKeywordSearch(db, "pool", 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe("src/db/pool.py");
    expect(results[0].score).toBe(0.9); // filename match
  });

  it("returns full metadata", () => {
    const results = pathKeywordSearch(db, "auth", 10);

    const r = results[0];
    expect(r.chunkId).toBeDefined();
    expect(r.filePath).toBeDefined();
    expect(r.lineStart).toBeDefined();
    expect(r.lineEnd).toBeDefined();
    expect(r.type).toBeDefined();
    expect(r.language).toBeDefined();
  });
});

// ── dependencyTrace tests ────────────────────────────────────────────────────

describe("dependencyTrace", () => {
  describe("imports direction", () => {
    it("follows imports one level deep", () => {
      const results = dependencyTrace(db, chunkC, "imports", 1);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("AuthService");
    });

    it("follows imports two levels deep", () => {
      const results = dependencyTrace(db, chunkC, "imports", 2);

      expect(results).toHaveLength(2);
      const names = results.map((r) => r.name);
      expect(names).toContain("AuthService");    // depth 1
      expect(names).toContain("validateToken");  // depth 2
    });

    it("follows full chain with sufficient depth", () => {
      const results = dependencyTrace(db, chunkD, "imports", 3);

      expect(results).toHaveLength(3);
      const names = results.map((r) => r.name);
      expect(names).toContain("handleAuth");
      expect(names).toContain("AuthService");
      expect(names).toContain("validateToken");
    });

    it("respects depth limit", () => {
      const results = dependencyTrace(db, chunkD, "imports", 1);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("handleAuth");
    });
  });

  describe("importedBy direction", () => {
    it("finds reverse dependencies one level", () => {
      const results = dependencyTrace(db, chunkA, "importedBy", 1);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("AuthService");
    });

    it("finds reverse dependencies two levels", () => {
      const results = dependencyTrace(db, chunkA, "importedBy", 2);

      expect(results).toHaveLength(2);
      const names = results.map((r) => r.name);
      expect(names).toContain("AuthService");
      expect(names).toContain("handleAuth");
    });
  });

  describe("scoring", () => {
    it("decreases score with depth", () => {
      const results = dependencyTrace(db, chunkD, "imports", 3);

      // Results should be ordered, scores should decrease
      const scores = results.map((r) => r.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThan(scores[i - 1]);
      }
    });

    it("depth 0 neighbors have score 1.0", () => {
      const results = dependencyTrace(db, chunkC, "imports", 1);

      expect(results[0].score).toBe(1.0);
    });
  });

  describe("edge cases", () => {
    it("returns empty for chunk with no dependencies", () => {
      const results = dependencyTrace(db, chunkE, "imports", 3);

      expect(results).toEqual([]);
    });

    it("returns empty for leaf node in importedBy direction", () => {
      const results = dependencyTrace(db, chunkD, "importedBy", 3);

      expect(results).toEqual([]);
    });

    it("does not duplicate chunks in results", () => {
      const results = dependencyTrace(db, chunkD, "imports", 5);

      const ids = results.map((r) => r.chunkId);
      const unique = new Set(ids);
      expect(ids.length).toBe(unique.size);
    });
  });
});
