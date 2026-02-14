import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import { LANGUAGE_MAP } from "../indexer/discovery.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** A single file change event from the watcher. */
export interface FileChange {
  type: "add" | "change" | "unlink";
  path: string;
}

export interface WatcherOptions {
  projectPath: string;
  dbPath?: string;
  debounceMs?: number;
  ignored?: string[];
}

export interface WatcherEvents {
  onChange: (changes: FileChange[]) => void;
  onError: (error: Error) => void;
}

/** Handle returned by createWatcher. Call start() to begin, stop() to clean up. */
export interface WatcherHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DEBOUNCE_MS = 500;

const ALWAYS_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".ctx",
  "dist",
  "build",
  "__pycache__",
]);

const WATCHED_EXTENSIONS = new Set(Object.keys(LANGUAGE_MAP));

// ── Implementation ───────────────────────────────────────────────────────────

function isWatchedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return WATCHED_EXTENSIONS.has(ext);
}

/** Create a file watcher that debounces changes and filters by code extensions. */
export function createWatcher(
  options: WatcherOptions,
  events: WatcherEvents,
): WatcherHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const projectPath = path.resolve(options.projectPath);

  const extraIgnored = new Set(options.ignored ?? []);

  function isIgnored(filePath: string): boolean {
    const segments = filePath.split(path.sep);
    for (const seg of segments) {
      if (ALWAYS_IGNORED_DIRS.has(seg)) return true;
      if (extraIgnored.has(seg)) return true;
    }
    return false;
  }

  let watcher: FSWatcher | null = null;
  let pendingChanges = new Map<string, FileChange>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (pendingChanges.size === 0) return;

    const batch = [...pendingChanges.values()];
    pendingChanges = new Map();

    events.onChange(batch);
  }

  function scheduleFlush(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, debounceMs);
  }

  function handleEvent(type: "add" | "change" | "unlink", filePath: string): void {
    if (!isWatchedFile(filePath)) return;

    // filePath is relative to cwd (chokidar cwd option)
    pendingChanges.set(filePath, { type, path: filePath });
    scheduleFlush();
  }

  return {
    start(): Promise<void> {
      return new Promise<void>((resolve) => {
        watcher = watch(".", {
          cwd: projectPath,
          ignored: (fp: string) => isIgnored(fp),
          ignoreInitial: true,
          persistent: true,
        });

        watcher.on("add", (fp) => handleEvent("add", fp));
        watcher.on("change", (fp) => handleEvent("change", fp));
        watcher.on("unlink", (fp) => handleEvent("unlink", fp));
        watcher.on("error", (err: unknown) => {
          events.onError(err instanceof Error ? err : new Error(String(err)));
        });
        watcher.on("ready", () => resolve());
      });
    },

    async stop(): Promise<void> {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      pendingChanges.clear();

      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    },
  };
}
