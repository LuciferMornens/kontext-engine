import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runWatch } from "../../src/cli/commands/watch.js";
import type { WatchHandle } from "../../src/cli/commands/watch.js";
import { runInit } from "../../src/cli/commands/init.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let watchHandle: WatchHandle | null = null;

function setup(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-watchcli-"));
  const srcDir = path.join(tmpDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "app.ts"),
    `export function greet(name: string): string {
  return "Hello " + name;
}
`,
  );
  return tmpDir;
}

afterEach(async () => {
  if (watchHandle) {
    await watchHandle.stop();
    watchHandle = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ctx watch", () => {
  it("starts and can be stopped", async () => {
    const root = setup();
    await runInit(root, { log: () => undefined, skipEmbedding: true });

    const logs: string[] = [];
    watchHandle = await runWatch(root, {
      debounceMs: 100,
      log: (msg) => logs.push(msg),
      skipEmbedding: true,
    });

    expect(logs.some((l) => l.includes("Watching"))).toBe(true);

    await watchHandle.stop();
    watchHandle = null;

    expect(logs.some((l) => l.includes("Stopped"))).toBe(true);
  });

  it("re-indexes when a file is added", async () => {
    const root = setup();
    await runInit(root, { log: () => undefined, skipEmbedding: true });

    const logs: string[] = [];
    watchHandle = await runWatch(root, {
      debounceMs: 100,
      log: (msg) => logs.push(msg),
      skipEmbedding: true,
    });

    // Wait for watcher to stabilize
    await sleep(200);

    // Add a new file
    fs.writeFileSync(
      path.join(root, "src", "utils.ts"),
      `export function add(a: number, b: number): number {
  return a + b;
}
`,
    );

    await sleep(600);

    expect(logs.some((l) => l.includes("utils.ts"))).toBe(true);
    expect(logs.some((l) => l.includes("Re-indexed"))).toBe(true);
  });

  it("re-indexes when a file is deleted", async () => {
    const root = setup();
    await runInit(root, { log: () => undefined, skipEmbedding: true });

    const logs: string[] = [];
    watchHandle = await runWatch(root, {
      debounceMs: 100,
      log: (msg) => logs.push(msg),
      skipEmbedding: true,
    });

    // Wait for watcher to stabilize
    await sleep(200);

    // Delete existing file
    fs.unlinkSync(path.join(root, "src", "app.ts"));
    await sleep(600);

    expect(logs.some((l) => l.includes("app.ts"))).toBe(true);
    expect(logs.some((l) => l.includes("Re-indexed") || l.includes("Deleted"))).toBe(true);
  });

  it("--init flag triggers initialization", async () => {
    const root = setup();
    // Don't call runInit — no .ctx/ exists

    const logs: string[] = [];
    watchHandle = await runWatch(root, {
      init: true,
      debounceMs: 100,
      log: (msg) => logs.push(msg),
      skipEmbedding: true,
    });

    // .ctx/ should now exist
    expect(fs.existsSync(path.join(root, ".ctx", "index.db"))).toBe(true);
    expect(logs.some((l) => l.includes("Watching"))).toBe(true);
  });

  it("throws when .ctx/ does not exist and no --init flag", async () => {
    const root = setup();
    // Don't initialize

    await expect(
      runWatch(root, { debounceMs: 100, log: () => undefined, skipEmbedding: true }),
    ).rejects.toThrow(/not initialized/i);
  });
});
