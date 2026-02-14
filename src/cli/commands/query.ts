import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "../../storage/db.js";
import type { KontextDatabase } from "../../storage/db.js";
import { vectorSearch } from "../../search/vector.js";
import { ftsSearch } from "../../search/fts.js";
import { astSearch } from "../../search/ast.js";
import { KontextError, SearchError, ErrorCode } from "../../utils/errors.js";
import { handleCommandError } from "../../utils/error-boundary.js";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { pathSearch } from "../../search/path.js";
import { fusionMerge } from "../../search/fusion.js";
import type { StrategyResult, StrategyName } from "../../search/fusion.js";
import type { SearchResult } from "../../search/types.js";
import { createLocalEmbedder } from "../../indexer/embedder.js";
import type { Embedder } from "../../indexer/embedder.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Options for the query command. */
export interface QueryOptions {
  limit: number;
  strategies: StrategyName[];
  language?: string;
  format: "json" | "text";
}

export interface QueryOutputResult {
  file: string;
  lines: [number, number];
  name: string | null;
  type: string;
  score: number;
  snippet: string;
  language: string;
}

export interface QueryOutput {
  query: string;
  results: QueryOutputResult[];
  stats: {
    strategies: string[];
    totalResults: number;
    searchTimeMs: number;
  };
  text?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CTX_DIR = ".ctx";
const DB_FILENAME = "index.db";
const SNIPPET_MAX_LENGTH = 200;

const STRATEGY_WEIGHTS: Record<StrategyName, number> = {
  vector: 1.0,
  fts: 0.8,
  ast: 0.9,
  path: 0.7,
  dependency: 0.6,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateSnippet(text: string): string {
  const oneLine = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (oneLine.length <= SNIPPET_MAX_LENGTH) return oneLine;
  return oneLine.slice(0, SNIPPET_MAX_LENGTH) + "...";
}

function toOutputResult(r: SearchResult): QueryOutputResult {
  return {
    file: r.filePath,
    lines: [r.lineStart, r.lineEnd],
    name: r.name,
    type: r.type,
    score: Math.round(r.score * 100) / 100,
    snippet: truncateSnippet(r.text),
    language: r.language,
  };
}

function formatTextOutput(query: string, results: QueryOutputResult[]): string {
  if (results.length === 0) {
    return `No results for "${query}"`;
  }

  const lines = [`Results for "${query}":\n`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const nameLabel = r.name ? `${r.name} [${r.type}]` : `[${r.type}]`;
    lines.push(`${i + 1}. ${r.file}:${r.lines[0]}-${r.lines[1]} (score: ${r.score})`);
    lines.push(`   ${nameLabel}`);
    lines.push(`   ${r.snippet}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Heuristic: extract likely symbol names from a query string */
function extractSymbolNames(query: string): string[] {
  // Match camelCase, PascalCase, snake_case identifiers
  const matches = query.match(/[A-Z]?[a-z]+(?:[A-Z][a-z]+)*|[a-z]+(?:_[a-z]+)+|[A-Z][a-zA-Z]+/g);
  return matches ?? [];
}

/** Heuristic: check if query looks like a file path pattern */
function isPathLike(query: string): boolean {
  return query.includes("/") || query.includes("*") || query.includes(".");
}

// ── Main query function ──────────────────────────────────────────────────────

/** Execute a multi-strategy search with RRF fusion. Returns ranked results. */
export async function runQuery(
  projectPath: string,
  query: string,
  options: QueryOptions,
): Promise<QueryOutput> {
  const absoluteRoot = path.resolve(projectPath);
  const dbPath = path.join(absoluteRoot, CTX_DIR, DB_FILENAME);

  if (!fs.existsSync(dbPath)) {
    throw new KontextError(
      `Project not initialized. Run "ctx init" first. (${CTX_DIR}/${DB_FILENAME} not found)`,
      ErrorCode.NOT_INITIALIZED,
    );
  }

  const start = performance.now();
  const db = createDatabase(dbPath);

  try {
    const strategyResults = await runStrategies(db, query, options);
    const fused = fusionMerge(strategyResults, options.limit);
    const outputResults = fused.map(toOutputResult);

    const searchTimeMs = Math.round(performance.now() - start);
    const text =
      options.format === "text"
        ? formatTextOutput(query, outputResults)
        : undefined;

    return {
      query,
      results: outputResults,
      stats: {
        strategies: strategyResults.map((s) => s.strategy),
        totalResults: outputResults.length,
        searchTimeMs,
      },
      text,
    };
  } finally {
    db.close();
  }
}

// ── Strategy dispatch ────────────────────────────────────────────────────────

async function runStrategies(
  db: KontextDatabase,
  query: string,
  options: QueryOptions,
): Promise<StrategyResult[]> {
  const results: StrategyResult[] = [];
  const filters = options.language ? { language: options.language } : undefined;
  const limit = options.limit * 3; // Fetch extra for fusion

  for (const strategy of options.strategies) {
    const weight = STRATEGY_WEIGHTS[strategy];
    const searchResults = await executeStrategy(
      db,
      strategy,
      query,
      limit,
      filters,
    );

    if (searchResults.length > 0) {
      results.push({ strategy, weight, results: searchResults });
    }
  }

  return results;
}

async function executeStrategy(
  db: KontextDatabase,
  strategy: StrategyName,
  query: string,
  limit: number,
  filters?: { language?: string },
): Promise<SearchResult[]> {
  switch (strategy) {
    case "vector": {
      const embedder = await loadEmbedder();
      return vectorSearch(db, embedder, query, limit, filters);
    }

    case "fts":
      return ftsSearch(db, query, limit, filters);

    case "ast": {
      const symbols = extractSymbolNames(query);
      if (symbols.length === 0) return [];

      const allResults: SearchResult[] = [];
      for (const name of symbols) {
        const results = astSearch(
          db,
          { name, language: filters?.language },
          limit,
        );
        allResults.push(...results);
      }

      // Deduplicate by chunkId
      const seen = new Set<number>();
      return allResults.filter((r) => {
        if (seen.has(r.chunkId)) return false;
        seen.add(r.chunkId);
        return true;
      });
    }

    case "path": {
      if (!isPathLike(query)) return [];
      return pathSearch(db, query, limit);
    }

    case "dependency":
      return [];
  }
}

// ── Embedder singleton ───────────────────────────────────────────────────────

let embedderInstance: Embedder | null = null;

async function loadEmbedder(): Promise<Embedder> {
  if (embedderInstance) return embedderInstance;
  embedderInstance = await createLocalEmbedder();
  return embedderInstance;
}

// ── CLI registration ─────────────────────────────────────────────────────────

export function registerQueryCommand(program: Command): void {
  program
    .command("query <query>")
    .description("Multi-strategy code search")
    .option("-l, --limit <n>", "Max results", "10")
    .option(
      "-s, --strategy <list>",
      "Comma-separated strategies: vector,fts,ast,path",
      "fts,ast",
    )
    .option("--language <lang>", "Filter by language")
    .option("-f, --format <fmt>", "Output format: json|text", "json")
    .option("--no-vectors", "Skip vector search")
    .action(async (query: string, opts: Record<string, string>) => {
      const projectPath = process.cwd();
      const verbose = program.opts()["verbose"] === true;
      const logger = createLogger({ level: verbose ? LogLevel.DEBUG : LogLevel.INFO });
      const strategies = (opts["strategy"] ?? "fts,ast")
        .split(",")
        .map((s) => s.trim()) as StrategyName[];

      try {
        const output = await runQuery(projectPath, query, {
          limit: parseInt(opts["limit"] ?? "10", 10),
          strategies,
          language: opts["language"] as string | undefined,
          format: (opts["format"] ?? "json") as "json" | "text",
        });

        if (output.text) {
          console.log(output.text);
        } else {
          console.log(JSON.stringify(output, null, 2));
        }
      } catch (err) {
        const wrapped = err instanceof KontextError ? err
          : new SearchError(
              err instanceof Error ? err.message : String(err),
              ErrorCode.SEARCH_FAILED,
              err instanceof Error ? err : undefined,
            );
        process.exitCode = handleCommandError(wrapped, logger, verbose);
      }
    });
}
