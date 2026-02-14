import type { SearchResult } from "../search/types.js";
import type { StrategyName } from "../search/fusion.js";
import { PLAN_SYSTEM_PROMPT, SYNTHESIZE_SYSTEM_PROMPT } from "./prompts.js";
import { classifyQuery } from "./classify.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** LLM provider for the steering layer. Wraps Gemini, OpenAI, or Anthropic chat APIs. */
export interface LLMProvider {
  name: string;
  chat(messages: ChatMessage[]): Promise<string>;
}

export interface StrategyPlan {
  strategy: StrategyName;
  query: string;
  weight: number;
  reason: string;
}

export interface SearchPlan {
  interpretation: string;
  strategies: StrategyPlan[];
}

/** Full result from LLM-steered search: plan, results, explanation, and cost. */
export interface SteeringResult {
  interpretation: string;
  strategies: StrategyPlan[];
  results: SearchResult[];
  explanation: string;
  tokensUsed: number;
  costEstimate: number;
}

export type SearchExecutor = (
  strategies: StrategyPlan[],
  limit: number,
) => Promise<SearchResult[]>;

// ── Constants ────────────────────────────────────────────────────────────────

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
const OPENAI_URL = "https://api.openai.com/v1/responses";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Re-export prompts so consumers that already import from llm.ts keep working.
export { PLAN_SYSTEM_PROMPT, SYNTHESIZE_SYSTEM_PROMPT } from "./prompts.js";

// ── Gemini provider ──────────────────────────────────────────────────────────

export function createGeminiProvider(apiKey: string): LLMProvider {
  return {
    name: "gemini",
    async chat(messages: ChatMessage[]): Promise<string> {
      const contents = messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      const systemInstruction = messages.find((m) => m.role === "system");
      const nonSystemContents = contents.filter(
        (_, i) => messages[i].role !== "system",
      );

      const body: Record<string, unknown> = {
        contents: nonSystemContents,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 6000,
        },
      };

      if (systemInstruction) {
        body["systemInstruction"] = {
          parts: [{ text: systemInstruction.content }],
        };
      }

      const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as {
        candidates: { content: { parts: { text: string }[] } }[];
      };

      return data.candidates[0].content.parts[0].text;
    },
  };
}

// ── OpenAI provider ──────────────────────────────────────────────────────────

export function createOpenAIProvider(apiKey: string): LLMProvider {
  return {
    name: "openai",
    async chat(messages: ChatMessage[]): Promise<string> {
      const systemMessage = messages.find((m) => m.role === "system");
      const userMessages = messages.filter((m) => m.role !== "system");
      const userInput = userMessages.map((m) => m.content).join("\n\n");

      const body: Record<string, unknown> = {
        model: "gpt-5-mini",
        input: userInput,
        max_output_tokens: 6000,
        reasoning: { effort: "low" },
      };

      if (systemMessage) {
        body["instructions"] = systemMessage.content;
      }

      const response = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as { output_text: string };

      return data.output_text;
    },
  };
}

// ── Anthropic provider ───────────────────────────────────────────────────────

