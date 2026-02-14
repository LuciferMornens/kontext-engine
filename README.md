# ctx - Context Engine for AI Coding Agents

> Give your AI coding agent deep understanding of any codebase.
> No plugins, no MCP - just a CLI.

<div align="center">

https://github.com/LuciferMornens/kontext-engine/releases/download/v0.1.6-demo/kontext-demo-v6.mp4

</div>

Any agent that can run bash can use `ctx`. Zero integration required.

```bash
ctx init                                          # Index your codebase (~5s for 1K files)
ctx query "authentication middleware"              # Multi-strategy code search
ctx ask "how does the auth middleware validate tokens?"  # LLM-steered natural language search
```

---

## Why

AI coding agents are blind. They either read the whole codebase (blows context windows), rely on grep (misses semantic meaning), or need hand-crafted AGENTS.md files that don't scale.

`ctx` fixes this. One command indexes your codebase into a local SQLite database. Every search combines **five strategies** - vector similarity, full-text, AST symbol lookup, path matching, and dependency tracing - then fuses the results with Reciprocal Rank Fusion.

The result: your agent gets exactly the right files and line ranges, in milliseconds.

---

## Features

- **Multi-strategy search** - five search strategies fused with Reciprocal Rank Fusion (RRF)
- **Semantic search** - vector embeddings via `all-MiniLM-L6-v2` (runs 100% locally)
- **Full-text search** - SQLite FTS5 with BM25 ranking, sanitized query handling for special characters
- **AST-aware symbol lookup** - Tree-sitter parsing for functions, classes, types, imports across 30+ languages
- **Path and dependency tracing** - glob matching + BFS dependency graph traversal
- **LLM-steered queries** - Gemini / OpenAI / Anthropic turn natural language into precise multi-strategy search plans
- **Smart result ranking** - import deprioritization, test file penalty, small snippet penalty, file diversity, export/public API boost
- **Incremental indexing** - SHA-256 hash comparison, only re-indexes changed files
- **File watching** - `ctx watch` auto re-indexes on save
- **100% local** - your code never leaves your machine (unless you opt into API embeddings or LLM steering)

---

## Installation

```bash
npm install -g kontext-engine

# Or run directly (any of these work)
npx kontext-engine init
npx ctx init
```

Requires **Node.js 20+**.

---

## Quickstart

```bash
# 1. Index your project
cd my-project
ctx init

# 2. Search (JSON output - perfect for agents)
ctx query "error handling"

# 3. Search (human-readable text)
ctx query "error handling" -f text

# 4. LLM-steered natural language search (needs API key)
export CTX_GEMINI_KEY=your-key     # or CTX_OPENAI_KEY / CTX_ANTHROPIC_KEY
ctx ask "how does the payment flow handle failed charges?"

# 5. Watch mode - auto re-index on file changes
ctx watch
```

---

## Search Quality

`ctx` goes beyond basic search fusion. Results are ranked through multiple passes to surface the most relevant code:

### Reciprocal Rank Fusion (RRF)

Results from all active strategies (vector, FTS, AST, path, dependency) are combined using RRF with K=60 and per-strategy weights. This produces a unified ranking without needing to normalize scores across different metrics.

### Path Boosting

Files whose path matches the query terms get a boost:
- **1.5x** for directory name matches (e.g., querying "indexer" boosts files in `src/indexer/`)
- **1.4x** for filename matches

### Import Deprioritization

Import blocks (import statements, require calls) receive a **0.5x penalty** when non-import results exist. This prevents import blocks from outranking actual implementations.

### Test File Deprioritization

Test files (`tests/`, `__tests__/`, `*.test.*`, `*.spec.*`) receive a **0.65x penalty** when non-test results exist. Test code is useful but rarely the primary answer to "how does X work?"

### Small Snippet Penalty

Results spanning only 1-3 lines (bare constants, trivial type aliases) get a mild penalty. A `const MAX_RETRIES = 3` should not outrank the retry logic itself.

### File Diversity

