import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runStatus } from "../../src/cli/commands/status.js";
import { runInit } from "../../src/cli/commands/init.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function setup(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-status-"));
  const srcDir = path.join(tmpDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "auth.ts"),
    `export function validateToken(token: string): boolean {
  return token.length > 0;
}

export function createToken(userId: string): string {
  return "token-" + userId;
}
`,
  );
  fs.writeFileSync(
    path.join(srcDir, "handler.ts"),
    `export async function handleRequest(req: Request): Promise<Response> {
  return new Response("OK");
}
`,
  );
  fs.writeFileSync(
    path.join(srcDir, "utils.py"),
    `def format_date(date):
    return date.isoformat()

MAX_RETRIES = 3
`,
  );
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ctx status", () => {
  it("shows correct stats for initialized project", async () => {
    const root = setup();
    await runInit(root, { log: () => undefined, skipEmbedding: true });

    const output = await runStatus(root);

    expect(output.initialized).toBe(true);
    expect(output.fileCount).toBe(3);
    expect(output.chunkCount).toBeGreaterThan(0);
    expect(output.vectorCount).toBe(0); // skipEmbedding
    expect(output.dbSizeBytes).toBeGreaterThan(0);
    expect(output.lastIndexed).toBeDefined();
  });

  it("shows not initialized for missing .ctx/", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-status-no-"));
    try {
      const output = await runStatus(root);

      expect(output.initialized).toBe(false);
      expect(output.fileCount).toBe(0);
      expect(output.chunkCount).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("language breakdown is accurate", async () => {
    const root = setup();
    await runInit(root, { log: () => undefined, skipEmbedding: true });

    const output = await runStatus(root);

    expect(output.languages).toBeDefined();
    expect(output.languages.get("typescript")).toBe(2);
    expect(output.languages.get("python")).toBe(1);
  });

  it("DB size is shown", async () => {
    const root = setup();
    await runInit(root, { log: () => undefined, skipEmbedding: true });

    const output = await runStatus(root);

    expect(output.dbSizeBytes).toBeGreaterThan(0);
    expect(typeof output.dbSizeBytes).toBe("number");
  });

  it("config summary is included", async () => {
    const root = setup();
    await runInit(root, { log: () => undefined, skipEmbedding: true });

    const output = await runStatus(root);

    expect(output.config).toBeDefined();
    expect(output.config?.provider).toBe("local");
    expect(output.config?.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(output.config?.dimensions).toBe(384);
  });

  it("text output is formatted correctly", async () => {
    const root = setup();
    await runInit(root, { log: () => undefined, skipEmbedding: true });

    const output = await runStatus(root);

    expect(output.text).toContain("Kontext Status");
    expect(output.text).toContain("Initialized:");
    expect(output.text).toContain("Files:");
    expect(output.text).toContain("Chunks:");
    expect(output.text).toContain("Languages:");
    expect(output.text).toContain("Typescript");
    expect(output.text).toContain("Python");
  });

  it("shows configured embedder provider in text output", async () => {
    const root = setup();
    await runInit(root, { log: () => undefined, skipEmbedding: true });

    const configPath = path.join(root, ".ctx", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      embedder: { provider: string; model: string; dimensions: number };
    };
    config.embedder.provider = "voyage";
    config.embedder.model = "voyage-code-3";
    config.embedder.dimensions = 1024;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const output = await runStatus(root);
    expect(output.text).toContain("Embedder: voyage");
  });

  it("reads status for a 1024-dim index when dimensions are omitted by caller", async () => {
    const root = setup();
    const ctxDir = path.join(root, ".ctx");
    fs.mkdirSync(ctxDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctxDir, "config.json"),
      JSON.stringify({
        embedder: {
          provider: "voyage",
          model: "voyage-code-3",
          dimensions: 1024,
        },
        search: {
          defaultLimit: 10,
          strategies: ["vector", "fts", "ast", "path"],
          weights: { vector: 1.0, fts: 0.8, ast: 0.9, path: 0.7, dependency: 0.6 },
        },
        watch: {
          debounceMs: 500,
          ignored: [],
        },
        llm: {
          provider: null,
          model: null,
        },
      }, null, 2),
    );

    await runInit(root, { log: () => undefined, skipEmbedding: true });

    const output = await runStatus(root);
    expect(output.initialized).toBe(true);
    expect(output.config?.dimensions).toBe(1024);
  });

  it("text output for non-initialized project", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-status-no2-"));
    try {
      const output = await runStatus(root);

      expect(output.text).toContain("Not initialized");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
