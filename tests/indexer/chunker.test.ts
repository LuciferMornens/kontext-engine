import { describe, it, expect } from "vitest";
import { chunkFile, estimateTokens } from "../../src/indexer/chunker.js";
import type { ASTNode } from "../../src/indexer/parser.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<ASTNode> & { type: ASTNode["type"] }): ASTNode {
  return {
    name: null,
    lineStart: 1,
    lineEnd: 5,
    language: "typescript",
    parent: null,
    text: "function foo() { return 1; }",
    ...overrides,
  };
}

function makeLargeText(lines: number): string {
  // Each line is roughly 10 tokens → 10 * lines tokens
  return Array.from({ length: lines }, (_, i) =>
    `  const value${i} = computeSomethingComplex(param1, param2, param3);`,
  ).join("\n");
}

// ── estimateTokens ───────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("estimates token count for a short string", () => {
    const tokens = estimateTokens("function foo() { return 1; }");
    // 6 words * 1.3 ≈ 7.8 → should be a small number
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it("estimates token count for a larger block", () => {
    const text = makeLargeText(100);
    const tokens = estimateTokens(text);
    // ~100 lines * ~8 words/line * 1.3 ≈ ~1040
    expect(tokens).toBeGreaterThan(500);
  });
});

// ── Small functions → single chunk ───────────────────────────────────────────

describe("chunkFile — small functions", () => {
  it("produces a single chunk for a small function", () => {
    const nodes: ASTNode[] = [
      makeNode({
        type: "function",
        name: "greet",
        lineStart: 1,
        lineEnd: 3,
        text: 'function greet(name: string) {\n  return "Hello " + name;\n}',
        exports: true,
      }),
    ];

    const chunks = chunkFile(nodes, "src/utils.ts");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].name).toBe("greet");
    expect(chunks[0].type).toBe("function");
    expect(chunks[0].filePath).toBe("src/utils.ts");
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(3);
    expect(chunks[0].exports).toBe(true);
    expect(chunks[0].text).toContain("function greet");
  });
});

// ── Large functions → split into sub-chunks ──────────────────────────────────

describe("chunkFile — large functions", () => {
  it("splits a large function into sub-chunks", () => {
    const bodyLines = makeLargeText(80);
    const text = `function bigFunction(a: number, b: number) {\n${bodyLines}\n}`;

    const nodes: ASTNode[] = [
      makeNode({
        type: "function",
        name: "bigFunction",
        lineStart: 1,
        lineEnd: 82,
        text,
      }),
    ];

    const chunks = chunkFile(nodes, "src/big.ts", { maxTokens: 500 });
    expect(chunks.length).toBeGreaterThan(1);

    // All sub-chunks should reference the function
    for (const chunk of chunks) {
      expect(chunk.filePath).toBe("src/big.ts");
      expect(chunk.name).toBe("bigFunction");
      expect(chunk.language).toBe("typescript");
    }

    // Line ranges should be contiguous and non-overlapping
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].lineStart).toBeLessThanOrEqual(chunks[i - 1].lineEnd + 1);
    }

    // Should cover the full range
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[chunks.length - 1].lineEnd).toBe(82);
  });
});

// ── Classes → per-method chunks with parent context ──────────────────────────