Diminishing returns per file prevent one file from dominating results:
- 1st result from a file: 1.0x
- 2nd result: 0.9x
- 3rd result: 0.8x
- 4th+: 0.7x

This ensures results spread across the codebase, giving broader context.

### Export Boost

Exported/public API symbols get a mild boost over internal helpers. When you ask about "chunking", the exported `chunkFile()` function ranks higher than the private `canMerge()` helper.

---

## CLI Reference

### `ctx init [path]`

Index a codebase. Discovers files, parses ASTs, creates chunks, generates embeddings, stores everything in `.ctx/index.db`.

```bash
ctx init                    # Index current directory
ctx init ./my-project       # Index specific path
```

Runs incrementally on subsequent calls - only processes changed files.

### `ctx query <query>`

Multi-strategy code search. Default output is JSON (agent-friendly).

```bash
ctx query "authentication"
ctx query "auth" -f text                  # Human-readable output
ctx query "auth" -s fts,ast               # Specific strategies
ctx query "auth" -l 20                    # Limit results
ctx query "auth" --language typescript    # Filter by language
```

**Options:**

| Flag | Description | Default |
|---|---|---|
| `-f, --format <fmt>` | Output format: `json` or `text` | `json` |
| `-s, --strategy <list>` | Comma-separated: `vector,fts,ast,path` | `fts,ast,path` |
| `-l, --limit <n>` | Maximum results | `10` |
| `--language <lang>` | Filter by language | all |
| `--no-vectors` | Skip vector search | - |

**JSON output (for agents):**

```json
{
  "query": "authentication",
  "results": [
    {
      "file": "src/middleware/auth.ts",
      "lineStart": 14,
      "lineEnd": 89,
      "name": "validateToken",
      "type": "function",
      "score": 0.94,
      "language": "typescript",
      "text": "export async function validateToken(token: string) { ... }"
    }
  ],
  "searchTimeMs": 12,
  "totalResults": 3
}
```

**Text output (for humans):**

```
Query: "authentication"

  src/middleware/auth.ts  L14-L89  (0.94)
  validateToken  [function]
  export async function validateToken(token: string) { ... }

  src/routes/login.ts  L45-L112  (0.87)
  handleLogin  [function]
  ...

3 results in 12ms
```

### `ctx find <query>`

Alias for `ctx query`. Identical behavior.

### `ctx ask <query>`

LLM-steered natural language search. Sends your query to a steering LLM that creates a search plan, executes multi-strategy search, then synthesizes an explanation.

```bash
ctx ask "how does the auth middleware validate tokens?"
ctx ask "what happens when a payment fails?" -f json
ctx ask "find all database models" --no-explain
ctx ask "auth flow" -p openai                    # Force specific provider
```

**Options:**

| Flag | Description | Default |
|---|---|---|
| `-f, --format <fmt>` | Output format: `json` or `text` | `text` |
| `-l, --limit <n>` | Maximum results | `10` |
| `-p, --provider <name>` | LLM provider: `gemini`, `openai`, `anthropic` | auto-detect |
| `--no-explain` | Skip explanation, return raw search results | - |

**Requires an API key** (set via environment variable):

```bash
export CTX_GEMINI_KEY=your-key       # Gemini 3 Flash (cheapest)
export CTX_OPENAI_KEY=your-key       # GPT-5-mini
export CTX_ANTHROPIC_KEY=your-key    # Claude 3.5 Haiku
```

Falls back to keyword-based multi-strategy search if no API key is available. A warning is shown when no LLM provider is detected.

**Natural language handling:** Queries like "how does the indexer work?" are automatically processed - stop words are stripped, code identifiers (camelCase, snake_case, dotted names like `fs.readFileSync`) are preserved, and the cleaned terms are used across all search strategies.

### `ctx watch [path]`

Watch mode - monitors files and re-indexes automatically when you save.

```bash
ctx watch                     # Watch current directory
ctx watch --init              # Run full init first, then watch
ctx watch --debounce 1000     # Custom debounce (ms)
ctx watch --embed             # Re-embed on changes (slower)
```

