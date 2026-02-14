import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import BetterSqlite3 from "better-sqlite3";
import {
  createDatabase,
  SCHEMA_VERSION,
} from "../../src/storage/db.js";
import type { KontextDatabase } from "../../src/storage/db.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

let db: KontextDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-test-"));
  db = createDatabase(path.join(tmpDir, "index.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Schema & initialization ──────────────────────────────────────────────────

describe("database initialization", () => {
  it("creates database file with correct schema", () => {
    const dbPath = path.join(tmpDir, "index.db");
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("stores schema version in meta table", () => {
    const version = db.getSchemaVersion();
    expect(version).toBe(SCHEMA_VERSION);
  });

  it("is idempotent — opening same path twice works", () => {
    const dbPath = path.join(tmpDir, "index.db");
    db.close();
    const db2 = createDatabase(dbPath);
    expect(db2.getSchemaVersion()).toBe(SCHEMA_VERSION);
    db2.close();
    db = createDatabase(dbPath);
  });

  it("throws when opening an index with mismatched vector dimensions", () => {
    const dbPath = path.join(tmpDir, "index.db");
    db.close();
    expect(() => createDatabase(dbPath, 1024)).toThrow(/dimension mismatch/i);
    db = createDatabase(dbPath);
  });

  it("opens existing non-default-dimension index when dimensions are omitted", () => {
    const dbPath = path.join(tmpDir, "index-1024.db");
    const seeded = createDatabase(dbPath, 1024);
    seeded.close();

    const reopened = createDatabase(dbPath);
    expect(reopened.getSchemaVersion()).toBe(SCHEMA_VERSION);
    reopened.close();
  });

  it("detects mismatched legacy table dimensions when vector metadata is missing", () => {
    const dbPath = path.join(tmpDir, "index.db");
    db.close();

    // Simulate a legacy index that has a vector table but lacks
    // meta.vector_dimensions.
    const seeded = createDatabase(dbPath, 384);
    seeded.close();
    const raw = new BetterSqlite3(dbPath);
    try {
      raw
        .prepare("DELETE FROM meta WHERE key = ?")
        .run("vector_dimensions");
    } finally {
      raw.close();
    }

    expect(() => createDatabase(dbPath, 1024)).toThrow(/dimension mismatch/i);
    db = createDatabase(dbPath, 384);
  });

  it("enables WAL mode for concurrent reads", () => {
    const mode = db.pragma("journal_mode");
    expect(mode).toBe("wal");
  });

  it("stores and reads index embedder metadata", () => {
    expect(db.getIndexEmbedder()).toBeNull();

    db.setIndexEmbedder({
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      dimensions: 384,
    });

    expect(db.getIndexEmbedder()).toEqual({
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      dimensions: 384,
    });
  });
});

// ── File CRUD ────────────────────────────────────────────────────────────────

describe("files", () => {
  it("upserts and retrieves a file", () => {
    const id = db.upsertFile({
      path: "src/auth.ts",
      language: "typescript",
      hash: "abc123",
      size: 1024,
    });

    expect(id).toBeGreaterThan(0);

    const file = db.getFile("src/auth.ts");
    expect(file).toBeDefined();
    if (!file) return;
    expect(file.path).toBe("src/auth.ts");
    expect(file.language).toBe("typescript");
    expect(file.hash).toBe("abc123");
    expect(file.size).toBe(1024);
    expect(file.lastIndexed).toBeGreaterThan(0);
  });

  it("updates existing file on upsert", () => {
    db.upsertFile({
      path: "src/auth.ts",
      language: "typescript",
      hash: "v1",
      size: 100,
    });

    db.upsertFile({
      path: "src/auth.ts",
      language: "typescript",
      hash: "v2",
      size: 200,
    });

    const file = db.getFile("src/auth.ts");
    expect(file?.hash).toBe("v2");
    expect(file?.size).toBe(200);
  });

  it("returns the same file id when upserting an existing file", () => {
    const firstId = db.upsertFile({
      path: "src/auth.ts",
      language: "typescript",
      hash: "v1",
      size: 100,
    });

    const secondId = db.upsertFile({
      path: "src/auth.ts",
      language: "typescript",
      hash: "v2",
      size: 200,
    });

    expect(secondId).toBe(firstId);
  });

  it("deletes a file", () => {
    db.upsertFile({
      path: "src/auth.ts",
      language: "typescript",
      hash: "abc",
      size: 100,
    });

    db.deleteFile("src/auth.ts");
    expect(db.getFile("src/auth.ts")).toBeNull();
  });

  it("returns null for non-existent file", () => {
    expect(db.getFile("nonexistent.ts")).toBeNull();
  });

  it("batch checks files by path-hash", () => {
    db.upsertFile({ path: "a.ts", language: "typescript", hash: "h1", size: 10 });
    db.upsertFile({ path: "b.ts", language: "typescript", hash: "h2", size: 20 });
    db.upsertFile({ path: "c.ts", language: "typescript", hash: "h3", size: 30 });

    const hashes = new Map([
      ["a.ts", "h1"],
      ["b.ts", "CHANGED"],
      ["d.ts", "h4"],
    ]);

    const existing = db.getFilesByHash(hashes);
    // a.ts matches hash → included, b.ts hash changed → not included, d.ts doesn't exist → not included
    expect(existing.has("a.ts")).toBe(true);
    expect(existing.has("b.ts")).toBe(false);
    expect(existing.has("d.ts")).toBe(false);
  });
});

// ── Chunk CRUD ───────────────────────────────────────────────────────────────

describe("chunks", () => {
  let fileId: number;

  beforeEach(() => {
    fileId = db.upsertFile({
      path: "src/auth.ts",
      language: "typescript",
      hash: "abc",
      size: 500,
    });
  });

  it("inserts and retrieves chunks with metadata", () => {
    const ids = db.insertChunks(fileId, [
      {
        lineStart: 1,
        lineEnd: 10,
        type: "function",
        name: "validateToken",
        parent: null,
        text: "function validateToken() {}",
        imports: ["jsonwebtoken"],
        exports: true,
        hash: "chunk1hash",
      },
      {
        lineStart: 12,
        lineEnd: 20,
        type: "method",
        name: "signToken",
        parent: "AuthService",
        text: "async signToken() {}",
        imports: [],
        exports: false,
        hash: "chunk2hash",
      },
    ]);

    expect(ids).toHaveLength(2);

    const chunks = db.getChunksByFile(fileId);
    expect(chunks).toHaveLength(2);

    const first = chunks.find((c) => c.name === "validateToken");
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.lineStart).toBe(1);
    expect(first.lineEnd).toBe(10);
    expect(first.type).toBe("function");
    expect(first.parent).toBeNull();
    expect(first.imports).toEqual(["jsonwebtoken"]);
    expect(first.exports).toBe(true);
  });

  it("deletes chunks by file", () => {
    db.insertChunks(fileId, [
      {
        lineStart: 1,
        lineEnd: 5,
        type: "function",
        name: "foo",
        parent: null,
        text: "function foo() {}",
        imports: [],
        exports: false,
        hash: "h1",
      },
    ]);

    db.deleteChunksByFile(fileId);
    const chunks = db.getChunksByFile(fileId);
    expect(chunks).toHaveLength(0);
  });
});

// ── CASCADE delete ───────────────────────────────────────────────────────────

describe("cascade delete", () => {
  it("deleting a file removes its chunks and vectors", () => {
    const fileId = db.upsertFile({
      path: "src/temp.ts",
      language: "typescript",
      hash: "abc",
      size: 100,
    });

    const [chunkId] = db.insertChunks(fileId, [
      {
        lineStart: 1,
        lineEnd: 5,
        type: "function",
        name: "temp",
        parent: null,
        text: "function temp() {}",
        imports: [],
        exports: false,
        hash: "h1",
      },
    ]);

    const vec = new Float32Array(384).fill(0.1);
    db.insertVector(chunkId, vec);

    // Delete the file
    db.deleteFile("src/temp.ts");

    // Chunks should be gone
    const chunks = db.getChunksByFile(fileId);
    expect(chunks).toHaveLength(0);

    // Vector search should not return the deleted chunk
    const results = db.searchVectors(vec, 10);
    const found = results.find((r) => r.chunkId === chunkId);
    expect(found).toBeUndefined();
  });
});

// ── Vector operations ────────────────────────────────────────────────────────

describe("vectors", () => {
  let fileId: number;

  beforeEach(() => {
    fileId = db.upsertFile({
      path: "src/test.ts",
      language: "typescript",
      hash: "abc",
      size: 100,
    });
  });

  it("inserts and searches vectors via KNN", () => {
    const ids = db.insertChunks(fileId, [
      { lineStart: 1, lineEnd: 5, type: "function", name: "a", parent: null, text: "function a() {}", imports: [], exports: false, hash: "h1" },
      { lineStart: 6, lineEnd: 10, type: "function", name: "b", parent: null, text: "function b() {}", imports: [], exports: false, hash: "h2" },
      { lineStart: 11, lineEnd: 15, type: "function", name: "c", parent: null, text: "function c() {}", imports: [], exports: false, hash: "h3" },
    ]);

    const vec1 = new Float32Array(384).fill(0.1);
    const vec2 = new Float32Array(384).fill(0.5);
    const vec3 = new Float32Array(384).fill(-0.3);
    db.insertVector(ids[0], vec1);
    db.insertVector(ids[1], vec2);
    db.insertVector(ids[2], vec3);

    // Search near vec1
    const queryVec = new Float32Array(384).fill(0.12);
    const results = db.searchVectors(queryVec, 2);
    expect(results).toHaveLength(2);
    // Nearest should be vec1 (id[0])
    expect(results[0].chunkId).toBe(ids[0]);
    expect(results[0].distance).toBeDefined();
    expect(typeof results[0].distance).toBe("number");
  });

  it("returns empty array when no vectors exist", () => {
    const queryVec = new Float32Array(384).fill(0.1);
    const results = db.searchVectors(queryVec, 5);
    expect(results).toEqual([]);
  });
});

// ── FTS5 operations ──────────────────────────────────────────────────────────

describe("FTS", () => {
  let fileId: number;

  beforeEach(() => {
    fileId = db.upsertFile({
      path: "src/test.ts",
      language: "typescript",
      hash: "abc",
      size: 100,
    });

    db.insertChunks(fileId, [
      { lineStart: 1, lineEnd: 5, type: "function", name: "validateToken", parent: "AuthService", text: "function validateToken(token) { return jwt.verify(token); }", imports: [], exports: true, hash: "h1" },
      { lineStart: 6, lineEnd: 10, type: "function", name: "createPool", parent: null, text: "function createPool(url) { return new Pool(url, maxSize); }", imports: [], exports: false, hash: "h2" },
      { lineStart: 11, lineEnd: 15, type: "function", name: "handleRequest", parent: "RequestHandler", text: "async function handleRequest(req, res) { res.json(data); }", imports: [], exports: false, hash: "h3" },
    ]);
  });

  it("finds matching text via FTS5 search", () => {
    const results = db.searchFTS("token", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("validateToken");
  });

  it("searches by function name", () => {
    const results = db.searchFTS("createPool", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("createPool");
  });

  it("searches by parent class name", () => {
    const results = db.searchFTS("AuthService", 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns empty for no matches", () => {
    const results = db.searchFTS("nonexistentXYZ123", 5);
    expect(results).toHaveLength(0);
  });

  it("FTS entries are removed when chunks are deleted", () => {
    db.deleteChunksByFile(fileId);
    const results = db.searchFTS("token", 5);
    expect(results).toHaveLength(0);
  });
});

// ── Transactions ─────────────────────────────────────────────────────────────

describe("transactions", () => {
  it("atomic transaction commits all changes", () => {
    db.transaction(() => {
      db.upsertFile({ path: "a.ts", language: "typescript", hash: "h1", size: 10 });
      db.upsertFile({ path: "b.ts", language: "typescript", hash: "h2", size: 20 });
    });

    expect(db.getFile("a.ts")).not.toBeNull();
    expect(db.getFile("b.ts")).not.toBeNull();
  });

  it("rolls back on error", () => {
    try {
      db.transaction(() => {
        db.upsertFile({ path: "x.ts", language: "typescript", hash: "h1", size: 10 });
        throw new Error("simulated failure");
      });
    } catch {
      // expected
    }

    expect(db.getFile("x.ts")).toBeNull();
  });
});

// ── Maintenance ──────────────────────────────────────────────────────────────

describe("maintenance", () => {
  it("vacuum runs without error", () => {
    expect(() => db.vacuum()).not.toThrow();
  });
});

// ── Migration ────────────────────────────────────────────────────────────────

describe("migration", () => {
  it("re-opening existing database preserves data", () => {
    db.upsertFile({ path: "src/keep.ts", language: "typescript", hash: "h1", size: 100 });
    const dbPath = path.join(tmpDir, "index.db");

    db.close();

    const db2 = createDatabase(dbPath);
    const file = db2.getFile("src/keep.ts");
    expect(file).not.toBeNull();
    expect(file?.hash).toBe("h1");
    db2.close();

    // Re-open for afterEach cleanup
    db = createDatabase(dbPath);
  });
});