export function createAnthropicProvider(apiKey: string): LLMProvider {
  return {
    name: "anthropic",
    async chat(messages: ChatMessage[]): Promise<string> {
      const systemMessage = messages.find((m) => m.role === "system");
      const nonSystemMessages = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      const body: Record<string, unknown> = {
        model: "claude-3-5-haiku-20241022",
        max_tokens: 6000,
        temperature: 0.1,
        messages: nonSystemMessages,
      };

      if (systemMessage) {
        body["system"] = systemMessage.content;
      }

      const response = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Anthropic API error (${response.status}): ${errorText}`,
        );
      }

      const data = (await response.json()) as {
        content: { type: string; text: string }[];
      };

      return data.content[0].text;
    },
  };
}

// ── Keyword extraction ───────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // Interrogatives & conjunctions
  "how", "does", "what", "where", "when", "why", "which", "who", "whom",
  // Be-verbs
  "is", "are", "was", "were", "be", "been", "being",
  // Do-verbs
  "do", "did", "doing", "done",
  // Articles, connectors, prepositions
  "the", "a", "an", "and", "or", "not", "no", "nor",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "about",
  "into", "through", "between", "after", "before", "during",
  // Pronouns & demonstratives
  "it", "its", "this", "that", "these", "those",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
  // Modals
  "can", "could", "should", "would", "will", "shall", "may", "might",
  // Have-verbs
  "has", "have", "had", "having",
  // Common imperative verbs that carry no search value
  "find", "show", "get", "tell", "look", "give", "list", "explain",
  // Misc filler
  "all", "any", "some", "each", "every", "much", "many", "also",
  "just", "like", "then", "there", "here", "very", "really",
  "use", "used", "using",
]);

/** Pattern: tokens that look like code identifiers (camelCase, PascalCase, snake_case, UPPER_CASE). */
const CODE_IDENT_RE = /^(?:[a-z]+(?:[A-Z][a-z]*)+|[A-Z][a-zA-Z]+|[a-z]+(?:_[a-z]+)+|[A-Z]+(?:_[A-Z]+)+)$/;

/** Pattern: dotted module paths like "fs.readFileSync" or "path.join". */
const DOTTED_IDENT_RE = /[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)+/g;

const COMMON_STEMS: Record<string, string> = {
  authentication: "auth",
  authorization: "auth",
  configuration: "config",
  initialization: "init",
  initialize: "init",
  initializing: "init",
  implementation: "impl",
  implements: "impl",
  implementing: "impl",
  dependency: "dep",
  dependencies: "dep",
  middleware: "middleware",
  validation: "valid",
  validator: "valid",
  serialize: "serial",
  serialization: "serial",
  deserialize: "deserial",
  database: "db",
  logging: "log",
  logger: "log",
  testing: "test",
  handler: "handle",
  handling: "handle",
  callback: "callback",
  subscriber: "subscribe",
  subscription: "subscribe",
  rendering: "render",
  renderer: "render",
  transformer: "transform",
  transformation: "transform",
  connection: "connect",
  connector: "connect",
  migration: "migrate",
  scheduling: "schedule",
  scheduler: "schedule",
  parsing: "parse",
  parser: "parse",
  routing: "route",
  router: "route",
  indexing: "index",
  indexer: "index",
};

const STEM_SUFFIXES = [
  "tion",
  "sion",
  "ment",
  "ness",
  "ing",
  "er",
  "or",
  "able",
  "ible",
  "ity",
  "ous",
  "ive",
  "ful",
  "less",
  "ly",
];

function getStemVariant(term: string): string | null {
  const lower = term.toLowerCase();
  const mapped = COMMON_STEMS[lower];
  if (mapped && mapped !== lower) return mapped;

  if (!/^[a-z][a-z0-9_]*$/.test(lower)) return null;

  for (const suffix of STEM_SUFFIXES) {
    if (!lower.endsWith(suffix)) continue;
    const stem = lower.slice(0, -suffix.length);
    if (stem.length >= 4 && stem !== lower) {
      return stem;
    }
  }

  return null;
}

/**
 * Extract meaningful search terms from a natural language query.
 *
 * Handles:
 * - Natural language stop-word removal
 * - Preservation of code identifiers (camelCase, snake_case, PascalCase)
 * - Dotted paths (e.g. "fs.readFileSync") kept intact
 * - Slash-separated file paths kept intact
 * - Deduplication while preserving order
 */
export function extractSearchTerms(query: string): string {
  const terms: string[] = [];
  const seen = new Set<string>();

  const addUnique = (term: string): void => {
    const key = term.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(term);
    }
  };

  const addTermAndVariants = (term: string): void => {
    addUnique(term);
    const variant = getStemVariant(term);
    if (variant && variant !== term.toLowerCase()) {
      addUnique(variant);
    }
  };

  // 1. Extract dotted identifiers before they get split (e.g. "fs.readFileSync")
  const dottedMatches = query.match(DOTTED_IDENT_RE) ?? [];
  for (const m of dottedMatches) addTermAndVariants(m);

  // 2. Extract path-like tokens (contain "/")
  const pathTokens = query.split(/\s+/).filter((t) => t.includes("/"));
  for (const p of pathTokens) addTermAndVariants(p.replace(/[?!,;]+$/g, ""));

  // 3. Tokenise the rest: replace special chars (but keep _ for identifiers) and split
  const words = query
    .replace(/[^a-zA-Z0-9_.\s/-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  for (const w of words) {
    const lower = w.toLowerCase();
    // Skip if already captured as dotted or path
    if (seen.has(lower)) continue;
    // Skip stop words — but only when the token is NOT a code identifier
    if (STOP_WORDS.has(lower) && !CODE_IDENT_RE.test(w)) continue;
    addTermAndVariants(w);
  }

  // 4. Fallback: if everything was filtered, take the longest original word
  if (terms.length === 0) {
    const allWords = query
      .replace(/[^a-zA-Z0-9_\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    const longest = allWords.sort((a, b) => b.length - a.length)[0];
    return longest ?? query;
  }

  return terms.join(" ");
}

// ── Plan step ────────────────────────────────────────────────────────────────

const VALID_STRATEGIES = new Set<string>([
  "vector",
  "fts",
  "ast",
  "path",
  "dependency",
]);

function buildFallbackPlan(query: string): SearchPlan {
  const strategies = buildFallbackStrategies(query);
  return {
    interpretation: `Searching for: ${query}`,
    strategies,
  };
}

export function buildFallbackStrategies(query: string): StrategyPlan[] {
  const keywords = extractSearchTerms(query);
  const { multipliers } = classifyQuery(query);

  return [
    {
      strategy: "vector",
      query,
      weight: 1.0 * multipliers.vector,
      reason: "Semantic search over natural language intent",
    },
    {
      strategy: "fts",
      query: keywords,
      weight: 0.8 * multipliers.fts,
      reason: "Full-text keyword search",
    },
    {
      strategy: "ast",
      query: keywords,
      weight: 0.9 * multipliers.ast,
      reason: "Structural symbol search",
    },
    {
      strategy: "path",
      query: keywords,
      weight: 0.7 * multipliers.path,
      reason: "Path keyword search",
    },
  ];
}

function parseSearchPlan(raw: string, query: string): SearchPlan {
  // Try to extract JSON from the response (may contain markdown fences)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return buildFallbackPlan(query);

  const parsed = JSON.parse(jsonMatch[0]) as {
    interpretation?: string;
    strategies?: StrategyPlan[];
  };

  if (
    !parsed.interpretation ||
    !Array.isArray(parsed.strategies) ||
    parsed.strategies.length === 0
  ) {
    return buildFallbackPlan(query);
  }

  // Validate strategy names
  const validStrategies = parsed.strategies.filter((s) =>
    VALID_STRATEGIES.has(s.strategy),
  );

  if (validStrategies.length === 0) return buildFallbackPlan(query);

  return {
    interpretation: parsed.interpretation,
    strategies: validStrategies,
  };
}

/** Ask the LLM to interpret a query and plan which search strategies to use. */
export async function planSearch(
  provider: LLMProvider,
  query: string,
): Promise<SearchPlan> {
  try {
    const response = await provider.chat([
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      { role: "user", content: query },
    ]);

    return parseSearchPlan(response, query);
  } catch {
    return buildFallbackPlan(query);
  }
}

// ── Synthesize step ──────────────────────────────────────────────────────────

function formatResultsForLLM(results: SearchResult[]): string {
  return results
    .slice(0, 10)
    .map(
      (r, i) =>
        `${i + 1}. ${r.filePath}:${r.lineStart}-${r.lineEnd} ${r.name ?? "(unnamed)"} [${r.type}] (score: ${r.score.toFixed(2)})\n   ${r.text.slice(0, 150)}`,
    )
    .join("\n\n");
}

export async function synthesizeExplanation(
  provider: LLMProvider,
  query: string,
  results: SearchResult[],
): Promise<string> {
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const formattedResults = formatResultsForLLM(results);

  const response = await provider.chat([
    { role: "system", content: SYNTHESIZE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Query: "${query}"\n\nSearch results:\n${formattedResults}`,
    },
  ]);

  return response;
}

