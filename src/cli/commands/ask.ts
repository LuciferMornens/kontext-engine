import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "../../storage/db.js";
import type { KontextDatabase } from "../../storage/db.js";
import { vectorSearch } from "../../search/vector.js";
import { ftsSearch } from "../../search/fts.js";
import { astSearch } from "../../search/ast.js";
import { pathSearch } from "../../search/path.js";
import { fusionMerge } from "../../search/fusion.js";
import { KontextError, SearchError, ErrorCode } from "../../utils/errors.js";
import { handleCommandError } from "../../utils/error-boundary.js";
import { createLogger, LogLevel } from "../../utils/logger.js";
import type { StrategyResult } from "../../search/fusion.js";
import type { SearchResult } from "../../search/types.js";
import {
  createGeminiProvider,
  createOpenAIProvider,
  createAnthropicProvider,
  steer,
  planSearch,
} from "../../steering/llm.js";
import type { LLMProvider, StrategyPlan, SearchExecutor } from "../../steering/llm.js";
import { createLocalEmbedder } from "../../indexer/embedder.js";
import type { Embedder } from "../../indexer/embedder.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Options for the LLM-steered ask command. */
export interface AskOptions {
  limit: number;
  format: "json" | "text";
  provider?: LLMProvider;
  providerName?: string;
  noExplain?: boolean;
}

export interface AskOutputResult {
  file: string;
  lines: [number, number];
  name: string | null;
  type: string;
  score: number;
  snippet: string;
  language: string;
}

