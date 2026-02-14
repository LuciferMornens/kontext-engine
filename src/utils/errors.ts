// ── Error codes ──────────────────────────────────────────────────────────────

/** String constants for all Kontext error codes. */
export const ErrorCode = {
  NOT_INITIALIZED: "NOT_INITIALIZED",
  INDEX_FAILED: "INDEX_FAILED",
  PARSE_FAILED: "PARSE_FAILED",
  CHUNK_FAILED: "CHUNK_FAILED",
  EMBEDDER_FAILED: "EMBEDDER_FAILED",
  SEARCH_FAILED: "SEARCH_FAILED",
  CONFIG_INVALID: "CONFIG_INVALID",
  DB_CORRUPTED: "DB_CORRUPTED",
  DB_WRITE_FAILED: "DB_WRITE_FAILED",
  WATCHER_FAILED: "WATCHER_FAILED",
  LLM_FAILED: "LLM_FAILED",
} as const;

/** Union type of all error code string values. */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ── Base error ───────────────────────────────────────────────────────────────

/** Base error class for all Kontext errors. Carries a typed `code` and optional `cause`. */
export class KontextError extends Error {
  readonly code: ErrorCodeValue;

  constructor(message: string, code: ErrorCodeValue, cause?: Error) {
    super(message, { cause });
    this.name = "KontextError";
    this.code = code;
  }
}

// ── Subclasses ───────────────────────────────────────────────────────────────

/** Error during indexing: file discovery, parsing, chunking, or embedding. */
export class IndexError extends KontextError {
  constructor(message: string, code: ErrorCodeValue, cause?: Error) {
    super(message, code, cause);
    this.name = "IndexError";
  }
}

/** Error during search: vector, FTS, AST, path, or fusion. */
export class SearchError extends KontextError {
  constructor(message: string, code: ErrorCodeValue, cause?: Error) {
    super(message, code, cause);
    this.name = "SearchError";
  }
}

/** Error reading, writing, or validating configuration. */
export class ConfigError extends KontextError {
  constructor(message: string, code: ErrorCodeValue, cause?: Error) {
    super(message, code, cause);
    this.name = "ConfigError";
  }
}

/** Error in SQLite storage operations. */
export class DatabaseError extends KontextError {
  constructor(message: string, code: ErrorCodeValue, cause?: Error) {
    super(message, code, cause);
    this.name = "DatabaseError";
  }
}
