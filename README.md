# ctx — Context Engine for AI Coding Agents

> Give your AI coding agent deep understanding of any codebase.
> No plugins, no MCP — just a CLI.

Any agent that can run bash can use `ctx`. Zero integration required.

```bash
ctx init                                          # Index your codebase (~5s for 1K files)
ctx query "authentication middleware"              # Multi-strategy code search
ctx ask "how does the auth middleware validate tokens?"  # LLM-steered natural language search
```

---

## Why

AI coding agents are blind. They either read the whole codebase (blows context windows), rely on grep (misses semantic meaning), or need hand-crafted AGENTS.md files that don't scale.

`ctx` fixes this. One command indexes your codebase into a local SQLite database. Every search combines **five strategies** — vector similarity, full-text, AST symbol lookup, path matching, and dependency tracing — then fuses the results with Reciprocal Rank Fusion.

The result: your agent gets exactly the right files and line ranges, in milliseconds.

---

## Features

- **🔍 Semantic search** — vector embeddings via `all-MiniLM-L6-v2` (runs 100% locally)
- **📝 Full-text search** — SQLite FTS5 with BM25 ranking
- **🌳 AST-aware symbol lookup** — Tree-sitter parsing for functions, classes, types, imports
- **📁 Path & dependency tracing** — glob matching + BFS dependency graph traversal
- **🤖 LLM-steered queries** — Gemini / OpenAI / Anthropic turn natural language into precise multi-strategy search plans
- **⚡ Incremental indexing** — SHA-256 hash comparison, only re-indexes changed files
- **👁️ File watching** — `ctx watch` auto re-indexes on save
- **🏠 100% local** — your code never leaves your machine (unless you opt into API embeddings)

---

## Installation

```bash
npm install -g kontext

# Or run directly
npx kontext init
```

Requires **Node.js 20+**.

---

## Quickstart

```bash
# 1. Index your project
cd my-project
ctx init

# 2. Search (JSON output — perfect for agents)
ctx query "error handling"

# 3. Search (human-readable text)
ctx query "error handling" -f text

# 4. LLM-steered natural language search (needs API key)
export CTX_GEMINI_KEY=your-key     # or CTX_OPENAI_KEY / CTX_ANTHROPIC_KEY
ctx ask "how does the payment flow handle failed charges?"

# 5. Watch mode — auto re-index on file changes
ctx watch
```

---

## CLI Reference

### `ctx init [path]`

Index a codebase. Discovers files, parses ASTs, creates chunks, generates embeddings, stores everything in `.ctx/index.db`.

```bash
ctx init                    # Index current directory
ctx init ./my-project       # Index specific path
```

Runs incrementally on subsequent calls — only processes changed files.

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
| `-s, --strategy <list>` | Comma-separated: `vector,fts,ast,path` | `fts,ast` |
| `-l, --limit <n>` | Maximum results | `10` |
| `--language <lang>` | Filter by language | all |
| `--no-vectors` | Skip vector search | — |

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

  src/middleware/auth.ts  L14–L89  (0.94)
  validateToken  [function]
  export async function validateToken(token: string) { ... }

  src/routes/login.ts  L45–L112  (0.87)
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
| `--no-explain` | Skip explanation, return raw search results | — |

**Requires an API key** (set via environment variable):

```bash
export CTX_GEMINI_KEY=your-key       # Gemini 2.0 Flash (cheapest)
export CTX_OPENAI_KEY=your-key       # GPT-4o-mini
export CTX_ANTHROPIC_KEY=your-key    # Claude 3.5 Haiku
```

Falls back to basic multi-strategy search if no API key is available.

### `ctx watch [path]`

Watch mode — monitors files and re-indexes automatically when you save.

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
Kontext Status — /path/to/project

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

Configuration lives in `.ctx/config.json`, created automatically by `ctx init`.

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

### Embedder providers

| Provider | Model | Dimensions | Cost | Notes |
|---|---|---|---|---|
| `local` | all-MiniLM-L6-v2 | 384 | Free | Default. Runs on CPU via ONNX Runtime. |
| `voyage` | voyage-code-3 | 1024 | API pricing | Higher quality for code search. |
| `openai` | text-embedding-3-small | 1536 | API pricing | OpenAI's smallest embedding model. |

### Search strategies

