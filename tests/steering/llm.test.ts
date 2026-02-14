import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createGeminiProvider,
  createOpenAIProvider,
  createAnthropicProvider,
  planSearch,
  synthesizeExplanation,
  steer,
} from "../../src/steering/llm.js";
import type { LLMProvider, StrategyPlan, SteeringResult } from "../../src/steering/llm.js";
import type { SearchResult } from "../../src/search/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(
  chunkId: number,
  name: string,
  score = 0.9,
): SearchResult {
  return {
    chunkId,
    filePath: `src/${name}.ts`,
    lineStart: 1,
    lineEnd: 10,
    name,
    type: "function",
    text: `function ${name}() { /* implementation */ }`,
    score,
    language: "typescript",
  };
}

function makePlan(overrides: Partial<StrategyPlan> = {}): StrategyPlan {
  return {
    strategy: "fts",
    query: "auth",
    weight: 1.0,
    reason: "full-text match",
    ...overrides,
  };
}

// ── Mock fetch ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(body: unknown, status = 200): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ── Gemini provider ──────────────────────────────────────────────────────────

describe("createGeminiProvider", () => {
  it("has correct name", () => {
    const provider = createGeminiProvider("test-key");
    expect(provider.name).toBe("gemini");
  });

  it("makes correct API call", async () => {
    mockFetch({
      candidates: [
        { content: { parts: [{ text: "Hello from Gemini" }] } },
      ],
    });

    const provider = createGeminiProvider("test-key");
    const result = await provider.chat([
      { role: "user", content: "Hello" },
    ]);

    expect(result).toBe("Hello from Gemini");
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    const [url, opts] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("key=test-key");
    expect(opts?.method).toBe("POST");
    expect(JSON.parse(opts?.body as string)).toHaveProperty("contents");
  });

  it("throws on API error", async () => {
    mockFetch({ error: { message: "Invalid key" } }, 401);

    const provider = createGeminiProvider("bad-key");
    await expect(
      provider.chat([{ role: "user", content: "Hello" }]),
    ).rejects.toThrow(/Gemini API error/);
  });
});

// ── OpenAI provider ──────────────────────────────────────────────────────────

describe("createOpenAIProvider", () => {
  it("has correct name", () => {
    const provider = createOpenAIProvider("test-key");
    expect(provider.name).toBe("openai");
  });

  it("makes correct API call", async () => {
    mockFetch({
      choices: [{ message: { content: "Hello from OpenAI" } }],
      usage: { total_tokens: 42 },
    });

    const provider = createOpenAIProvider("test-key");
    const result = await provider.chat([
      { role: "user", content: "Hello" },
    ]);

    expect(result).toBe("Hello from OpenAI");
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    const [url, opts] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(opts?.method).toBe("POST");

    const headers = opts?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");

    const body = JSON.parse(opts?.body as string);
    expect(body.model).toBe("gpt-5-mini");
    expect(body.messages).toHaveLength(1);
  });

  it("throws on API error", async () => {
    mockFetch({ error: { message: "Rate limited" } }, 429);

    const provider = createOpenAIProvider("test-key");
    await expect(
      provider.chat([{ role: "user", content: "Hello" }]),
    ).rejects.toThrow(/OpenAI API error/);
  });
});

// ── Anthropic provider ───────────────────────────────────────────────────────

