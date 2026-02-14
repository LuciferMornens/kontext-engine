import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, LogLevel } from "../../src/utils/logger.js";

describe("createLogger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env["CTX_DEBUG"];
  });

  function collected(): string {
    return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
  }

  it("writes to stderr", () => {
    const logger = createLogger({ level: LogLevel.DEBUG });
    logger.info("hello");

    expect(stderrSpy).toHaveBeenCalled();
    expect(collected()).toContain("hello");
  });

  it("formats with level prefix", () => {
    const logger = createLogger({ level: LogLevel.DEBUG });
    logger.info("test message");

    expect(collected()).toContain("[info]");
    expect(collected()).toContain("test message");
  });

  it("filters messages below configured level", () => {
    const logger = createLogger({ level: LogLevel.WARN });

    logger.debug("hidden debug");
    logger.info("hidden info");
    logger.warn("visible warn");
    logger.error("visible error");

    expect(collected()).not.toContain("hidden debug");
    expect(collected()).not.toContain("hidden info");
    expect(collected()).toContain("visible warn");
    expect(collected()).toContain("visible error");
  });

  it("debug only shows in verbose mode", () => {
    const quiet = createLogger({ level: LogLevel.INFO });
    quiet.debug("should not appear");

    expect(stderrSpy).not.toHaveBeenCalled();

    const verbose = createLogger({ level: LogLevel.DEBUG });
    verbose.debug("should appear");

    expect(collected()).toContain("should appear");
  });

  it("defaults to INFO level", () => {
    const logger = createLogger();

    logger.debug("hidden");
    logger.info("visible");

    expect(collected()).not.toContain("hidden");
    expect(collected()).toContain("visible");
  });

  it("respects CTX_DEBUG env var", () => {
    process.env["CTX_DEBUG"] = "1";
    const logger = createLogger();

    logger.debug("env debug");

    expect(collected()).toContain("env debug");
  });

  it("supports extra arguments", () => {
    const logger = createLogger({ level: LogLevel.DEBUG });
    logger.debug("count:", 42, "flag:", true);

    expect(collected()).toContain("count:");
    expect(collected()).toContain("42");
  });

  it("error level always shows", () => {
    const logger = createLogger({ level: LogLevel.ERROR });

    logger.debug("nope");
    logger.info("nope");
    logger.warn("nope");
    logger.error("critical");

    expect(collected()).toContain("critical");
    expect(collected()).not.toContain("nope");
  });

  it("warn shows at WARN level", () => {
    const logger = createLogger({ level: LogLevel.WARN });
    logger.warn("caution");

    expect(collected()).toContain("[warn]");
    expect(collected()).toContain("caution");
  });

  it("silent level suppresses all output", () => {
    const logger = createLogger({ level: LogLevel.SILENT });

    logger.debug("nope");
    logger.info("nope");
    logger.warn("nope");
    logger.error("nope");

    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