| Strategy | What it does | Best for |
|---|---|---|
| `vector` | KNN cosine similarity on embeddings | Semantic/conceptual search |
| `fts` | SQLite FTS5 full-text search with BM25 | Keyword/exact term search |
| `ast` | Symbol name/type/parent matching | Finding specific functions, classes, types |
| `path` | Glob-pattern file path matching | Finding files by name or directory |
| `dependency` | BFS traversal of import/require graph | Tracing what depends on what |

Results from all strategies are fused using **Reciprocal Rank Fusion (RRF)** with K=60 and per-strategy weights.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                         ctx CLI                          │
├──────────┬──────────────┬───────────────┬───────────────┤
│  Indexer  │ Search Engine │  Steering LLM  │  File Watcher │
├──────────┴──────────────┴───────────────┴───────────────┤
│                    Storage (SQLite)                       │
└─────────────────────────────────────────────────────────┘
```

### Indexing pipeline

```
Source Files → Discovery → Tree-sitter AST → Logical Chunks → Embeddings → SQLite
                 │              │                   │               │
                 │              ├── functions        ├── chunk text  ├── vectors (sqlite-vec)
                 │              ├── classes          ├── file path   ├── FTS5 index
                 │              ├── imports          ├── line range  ├── AST metadata
                 │              └── types            └── language    └── file hashes
                 │
                 ├── .gitignore / .ctxignore filtering
                 └── 30+ language extensions
```

1. **Discovery** — recursive file scan, respects `.gitignore` and `.ctxignore`, filters by 30+ language extensions
2. **Parsing** — Tree-sitter extracts functions, classes, methods, types, imports, constants with line ranges and docstrings
3. **Chunking** — splits files into logical code units (not arbitrary line windows). Functions stay whole. Related imports group together. Small constants merge.
4. **Embedding** — `all-MiniLM-L6-v2` via ONNX Runtime (384-dimensional vectors, runs locally)
5. **Storage** — SQLite with sqlite-vec for vector KNN, FTS5 for full-text, plus metadata tables

### Search pipeline

```
Query → [Steering LLM] → Strategy Selection → Parallel Search → RRF Fusion → Ranked Results
              │                    │
              │                    ├── Vector similarity (KNN)
              │                    ├── Full-text search (BM25)
              │                    ├── AST symbol lookup
              │                    ├── Path glob matching
              │                    └── Dependency tracing (BFS)
              │
              └── Optional: interprets query, picks strategies,
                  synthesizes explanation after search
```

### Key design decisions

- **SQLite for everything** — vectors, FTS, metadata, all in one file (`.ctx/index.db`). Zero infrastructure.
- **Tree-sitter for AST** — language-agnostic parsing via WebAssembly grammars. Supports TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, and more.
- **Logical chunking** — chunks follow code structure (functions, classes, type blocks), not arbitrary line windows. This gives better search quality and more useful results.
- **RRF fusion** — combines results from multiple strategies without needing to normalize scores across different metrics. Simple, effective, well-studied.
- **Incremental by default** — SHA-256 content hashing means re-indexing only processes files that actually changed.

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
- Use `-s fts,ast` for fast, embedding-free search
- Use `ctx ask` when the query is natural language and an LLM key is available
- Run `ctx init` once, then `ctx watch` in the background to keep the index fresh
- The index is stored in `.ctx/` — add it to `.gitignore` (done automatically by `ctx init`)

### Works with

- **OpenAI Codex** (CLI)
- **Claude Code** (Anthropic)
- **Cursor** (AI IDE)
- **Aider** (terminal)
- **lxt** (coding agent)
- Any tool that can execute shell commands

---

## Supported Languages

TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, C#, Ruby, PHP, Swift, Kotlin, Scala, Haskell, Lua, R, Dart, Elixir, Shell, SQL, HTML, CSS, SCSS, Vue, Svelte, JSON, YAML, TOML, Markdown, and more.

---

## Project Structure

```
src/
├── cli/            # CLI commands (init, query, ask, watch, status, config)
├── indexer/        # File discovery, Tree-sitter parsing, chunking, embedding
├── search/         # Vector, FTS, AST, path, dependency search + RRF fusion
├── steering/       # LLM integration (Gemini, OpenAI, Anthropic)
├── storage/        # SQLite database, sqlite-vec vectors
├── watcher/        # File watching with chokidar
└── utils/          # Error handling, logging
```

---

## Development

```bash
git clone https://github.com/example/kontext.git
cd kontext
npm install
npm run build         # Build with tsup
npm run test          # Run tests (vitest)
npm run lint          # Lint (eslint)
npm run typecheck     # Type check (tsc --noEmit)
```

---

## License

MIT
