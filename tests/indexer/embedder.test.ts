import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Embedder } from "../../src/indexer/embedder.js";
import {
  createLocalEmbedder,
  createVoyageEmbedder,
  createOpenAIEmbedder,
  normalizeVector,
  cosineSimilarity,
  prepareChunkText,
} from "../../src/indexer/embedder.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function l2Norm(vec: Float32Array): number {
  let sum = 0;
  for (const v of vec) sum += v * v;
  return Math.sqrt(sum);
}

// ── normalizeVector ──────────────────────────────────────────────────────────

describe("normalizeVector", () => {
  it("normalizes a vector to unit length", () => {
    const vec = new Float32Array([3, 4]);
    const norm = normalizeVector(vec);
    expect(l2Norm(norm)).toBeCloseTo(1.0, 5);
    expect(norm[0]).toBeCloseTo(0.6, 5);
    expect(norm[1]).toBeCloseTo(0.8, 5);
  });

  it("handles zero vector gracefully", () => {
    const vec = new Float32Array([0, 0, 0]);
    const norm = normalizeVector(vec);
    expect(norm).toEqual(new Float32Array([0, 0, 0]));
  });
});

// ── cosineSimilarity ─────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical normalized vectors", () => {
    const v = normalizeVector(new Float32Array([1, 2, 3]));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns ~0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });
});

// ── prepareChunkText ─────────────────────────────────────────────────────────

describe("prepareChunkText", () => {
  it("combines file path, parent context, and chunk text", () => {
    const result = prepareChunkText("src/auth.ts", "AuthService", "async signToken() {}");
    expect(result).toContain("src/auth.ts");
    expect(result).toContain("AuthService");
    expect(result).toContain("signToken");
  });

  it("works without parent context", () => {
    const result = prepareChunkText("src/utils.ts", null, "function hello() {}");
    expect(result).toContain("src/utils.ts");
    expect(result).toContain("hello");
    expect(result).not.toContain("null");
  });
});

// ── Local embedder (integration — loads real model) ──────────────────────────

describe("createLocalEmbedder", () => {
  let embedder: Embedder;

  // Loading the model may take a while on first run
  beforeEach(async () => {
    embedder = await createLocalEmbedder();
  }, 120_000);

  it("has correct name and dimensions", () => {
    expect(embedder.name).toBe("all-MiniLM-L6-v2");
    expect(embedder.dimensions).toBe(384);
  });

  it("produces correct-dimension vectors", async () => {
    const vec = await embedder.embedSingle("function greet(name) { return name; }");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
  });

  it("produces normalized vectors (L2 norm ≈ 1.0)", async () => {
    const vec = await embedder.embedSingle("const x = 42;");
    const norm = l2Norm(vec);
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it("handles batch embedding (multiple texts at once)", async () => {
    const texts = [
      "function add(a, b) { return a + b; }",
      "class UserService { findUser(id) {} }",
      "import express from 'express';",
    ];
    const vectors = await embedder.embed(texts);
    expect(vectors).toHaveLength(3);
    for (const vec of vectors) {
      expect(vec.length).toBe(384);
      expect(l2Norm(vec)).toBeCloseTo(1.0, 3);
    }
  });

  it("produces similar vectors for similar code", async () => {
    const vec1 = await embedder.embedSingle(
      "function add(a, b) { return a + b; }",
    );
    const vec2 = await embedder.embedSingle(
      "function sum(x, y) { return x + y; }",
    );
    const sim = cosineSimilarity(vec1, vec2);
    expect(sim).toBeGreaterThan(0.7);
  });

  it("produces different vectors for different code", async () => {
    const vec1 = await embedder.embedSingle(
      "function add(a, b) { return a + b; }",
    );
    const vec2 = await embedder.embedSingle(
      "import { readFile } from 'node:fs/promises';",
    );
    const sim = cosineSimilarity(vec1, vec2);
    expect(sim).toBeLessThan(0.5);
  });
}, 120_000);

// ── Voyage embedder (mocked HTTP) ────────────────────────────────────────────

describe("createVoyageEmbedder", () => {
  let embedder: Embedder;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    embedder = createVoyageEmbedder("test-voyage-key");
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("has correct name and dimensions", () => {
    expect(embedder.name).toBe("voyage-code-3");
    expect(embedder.dimensions).toBe(1024);
  });

  it("calls Voyage API with correct payload", async () => {
    const fakeEmbedding = new Array(1024).fill(0.01);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: fakeEmbedding }],
      }),
    });

    const result = await embedder.embedSingle("function hello() {}");
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string) as {
      model: string;
      input: string[];
      input_type: string;
      output_dimension: number;
    };
    expect(body.model).toBe("voyage-code-3");
    expect(body.input).toEqual(["function hello() {}"]);
    expect(body.input_type).toBe("query");
    expect(body.output_dimension).toBe(1024);

    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-voyage-key");

    expect(result.length).toBe(1024);
  });

  it("handles batch embedding", async () => {
    const fakeEmbedding = new Array(1024).fill(0.01);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: fakeEmbedding }, { embedding: fakeEmbedding }],
      }),
    });

    const results = await embedder.embed(["text1", "text2"]);
    expect(results).toHaveLength(2);
  });

  it("retries on 429 rate limit", async () => {
    const fakeEmbedding = new Array(1024).fill(0.01);

    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: fakeEmbedding }],
        }),
      });

    const result = await embedder.embedSingle("test");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.length).toBe(1024);
  });

  it("throws after max retries", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });

    await expect(embedder.embedSingle("test")).rejects.toThrow();
    // Should attempt multiple times
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });
});

// ── OpenAI embedder (mocked HTTP) ────────────────────────────────────────────

describe("createOpenAIEmbedder", () => {
  let embedder: Embedder;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    embedder = createOpenAIEmbedder("test-openai-key");
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("has correct name and dimensions", () => {
    expect(embedder.name).toBe("text-embedding-3-large");
    expect(embedder.dimensions).toBe(1024);
  });

  it("calls OpenAI API with correct payload", async () => {
    const fakeEmbedding = new Array(1024).fill(0.01);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: fakeEmbedding }],
      }),
    });

    const result = await embedder.embedSingle("function test() {}");
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string) as {
      model: string;
      input: string[];
      dimensions: number;
    };
    expect(body.model).toBe("text-embedding-3-large");
    expect(body.input).toEqual(["function test() {}"]);
    expect(body.dimensions).toBe(1024);

    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-openai-key");

    expect(result.length).toBe(1024);
  });

  it("retries on 429 rate limit", async () => {
    const fakeEmbedding = new Array(1024).fill(0.01);

    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: fakeEmbedding }],
        }),
      });

    const result = await embedder.embedSingle("test");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.length).toBe(1024);
  });
});

// ── Progress callback ────────────────────────────────────────────────────────

describe("progress callback", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("fires with correct counts on API embedder batch", async () => {
    const embedder = createVoyageEmbedder("test-key");
    const fakeEmbedding = new Array(1024).fill(0.01);

    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: fakeEmbedding },
          { embedding: fakeEmbedding },
          { embedding: fakeEmbedding },
        ],
      }),
    });

    const progress: { done: number; total: number }[] = [];
    await embedder.embed(["a", "b", "c"], (done, total) => {
      progress.push({ done, total });
    });

    expect(progress.length).toBeGreaterThan(0);
    const last = progress[progress.length - 1];
    expect(last.done).toBe(3);
    expect(last.total).toBe(3);
  });
});
