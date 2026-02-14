import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runAsk,
  detectProvider,
} from "../../src/cli/commands/ask.js";
import type { LLMProvider } from "../../src/steering/llm.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/commands/init.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function setupProject(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-ask-"));
  const srcDir = path.join(tmpDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "auth.ts"),
    `export function validateToken(token: string): boolean {
  return token.length > 0;
}
`,
  );
}

function makeMockProvider(): LLMProvider {
  return {
    name: "mock",
    chat: vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        interpretation: "Looking for token validation",
        strategies: [
          { strategy: "fts", query: "validateToken", weight: 1.0, reason: "keyword search" },
        ],
      }))
      .mockResolvedValueOnce("Found validateToken function that checks token validity."),
  };
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// ── detectProvider ───────────────────────────────────────────────────────────

describe("detectProvider", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it("detects Gemini from CTX_GEMINI_KEY", () => {
    process.env = { ...originalEnv, CTX_GEMINI_KEY: "test-gemini-key" };
    const provider = detectProvider();
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("gemini");
  });

  it("detects OpenAI from CTX_OPENAI_KEY", () => {
    process.env = { ...originalEnv, CTX_OPENAI_KEY: "test-openai-key" };
    const provider = detectProvider();
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("openai");
  });

  it("detects Anthropic from CTX_ANTHROPIC_KEY", () => {
    process.env = { ...originalEnv, CTX_ANTHROPIC_KEY: "test-anthropic-key" };
    const provider = detectProvider();
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("anthropic");
  });

  it("prefers Gemini over OpenAI over Anthropic", () => {
    process.env = {
      ...originalEnv,
      CTX_GEMINI_KEY: "g-key",
      CTX_OPENAI_KEY: "o-key",
      CTX_ANTHROPIC_KEY: "a-key",
    };
    const provider = detectProvider();
    expect(provider?.name).toBe("gemini");
  });

  it("returns null when no API key set", () => {
    process.env = { ...originalEnv };
    delete process.env["CTX_GEMINI_KEY"];
    delete process.env["CTX_OPENAI_KEY"];
    delete process.env["CTX_ANTHROPIC_KEY"];
    const provider = detectProvider();
    expect(provider).toBeNull();
  });

  it("respects explicit provider override", () => {
    process.env = {
      ...originalEnv,
      CTX_GEMINI_KEY: "g-key",
      CTX_OPENAI_KEY: "o-key",
    };
    const provider = detectProvider("openai");
    expect(provider?.name).toBe("openai");
  });

  it("returns null for explicit provider with no key", () => {
    process.env = { ...originalEnv };
    delete process.env["CTX_ANTHROPIC_KEY"];
    const provider = detectProvider("anthropic");
    expect(provider).toBeNull();
  });
});

// ── runAsk ───────────────────────────────────────────────────────────────────