describe("chunkFile — classes with methods", () => {
  it("creates per-method chunks with parent class name", () => {
    const nodes: ASTNode[] = [
      makeNode({
        type: "class",
        name: "UserService",
        lineStart: 1,
        lineEnd: 20,
        text: "class UserService { /* ... */ }",
      }),
      makeNode({
        type: "method",
        name: "findUser",
        lineStart: 3,
        lineEnd: 8,
        parent: "UserService",
        text: "async findUser(id: number): Promise<User> { return this.db.find(id); }",
      }),
      makeNode({
        type: "method",
        name: "createUser",
        lineStart: 10,
        lineEnd: 18,
        parent: "UserService",
        text: "async createUser(data: UserInput): Promise<User> { return this.db.create(data); }",
      }),
    ];

    const chunks = chunkFile(nodes, "src/services/user.ts");

    // Should have chunks for the class and methods
    const methodChunks = chunks.filter((c) => c.type === "method");
    expect(methodChunks.length).toBe(2);

    const findUser = methodChunks.find((c) => c.name === "findUser");
    expect(findUser).toBeDefined();
    if (!findUser) return;
    expect(findUser.parent).toBe("UserService");

    const createUser = methodChunks.find((c) => c.name === "createUser");
    expect(createUser).toBeDefined();
    if (!createUser) return;
    expect(createUser.parent).toBe("UserService");
  });

  it("keeps a short class as a single chunk", () => {
    const shortClassText = [
      "class Config {",
      "  host = 'localhost';",
      "  port = 3000;",
      "}",
    ].join("\n");

    const nodes: ASTNode[] = [
      makeNode({
        type: "class",
        name: "Config",
        lineStart: 1,
        lineEnd: 4,
        text: shortClassText,
      }),
      // No separate method nodes — class is small enough to be one chunk
    ];

    const chunks = chunkFile(nodes, "src/config.ts");
    const classChunks = chunks.filter((c) => c.name === "Config");
    expect(classChunks).toHaveLength(1);
  });
});

// ── Imports → grouped into a single chunk ────────────────────────────────────

describe("chunkFile — imports", () => {
  it("groups consecutive imports into a single chunk", () => {
    const nodes: ASTNode[] = [
      makeNode({
        type: "import",
        name: null,
        lineStart: 1,
        lineEnd: 1,
        text: 'import { Router } from "express";',
      }),
      makeNode({
        type: "import",
        name: null,
        lineStart: 2,
        lineEnd: 2,
        text: 'import { Pool } from "pg";',
      }),
      makeNode({
        type: "import",
        name: null,
        lineStart: 3,
        lineEnd: 3,
        text: 'import path from "node:path";',
      }),
      makeNode({
        type: "function",
        name: "main",
        lineStart: 5,
        lineEnd: 10,
        text: "function main() { /* ... */ }",
      }),
    ];

    const chunks = chunkFile(nodes, "src/index.ts");
    const importChunks = chunks.filter((c) => c.type === "import");
    expect(importChunks).toHaveLength(1);
    expect(importChunks[0].text).toContain("Router");
    expect(importChunks[0].text).toContain("Pool");
    expect(importChunks[0].text).toContain("path");
  });
});

// ── Type definitions → one chunk each ────────────────────────────────────────

describe("chunkFile — type definitions", () => {
  it("creates a chunk for each type definition", () => {
    const nodes: ASTNode[] = [
      makeNode({
        type: "type",
        name: "User",
        lineStart: 1,
        lineEnd: 5,
        text: "interface User {\n  id: number;\n  email: string;\n  role: string;\n}",
      }),
      makeNode({
        type: "type",
        name: "AuthResult",
        lineStart: 7,
        lineEnd: 7,
        text: "type AuthResult = { ok: true; user: User } | { ok: false; error: string };",
      }),
    ];

    const chunks = chunkFile(nodes, "src/types.ts");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].name).toBe("User");
    expect(chunks[1].name).toBe("AuthResult");
    expect(chunks[0].type).toBe("type");
    expect(chunks[1].type).toBe("type");
  });
});

// ── Small node merging ───────────────────────────────────────────────────────

describe("chunkFile — merging small nodes", () => {
  it("merges very small adjacent nodes into a single chunk", () => {
    const nodes: ASTNode[] = [
      makeNode({
        type: "constant",
        name: "A",
        lineStart: 1,
        lineEnd: 1,
        text: "const A = 1;",
      }),
      makeNode({
        type: "constant",
        name: "B",
        lineStart: 2,
        lineEnd: 2,
        text: "const B = 2;",
      }),
      makeNode({
        type: "constant",
        name: "C",
        lineStart: 3,
        lineEnd: 3,
        text: "const C = 3;",
      }),
    ];

    const chunks = chunkFile(nodes, "src/constants.ts");
    // Three tiny constants should be merged
    expect(chunks.length).toBeLessThan(3);
    // The merged chunk should cover all lines
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[chunks.length - 1].lineEnd).toBe(3);
  });
});