**Options:**

| Flag | Description | Default |
|---|---|---|
| `--init` | Run `ctx init` before starting watch | off |
| `--debounce <ms>` | Debounce interval | `500` |
| `--embed` | Enable embedding during watch | off |

Press `Ctrl+C` to stop gracefully.

### `ctx status [path]`

Show index statistics.

```bash
ctx status
```

```
Kontext Status - /path/to/project

  Initialized:  Yes
  Database:     .ctx/index.db (14.2 MB)
  Last indexed: 2025-01-15 14:30:22

  Files:    847
  Chunks:   3,241
  Vectors:  3,241

  Languages:
    Typescript   420 files
    Python       200 files
    Javascript   127 files
    Go            50 files
    Rust          50 files

  Embedder: local (all-MiniLM-L6-v2, 384 dims)
```

### `ctx config <subcommand>`

Manage project configuration stored in `.ctx/config.json`.

```bash
ctx config show                              # Show full config
ctx config get search.defaultLimit           # Get specific value
ctx config set search.defaultLimit 20        # Set value
ctx config set embedder.provider voyage      # Switch embedder
ctx config set search.strategies '["fts","ast","vector"]'
ctx config reset                             # Reset to defaults
```

Supports dot-notation for nested keys. Values are auto-parsed (numbers, booleans, JSON arrays, `null`).

### Global Options

| Flag | Description |
|---|---|
| `--verbose` | Enable debug output (stderr) |
| `--version` | Show version |
| `--help` | Show help |

Debug logging is also enabled via `CTX_DEBUG=1`.

---

## Configuration

Configuration lives in `.ctx/config.json`, created automatically by `ctx init`. Manage it with `ctx config show`, `ctx config get <key>`, `ctx config set <key> <value>`, or `ctx config reset [key]`.

```json
{
  "embedder": {
    "provider": "local",
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 384
  },
  "search": {
    "defaultLimit": 10,
    "strategies": ["vector", "fts", "ast", "path"],
    "weights": {
      "vector": 1.0,
      "fts": 0.8,
      "ast": 0.9,
      "path": 0.7,
      "dependency": 0.6
    }
  },
  "watch": {
    "debounceMs": 500,
    "ignored": []
  },
  "llm": {
    "provider": null,
    "model": null
  }
}
```

### Configuration reference

#### `embedder` - Vector embedding settings

| Key | Type | Default | Description |
|---|---|---|---|
| `embedder.provider` | `"local"` \| `"openai"` \| `"voyage"` | `"local"` | Which embedding provider to use. `local` runs offline on CPU; `openai` and `voyage` call remote APIs. |
| `embedder.model` | string | `"Xenova/all-MiniLM-L6-v2"` | Model name. Only change this if you know the provider supports it. |
| `embedder.dimensions` | number | `384` | Vector dimensions. Must match the model (`384` for local, `1024` for voyage-code-3, configurable for OpenAI). |

Switching providers requires rebuilding the index: `rm -f .ctx/index.db && ctx init`. Running `ctx init` after a provider change will show a dimension mismatch error with instructions.

#### `search` - Search behavior

| Key | Type | Default | Description |
|---|---|---|---|
| `search.defaultLimit` | number | `10` | How many results to return when `-l` is not specified. |
| `search.strategies` | string[] | `["vector", "fts", "ast", "path"]` | Which search strategies to run. Order does not matter; results are fused. |
| `search.weights.vector` | number | `1.0` | Weight for vector (semantic) search in RRF fusion. Higher = more influence on final ranking. |
| `search.weights.fts` | number | `0.8` | Weight for FTS5 full-text search. |
| `search.weights.ast` | number | `0.9` | Weight for AST symbol name matching. |
| `search.weights.path` | number | `0.7` | Weight for file path matching. |
| `search.weights.dependency` | number | `0.6` | Weight for import/dependency graph traversal. |

Weights are relative to each other. A strategy with weight `1.0` has more influence than one with `0.6`. Set a weight to `0` to effectively disable a strategy without removing it from the list.

