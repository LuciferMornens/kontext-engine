import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { discoverFiles } from "../../indexer/discovery.js";
import { computeChanges } from "../../indexer/incremental.js";
import { initParser, parseFile } from "../../indexer/parser.js";
import { chunkFile } from "../../indexer/chunker.js";
import type { Chunk } from "../../indexer/chunker.js";
import { prepareChunkText } from "../../indexer/embedder.js";
import type { Embedder } from "../../indexer/embedder.js";
import { IndexError, ErrorCode } from "../../utils/errors.js";
import { handleCommandError } from "../../utils/error-boundary.js";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { createDatabase } from "../../storage/db.js";
import type { IndexEmbedderMetadata } from "../../storage/db.js";
import { DEFAULT_CONFIG } from "./config.js";
import {
  createProjectEmbedder,
  getProjectEmbedderConfig,
} from "../embedder.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Options for the init pipeline. */
export interface InitOptions {
  log?: (msg: string) => void;
  skipEmbedding?: boolean;
}

interface IndexStats {
  filesDiscovered: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  filesUnchanged: number;
  chunksCreated: number;
  vectorsCreated: number;
  durationMs: number;
  languageCounts: Map<string, number>;
}

function isSameEmbedderConfig(
  a: IndexEmbedderMetadata,
  b: { provider: string; model: string; dimensions: number },
): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.dimensions === b.dimensions
  );
}

// ── Constants ────────────────────────────────────────────────────────────────

const CTX_DIR = ".ctx";
const DB_FILENAME = "index.db";
const CONFIG_FILENAME = "config.json";
const GITIGNORE_ENTRY = ".ctx/";

// ── Gitignore management ─────────────────────────────────────────────────────

function ensureGitignore(projectRoot: string): void {
  const gitignorePath = path.join(projectRoot, ".gitignore");

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (content.includes(GITIGNORE_ENTRY)) return;
    const suffix = content.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(gitignorePath, `${content}${suffix}${GITIGNORE_ENTRY}\n`);
  } else {
    fs.writeFileSync(gitignorePath, `${GITIGNORE_ENTRY}\n`);
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

function ensureConfig(ctxDir: string): void {
  const configPath = path.join(ctxDir, CONFIG_FILENAME);
  if (fs.existsSync(configPath)) return;

  fs.writeFileSync(
    configPath,
    JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
  );
}

// ── Format helpers ───────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLanguageSummary(counts: Map<string, number>): string {
  const entries = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => `${lang}: ${count}`);
  return entries.join(", ");
}

// ── Main pipeline ────────────────────────────────────────────────────────────

