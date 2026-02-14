import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { DiscoveredFile } from "./discovery.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Result of incremental change detection: files categorized by status. */
export interface IncrementalResult {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  /** SHA-256 content hashes for added + modified files */
  hashes: Map<string, string>;
  /** Wall-clock duration in milliseconds */
  duration: number;
}

/** Minimal DB surface needed for change detection */
export interface ChangeDetectionDb {
  getFile(filePath: string): { hash: string } | null;
  getAllFilePaths(): string[];
}

// ── File hashing ─────────────────────────────────────────────────────────────

export async function hashFileContent(absolutePath: string): Promise<string> {
  const content = await fs.readFile(absolutePath);
  return createHash("sha256").update(content).digest("hex");
}

// ── Change detection ─────────────────────────────────────────────────────────

/** Compare discovered files against stored hashes to detect adds, modifies, and deletes. */
export async function computeChanges(
  discovered: DiscoveredFile[],
  db: ChangeDetectionDb,
): Promise<IncrementalResult> {
  const start = performance.now();

  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  const hashes = new Map<string, string>();

  // Build set of discovered paths for fast lookup
  const discoveredPaths = new Set(discovered.map((f) => f.path));

  // Classify each discovered file
  await Promise.all(
    discovered.map(async (file) => {
      const contentHash = await hashFileContent(file.absolutePath);
      const existing = db.getFile(file.path);

      if (!existing) {
        added.push(file.path);
        hashes.set(file.path, contentHash);
      } else if (existing.hash !== contentHash) {
        modified.push(file.path);
        hashes.set(file.path, contentHash);
      } else {
        unchanged.push(file.path);
      }
    }),
  );

  // Find deleted files: in DB but not discovered
  const dbPaths = db.getAllFilePaths();
  const deleted = dbPaths.filter((p) => !discoveredPaths.has(p));

  // Sort for deterministic output
  added.sort();
  modified.sort();
  deleted.sort();
  unchanged.sort();

  return {
    added,
    modified,
    deleted,
    unchanged,
    hashes,
    duration: performance.now() - start,
  };
}