#### `watch` - File watcher settings

| Key | Type | Default | Description |
|---|---|---|---|
| `watch.debounceMs` | number | `500` | Milliseconds to wait after a file change before re-indexing. Prevents rapid-fire re-indexes during saves. |
| `watch.ignored` | string[] | `[]` | Additional glob patterns to ignore (on top of `.gitignore` and built-in ignores like `node_modules`, `.git`). Example: `["*.generated.ts", "dist/**"]` |

#### `llm` - LLM provider override for `ctx ask`

| Key | Type | Default | Description |
|---|---|---|---|
| `llm.provider` | `"gemini"` \| `"openai"` \| `"anthropic"` \| `null` | `null` | Force a specific LLM provider for `ctx ask`. When `null`, auto-detects by checking which API key is set (in order: Gemini, OpenAI, Anthropic). |
| `llm.model` | string \| `null` | `null` | Override the default model for the chosen provider. When `null`, uses Gemini 3 Flash, GPT-5-mini, or Claude 3.5 Haiku respectively. |

### Embedder providers

| Provider | Model | Dimensions | Cost | Notes |
|---|---|---|---|---|
| `local` | all-MiniLM-L6-v2 | 384 | Free | Default. Runs on CPU via ONNX Runtime. |
| `voyage` | voyage-code-3 | 1024 | API pricing | Higher quality for code search. |
| `openai` | text-embedding-3-large | 1024 | API pricing | OpenAI embedding model (dimension truncated for efficiency). |

Remote embedders require API keys:

```bash
export CTX_VOYAGE_KEY=your-key
export CTX_OPENAI_KEY=your-key
```

### Search strategies

| Strategy | What it does | Best for |
|---|---|---|
| `vector` | KNN cosine similarity on embeddings | Semantic/conceptual search |
| `fts` | SQLite FTS5 full-text search with BM25 | Keyword/exact term search |
| `ast` | Symbol name/type/parent matching | Finding specific functions, classes, types |
| `path` | Glob-pattern and keyword file path matching | Finding files by name or directory |
| `dependency` | BFS traversal of import/require graph | Tracing what depends on what |

Default strategies are `fts,ast,path`. Vector search is opt-in (add `vector` to the strategy list or configure in `.ctx/config.json`). Dependency tracing runs when queries match dependency patterns.

Results from all strategies are fused using **Reciprocal Rank Fusion (RRF)** with K=60 and per-strategy weights, then re-ranked with path boosting, import/test deprioritization, file diversity, and export boosting.

---

## Architecture

| Layer | Components |
|---|---|
| **CLI** | `ctx init` / `ctx query` / `ctx ask` / `ctx watch` / `ctx status` / `ctx config` |
| **Engine** | Indexer - Search Engine - Steering LLM - File Watcher |
| **Storage** | SQLite (sqlite-vec vectors + FTS5 full-text + metadata) |

### Indexing pipeline

| Stage | What it does | Output |
|---|---|---|
| **Discovery** | Recursive file scan, respects `.gitignore` / `.ctxignore`, 30+ language extensions | File list |
| **Parsing** | Tree-sitter extracts functions, classes, methods, types, imports, constants | AST nodes with line ranges |
| **Chunking** | Groups nodes into logical code units, merges small chunks, keeps functions whole | Chunks with metadata |
| **Embedding** | `all-MiniLM-L6-v2` via ONNX Runtime (384-dim vectors, runs locally) | Vector embeddings |
| **Storage** | Writes to SQLite: sqlite-vec for KNN, FTS5 for full-text, plus file hashes | `.ctx/index.db` |

1. **Discovery** - recursive file scan, respects `.gitignore` and `.ctxignore`, filters by 30+ language extensions
2. **Parsing** - Tree-sitter extracts functions, classes, methods, types, imports, constants with line ranges and docstrings
3. **Chunking** - splits files into logical code units (not arbitrary line windows). Functions stay whole. Related imports group together. Small constants merge.
4. **Embedding** - `all-MiniLM-L6-v2` via ONNX Runtime (384-dimensional vectors, runs locally)
5. **Storage** - SQLite with sqlite-vec for vector KNN, FTS5 for full-text, plus metadata tables

