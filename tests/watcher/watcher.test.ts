import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createWatcher } from "../../src/watcher/watcher.js";
import type { FileChange, WatcherHandle } from "../../src/watcher/watcher.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let handle: WatcherHandle | null = null;

function setup(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kontext-watch-"));
  const srcDir = path.join(tmpDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "existing.ts"),
    "export const x = 1;\n",
  );
  return tmpDir;
}

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createWatcher", () => {
  it("detects file addition", async () => {
    const root = setup();
    const changes: FileChange[] = [];

    handle = createWatcher(
      { projectPath: root, debounceMs: 100 },
      {
        onChange: (c) => changes.push(...c),
        onError: () => undefined,
      },
    );

    await handle.start();
    // Let watcher stabilize
    await sleep(100);

    // Add a new file
    fs.writeFileSync(path.join(root, "src", "new.ts"), "const a = 1;\n");
    await sleep(500);

    expect(changes.some((c) => c.type === "add" && c.path.includes("new.ts"))).toBe(true);
  });

  it("detects file modification", async () => {
    const root = setup();
    const changes: FileChange[] = [];

    handle = createWatcher(
      { projectPath: root, debounceMs: 100 },
      {
        onChange: (c) => changes.push(...c),
        onError: () => undefined,
      },
    );

    await handle.start();
    // Let watcher stabilize after initial scan
    await sleep(100);

    // Modify existing file
    fs.writeFileSync(
      path.join(root, "src", "existing.ts"),
      "export const x = 2;\n",
    );
    await sleep(400);

    expect(changes.some((c) => c.path.includes("existing.ts"))).toBe(true);
    const change = changes.find((c) => c.path.includes("existing.ts"));
    // Chokidar may report as 'add' or 'change' depending on timing
    expect(["add", "change"]).toContain(change?.type);
  });

  it("detects file deletion", async () => {
    const root = setup();
    const changes: FileChange[] = [];

    handle = createWatcher(
      { projectPath: root, debounceMs: 100 },
      {
        onChange: (c) => changes.push(...c),
        onError: () => undefined,
      },
    );

    await handle.start();
    // Let watcher stabilize
    await sleep(100);

    // Delete existing file
    fs.unlinkSync(path.join(root, "src", "existing.ts"));
    await sleep(500);

    expect(changes.some((c) => c.type === "unlink" && c.path.includes("existing.ts"))).toBe(true);
  });

  it("debounces rapid changes into one batch", async () => {
    const root = setup();
    const batches: FileChange[][] = [];

    handle = createWatcher(
      { projectPath: root, debounceMs: 200 },
      {
        onChange: (c) => batches.push([...c]),
        onError: () => undefined,
      },
    );

    await handle.start();

    // Rapid-fire 3 files within debounce window
    fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\n");
    await sleep(30);
    fs.writeFileSync(path.join(root, "src", "b.ts"), "const b = 2;\n");
    await sleep(30);
    fs.writeFileSync(path.join(root, "src", "c.ts"), "const c = 3;\n");

    await sleep(500);

    // Should be batched — 1 batch with all 3 (or at most 2 batches)
    const totalChanges = batches.reduce((sum, b) => sum + b.length, 0);
    expect(totalChanges).toBeGreaterThanOrEqual(3);
    // With 200ms debounce and 30ms gaps, should batch into 1
    expect(batches.length).toBeLessThanOrEqual(2);
  });

  it("ignores node_modules and .git directories", async () => {
    const root = setup();
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    const changes: FileChange[] = [];

    handle = createWatcher(
      { projectPath: root, debounceMs: 100 },
      {
        onChange: (c) => changes.push(...c),
        onError: () => undefined,
      },
    );

    await handle.start();

    // Write to node_modules — should be ignored
    fs.writeFileSync(
      path.join(root, "node_modules", "pkg.js"),
      "module.exports = 1;\n",
    );
    await sleep(400);

    expect(changes.some((c) => c.path.includes("node_modules"))).toBe(false);
  });

  it("ignores non-code files", async () => {
    const root = setup();
    const changes: FileChange[] = [];

    handle = createWatcher(
      { projectPath: root, debounceMs: 100 },
      {
        onChange: (c) => changes.push(...c),
        onError: () => undefined,
      },
    );

    await handle.start();

    // Write a .png file — should be ignored
    fs.writeFileSync(path.join(root, "src", "image.png"), "fake-png");
    await sleep(400);

    expect(changes.some((c) => c.path.includes("image.png"))).toBe(false);
  });

  it("stop properly cleans up watcher", async () => {
    const root = setup();
    const changes: FileChange[] = [];

    handle = createWatcher(
      { projectPath: root, debounceMs: 100 },
      {
        onChange: (c) => changes.push(...c),
        onError: () => undefined,
      },
    );

    await handle.start();
    await handle.stop();
    handle = null;

    // Changes after stop should not be detected
    fs.writeFileSync(path.join(root, "src", "after.ts"), "const z = 1;\n");
    await sleep(400);

    expect(changes.some((c) => c.path.includes("after.ts"))).toBe(false);
  });

  it("uses relative paths in file changes", async () => {
    const root = setup();
    const changes: FileChange[] = [];

    handle = createWatcher(
      { projectPath: root, debounceMs: 100 },
      {
        onChange: (c) => changes.push(...c),
        onError: () => undefined,
      },
    );

    await handle.start();

    fs.writeFileSync(path.join(root, "src", "relative.ts"), "const r = 1;\n");
    await sleep(400);

    const change = changes.find((c) => c.path.includes("relative.ts"));
    expect(change).toBeDefined();
    // Path should be relative, not absolute
    expect(change?.path).not.toContain(os.tmpdir());
    expect(change?.path).toMatch(/^src[\\/]relative\.ts$/);
  });

  it("respects additional ignore patterns", async () => {
    const root = setup();
    fs.mkdirSync(path.join(root, "generated"), { recursive: true });
    const changes: FileChange[] = [];

    handle = createWatcher(
      { projectPath: root, debounceMs: 100, ignored: ["generated"] },
      {
        onChange: (c) => changes.push(...c),
        onError: () => undefined,
      },
    );

    await handle.start();

    fs.writeFileSync(
      path.join(root, "generated", "output.ts"),
      "const g = 1;\n",
    );
    await sleep(400);

    expect(changes.some((c) => c.path.includes("generated"))).toBe(false);
  });
});
