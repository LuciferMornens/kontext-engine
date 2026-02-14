// ── Types ────────────────────────────────────────────────────────────────────

export type ProgressCallback = (done: number, total: number) => void;

export interface EmbeddingResult {
  chunkId: string;
  vector: Float32Array;
  dimensions: number;
}

/** Embedding provider: generates vector representations of text. */
export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  embed(
    texts: string[],
    onProgress?: ProgressCallback,
  ): Promise<Float32Array[]>;
  embedSingle(text: string): Promise<Float32Array>;
}

// ── Vector utilities ─────────────────────────────────────────────────────────

export function normalizeVector(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Text preparation ─────────────────────────────────────────────────────────

/** Format a chunk into embedding-friendly text with file path and name prefix. */
export function prepareChunkText(
  filePath: string,
  parent: string | null,
  text: string,
): string {
  const parts = [filePath];
  if (parent) parts.push(parent);
  parts.push(text);
  return parts.join("\n");
}

// ── Retry with exponential backoff ───────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);

    if (response.ok) return response;

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
      continue;
    }

    throw new Error(
      `Embedding API error: HTTP ${response.status} ${response.statusText}`,
    );
  }

  throw lastError ?? new Error("Embedding API request failed after retries");
}

// ── Local embedder (Xenova/all-MiniLM-L6-v2 via @huggingface/transformers) ──

const LOCAL_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const LOCAL_DIMENSIONS = 384;
const LOCAL_BATCH_SIZE = 32;

type FeatureExtractionPipeline = (
  texts: string | string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array }>;

let pipelineInstance: FeatureExtractionPipeline | null = null;

async function getLocalPipeline(): Promise<FeatureExtractionPipeline> {
  if (pipelineInstance) return pipelineInstance;

  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = getCacheDir();

  pipelineInstance = (await pipeline("feature-extraction", LOCAL_MODEL_ID, {
    dtype: "fp32",
  })) as unknown as FeatureExtractionPipeline;

  return pipelineInstance;
}

function getCacheDir(): string {
  const home =
    process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp";
  return `${home}/.cache/kontext/models`;
}

/** Create a local embedder using Xenova/all-MiniLM-L6-v2 (384 dims, ONNX Runtime). */
export async function createLocalEmbedder(): Promise<Embedder> {
  const pipe = await getLocalPipeline();

  return {
    name: "all-MiniLM-L6-v2",
    dimensions: LOCAL_DIMENSIONS,

    async embed(
      texts: string[],
      onProgress?: ProgressCallback,
    ): Promise<Float32Array[]> {
      const results: Float32Array[] = [];

      for (let i = 0; i < texts.length; i += LOCAL_BATCH_SIZE) {
        const batch = texts.slice(i, i + LOCAL_BATCH_SIZE);
        const output = await pipe(batch, {
          pooling: "mean",
          normalize: true,
        });

        // Output shape: [batchSize, dimensions]
        for (let j = 0; j < batch.length; j++) {
          const offset = j * LOCAL_DIMENSIONS;
          const vec = new Float32Array(
            output.data.buffer,
            output.data.byteOffset + offset * 4,
            LOCAL_DIMENSIONS,
          );
          results.push(normalizeVector(vec));
        }

        onProgress?.(Math.min(i + batch.length, texts.length), texts.length);
      }

      return results;
    },

    async embedSingle(text: string): Promise<Float32Array> {
      const output = await pipe(text, {
        pooling: "mean",
        normalize: true,
      });

      const vec = new Float32Array(
        output.data.buffer,
        output.data.byteOffset,
        LOCAL_DIMENSIONS,
      );
      return normalizeVector(vec);
    },
  };
}

// ── Voyage embedder (VoyageCode3) ────────────────────────────────────────────

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-code-3";
const VOYAGE_DIMENSIONS = 1024;
const VOYAGE_BATCH_SIZE = 128;

/** Create an embedder using Voyage AI's code embedding API. */
export function createVoyageEmbedder(apiKey: string): Embedder {
  return {
    name: VOYAGE_MODEL,
    dimensions: VOYAGE_DIMENSIONS,

    async embed(
      texts: string[],
      onProgress?: ProgressCallback,
    ): Promise<Float32Array[]> {
      const results: Float32Array[] = [];

      for (let i = 0; i < texts.length; i += VOYAGE_BATCH_SIZE) {
        const batch = texts.slice(i, i + VOYAGE_BATCH_SIZE);
        const vectors = await callVoyageAPI(apiKey, batch);
        results.push(...vectors);
        onProgress?.(Math.min(i + batch.length, texts.length), texts.length);
      }

      return results;
    },

    async embedSingle(text: string): Promise<Float32Array> {
      const vectors = await callVoyageAPI(apiKey, [text]);
      return vectors[0];
    },
  };
}

interface EmbeddingAPIResponse {
  data: { embedding: number[] }[];
}

async function callVoyageAPI(
  apiKey: string,
  texts: string[],
): Promise<Float32Array[]> {
  const response = await fetchWithRetry(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: "document",
    }),
  });

  const json = (await response.json()) as EmbeddingAPIResponse;
  return json.data.map((d) => normalizeVector(new Float32Array(d.embedding)));
}

// ── OpenAI embedder (text-embedding-3-large) ─────────────────────────────────

const OPENAI_API_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_MODEL = "text-embedding-3-large";
const OPENAI_DIMENSIONS = 1024; // truncated from 3072 for efficiency
const OPENAI_BATCH_SIZE = 128;

/** Create an embedder using OpenAI's text-embedding-3-small API. */
export function createOpenAIEmbedder(apiKey: string): Embedder {
  return {
    name: OPENAI_MODEL,
    dimensions: OPENAI_DIMENSIONS,

    async embed(
      texts: string[],
      onProgress?: ProgressCallback,
    ): Promise<Float32Array[]> {
      const results: Float32Array[] = [];

      for (let i = 0; i < texts.length; i += OPENAI_BATCH_SIZE) {
        const batch = texts.slice(i, i + OPENAI_BATCH_SIZE);
        const vectors = await callOpenAIAPI(apiKey, batch);
        results.push(...vectors);
        onProgress?.(Math.min(i + batch.length, texts.length), texts.length);
      }

      return results;
    },

    async embedSingle(text: string): Promise<Float32Array> {
      const vectors = await callOpenAIAPI(apiKey, [text]);
      return vectors[0];
    },
  };
}

async function callOpenAIAPI(
  apiKey: string,
  texts: string[],
): Promise<Float32Array[]> {
  const response = await fetchWithRetry(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: texts,
      dimensions: OPENAI_DIMENSIONS,
    }),
  });

  const json = (await response.json()) as EmbeddingAPIResponse;
  return json.data.map((d) => normalizeVector(new Float32Array(d.embedding)));
}