### Search pipeline

| Step | Description |
|---|---|
| **1. Query input** | Raw user query (natural language or code terms) |
| **2. Steering (optional)** | LLM interprets query, selects strategies, optimizes search terms |
| **3. Parallel search** | Runs selected strategies simultaneously: Vector (KNN), FTS (BM25), AST (symbol lookup), Path (glob/keyword), Dependency (BFS) |
| **4. RRF Fusion** | Reciprocal Rank Fusion combines results across strategies (K=60, per-strategy weights) |
| **5. Re-ranking** | Path boosting, import penalty, test file penalty, snippet penalty, file diversity, export boost |
| **6. Synthesis (optional)** | LLM generates a concise explanation referencing specific files and line numbers |

### Key design decisions

- **SQLite for everything** - vectors, FTS, metadata, all in one file (`.ctx/index.db`). Zero infrastructure.
- **Tree-sitter for AST** - language-agnostic parsing via WebAssembly grammars. Supports TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, and more.
- **Logical chunking** - chunks follow code structure (functions, classes, type blocks), not arbitrary line windows. This gives better search quality and more useful results.
- **RRF fusion** - combines results from multiple strategies without needing to normalize scores across different metrics. Simple, effective, well-studied.
- **Multi-pass re-ranking** - after fusion, results go through path boosting, import/test/snippet deprioritization, file diversity balancing, and export boosting for consistently relevant output.
- **Incremental by default** - SHA-256 content hashing means re-indexing only processes files that actually changed.

---

## For AI Agent Authors

`ctx` is designed to be called from any AI coding agent via shell. No SDK, no API server, no MCP protocol needed.

### Integration pattern

```bash
# Your agent runs this in bash:
ctx query "authentication middleware" -f json

# Parse the JSON output, use the file paths and line ranges
# to read exactly the right code into the agent's context window.
```

### Recommended agent workflow

```
1. Agent receives a task involving unfamiliar code
2. Agent runs: ctx query "<relevant terms>" -f json
3. Agent reads the top results (file paths + line ranges)
4. Agent now has targeted context instead of the whole codebase
5. Agent completes the task with precision
```

### Tips for agent integration

- Always use `-f json` for machine-readable output
- Default strategies (`fts,ast,path`) work great without embeddings
- Use `ctx ask` when the query is natural language and an LLM key is available
- Run `ctx init` once, then `ctx watch` in the background to keep the index fresh
- The index is stored in `.ctx/` - add it to `.gitignore` (done automatically by `ctx init`)

### Works with

- **OpenAI Codex CLI**
- **Claude Code**
- **Cursor**
- **Amp**
- **Code Factory**
- **Droid**
- Any tool that can execute shell commands

---

## Supported Languages

TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, C#, Ruby, PHP, Swift, Kotlin, Scala, Haskell, Lua, R, Dart, Elixir, Shell, SQL, HTML, CSS, SCSS, Vue, Svelte, JSON, YAML, TOML, Markdown, and more.

---

## Project Structure

```
src/
  cli/            # CLI commands (init, query, ask, watch, status, config)
  indexer/        # File discovery, Tree-sitter parsing, chunking, embedding
  search/         # Vector, FTS, AST, path, dependency search + RRF fusion + re-ranking
  steering/       # LLM integration and prompts (Gemini, OpenAI, Anthropic)
  storage/        # SQLite database, sqlite-vec vectors
  watcher/        # File watching with chokidar
  utils/          # Error handling, logging
```

---

## Development

```bash
git clone https://github.com/LuciferMornens/kontext-engine.git
cd kontext-engine
npm install
npm run build         # Build with tsup
npm run test          # Run tests (vitest) - 369 tests
npm run lint          # Lint (eslint)
npm run typecheck     # Type check (tsc --noEmit)
npm run check         # All of the above
```

---

## License

Apache 2.0 - See [LICENSE](LICENSE) for details.
