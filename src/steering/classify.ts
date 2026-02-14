import type { StrategyName } from "../search/fusion.js";

export type QueryKind = "symbol" | "path" | "natural_language" | "keyword";

export interface QueryClassification {
  kind: QueryKind;
  multipliers: Record<StrategyName, number>;
}

const SYMBOL_CAMEL_RE = /^[a-z][a-zA-Z0-9]*$/;
const SYMBOL_PASCAL_RE = /^[A-Z][a-zA-Z0-9]*$/;
const SYMBOL_SNAKE_RE = /^[a-z]+(?:_[a-z]+)+$/;
const SYMBOL_UPPER_RE = /^[A-Z]+(?:_[A-Z]+)*$/;

const PATH_EXTENSION_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|hpp|json|yaml|yml|toml|md|sql|sh|bash)$/i;

const QUESTION_WORDS = new Set([
  "how",
  "what",
  "where",
  "why",
  "when",
  "which",
  "show",
  "explain",
  "find",
  "list",
]);

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "to",
  "for",
  "of",
  "in",
  "on",
  "with",
  "by",
  "and",
  "or",
]);

function defaultMultipliers(): Record<StrategyName, number> {
  return {
    vector: 1.0,
    fts: 1.0,
    ast: 1.0,
    path: 1.0,
    dependency: 1.0,
  };
}

function isSymbolQuery(query: string): boolean {
  return (
    SYMBOL_CAMEL_RE.test(query) ||
    SYMBOL_PASCAL_RE.test(query) ||
    SYMBOL_SNAKE_RE.test(query) ||
    SYMBOL_UPPER_RE.test(query)
  );
}

function isPathQuery(query: string): boolean {
  return query.includes("/") || PATH_EXTENSION_RE.test(query);
}

function isNaturalLanguageQuery(query: string): boolean {
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 0);
  const hasQuestionWord = words.some((w) => QUESTION_WORDS.has(w));
  const hasStopWord = words.some((w) => STOP_WORDS.has(w));

  return hasQuestionWord || (words.length >= 4 && hasStopWord);
}

export function classifyQuery(query: string): QueryClassification {
  const trimmed = query.trim();
  const multipliers = defaultMultipliers();

  if (isPathQuery(trimmed)) {
    multipliers.path = 2.0;
    multipliers.ast = 0.5;
    return { kind: "path", multipliers };
  }

  if (isSymbolQuery(trimmed)) {
    multipliers.ast = 1.5;
    multipliers.vector = 0.5;
    return { kind: "symbol", multipliers };
  }

  if (isNaturalLanguageQuery(trimmed)) {
    multipliers.vector = 1.5;
    multipliers.path = 1.2;
    multipliers.ast = 0.7;
    return { kind: "natural_language", multipliers };
  }

  return { kind: "keyword", multipliers };
}
