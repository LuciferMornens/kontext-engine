import {
  createLocalEmbedder,
  createOpenAIEmbedder,
  createVoyageEmbedder,
} from "../indexer/embedder.js";
import type { Embedder } from "../indexer/embedder.js";
import { runConfigShow } from "./commands/config.js";
import { ConfigError, ErrorCode } from "../utils/errors.js";

export interface ProjectEmbedderConfig {
  provider: string;
  model: string;
  dimensions: number;
}

export function getProjectEmbedderConfig(projectPath: string): ProjectEmbedderConfig {
  const { config } = runConfigShow(projectPath);
  return config.embedder;
}

export async function createProjectEmbedder(projectPath: string): Promise<Embedder> {
  const config = getProjectEmbedderConfig(projectPath);
  validateProjectEmbedderConfig(config);

  switch (config.provider) {
    case "local":
      return await createLocalEmbedder();

    case "voyage": {
      const apiKey = requireApiKey("CTX_VOYAGE_KEY", "voyage");
      return createVoyageEmbedder(apiKey, config.dimensions);
    }

    case "openai": {
      const apiKey = requireApiKey("CTX_OPENAI_KEY", "openai");
      return createOpenAIEmbedder(apiKey, config.dimensions);
    }

    default:
      throw new ConfigError(
        `Unsupported embedder provider "${config.provider}". Use local, voyage, or openai.`,
        ErrorCode.CONFIG_INVALID,
      );
  }
}

function requireApiKey(envVar: string, provider: string): string {
  const value = process.env[envVar];
  if (typeof value === "string" && value.length > 0) return value;
  throw new ConfigError(
    `Embedder provider "${provider}" requires ${envVar}. Export ${envVar} before running this command.`,
    ErrorCode.CONFIG_INVALID,
  );
}

function validateProjectEmbedderConfig(config: ProjectEmbedderConfig): void {
  if (!Number.isInteger(config.dimensions) || config.dimensions <= 0) {
    throw new ConfigError(
      `Invalid embedder.dimensions (${String(config.dimensions)}). Must be a positive integer.`,
      ErrorCode.CONFIG_INVALID,
    );
  }

  if (config.provider === "local" && config.dimensions !== 384) {
    throw new ConfigError(
      'Local embedder requires "embedder.dimensions" = 384. Update config or switch provider.',
      ErrorCode.CONFIG_INVALID,
    );
  }
}
