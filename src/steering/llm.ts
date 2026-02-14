import type { SearchResult } from "../search/types.js";
import type { StrategyName } from "../search/fusion.js";

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
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const PLAN_SYSTEM_PROMPT = `You are a code search strategy planner. Given a user query about code, output a JSON object with:
- "interpretation": a one-line summary of what the user is looking for
- "strategies": an array of search strategy objects, each with:
  - "strategy": one of "vector", "fts", "ast", "path", "dependency"
  - "query": the optimized query string for that strategy
  - "weight": a number 0-1 indicating importance
  - "reason": brief explanation of why this strategy is used

Choose strategies based on query type:
- Conceptual/natural language → vector (semantic search)
- Keywords/identifiers → fts (full-text search)
- Symbol names (functions, classes) → ast (structural search)
- File paths or patterns → path (path glob search)
- Import/dependency chains → dependency

Output ONLY valid JSON, no markdown.`;

const SYNTHESIZE_SYSTEM_PROMPT = `You are a code search assistant. Given search results, write a brief, helpful explanation of what was found. Be concise (2-4 sentences). Reference specific files and function names. Do not use markdown.`;

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
      const response = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-5-mini",
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as {
        choices: { message: { content: string } }[];
      };

      return data.choices[0].message.content;
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
        max_tokens: 1024,
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

// ── Plan step ────────────────────────────────────────────────────────────────

const VALID_STRATEGIES = new Set<string>([
  "vector",
  "fts",
  "ast",
  "path",
  "dependency",
]);

function buildFallbackPlan(query: string): SearchPlan {
  const strategies: StrategyPlan[] = [
    { strategy: "fts", query, weight: 0.8, reason: "Full-text keyword search" },
    { strategy: "ast", query, weight: 0.9, reason: "Structural symbol search" },
  ];

  return {
    interpretation: `Searching for: ${query}`,
    strategies,
  };
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