/** Index a codebase: discover → parse → chunk → embed → store. Runs incrementally on subsequent calls. */
export async function runInit(
  projectPath: string,
  options: InitOptions = {},
): Promise<IndexStats> {
  const log = options.log ?? console.log;
  const absoluteRoot = path.resolve(projectPath);
  const start = performance.now();

  log(`Indexing ${absoluteRoot}...`);

  // 1. Setup .ctx directory
  const ctxDir = path.join(absoluteRoot, CTX_DIR);
  if (!fs.existsSync(ctxDir)) fs.mkdirSync(ctxDir, { recursive: true });

  ensureGitignore(absoluteRoot);
  ensureConfig(ctxDir);
  const embedderConfig = getProjectEmbedderConfig(absoluteRoot);

  // 2. Open/create database
  const dbPath = path.join(ctxDir, DB_FILENAME);
  const db = createDatabase(dbPath, embedderConfig.dimensions);

  try {
    const existingEmbedder = db.getIndexEmbedder();
    if (existingEmbedder) {
      if (!isSameEmbedderConfig(existingEmbedder, embedderConfig)) {
        throw new IndexError(
          `Index embedder mismatch: index uses ${existingEmbedder.provider} (${existingEmbedder.model}, ${existingEmbedder.dimensions} dims) but config requests ${embedderConfig.provider} (${embedderConfig.model}, ${embedderConfig.dimensions} dims). Rebuild the index.`,
          ErrorCode.CONFIG_INVALID,
        );
      }
    } else {
      const isEmptyIndex =
        db.getFileCount() === 0 && db.getChunkCount() === 0 && db.getVectorCount() === 0;
      if (isEmptyIndex) {
        db.setIndexEmbedder({
          provider: embedderConfig.provider,
          model: embedderConfig.model,
          dimensions: embedderConfig.dimensions,
        });
      }
    }

    // 3. Discover files
    const discovered = await discoverFiles({
      root: absoluteRoot,
      extraIgnore: [".ctx/"],
    });

    const languageCounts = new Map<string, number>();
    for (const file of discovered) {
      languageCounts.set(
        file.language,
        (languageCounts.get(file.language) ?? 0) + 1,
      );
    }

    log(
      `  Discovered ${discovered.length} files` +
        (discovered.length > 0
          ? ` (${formatLanguageSummary(languageCounts)})`
          : ""),
    );

    // 4. Compute incremental changes
    const changes = await computeChanges(discovered, db);

    const filesToProcess = [
      ...changes.added.map((p) => ({ path: p, reason: "added" as const })),
      ...changes.modified.map((p) => ({ path: p, reason: "modified" as const })),
    ];

    if (changes.unchanged.length > 0) {
      log(`  ${changes.unchanged.length} unchanged files skipped`);
    }
    if (changes.deleted.length > 0) {
      log(`  ${changes.deleted.length} deleted files removed`);
    }
    if (changes.added.length > 0) {
      log(`  ${changes.added.length} new files to index`);
    }
    if (changes.modified.length > 0) {
      log(`  ${changes.modified.length} modified files to re-index`);
    }

    // 5. Delete removed files from DB (CASCADE handles chunks + vectors)
    for (const deletedPath of changes.deleted) {
      db.deleteFile(deletedPath);
    }

    // 6. Parse & chunk changed files
    await initParser();

    const allChunksWithMeta: {
      fileRelPath: string;
      chunk: Chunk;
    }[] = [];

    let filesProcessed = 0;

    for (const { path: relPath } of filesToProcess) {
      const discovered_file = discovered.find((f) => f.path === relPath);
      if (!discovered_file) continue;

      // Delete old data for modified files
      const existingFile = db.getFile(relPath);
      if (existingFile) {
        db.deleteChunksByFile(existingFile.id);
      }

      // Parse
      let nodes;
      try {
        nodes = await parseFile(discovered_file.absolutePath, discovered_file.language);
      } catch {
        log(`  ⚠ Skipping ${relPath} (parse error)`);
        continue;
      }

      // Chunk
      const chunks = chunkFile(nodes, relPath);

      // Upsert file record
      const fileId = db.upsertFile({
        path: relPath,
        language: discovered_file.language,
        hash: changes.hashes.get(relPath) ?? "",
        size: discovered_file.size,
      });

      // Insert chunks into DB
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

      // Pair chunks with their DB IDs for embedding
      for (let i = 0; i < chunks.length; i++) {
        allChunksWithMeta.push({
          fileRelPath: relPath,
          chunk: { ...chunks[i], id: String(chunkIds[i]) },
        });
      }

      filesProcessed++;
      if (filesProcessed % 50 === 0 || filesProcessed === filesToProcess.length) {
        log(`  Parsing... ${filesProcessed}/${filesToProcess.length}`);
      }
    }

    log(`  ${allChunksWithMeta.length} chunks created`);

    // 7. Embedding
    let vectorsCreated = 0;

    if (!options.skipEmbedding && allChunksWithMeta.length > 0) {
      const embedder = await createEmbedder(absoluteRoot);

      const texts = allChunksWithMeta.map((cm) =>
        prepareChunkText(cm.fileRelPath, cm.chunk.parent, cm.chunk.text),
      );

      const vectors = await embedder.embed(texts, (done, total) => {
        log(`  Embedding... ${done}/${total}`);
      });

      // Store vectors
      db.transaction(() => {
        for (let i = 0; i < allChunksWithMeta.length; i++) {
          const chunkDbId = parseInt(allChunksWithMeta[i].chunk.id, 10);
          db.insertVector(chunkDbId, vectors[i]);
        }
      });

      vectorsCreated = vectors.length;
    }

    // 8. Summary
    const durationMs = performance.now() - start;
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

    log("");
    log(`✓ Indexed in ${formatDuration(durationMs)}`);
    log(
      `  ${discovered.length} files → ${allChunksWithMeta.length} chunks` +
        (vectorsCreated > 0 ? ` → ${vectorsCreated} vectors` : ""),
    );
    log(`  Database: ${CTX_DIR}/${DB_FILENAME} (${formatBytes(dbSize)})`);

    return {
      filesDiscovered: discovered.length,
      filesAdded: changes.added.length,
      filesModified: changes.modified.length,
      filesDeleted: changes.deleted.length,
      filesUnchanged: changes.unchanged.length,
      chunksCreated: allChunksWithMeta.length,
      vectorsCreated,
      durationMs,
      languageCounts,
    };
  } finally {
    db.close();
  }
}

// ── Embedder factory (separated for testability) ─────────────────────────────

async function createEmbedder(projectPath: string): Promise<Embedder> {
  return createProjectEmbedder(projectPath);
}

// ── CLI registration ─────────────────────────────────────────────────────────

export function registerInitCommand(program: Command): void {
  program
    .command("init [path]")
    .description("Index current directory or specified path")
    .action(async (inputPath?: string) => {
      const projectPath = inputPath ?? process.cwd();
      const verbose = program.opts()["verbose"] === true;
      const logger = createLogger({ level: verbose ? LogLevel.DEBUG : LogLevel.INFO });

      try {
        await runInit(projectPath);
      } catch (err) {
        const wrapped = err instanceof IndexError ? err
          : new IndexError(
              err instanceof Error ? err.message : String(err),
              ErrorCode.INDEX_FAILED,
              err instanceof Error ? err : undefined,
            );
        process.exitCode = handleCommandError(wrapped, logger, verbose);
      }
    });
}