// ── Steer (full pipeline) ────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

/** Full steering pipeline: plan → search → synthesize. Falls back to basic search on failure. */
export async function steer(
  provider: LLMProvider,
  query: string,
  limit: number,
  searchExecutor: SearchExecutor,
): Promise<SteeringResult> {
  let totalTokens = 0;

  // Step 1: Plan
  const plan = await planSearch(provider, query);
  totalTokens += estimateTokens(PLAN_SYSTEM_PROMPT + query);
  totalTokens += estimateTokens(JSON.stringify(plan));

  // Step 2: Execute search
  const results = await searchExecutor(plan.strategies, limit);

  // Step 3: Synthesize
  let explanation: string;
  try {
    explanation = await synthesizeExplanation(provider, query, results);
    totalTokens += estimateTokens(SYNTHESIZE_SYSTEM_PROMPT + query);
    totalTokens += estimateTokens(explanation);
  } catch {
    explanation = results.length > 0
      ? `Found ${results.length} result(s) for "${query}".`
      : `No results found for "${query}".`;
  }

  // Rough cost estimate (assuming ~$0.15/1M input tokens for budget models)
  const costEstimate = (totalTokens / 1_000_000) * 0.15;

  return {
    interpretation: plan.interpretation,
    strategies: plan.strategies,
    results,
    explanation,
    tokensUsed: totalTokens,
    costEstimate,
  };
}