describe("createAnthropicProvider", () => {
  it("has correct name", () => {
    const provider = createAnthropicProvider("test-key");
    expect(provider.name).toBe("anthropic");
  });

  it("makes correct API call", async () => {
    mockFetch({
      content: [{ type: "text", text: "Hello from Anthropic" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const provider = createAnthropicProvider("test-key");
    const result = await provider.chat([
      { role: "user", content: "Hello" },
    ]);

    expect(result).toBe("Hello from Anthropic");
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    const [url, opts] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(opts?.method).toBe("POST");

    const headers = opts?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(opts?.body as string);
    expect(body.model).toBe("claude-3-5-haiku-20241022");
    expect(body.messages).toHaveLength(1);
  });

  it("throws on API error", async () => {
    mockFetch({ error: { message: "Bad request" } }, 400);

    const provider = createAnthropicProvider("test-key");
    await expect(
      provider.chat([{ role: "user", content: "Hello" }]),
    ).rejects.toThrow(/Anthropic API error/);
  });
});

// ── planSearch ────────────────────────────────────────────────────────────────

describe("planSearch", () => {
  it("extracts strategies from LLM response", async () => {
    const plan: StrategyPlan[] = [
      {
        strategy: "vector",
        query: "authentication middleware",
        weight: 1.0,
        reason: "Conceptual query needs semantic search",
      },
      {
        strategy: "ast",
        query: "authenticate",
        weight: 0.9,
        reason: "Likely function name",
      },
    ];

    const mockProvider: LLMProvider = {
      name: "mock",
      chat: vi.fn().mockResolvedValue(JSON.stringify({
        interpretation: "Looking for auth middleware",
        strategies: plan,
      })),
    };

    const result = await planSearch(mockProvider, "how does authentication work");

    expect(result.interpretation).toBe("Looking for auth middleware");
    expect(result.strategies).toHaveLength(2);
    expect(result.strategies[0].strategy).toBe("vector");
    expect(result.strategies[1].strategy).toBe("ast");
    expect(mockProvider.chat).toHaveBeenCalledOnce();
  });

  it("handles malformed LLM response with fallback", async () => {
    const mockProvider: LLMProvider = {
      name: "mock",
      chat: vi.fn().mockResolvedValue("This is not valid JSON at all"),
    };

    const result = await planSearch(mockProvider, "find the auth handler");

    // Should fallback to default strategies
    expect(result.strategies.length).toBeGreaterThan(0);
    expect(result.interpretation).toBeTruthy();
  });
});

// ── synthesizeExplanation ────────────────────────────────────────────────────

describe("synthesizeExplanation", () => {
  it("produces explanation from search results", async () => {
    const mockProvider: LLMProvider = {
      name: "mock",
      chat: vi.fn().mockResolvedValue(
        "Found 2 functions related to authentication in src/auth.ts.",
      ),
    };

    const results = [makeResult(1, "validateToken"), makeResult(2, "createToken")];
    const explanation = await synthesizeExplanation(
      mockProvider,
      "auth functions",
      results,
    );

    expect(explanation).toContain("authentication");
    expect(mockProvider.chat).toHaveBeenCalledOnce();
  });
});

// ── steer (integration) ──────────────────────────────────────────────────────

describe("steer", () => {
  it("runs full pipeline: plan → search → synthesize", async () => {
    const plan: StrategyPlan[] = [
      makePlan({ strategy: "fts", query: "validateToken", weight: 1.0 }),
    ];

    const mockProvider: LLMProvider = {
      name: "mock",
      chat: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          interpretation: "Looking for token validation",
          strategies: plan,
        }))
        .mockResolvedValueOnce("Found validateToken function in auth module."),
    };

    const mockResults = [makeResult(1, "validateToken")];

    // Mock the search executor
    const mockSearchExecutor = vi.fn().mockResolvedValue(mockResults);

    const result: SteeringResult = await steer(
      mockProvider,
      "how does token validation work",
      10,
      mockSearchExecutor,
    );

    expect(result.interpretation).toBe("Looking for token validation");
    expect(result.strategies).toHaveLength(1);
    expect(result.results).toHaveLength(1);
    expect(result.explanation).toContain("validateToken");
    expect(typeof result.tokensUsed).toBe("number");
    expect(typeof result.costEstimate).toBe("number");
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
    expect(mockSearchExecutor).toHaveBeenCalledOnce();
  });

  it("tracks token usage", async () => {
    const mockProvider: LLMProvider = {
      name: "mock",
      chat: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          interpretation: "test",
          strategies: [makePlan()],
        }))
        .mockResolvedValueOnce("Explanation here."),
    };

    const result = await steer(
      mockProvider,
      "test query",
      10,
      vi.fn().mockResolvedValue([]),
    );

    expect(result.tokensUsed).toBeGreaterThanOrEqual(0);
    expect(result.costEstimate).toBeGreaterThanOrEqual(0);
  });

  it("works with fallback when LLM planning fails", async () => {
    const mockProvider: LLMProvider = {
      name: "mock",
      chat: vi.fn()
        .mockRejectedValueOnce(new Error("API down"))
        .mockResolvedValueOnce("Best effort explanation."),
    };

    const mockResults = [makeResult(1, "handler")];
    const mockSearchExecutor = vi.fn().mockResolvedValue(mockResults);

    const result = await steer(
      mockProvider,
      "find handler",
      10,
      mockSearchExecutor,
    );

    // Should still produce results using fallback plan
    expect(result.results).toHaveLength(1);
    expect(result.strategies.length).toBeGreaterThan(0);
    expect(mockSearchExecutor).toHaveBeenCalledOnce();
  });
});
