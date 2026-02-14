import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  runConfigShow,
  runConfigGet,
  runConfigSet,
  runConfigReset,
  DEFAULT_CONFIG,
} from "../../src/cli/commands/config.js";
import type { KontextConfig } from "../../src/cli/commands/config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function setup(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-config-"));
  const ctxDir = path.join(tmpDir, ".ctx");
  fs.mkdirSync(ctxDir, { recursive: true });
  return tmpDir;
}

function setupWithConfig(config?: Partial<KontextConfig>): string {
  const root = setup();
  const merged = { ...DEFAULT_CONFIG, ...config };
  fs.writeFileSync(
    path.join(root, ".ctx", "config.json"),
    JSON.stringify(merged, null, 2),
  );
  return root;
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ctx config", () => {
  describe("show", () => {
    it("shows full config", () => {
      const root = setupWithConfig();
      const output = runConfigShow(root);

      expect(output.config).toBeDefined();
      expect(output.config.embedder).toBeDefined();
      expect(output.config.search).toBeDefined();
      expect(output.config.watch).toBeDefined();
      expect(output.config.llm).toBeDefined();
    });

    it("text output is formatted JSON", () => {
      const root = setupWithConfig();
      const output = runConfigShow(root);

      expect(output.text).toContain("embedder");
      expect(output.text).toContain("search");
      // Should be pretty-printed
      expect(output.text).toContain("\n");
    });

    it("creates default config if missing", () => {
      const root = setup();
      // No config.json written
      const output = runConfigShow(root);

      expect(output.config).toEqual(DEFAULT_CONFIG);
      // File should have been created
      expect(
        fs.existsSync(path.join(root, ".ctx", "config.json")),
      ).toBe(true);
    });

    it("throws when .ctx/ does not exist", () => {
      const noCtx = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-noconfig-"));
      try {
        expect(() => runConfigShow(noCtx)).toThrow(/not initialized/i);
      } finally {
        fs.rmSync(noCtx, { recursive: true, force: true });
      }
    });
  });

  describe("get", () => {
    it("gets top-level key", () => {
      const root = setupWithConfig();
      const value = runConfigGet(root, "embedder");

      expect(value).toEqual(DEFAULT_CONFIG.embedder);
    });

    it("gets nested key with dot notation", () => {
      const root = setupWithConfig();
      const value = runConfigGet(root, "search.defaultLimit");

      expect(value).toBe(10);
    });

    it("gets deeply nested key", () => {
      const root = setupWithConfig();
      const value = runConfigGet(root, "embedder.provider");

      expect(value).toBe("local");
    });

    it("returns undefined for nonexistent key", () => {
      const root = setupWithConfig();
      const value = runConfigGet(root, "nonexistent.key");

      expect(value).toBeUndefined();
    });
  });

  describe("set", () => {
    it("sets nested value with dot notation", () => {
      const root = setupWithConfig();
      runConfigSet(root, "search.defaultLimit", "20");

      const value = runConfigGet(root, "search.defaultLimit");
      expect(value).toBe(20);
    });

    it("sets string value", () => {
      const root = setupWithConfig();
      runConfigSet(root, "embedder.provider", "voyage");

      const value = runConfigGet(root, "embedder.provider");
      expect(value).toBe("voyage");
    });

    it("persists to config.json", () => {
      const root = setupWithConfig();
      runConfigSet(root, "watch.debounceMs", "1000");

      // Re-read from file
      const raw = fs.readFileSync(
        path.join(root, ".ctx", "config.json"),
        "utf-8",
      );
      const config = JSON.parse(raw) as KontextConfig;
      expect(config.watch.debounceMs).toBe(1000);
    });

    it("sets array values as JSON", () => {
      const root = setupWithConfig();
      runConfigSet(root, "search.strategies", '["fts","ast"]');

      const value = runConfigGet(root, "search.strategies");
      expect(value).toEqual(["fts", "ast"]);
    });

    it("sets null value", () => {
      const root = setupWithConfig();
      runConfigSet(root, "llm.provider", "null");

      const value = runConfigGet(root, "llm.provider");
      expect(value).toBeNull();
    });

    it("rejects invalid embedder provider", () => {
      const root = setupWithConfig();

      expect(() => runConfigSet(root, "embedder.provider", "invalid")).toThrow(
        /invalid value/i,
      );
    });

    it("rejects non-numeric dimensions", () => {
      const root = setupWithConfig();

      expect(() => runConfigSet(root, "embedder.dimensions", "abc")).toThrow(
        /invalid value/i,
      );
    });
  });

  describe("reset", () => {
    it("restores defaults", () => {
      const root = setupWithConfig();
      runConfigSet(root, "search.defaultLimit", "50");
      runConfigSet(root, "watch.debounceMs", "2000");

      runConfigReset(root);

      const output = runConfigShow(root);
      expect(output.config).toEqual(DEFAULT_CONFIG);
    });

    it("persists reset to file", () => {
      const root = setupWithConfig();
      runConfigSet(root, "search.defaultLimit", "50");

      runConfigReset(root);

      const raw = fs.readFileSync(
        path.join(root, ".ctx", "config.json"),
        "utf-8",
      );
      const config = JSON.parse(raw) as KontextConfig;
      expect(config.search.defaultLimit).toBe(DEFAULT_CONFIG.search.defaultLimit);
    });
  });
});