// ── Deterministic chunk IDs ──────────────────────────────────────────────────

describe("chunkFile — deterministic IDs", () => {
  it("generates the same ID for the same input", () => {
    const nodes: ASTNode[] = [
      makeNode({
        type: "function",
        name: "hello",
        lineStart: 1,
        lineEnd: 3,
        text: 'function hello() { return "world"; }',
      }),
    ];

    const chunks1 = chunkFile(nodes, "src/hello.ts");
    const chunks2 = chunkFile(nodes, "src/hello.ts");
    expect(chunks1[0].id).toBe(chunks2[0].id);
  });

  it("generates different IDs for different files", () => {
    const nodes: ASTNode[] = [
      makeNode({
        type: "function",
        name: "hello",
        lineStart: 1,
        lineEnd: 3,
        text: 'function hello() { return "world"; }',
      }),
    ];

    const chunks1 = chunkFile(nodes, "src/a.ts");
    const chunks2 = chunkFile(nodes, "src/b.ts");
    expect(chunks1[0].id).not.toBe(chunks2[0].id);
  });
});

// ── Content hash for incremental updates ─────────────────────────────────────

describe("chunkFile — content hash", () => {
  it("generates a content hash for each chunk", () => {
    const nodes: ASTNode[] = [
      makeNode({
        type: "function",
        name: "foo",
        lineStart: 1,
        lineEnd: 3,
        text: "function foo() { return 42; }",
      }),
    ];

    const chunks = chunkFile(nodes, "src/foo.ts");
    expect(chunks[0].hash).toBeDefined();
    expect(typeof chunks[0].hash).toBe("string");
    expect(chunks[0].hash.length).toBeGreaterThan(0);
  });

  it("produces different hash for different content", () => {
    const nodes1: ASTNode[] = [
      makeNode({
        type: "function",
        name: "foo",
        lineStart: 1,
        lineEnd: 3,
        text: "function foo() { return 42; }",
      }),
    ];
    const nodes2: ASTNode[] = [
      makeNode({
        type: "function",
        name: "foo",
        lineStart: 1,
        lineEnd: 3,
        text: "function foo() { return 99; }",
      }),
    ];

    const chunks1 = chunkFile(nodes1, "src/foo.ts");
    const chunks2 = chunkFile(nodes2, "src/foo.ts");
    expect(chunks1[0].hash).not.toBe(chunks2[0].hash);
  });
});

// ── Import extraction context ────────────────────────────────────────────────

describe("chunkFile — import context", () => {
  it("attaches relevant imports to function chunks", () => {
    const nodes: ASTNode[] = [
      makeNode({
        type: "import",
        name: null,
        lineStart: 1,
        lineEnd: 1,
        text: 'import { Router } from "express";',
      }),
      makeNode({
        type: "import",
        name: null,
        lineStart: 2,
        lineEnd: 2,
        text: 'import { Pool } from "pg";',
      }),
      makeNode({
        type: "function",
        name: "createApp",
        lineStart: 4,
        lineEnd: 10,
        text: "function createApp() { const router = Router(); return router; }",
      }),
    ];

    const chunks = chunkFile(nodes, "src/app.ts");
    const fnChunk = chunks.find((c) => c.name === "createApp");
    expect(fnChunk).toBeDefined();
    if (!fnChunk) return;
    expect(fnChunk.imports.length).toBeGreaterThan(0);
  });
});

// ── Empty input ──────────────────────────────────────────────────────────────

describe("chunkFile — edge cases", () => {
  it("returns empty array for empty node list", () => {
    const chunks = chunkFile([], "src/empty.ts");
    expect(chunks).toEqual([]);
  });

  it("handles a file with only imports", () => {
    const nodes: ASTNode[] = [
      makeNode({
        type: "import",
        name: null,
        lineStart: 1,
        lineEnd: 1,
        text: 'import fs from "node:fs";',
      }),
    ];

    const chunks = chunkFile(nodes, "src/imports-only.ts");
    expect(chunks.length).toBe(1);
    expect(chunks[0].type).toBe("import");
  });
});
