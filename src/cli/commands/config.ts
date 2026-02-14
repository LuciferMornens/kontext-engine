import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { ConfigError, ErrorCode } from "../../utils/errors.js";
import { handleCommandError } from "../../utils/error-boundary.js";
import { createLogger, LogLevel } from "../../utils/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Project-level configuration stored in .ctx/config.json. */
export interface KontextConfig {
  embedder: {
    provider: string;
    model: string;
    dimensions: number;
  };
  search: {
    defaultLimit: number;
    strategies: string[];
    weights: Record<string, number>;
  };
  watch: {
    debounceMs: number;
    ignored: string[];
  };
  llm: {
    provider: string | null;
    model: string | null;
  };
}

export interface ConfigShowOutput {
  config: KontextConfig;
  text: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CTX_DIR = ".ctx";
const CONFIG_FILENAME = "config.json";

/** Default configuration values for a new project. */
export const DEFAULT_CONFIG: KontextConfig = {
  embedder: {
    provider: "local",
    model: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
  },
  search: {
    defaultLimit: 10,
    strategies: ["vector", "fts", "ast", "path"],
    weights: { vector: 1.0, fts: 0.8, ast: 0.9, path: 0.7, dependency: 0.6 },
  },
  watch: {
    debounceMs: 500,
    ignored: [],
  },
  llm: {
    provider: null,
    model: null,
  },
};

// ── Validation ───────────────────────────────────────────────────────────────

const VALID_EMBEDDER_PROVIDERS = new Set(["local", "voyage", "openai"]);
const VALID_LLM_PROVIDERS = new Set(["gemini", "openai", "anthropic"]);

interface ValidationRule {
  validate: (value: unknown) => boolean;
  message: string;
}

const VALIDATION_RULES: Record<string, ValidationRule> = {
  "embedder.provider": {
    validate: (v) => typeof v === "string" && VALID_EMBEDDER_PROVIDERS.has(v),
    message: `Must be one of: ${[...VALID_EMBEDDER_PROVIDERS].join(", ")}`,
  },
  "embedder.dimensions": {
    validate: (v) => typeof v === "number" && v > 0 && Number.isInteger(v),
    message: "Must be a positive integer",
  },
  "search.defaultLimit": {
    validate: (v) => typeof v === "number" && v > 0 && Number.isInteger(v),
    message: "Must be a positive integer",
  },
  "watch.debounceMs": {
    validate: (v) => typeof v === "number" && v >= 0 && Number.isInteger(v),
    message: "Must be a non-negative integer",
  },
  "llm.provider": {
    validate: (v) => v === null || (typeof v === "string" && VALID_LLM_PROVIDERS.has(v)),
    message: `Must be null or one of: ${[...VALID_LLM_PROVIDERS].join(", ")}`,
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveCtxDir(projectPath: string): string {
  const absoluteRoot = path.resolve(projectPath);
  const ctxDir = path.join(absoluteRoot, CTX_DIR);

  if (!fs.existsSync(ctxDir)) {
    throw new ConfigError(
      `Project not initialized. Run "ctx init" first. (${CTX_DIR}/ not found)`,
      ErrorCode.NOT_INITIALIZED,
    );
  }

  return ctxDir;
}

function configPath(ctxDir: string): string {
  return path.join(ctxDir, CONFIG_FILENAME);
}

function readConfig(ctxDir: string): KontextConfig {
  const filePath = configPath(ctxDir);

  if (!fs.existsSync(filePath)) {
    // Create default config
    writeConfig(ctxDir, DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<KontextConfig>;

  // Merge with defaults to fill missing keys
  return mergeWithDefaults(parsed);
}

function writeConfig(ctxDir: string, config: KontextConfig): void {
  fs.writeFileSync(
    configPath(ctxDir),
    JSON.stringify(config, null, 2) + "\n",
  );
}

function mergeWithDefaults(partial: Partial<KontextConfig>): KontextConfig {
  return {
    embedder: { ...DEFAULT_CONFIG.embedder, ...partial.embedder },
    search: {
      ...DEFAULT_CONFIG.search,
      ...partial.search,
      weights: { ...DEFAULT_CONFIG.search.weights, ...partial.search?.weights },
    },
    watch: { ...DEFAULT_CONFIG.watch, ...partial.watch },
    llm: { ...DEFAULT_CONFIG.llm, ...partial.llm },
  };
}

function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

function parseValue(rawValue: string): unknown {
  // Handle null
  if (rawValue === "null") return null;

  // Handle boolean
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;

  // Handle numbers
  const num = Number(rawValue);
  if (!Number.isNaN(num) && rawValue.trim() !== "") return num;

  // Handle JSON arrays/objects
  if (rawValue.startsWith("[") || rawValue.startsWith("{")) {
    try {
      return JSON.parse(rawValue) as unknown;
    } catch {
      // Fall through to string
    }
  }

  // Default: string
  return rawValue;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Read and return the full project configuration. Creates defaults if missing. */
export function runConfigShow(projectPath: string): ConfigShowOutput {
  const ctxDir = resolveCtxDir(projectPath);
  const config = readConfig(ctxDir);

  return {
    config,
    text: JSON.stringify(config, null, 2),
  };
}

/** Get a config value by dot-notation key (e.g., "search.defaultLimit"). */
export function runConfigGet(projectPath: string, key: string): unknown {
  const ctxDir = resolveCtxDir(projectPath);
  const config = readConfig(ctxDir);
  return getNestedValue(config as unknown as Record<string, unknown>, key);
}

/** Set a config value by dot-notation key. Validates against known rules. */
export function runConfigSet(
  projectPath: string,
  key: string,
  rawValue: string,
): void {
  const ctxDir = resolveCtxDir(projectPath);
  const config = readConfig(ctxDir);
  const value = parseValue(rawValue);

  // Validate if rule exists
  const rule = VALIDATION_RULES[key];
  if (rule && !rule.validate(value)) {
    throw new ConfigError(`Invalid value for "${key}": ${rule.message}`, ErrorCode.CONFIG_INVALID);
  }

  setNestedValue(config as unknown as Record<string, unknown>, key, value);
  writeConfig(ctxDir, config);
}

/** Reset all configuration to defaults. */
export function runConfigReset(projectPath: string): void {
  const ctxDir = resolveCtxDir(projectPath);
  writeConfig(ctxDir, structuredClone(DEFAULT_CONFIG));
}

// ── CLI registration ─────────────────────────────────────────────────────────

export function registerConfigCommand(program: Command): void {
  const cmd = program
    .command("config")
    .description("Show or modify configuration");

  function configErrorHandler(err: unknown): void {
    const verbose = program.opts()["verbose"] === true;
    const logger = createLogger({ level: verbose ? LogLevel.DEBUG : LogLevel.INFO });
    process.exitCode = handleCommandError(err, logger, verbose);
  }

  cmd
    .command("show")
    .description("Show current configuration")
    .action(() => {
      try {
        const output = runConfigShow(process.cwd());
        console.log(output.text);
      } catch (err) {
        configErrorHandler(err);
      }
    });

  cmd
    .command("get <key>")
    .description("Get a configuration value (dot notation)")
    .action((key: string) => {
      try {
        const value = runConfigGet(process.cwd(), key);
        console.log(
          typeof value === "object" ? JSON.stringify(value, null, 2) : String(value),
        );
      } catch (err) {
        configErrorHandler(err);
      }
    });

  cmd
    .command("set <key> <value>")
    .description("Set a configuration value (dot notation)")
    .action((key: string, value: string) => {
      try {
        runConfigSet(process.cwd(), key, value);
        console.log(`Set ${key} = ${value}`);
      } catch (err) {
        configErrorHandler(err);
      }
    });

  cmd
    .command("reset")
    .description("Reset configuration to defaults")
    .action(() => {
      try {
        runConfigReset(process.cwd());
        console.log("Configuration reset to defaults.");
      } catch (err) {
        configErrorHandler(err);
      }
    });
}
