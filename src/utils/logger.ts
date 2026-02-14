// ── Log levels ───────────────────────────────────────────────────────────────

/** Numeric log level constants. Lower = more verbose. */
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
} as const;

/** Union type of all log level numeric values. */
export type LogLevelValue = (typeof LogLevel)[keyof typeof LogLevel];

// ── Logger interface ─────────────────────────────────────────────────────────

/** Leveled logger that writes to stderr. */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

// ── Options ──────────────────────────────────────────────────────────────────

/** Options for creating a logger instance. */
export interface LoggerOptions {
  level?: LogLevelValue;
}

// ── Factory ──────────────────────────────────────────────────────────────────

function resolveLevel(options?: LoggerOptions): LogLevelValue {
  if (options?.level !== undefined) return options.level;
  if (process.env["CTX_DEBUG"] === "1") return LogLevel.DEBUG;
  return LogLevel.INFO;
}

function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
}

function write(level: string, msg: string, args: unknown[]): void {
  const extra = args.length > 0 ? ` ${formatArgs(args)}` : "";
  process.stderr.write(`[${level}] ${msg}${extra}\n`);
}

/** Create a logger. Respects `CTX_DEBUG=1` env var for debug output. */
export function createLogger(options?: LoggerOptions): Logger {
  const minLevel = resolveLevel(options);

  return {
    debug(msg: string, ...args: unknown[]): void {
      if (minLevel <= LogLevel.DEBUG) write("debug", msg, args);
    },
    info(msg: string, ...args: unknown[]): void {
      if (minLevel <= LogLevel.INFO) write("info", msg, args);
    },
    warn(msg: string, ...args: unknown[]): void {
      if (minLevel <= LogLevel.WARN) write("warn", msg, args);
    },
    error(msg: string, ...args: unknown[]): void {
      if (minLevel <= LogLevel.ERROR) write("error", msg, args);
    },
  };
}
