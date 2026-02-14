import { describe, it, expect, vi, afterEach } from "vitest";
import {
  KontextError,
  IndexError,
  SearchError,
  ConfigError,
  ErrorCode,
} from "../../src/utils/errors.js";
import { handleCommandError } from "../../src/utils/error-boundary.js";
import { createLogger, LogLevel } from "../../src/utils/logger.js";

describe("handleCommandError", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    stderrSpy?.mockRestore();
  });

  function capturedStderr(): string {
    return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
  }

  it("formats KontextError with code", () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ level: LogLevel.ERROR });
    const err = new KontextError("not found", ErrorCode.NOT_INITIALIZED);

    const exitCode = handleCommandError(err, logger, false);

    expect(exitCode).toBe(1);
    expect(capturedStderr()).toContain("not found");
    expect(capturedStderr()).toContain("NOT_INITIALIZED");
  });

  it("shows cause in verbose mode", () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ level: LogLevel.DEBUG });
    const cause = new Error("SQLITE_CORRUPT");
    const err = new IndexError("index broken", ErrorCode.INDEX_FAILED, cause);

    const exitCode = handleCommandError(err, logger, true);

    expect(exitCode).toBe(1);
    expect(capturedStderr()).toContain("index broken");
    expect(capturedStderr()).toContain("SQLITE_CORRUPT");
  });

  it("hides cause in non-verbose mode", () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ level: LogLevel.ERROR });
    const cause = new Error("internal detail");
    const err = new SearchError("search failed", ErrorCode.SEARCH_FAILED, cause);

    handleCommandError(err, logger, false);

    expect(capturedStderr()).toContain("search failed");
    expect(capturedStderr()).not.toContain("internal detail");
  });

  it("handles unknown errors with exit code 2", () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ level: LogLevel.ERROR });

    const exitCode = handleCommandError("string error", logger, false);

    expect(exitCode).toBe(2);
    expect(capturedStderr()).toContain("Unexpected error");
  });

  it("shows stack trace for unknown errors in verbose mode", () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ level: LogLevel.DEBUG });
    const err = new Error("something unexpected");

    const exitCode = handleCommandError(err, logger, true);

    expect(exitCode).toBe(2);
    expect(capturedStderr()).toContain("something unexpected");
  });

  it("works with ConfigError", () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ level: LogLevel.ERROR });
    const err = new ConfigError("bad config", ErrorCode.CONFIG_INVALID);

    const exitCode = handleCommandError(err, logger, false);

    expect(exitCode).toBe(1);
    expect(capturedStderr()).toContain("bad config");
    expect(capturedStderr()).toContain("CONFIG_INVALID");
  });
});
