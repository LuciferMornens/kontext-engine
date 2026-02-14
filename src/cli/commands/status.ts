import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "../../storage/db.js";
import { handleCommandError } from "../../utils/error-boundary.js";
import { createLogger, LogLevel } from "../../utils/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface ProjectConfig {
  provider: string;
  model: string;
  dimensions: number;
}

/** Structured output from the status command. */
export interface StatusOutput {
  initialized: boolean;
  fileCount: number;
  chunkCount: number;
  vectorCount: number;
  dbSizeBytes: number;
  lastIndexed: string | null;
  languages: Map<string, number>;
  config: ProjectConfig | null;
  indexEmbedder: ProjectConfig | null;
  embedderWarning: string | null;
  text: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CTX_DIR = ".ctx";
const DB_FILENAME = "index.db";
const CONFIG_FILENAME = "config.json";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(raw: string): string {
  const num = Number(raw);
  if (Number.isNaN(num)) return raw;
  const date = new Date(num);
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function readConfig(ctxDir: string): ProjectConfig | null {
  const configPath = path.join(ctxDir, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Support both new (embedder.model) and legacy (model) config formats
    const embedder = parsed.embedder as
      | { provider?: string; model?: string; dimensions?: number }
      | undefined;
    return {
      provider:
        (embedder?.provider as string | undefined) ??
        (parsed.provider as string | undefined) ??
        "unknown",
      model:
        embedder?.model ?? (parsed.model as string | undefined) ?? "unknown",
      dimensions:
        embedder?.dimensions ??
        (parsed.dimensions as number | undefined) ??
        0,
    };
  } catch {
    return null;
  }
}

// ── Format text output ───────────────────────────────────────────────────────

function formatNotInitialized(projectPath: string): string {
  return [
    `Kontext Status — ${projectPath}`,
    "",
    '  Not initialized. Run "ctx init" first.',
    "",
  ].join("\n");
}

function formatStatus(projectPath: string, output: StatusOutput): string {
  const lines: string[] = [
    `Kontext Status — ${projectPath}`,
    "",
    `  Initialized:  Yes`,
    `  Database:     ${CTX_DIR}/${DB_FILENAME} (${formatBytes(output.dbSizeBytes)})`,
  ];

  if (output.lastIndexed) {
    lines.push(`  Last indexed: ${formatTimestamp(output.lastIndexed)}`);
  }

  lines.push("");
  lines.push(`  Files:    ${output.fileCount.toLocaleString()}`);
  lines.push(`  Chunks:   ${output.chunkCount.toLocaleString()}`);
  lines.push(`  Vectors:  ${output.vectorCount.toLocaleString()}`);

  if (output.languages.size > 0) {
    lines.push("");
    lines.push("  Languages:");

    const maxLangLen = Math.max(
      ...[...output.languages.keys()].map((k) => capitalize(k).length),
    );

    for (const [lang, count] of output.languages) {
      const label = capitalize(lang).padEnd(maxLangLen + 2);
      lines.push(`    ${label}${count} file${count !== 1 ? "s" : ""}`);
    }
  }

  const hasConfig = output.config !== null;
  const hasIndexEmbedder = output.indexEmbedder !== null;

  if (hasConfig || hasIndexEmbedder) lines.push("");

  if (hasConfig && hasIndexEmbedder) {
    const config = output.config;
    const indexEmbedder = output.indexEmbedder;
    if (!config || !indexEmbedder) {
      lines.push("  Embedder: unknown");
    } else if (isSameEmbedder(config, indexEmbedder)) {
      lines.push(
        `  Embedder: ${indexEmbedder.provider} (${indexEmbedder.model}, ${indexEmbedder.dimensions} dims)`,
      );
    } else {
      lines.push(
        `  Index embedder:  ${indexEmbedder.provider} (${indexEmbedder.model}, ${indexEmbedder.dimensions} dims)`,
      );
      lines.push(
        `  Config embedder: ${config.provider} (${config.model}, ${config.dimensions} dims)`,
      );
    }
  } else if (hasIndexEmbedder) {
    const indexEmbedder = output.indexEmbedder;
    if (!indexEmbedder) {
      lines.push("  Index embedder: unknown");
    } else {
      lines.push(
        `  Index embedder: ${indexEmbedder.provider} (${indexEmbedder.model}, ${indexEmbedder.dimensions} dims)`,
      );
    }
  } else if (hasConfig) {
    const config = output.config;
    if (!config) {
      lines.push("  Config embedder: unknown");
    } else {
      lines.push(
        `  Config embedder: ${config.provider} (${config.model}, ${config.dimensions} dims)`,
      );
    }
  }

  if (output.embedderWarning) {
    lines.push(`  Warning: ${output.embedderWarning}`);
  }

  lines.push("");
  return lines.join("\n");
}

function isSameEmbedder(a: ProjectConfig, b: ProjectConfig): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.dimensions === b.dimensions
  );
}

// ── Main status function ─────────────────────────────────────────────────────

/** Gather index statistics: file/chunk/vector counts, languages, DB size, config. */
export async function runStatus(projectPath: string): Promise<StatusOutput> {
  const absoluteRoot = path.resolve(projectPath);
  const ctxDir = path.join(absoluteRoot, CTX_DIR);
  const dbPath = path.join(ctxDir, DB_FILENAME);

  if (!fs.existsSync(dbPath)) {
    const output: StatusOutput = {
      initialized: false,
      fileCount: 0,
      chunkCount: 0,
      vectorCount: 0,
      dbSizeBytes: 0,
      lastIndexed: null,
      languages: new Map(),
      config: null,
      indexEmbedder: null,
      embedderWarning: null,
      text: formatNotInitialized(absoluteRoot),
    };
    return output;
  }

  const db = createDatabase(dbPath);

  try {
    const fileCount = db.getFileCount();
    const chunkCount = db.getChunkCount();
    const vectorCount = db.getVectorCount();
    const languages = db.getLanguageBreakdown();
    const lastIndexed = db.getLastIndexed();
    const config = readConfig(ctxDir);
    const indexEmbedder = db.getIndexEmbedder();
    const dbSizeBytes = fs.statSync(dbPath).size;
    const embedderWarning =
      config && indexEmbedder && !isSameEmbedder(config, indexEmbedder)
        ? `Index built with ${indexEmbedder.provider} (${indexEmbedder.dimensions} dims), config requests ${config.provider} (${config.dimensions} dims) — rebuild needed.`
        : null;

    const output: StatusOutput = {
      initialized: true,
      fileCount,
      chunkCount,
      vectorCount,
      dbSizeBytes,
      lastIndexed,
      languages,
      config,
      indexEmbedder,
      embedderWarning,
      text: "",
    };

    output.text = formatStatus(absoluteRoot, output);
    return output;
  } finally {
    db.close();
  }
}

// ── CLI registration ─────────────────────────────────────────────────────────

export function registerStatusCommand(program: Command): void {
  program
    .command("status [path]")
    .description("Show index statistics")
    .action(async (inputPath?: string) => {
      const projectPath = inputPath ?? process.cwd();
      const verbose = program.opts()["verbose"] === true;
      const logger = createLogger({ level: verbose ? LogLevel.DEBUG : LogLevel.INFO });

      try {
        const output = await runStatus(projectPath);
        console.log(output.text);
      } catch (err) {
        process.exitCode = handleCommandError(err, logger, verbose);
      }
    });
}
