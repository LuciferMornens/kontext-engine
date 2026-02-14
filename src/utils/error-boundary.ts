import { KontextError } from "./errors.js";
import type { Logger } from "./logger.js";

/** Standard error handler for CLI commands. Returns exit code: 1 for KontextError, 2 for unexpected. */
export function handleCommandError(
  err: unknown,
  logger: Logger,
  verbose: boolean,
): number {
  if (err instanceof KontextError) {
    logger.error(`${err.message} [${err.code}]`);
    if (verbose && err.cause) {
      logger.debug("Cause:", String(err.cause));
    }
    return 1;
  }

  if (err instanceof Error) {
    logger.error(`Unexpected error: ${err.message}`);
    if (verbose && err.stack) {
      logger.debug(err.stack);
    }
  } else {
    logger.error(`Unexpected error: ${String(err)}`);
  }

  return 2;
}
