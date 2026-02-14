import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "../../storage/db.js";
import type { KontextDatabase } from "../../storage/db.js";
import { createWatcher } from "../../watcher/watcher.js";
import type { FileChange, WatcherHandle } from "../../watcher/watcher.js";
import { initParser, parseFile } from "../../indexer/parser.js";
import { chunkFile } from "../../indexer/chunker.js";
import type { Chunk } from "../../indexer/chunker.js";
import { prepareChunkText } from "../../indexer/embedder.js";
import type { Embedder } from "../../indexer/embedder.js";
import { KontextError, IndexError, ErrorCode } from "../../utils/errors.js";
import { handleCommandError } from "../../utils/error-boundary.js";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { LANGUAGE_MAP } from "../../indexer/discovery.js";
import { runInit } from "./init.js";
import {
  createProjectEmbedder,
  getProjectEmbedderConfig,
} from "../embedder.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Options for the watch command. */
export interface WatchOptions {
  init?: boolean;
  debounceMs?: number;
  log?: (msg: string) => void;
  skipEmbedding?: boolean;
}

/** Handle for a running watch session. Call stop() for graceful shutdown. */
export interface WatchHandle {
  stop(): Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CTX_DIR = ".ctx";
const DB_FILENAME = "index.db";

// ── Helpers ──────────────────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] ?? null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function hashFile(absolutePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const content = fs.readFileSync(absolutePath);
  return createHash("sha256").update(content).digest("hex");
}

// ── Re-index pipeline ────────────────────────────────────────────────────────

interface ReindexResult {
  filesProcessed: number;
  chunksUpdated: number;
  durationMs: number;
}

async function reindexChanges(
  db: KontextDatabase,
  changes: FileChange[],
  projectPath: string,
  options: { skipEmbedding?: boolean; log: (msg: string) => void },
): Promise<ReindexResult> {
  const start = performance.now();
  const log = options.log;

  let filesProcessed = 0;
  let chunksUpdated = 0;

  const allChunksWithMeta: { fileRelPath: string; chunk: Chunk }[] = [];

  for (const change of changes) {
    const absolutePath = path.join(projectPath, change.path);
    const language = detectLanguage(change.path);

    if (change.type === "unlink") {
      log(`[${timestamp()}] Deleted: ${change.path}`);
      const existingFile = db.getFile(change.path);
      if (existingFile) {
        db.deleteFile(change.path);
      }
      filesProcessed++;
      continue;
    }

    if (!language) continue;
    if (!fs.existsSync(absolutePath)) continue;

    const label = change.type === "add" ? "Added" : "Changed";
    log(`[${timestamp()}] ${label}: ${change.path}`);

    // Delete old chunks for this file
    const existingFile = db.getFile(change.path);
    if (existingFile) {
      db.deleteChunksByFile(existingFile.id);
    }

    // Parse
    let nodes;
    try {
      nodes = await parseFile(absolutePath, language);
    } catch {
      log(`[${timestamp()}] ⚠ Skipping ${change.path} (parse error)`);
      continue;
    }

    // Chunk
    const chunks = chunkFile(nodes, change.path);

    // Compute file hash
    const hash = await hashFile(absolutePath);
    const size = fs.statSync(absolutePath).size;

    // Upsert file record
    const fileId = db.upsertFile({
      path: change.path,
      language,
      hash,
      size,
    });

    // Insert chunks
    const chunkIds = db.insertChunks(
      fileId,
      chunks.map((c) => ({
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        type: c.type,
        name: c.name,
        parent: c.parent,
        text: c.text,
        imports: c.imports,
        exports: c.exports,
        hash: c.hash,
      })),
    );

    for (let i = 0; i < chunks.length; i++) {
      allChunksWithMeta.push({
        fileRelPath: change.path,
        chunk: { ...chunks[i], id: String(chunkIds[i]) },
      });
    }

    chunksUpdated += chunks.length;
    filesProcessed++;
  }

  // Embedding (if enabled)
  if (!options.skipEmbedding && allChunksWithMeta.length > 0) {
    const embedder = await loadEmbedder(projectPath);

    const texts = allChunksWithMeta.map((cm) =>
      prepareChunkText(cm.fileRelPath, cm.chunk.parent, cm.chunk.text),
    );

    const vectors = await embedder.embed(texts);

    db.transaction(() => {
      for (let i = 0; i < allChunksWithMeta.length; i++) {
        const chunkDbId = parseInt(allChunksWithMeta[i].chunk.id, 10);
        db.insertVector(chunkDbId, vectors[i]);
      }
    });
  }

  const durationMs = performance.now() - start;
  return { filesProcessed, chunksUpdated, durationMs };
}

