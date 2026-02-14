import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { runInit } from "../../src/cli/commands/init.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-init-"));
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

function createFixtureProject(): void {
  writeFixture(
    "src/auth.ts",
    `import jwt from "jsonwebtoken";

export function validateToken(token: string): boolean {
  return jwt.verify(token) !== null;
}

export function createToken(userId: string): string {
  return jwt.sign({ userId }, "secret");
}
`,
  );

  writeFixture(
    "src/utils.ts",
    `export function formatDate(date: Date): string {
  return date.toISOString();
}

export const MAX_RETRIES = 3;
`,
  );

  writeFixture(
    "src/index.ts",
    `export { validateToken, createToken } from "./auth";
export { formatDate } from "./utils";
`,
  );
}

// ── Capture output ───────────────────────────────────────────────────────────

interface InitOutput {
  lines: string[];
}

async function captureInit(projectPath: string): Promise<InitOutput> {
  const lines: string[] = [];
  const logger = (msg: string): void => {
    lines.push(msg);
  };

  await runInit(projectPath, { log: logger, skipEmbedding: true });
  return { lines };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ctx init", () => {
  it("creates .ctx directory with index.db", async () => {
    createFixtureProject();
    await captureInit(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, ".ctx"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".ctx", "index.db"))).toBe(true);
  });

  it("creates config.json in .ctx directory", async () => {
    createFixtureProject();
    await captureInit(tmpDir);

    const configPath = path.join(tmpDir, ".ctx", "config.json");
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(config["embedder"]).toBeDefined();
  });

  it("adds .ctx/ to .gitignore when .gitignore exists", async () => {
    createFixtureProject();
    writeFixture(".gitignore", "node_modules\ndist\n");

    await captureInit(tmpDir);

    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".ctx/");
  });

  it("creates .gitignore with .ctx/ when none exists", async () => {
    createFixtureProject();

    await captureInit(tmpDir);

    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".ctx/");
  });

  it("does not duplicate .ctx/ in .gitignore on re-run", async () => {
    createFixtureProject();
    writeFixture(".gitignore", "node_modules\n.ctx/\n");

    await captureInit(tmpDir);

    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    const matches = gitignore.match(/\.ctx\//g);
    expect(matches).toHaveLength(1);
  });

  it("indexes files and stores them in the database", async () => {
    createFixtureProject();
    const output = await captureInit(tmpDir);

    const allText = output.lines.join("\n");
    // Should mention discovered files
    expect(allText).toMatch(/\d+ files/);
    // Should mention chunks
    expect(allText).toMatch(/\d+ chunks/);
  });

  it("reports accurate file and chunk counts", async () => {
    createFixtureProject();
    const output = await captureInit(tmpDir);

    const allText = output.lines.join("\n");
    // 3 TypeScript files in the fixture
    expect(allText).toContain("3 files");
  });

  it("re-running is incremental — skips unchanged files", async () => {
    createFixtureProject();
    await captureInit(tmpDir);

    // Run again — should detect 0 changes
    const output = await captureInit(tmpDir);
    const allText = output.lines.join("\n");
    expect(allText).toMatch(/unchanged/i);
  });

  it("detects modified files on re-index", async () => {
    createFixtureProject();
    await captureInit(tmpDir);

    // Modify a file
    writeFixture(
      "src/auth.ts",
      `import jwt from "jsonwebtoken";

export function validateToken(token: string): boolean {
  console.log("checking token");
  return jwt.verify(token) !== null;
}
`,
    );

    const output = await captureInit(tmpDir);
    const allText = output.lines.join("\n");
    expect(allText).toMatch(/modified/i);
  });

  it("skips unparseable files without crashing", async () => {
    createFixtureProject();
    // Add a binary-like file that can still be "discovered"
    writeFixture("src/broken.ts", "\0\0\0invalid content\0\0\0");

    // Should not throw
    await expect(captureInit(tmpDir)).resolves.toBeDefined();
  });

  it("handles empty project directory", async () => {
    const output = await captureInit(tmpDir);

    // Should still create .ctx
    expect(fs.existsSync(path.join(tmpDir, ".ctx"))).toBe(true);
    const allText = output.lines.join("\n");
    expect(allText).toMatch(/0 files/);
  });

  it("uses configured embedder dimensions when creating vector table", async () => {
    createFixtureProject();
    const ctxDir = path.join(tmpDir, ".ctx");
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

    await runInit(tmpDir, { log: () => undefined, skipEmbedding: true });

    const dbPath = path.join(tmpDir, ".ctx", "index.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'chunk_vectors'")
        .get() as { sql: string };
      expect(row.sql).toContain("embedding float[1024]");
    } finally {
      db.close();
    }
  });

  it("requires CTX_VOYAGE_KEY when voyage embedder is configured", async () => {
    createFixtureProject();
    const ctxDir = path.join(tmpDir, ".ctx");
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

    const originalKey = process.env["CTX_VOYAGE_KEY"];
    delete process.env["CTX_VOYAGE_KEY"];

    try {
      await expect(
        runInit(tmpDir, { log: () => undefined }),
      ).rejects.toThrow(/CTX_VOYAGE_KEY/);
    } finally {
      if (originalKey) {
        process.env["CTX_VOYAGE_KEY"] = originalKey;
      } else {
        delete process.env["CTX_VOYAGE_KEY"];
      }
    }
  });
});