describe("runAsk", () => {
  describe("with LLM provider", () => {
    it("returns valid JSON structure", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const output = await runAsk(tmpDir, "how does token validation work", {
        limit: 10,
        format: "json",
        provider: makeMockProvider(),
      });

      expect(output.query).toBe("how does token validation work");
      expect(output.interpretation).toBeDefined();
      expect(Array.isArray(output.results)).toBe(true);
      expect(output.explanation).toBeDefined();
      expect(typeof output.stats.tokensUsed).toBe("number");
      expect(typeof output.stats.costEstimate).toBe("number");
      expect(Array.isArray(output.stats.strategies)).toBe(true);
    });

    it("text output includes interpretation and explanation", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const output = await runAsk(tmpDir, "validate token", {
        limit: 10,
        format: "text",
        provider: makeMockProvider(),
      });

      expect(output.text).toBeDefined();
      expect(output.text).toContain("Understanding:");
      expect(output.text).toContain("Explanation:");
    });

    it("--no-explain skips explanation", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const provider: LLMProvider = {
        name: "mock",
        chat: vi.fn().mockResolvedValueOnce(JSON.stringify({
          interpretation: "Looking for token validation",
          strategies: [
            { strategy: "fts", query: "validateToken", weight: 1.0, reason: "keyword" },
          ],
        })),
      };

      const output = await runAsk(tmpDir, "validateToken", {
        limit: 10,
        format: "json",
        noExplain: true,
        provider,
      });

      // Only 1 LLM call (plan), no synthesize call
      expect(provider.chat).toHaveBeenCalledOnce();
      expect(output.explanation).toBe("");
    });

    it("includes cost and token stats", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const output = await runAsk(tmpDir, "validate token", {
        limit: 10,
        format: "json",
        provider: makeMockProvider(),
      });

      expect(output.stats.tokensUsed).toBeGreaterThan(0);
      expect(output.stats.costEstimate).toBeGreaterThanOrEqual(0);
    });
  });

  describe("fallback (no provider)", () => {
    it("runs basic search when no LLM provider", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const output = await runAsk(tmpDir, "validateToken", {
        limit: 10,
        format: "json",
      });

      expect(output.results.length).toBeGreaterThanOrEqual(0);
      expect(output.explanation).toBe("");
      expect(output.fallback).toBe(true);
    });

    it("fallback strategy set includes vector search", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const output = await runAsk(tmpDir, "how does token validation work", {
        limit: 10,
        format: "json",
      });

      expect(output.stats.strategies).toContain("vector");
    });

    it("returns zero results when limit is 0", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const output = await runAsk(tmpDir, "validateToken", {
        limit: 0,
        format: "json",
      });

      expect(output.results).toEqual([]);
      expect(output.stats.totalResults).toBe(0);
    });

    it("returns zero results when limit is negative", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const output = await runAsk(tmpDir, "validateToken", {
        limit: -1,
        format: "json",
      });

      expect(output.results).toEqual([]);
      expect(output.stats.totalResults).toBe(0);
    });

    it("text fallback includes notice message", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const output = await runAsk(tmpDir, "validateToken", {
        limit: 10,
        format: "text",
      });

      expect(output.text).toContain("No LLM provider configured");
    });

    it("JSON fallback includes warning field", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const output = await runAsk(tmpDir, "validateToken", {
        limit: 10,
        format: "json",
      });

      expect(output.warning).toBeDefined();
      expect(output.warning).toContain("No LLM provider configured");
      expect(output.warning).toContain("CTX_GEMINI_KEY");
      expect(output.warning).toContain("CTX_OPENAI_KEY");
      expect(output.warning).toContain("CTX_ANTHROPIC_KEY");
    });

    it("warning field is absent when LLM provider is configured", async () => {
      setupProject();
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      const output = await runAsk(tmpDir, "validateToken", {
        limit: 10,
        format: "json",
        provider: makeMockProvider(),
      });

      expect(output.warning).toBeUndefined();
    });
  });

  describe("NL query fallback quality", () => {
    it("natural language fallback query returns results for matching terms", async () => {
      // Set up project with an indexer directory
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-ask-nl-"));
      const indexerDir = path.join(tmpDir, "src", "indexer");
      fs.mkdirSync(indexerDir, { recursive: true });
      fs.writeFileSync(
        path.join(indexerDir, "chunker.ts"),
        `export function chunkFile(content: string): string[] {
  const lines = content.split("\\n");
  return lines;
}
`,
      );
      await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

      // Simulate fallback (no provider) with NL query
      const output = await runAsk(tmpDir, "how does the indexer work?", {
        limit: 10,
        format: "json",
      });

      // Should find the indexer file even with stop words in query
      expect(output.results.length).toBeGreaterThan(0);
      const files = output.results.map((r) => r.file);
      expect(files.some((f) => f.includes("indexer"))).toBe(true);
    });
  });

  describe("error handling", () => {
    it("throws when not initialized", async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-ask-no-"));
      try {
        await expect(
          runAsk(emptyDir, "test", { limit: 10, format: "json" }),
        ).rejects.toThrow(/not initialized/i);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });
});
