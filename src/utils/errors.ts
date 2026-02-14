// ── Error codes ──────────────────────────────────────────────────────────────

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

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ── Base error ───────────────────────────────────────────────────────────────

export class KontextError extends Error {
  readonly code: ErrorCodeValue;

  constructor(message: string, code: ErrorCodeValue, cause?: Error) {
    super(message, { cause });
    this.name = "KontextError";
    this.code = code;
  }
}

// ── Subclasses ───────────────────────────────────────────────────────────────

export class IndexError extends KontextError {
  constructor(message: string, code: ErrorCodeValue, cause?: Error) {
    super(message, code, cause);
    this.name = "IndexError";
  }
}

export class SearchError extends KontextError {
  constructor(message: string, code: ErrorCodeValue, cause?: Error) {
    super(message, code, cause);
    this.name = "SearchError";
  }
}

export class ConfigError extends KontextError {
  constructor(message: string, code: ErrorCodeValue, cause?: Error) {
    super(message, code, cause);
    this.name = "ConfigError";
  }
}

export class DatabaseError extends KontextError {
  constructor(message: string, code: ErrorCodeValue, cause?: Error) {
    super(message, code, cause);
    this.name = "DatabaseError";
  }
}