// ── Embedder singleton ───────────────────────────────────────────────────────

let embedderInstance: Embedder | null = null;
let embedderKey: string | null = null;

function getCacheKey(projectPath: string): string {
  const config = getProjectEmbedderConfig(projectPath);
  return `${projectPath}:${config.provider}:${config.model}:${config.dimensions}`;
}

async function loadEmbedder(projectPath: string): Promise<Embedder> {
  const cacheKey = getCacheKey(projectPath);
  if (embedderInstance && embedderKey === cacheKey) return embedderInstance;
  embedderInstance = await createProjectEmbedder(projectPath);
  embedderKey = cacheKey;
  return embedderInstance;
}

// ── Main watch function ──────────────────────────────────────────────────────

/** Start watching a project for file changes. Re-indexes incrementally on each change batch. */
export async function runWatch(
  projectPath: string,
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const absoluteRoot = path.resolve(projectPath);
  const dbPath = path.join(absoluteRoot, CTX_DIR, DB_FILENAME);
  const log = options.log ?? console.log;

  // Optionally run init first
  if (options.init) {
    await runInit(absoluteRoot, { log, skipEmbedding: options.skipEmbedding });
  }

  // Validate .ctx/ exists
  if (!fs.existsSync(dbPath)) {
    throw new KontextError(
      `Project not initialized. Run "ctx init" first or use --init flag. (${CTX_DIR}/${DB_FILENAME} not found)`,
      ErrorCode.NOT_INITIALIZED,
    );
  }

  // Initialize parser
  await initParser();

  // Open DB
  const embedderConfig = getProjectEmbedderConfig(absoluteRoot);
  const db = createDatabase(dbPath, embedderConfig.dimensions);

  // Create watcher
  let watcherHandle: WatcherHandle | null = null;

  const watcher = createWatcher(
    {
      projectPath: absoluteRoot,
      dbPath,
      debounceMs: options.debounceMs,
    },
    {
      onChange: (changes: FileChange[]) => {
        void (async () => {
          try {
            const result = await reindexChanges(db, changes, absoluteRoot, {
              skipEmbedding: options.skipEmbedding,
              log,
            });

            if (result.filesProcessed > 0) {
              log(
                `[${timestamp()}] Re-indexed: ${result.filesProcessed} file(s), ${result.chunksUpdated} chunks updated (${formatDuration(result.durationMs)})`,
              );
            }
          } catch (err) {
            log(
              `[${timestamp()}] Error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
      },
      onError: (err) => {
        log(`[${timestamp()}] Watcher error: ${err.message}`);
      },
    },
  );

  // Start watching
  await watcher.start();
  watcherHandle = watcher;

  log(`Watching ${absoluteRoot} for changes...`);

  return {
    async stop(): Promise<void> {
      if (watcherHandle) {
        await watcherHandle.stop();
        watcherHandle = null;
      }
      db.close();
      log("Stopped watching. Database saved.");
    },
  };
}

// ── CLI registration ─────────────────────────────────────────────────────────

export function registerWatchCommand(program: Command): void {
  program
    .command("watch [path]")
    .description("Watch mode — re-index on file changes")
    .option("--init", "Run init before starting watch")
    .option("--debounce <ms>", "Debounce interval in ms", "500")
    .option("--embed", "Enable embedding during watch (slower)")
    .action(async (inputPath: string | undefined, opts: Record<string, string | boolean>) => {
      const projectPath = inputPath ?? process.cwd();
      const verbose = program.opts()["verbose"] === true;
      const logger = createLogger({ level: verbose ? LogLevel.DEBUG : LogLevel.INFO });
      const skipEmbedding = opts["embed"] !== true;

      try {
        const handle = await runWatch(projectPath, {
          init: opts["init"] === true,
          debounceMs: parseInt(String(opts["debounce"] ?? "500"), 10),
          skipEmbedding,
        });

        // Handle Ctrl+C
        const shutdown = () => {
          void handle.stop().then(() => process.exit(0));
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err) {
        const wrapped = err instanceof KontextError ? err
          : new IndexError(
              err instanceof Error ? err.message : String(err),
              ErrorCode.WATCHER_FAILED,
              err instanceof Error ? err : undefined,
            );
        process.exitCode = handleCommandError(wrapped, logger, verbose);
      }
    });
}
