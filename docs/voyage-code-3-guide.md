# Voyage `voyage-code-3` Integration Guide for `ctx` (kontext-engine)

Last updated: 2026-02-14

## 1) What `voyage-code-3` is and why use it for code search

`voyage-code-3` is Voyage AI's code-focused embedding model for semantic code retrieval. In Voyage docs, it is positioned as a high-quality model for code search with:

- Default embedding size: `1024`
- Optional output dimensions: `256`, `512`, `1024`, `2048`
- Max context length: `32,000` tokens
- Model family optimized for retrieval over code and natural language

Voyage also publishes benchmark claims for `voyage-code-3` vs alternatives (for example, better code retrieval scores than OpenAI `text-embedding-3-large` on Voyage's published benchmark). Treat those as vendor-reported; run local evals on your codebase before finalizing provider choice.

## 2) Voyage API details (official docs summary)

### Endpoint and auth

- REST endpoint: `POST https://api.voyageai.com/v1/embeddings`
- Auth: `Authorization: Bearer <VOYAGE_API_KEY>`
- Header: `Content-Type: application/json`

### Request format (important fields)

Typical request body:

```json
{
  "model": "voyage-code-3",
  "input": ["...text or code chunk..."],
  "input_type": "document",
  "truncation": true,
  "output_dimension": 1024,
  "output_dtype": "float"
}
```

Notes:

- `input` can be a string or array of strings.
- `input_type` should be:
  - `document` for indexed chunks
  - `query` for search queries
- `output_dimension` is optional if you want default behavior.

### Response format

Voyage returns OpenAI-like embedding payloads (`data[]` with embeddings). In this repo, existing Voyage parsing already expects:

- `data[i].embedding` as numeric vector

### Pricing and limits (as documented)

For `voyage-code-3`, Voyage docs list:

- Price: `~$0.12 / 1M input tokens` for code retrieval
- Per-request limit: max input array length `1000`
- Per-request token cap: `120,000` total tokens

Published rate-limit table (varies by account tier):

- Free: `3 RPM`, `200k TPM`
- Paid tiers: up to `2000 RPM` and up to `120M TPM`
- Batch processing also documented with high token quotas

Always verify your account-specific limits in dashboard/docs before production sizing.

## 3) SDKs / packages

### Official TypeScript package

- npm package: `voyageai`
- Repo: `voyage-ai/typescript-sdk`

Install:

```bash
npm install voyageai
```

Example:

```ts
import VoyageAI from "voyageai";

const client = new VoyageAI({ apiKey: process.env.CTX_VOYAGE_KEY! });
const result = await client.embed({
  model: "voyage-code-3",
  input: ["function foo() { return 1; }"],
  inputType: "document"
});
```

As of 2026-02-14, `@voyageai/sdk` is not found on npm (`404`), while `voyageai` exists.

## 4) `ctx` codebase audit (current state)

## 4.1 Embedder implementation

File: `src/indexer/embedder.ts`

Already present:

- `createLocalEmbedder()` (`384` dims)
- `createVoyageEmbedder(apiKey)` (`1024` dims)
- `createOpenAIEmbedder(apiKey)` (`1024` dims in code)

Important details:

- Voyage embedder exists and is exported.
- It calls `https://api.voyageai.com/v1/embeddings` with bearer auth.
- It currently hardcodes `input_type: "document"` for both indexing and query embedding.

## 4.2 Vector search usage

File: `src/search/vector.ts`

- Query path calls `embedder.embedSingle(query)`.
- So provider-specific query/document behavior must be implemented inside embedder.

## 4.3 Storage + schema + dimensions

Files: `src/storage/schema.ts`, `src/storage/db.ts`

- Vector table is created as `embedding float[<dimensions>]`.
- Dimension is fixed per DB table creation.
- `createDatabase(dbPath, dimensions = 384)` supports variable dimensions in principle.
- But CLI callers do not pass config dimensions today.
- `initializeSchema()` only runs on first schema creation; existing DB dimensions are not migrated/validated.

Result: schema supports variable dimensions at creation time, but no safe migration path is implemented.

## 4.4 CLI/config support status

Files: `src/cli/commands/config.ts`, `src/cli/commands/init.ts`, `src/cli/commands/query.ts`, `src/cli/commands/ask.ts`, `src/cli/commands/watch.ts`, `src/cli/commands/status.ts`

What exists:

- Config schema includes `embedder.provider`, `embedder.model`, `embedder.dimensions`.
- Valid providers include `local`, `voyage`, `openai`.

What is missing:

- `init/query/ask/watch` still instantiate `createLocalEmbedder()` directly.
- Config embedder provider/model/dimensions are not wired into runtime embedder selection.
- No embedding provider env-var detection for Voyage (`CTX_VOYAGE_KEY` not used).
- Status output always labels embedder as local.

Net: Voyage support is partially implemented at library level, not fully integrated in CLI workflow.

## 5) What code changes are needed for full Voyage support

## 5.1 Do we need `createVoyageEmbedder()`?

Already implemented. No new factory required.

Recommended update:

- Add query/document mode handling:
  - `embed()` -> `input_type: "document"`
  - `embedSingle()` for search query -> `input_type: "query"`

## 5.2 Config and env wiring

Add/standardize:

- Env var: `CTX_VOYAGE_KEY`
- Keep existing pattern for `CTX_OPENAI_KEY` and local provider.

Implement shared loader used by `init/query/ask/watch`:

- Read `.ctx/config.json`
- Resolve provider
- Build embedder instance:
  - `local` -> `createLocalEmbedder()`
  - `voyage` -> `createVoyageEmbedder(process.env.CTX_VOYAGE_KEY)`
  - `openai` -> `createOpenAIEmbedder(process.env.CTX_OPENAI_KEY)`

If key missing for remote provider, fail with clear actionable error.

## 5.3 Exact files to change

Core runtime wiring:

- `src/cli/commands/init.ts`
  - Load project config before DB/embedder init
  - Pass `embedder.dimensions` to `createDatabase(...)`
  - Replace local-only embedder factory with provider-aware factory

- `src/cli/commands/query.ts`
  - Replace `loadEmbedder()` local-only logic with config-driven provider loader

- `src/cli/commands/ask.ts`
  - Same as query for vector strategy path

- `src/cli/commands/watch.ts`
  - Same as init/query

- `src/cli/commands/status.ts`
  - Display configured provider/model/dimensions instead of hardcoded `local (...)`

Dimension safety + migration signaling:

- `src/storage/db.ts`
  - Persist vector dimension metadata (e.g., in `meta`)
  - Validate configured dimension against existing index
  - Emit explicit mismatch error requiring rebuild/reindex

Embedder behavior improvement:

- `src/indexer/embedder.ts`
  - Support `input_type: "query"` for search query embeddings
  - Optionally allow `output_dimension` from config for Voyage

Docs/tests:

- `README.md` (provider behavior and current dimensions)
- Tests in `tests/cli/*`, `tests/indexer/embedder.test.ts`, and storage tests for dimension mismatch path

## 5.4 OpenAI-compatible pattern reuse?

Partially.

- Similarities: same auth style (bearer), similar embeddings endpoint shape, similar `data[].embedding` response handling.
- Differences: Voyage-specific parameters (`input_type`, model IDs, token/request limits, optional output controls).

So it is best to keep Voyage as a separate provider implementation (as you already do), not as a pure OpenAI alias.

## 6) Dimension migration notes (384 -> 1024)

Current behavior:

- Existing `.ctx/index.db` vector table has fixed dimension from creation time (currently typically `384`).
- Switching provider in config alone does not re-create vector table.
- Inserting `1024` vectors into a `384` table will fail.

Recommended migration flow:

1. Update config to Voyage + 1024 dims.
2. Export API key:

```bash
export CTX_VOYAGE_KEY=your_voyage_api_key
```

3. Rebuild index from scratch (safe and simplest):

```bash
rm -f .ctx/index.db
ctx init
```

Optionally remove full `.ctx/` if you want a clean reset of config + DB.

Future improvement:

- Add a first-class command/flag for rebuild (example: `ctx init --rebuild`) that drops/recreates vector structures automatically when dimensions/provider change.

## 7) Practical configuration examples

These commands are valid config intents; today they are only partially effective until runtime wiring is added.

```bash
ctx config set embedder.provider voyage
ctx config set embedder.model voyage-code-3
ctx config set embedder.dimensions 1024
```

After full wiring is implemented, these should control both indexing and query-time embeddings.

## 8) Performance and quality expectations

Based on Voyage docs + model notes:

- Quality: expect stronger semantic code retrieval than small local models (`all-MiniLM-L6-v2`), especially cross-language and conceptual queries.
- Latency/cost tradeoff: remote API adds network + billing overhead, but gives much higher retrieval quality.
- Throughput: Voyage publishes high throughput guidance and tiered rate limits; real throughput in `ctx` will depend on batch size, retry behavior, and your account limits.

For production decisions, run an internal retrieval benchmark on your own repositories (precision@k / recall@k / answer success rate) before cutover.

## 9) Current support status summary

- `createVoyageEmbedder()` exists and is tested.
- `ctx` CLI does not yet actually switch providers based on config.
- DB dimension handling is static per index and needs explicit rebuild logic when changing providers/dimensions.
- Adding `CTX_VOYAGE_KEY` and provider-aware runtime loading is the main missing integration work.

## Sources

- Voyage model choices (dimensions, model capabilities, compatibility):
  - https://docs.voyageai.com/docs/embeddings
- Voyage embeddings API reference / endpoint:
  - https://docs.voyageai.com/reference/embeddings-api-1
- Voyage pricing and rate limits:
  - https://docs.voyageai.com/docs/rate-limits
- Voyage code model announcement/benchmark claims:
  - https://blog.voyageai.com/2024/12/04/voyage-code-3/
- Voyage TypeScript SDK repo:
  - https://github.com/voyage-ai/typescript-sdk
- Voyage npm package:
  - https://www.npmjs.com/package/voyageai