export interface AskOutput {
  query: string;
  interpretation: string;
  results: AskOutputResult[];
  explanation: string;
  stats: {
    strategies: string[];
    tokensUsed: number;
    costEstimate: number;
    totalResults: number;
  };
  fallback?: boolean;
  text?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CTX_DIR = ".ctx";
const DB_FILENAME = "index.db";
const SNIPPET_MAX_LENGTH = 200;

const FALLBACK_NOTICE =
  "No LLM provider configured. Set CTX_GEMINI_KEY, CTX_OPENAI_KEY, or CTX_ANTHROPIC_KEY. Running basic search instead.";

// ── Provider detection ───────────────────────────────────────────────────────

const PROVIDER_ENV_MAP: Record<string, string> = {
  gemini: "CTX_GEMINI_KEY",
  openai: "CTX_OPENAI_KEY",
  anthropic: "CTX_ANTHROPIC_KEY",
};

const PROVIDER_FACTORIES: Record<string, (key: string) => LLMProvider> = {
  gemini: createGeminiProvider,
  openai: createOpenAIProvider,
  anthropic: createAnthropicProvider,
};

const DETECTION_ORDER = ["gemini", "openai", "anthropic"];

/** Auto-detect LLM provider from env vars (CTX_GEMINI_KEY → CTX_OPENAI_KEY → CTX_ANTHROPIC_KEY). */
export function detectProvider(explicit?: string): LLMProvider | null {
  if (explicit) {
    const envVar = PROVIDER_ENV_MAP[explicit];
    const apiKey = envVar ? process.env[envVar] : undefined;
    if (!apiKey) return null;
    const factory = PROVIDER_FACTORIES[explicit];
    return factory ? factory(apiKey) : null;
  }

  for (const name of DETECTION_ORDER) {
    const envVar = PROVIDER_ENV_MAP[name];
    const apiKey = envVar ? process.env[envVar] : undefined;
    if (apiKey) {
      const factory = PROVIDER_FACTORIES[name];
      if (factory) return factory(apiKey);
    }
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateSnippet(text: string): string {
  const oneLine = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (oneLine.length <= SNIPPET_MAX_LENGTH) return oneLine;
  return oneLine.slice(0, SNIPPET_MAX_LENGTH) + "...";
}

function toOutputResult(r: SearchResult): AskOutputResult {
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

function formatTextOutput(output: AskOutput): string {
  const lines: string[] = [];

  if (output.fallback) {
    lines.push(FALLBACK_NOTICE);
    lines.push("");
  }

  if (output.interpretation) {
    lines.push(`Understanding: ${output.interpretation}`);
    lines.push("");
  }

  if (output.results.length === 0) {
    lines.push(`No results found for "${output.query}"`);
  } else {
    lines.push(`Found ${output.results.length} relevant location(s):`);
    lines.push("");

    for (let i = 0; i < output.results.length; i++) {
      const r = output.results[i];
      const nameLabel = r.name ? `${r.name} [${r.type}]` : `[${r.type}]`;
      lines.push(`${i + 1}. ${r.file}:${r.lines[0]}-${r.lines[1]} (score: ${r.score})`);
      lines.push(`   ${nameLabel}`);
      lines.push(`   ${r.snippet}`);
      lines.push("");
    }
  }

  if (output.explanation) {
    lines.push("Explanation:");
    lines.push(output.explanation);
    lines.push("");
  }

  lines.push("─────────");
  const cost = output.stats.costEstimate.toFixed(4);
  lines.push(
    `Tokens: ${output.stats.tokensUsed.toLocaleString()} | Cost: ~$${cost} | Strategies: ${output.stats.strategies.join(", ")}`,
  );

  return lines.join("\n");
}

// ── Search executor factory ──────────────────────────────────────────────────

function createSearchExecutor(db: KontextDatabase): SearchExecutor {
  return async (strategies: StrategyPlan[], limit: number): Promise<SearchResult[]> => {
    const strategyResults: StrategyResult[] = [];
    const fetchLimit = limit * 3;

    for (const plan of strategies) {
      const results = await executeStrategy(db, plan, fetchLimit);
      if (results.length > 0) {
        strategyResults.push({
          strategy: plan.strategy,
          weight: plan.weight,
          results,
        });
      }
    }

    return fusionMerge(strategyResults, limit);
  };
}

async function executeStrategy(
  db: KontextDatabase,
  plan: StrategyPlan,
  limit: number,
): Promise<SearchResult[]> {
  switch (plan.strategy) {
    case "vector": {
      const embedder = await loadEmbedder();
      return vectorSearch(db, embedder, plan.query, limit);
    }
    case "fts":
      return ftsSearch(db, plan.query, limit);
    case "ast":
      return astSearch(db, { name: plan.query }, limit);
    case "path":
      return pathSearch(db, plan.query, limit);
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

// ── Fallback search (no LLM) ────────────────────────────────────────────────

async function fallbackSearch(
  db: KontextDatabase,
  query: string,
  limit: number,
): Promise<AskOutput> {
  const executor = createSearchExecutor(db);
  const fallbackStrategies: StrategyPlan[] = [
    { strategy: "fts", query, weight: 0.8, reason: "fallback keyword search" },
    { strategy: "ast", query, weight: 0.9, reason: "fallback structural search" },
  ];

  const results = await executor(fallbackStrategies, limit);

  return {
    query,
    interpretation: "",
    results: results.map(toOutputResult),
    explanation: "",
    stats: {
      strategies: fallbackStrategies.map((s) => s.strategy),
      tokensUsed: 0,
      costEstimate: 0,
      totalResults: results.length,
    },
    fallback: true,
  };
}

// ── Main ask function ────────────────────────────────────────────────────────

/** LLM-steered natural language search. Falls back to basic multi-strategy search without API key. */
export async function runAsk(
  projectPath: string,
  query: string,
  options: AskOptions,
): Promise<AskOutput> {
  const absoluteRoot = path.resolve(projectPath);
  const dbPath = path.join(absoluteRoot, CTX_DIR, DB_FILENAME);

  if (!fs.existsSync(dbPath)) {
    throw new KontextError(
      `Project not initialized. Run "ctx init" first. (${CTX_DIR}/${DB_FILENAME} not found)`,
      ErrorCode.NOT_INITIALIZED,
    );
  }

  const db = createDatabase(dbPath);

  try {
    const provider = options.provider ?? null;

    if (!provider) {
      const output = await fallbackSearch(db, query, options.limit);
      if (options.format === "text") {
        output.text = formatTextOutput(output);
      }
      return output;
    }

    const executor = createSearchExecutor(db);

    if (options.noExplain) {
      return await runNoExplain(provider, query, options, executor);
    }

    return await runWithSteering(provider, query, options, executor);
  } finally {
    db.close();
  }
}

async function runNoExplain(
  provider: LLMProvider,
  query: string,
  options: AskOptions,
  executor: SearchExecutor,
): Promise<AskOutput> {
  const plan = await planSearch(provider, query);
  const results = await executor(plan.strategies, options.limit);

  const output: AskOutput = {
    query,
    interpretation: plan.interpretation,
    results: results.map(toOutputResult),
    explanation: "",
    stats: {
      strategies: plan.strategies.map((s) => s.strategy),
      tokensUsed: 0,
      costEstimate: 0,
      totalResults: results.length,
    },
  };

  if (options.format === "text") {
    output.text = formatTextOutput(output);
  }

  return output;
}

async function runWithSteering(
  provider: LLMProvider,
  query: string,
  options: AskOptions,
  executor: SearchExecutor,
): Promise<AskOutput> {
  const result = await steer(provider, query, options.limit, executor);

  const output: AskOutput = {
    query,
    interpretation: result.interpretation,
    results: result.results.map(toOutputResult),
    explanation: result.explanation,
    stats: {
      strategies: result.strategies.map((s) => s.strategy),
      tokensUsed: result.tokensUsed,
      costEstimate: result.costEstimate,
      totalResults: result.results.length,
    },
  };

  if (options.format === "text") {
    output.text = formatTextOutput(output);
  }

  return output;
}

// ── CLI registration ─────────────────────────────────────────────────────────

export function registerAskCommand(program: Command): void {
  program
    .command("ask <query>")
    .description("LLM-steered natural language code search")
    .option("-l, --limit <n>", "Max results", "10")
    .option("-p, --provider <name>", "LLM provider: gemini|openai|anthropic")
    .option("-f, --format <fmt>", "Output format: json|text", "text")
    .option("--no-explain", "Skip explanation, just return search results")
    .action(async (query: string, opts: Record<string, string | boolean>) => {
      const projectPath = process.cwd();
      const verbose = program.opts()["verbose"] === true;
      const logger = createLogger({ level: verbose ? LogLevel.DEBUG : LogLevel.INFO });
      const providerName = opts["provider"] as string | undefined;
      const provider = detectProvider(providerName);

      try {
        const output = await runAsk(projectPath, query, {
          limit: parseInt(String(opts["limit"] ?? "10"), 10),
          format: (opts["format"] ?? "text") as "json" | "text",
          provider: provider ?? undefined,
          noExplain: opts["explain"] === false,
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
