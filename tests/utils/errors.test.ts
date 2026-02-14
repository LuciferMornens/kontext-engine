import { describe, it, expect } from "vitest";
import {
  KontextError,
  IndexError,
  SearchError,
  ConfigError,
  DatabaseError,
  ErrorCode,
} from "../../src/utils/errors.js";

describe("KontextError", () => {
  it("has correct message and code", () => {
    const err = new KontextError("something broke", ErrorCode.NOT_INITIALIZED);

    expect(err.message).toBe("something broke");
    expect(err.code).toBe("NOT_INITIALIZED");
    expect(err.name).toBe("KontextError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KontextError);
  });

  it("preserves cause chain", () => {
    const original = new Error("disk full");
    const err = new KontextError("write failed", ErrorCode.INDEX_FAILED, original);

    expect(err.cause).toBe(original);
    expect(err.message).toBe("write failed");
  });

  it("has a stack trace", () => {
    const err = new KontextError("test", ErrorCode.NOT_INITIALIZED);
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("KontextError");
  });
});

describe("IndexError", () => {
  it("is a KontextError subclass", () => {
    const err = new IndexError("parse failed", ErrorCode.INDEX_FAILED);

    expect(err).toBeInstanceOf(KontextError);
    expect(err).toBeInstanceOf(IndexError);
    expect(err.name).toBe("IndexError");
    expect(err.code).toBe("INDEX_FAILED");
  });

  it("supports cause", () => {
    const cause = new Error("tree-sitter crash");
    const err = new IndexError("parse failed", ErrorCode.PARSE_FAILED, cause);

    expect(err.cause).toBe(cause);
  });
});

describe("SearchError", () => {
  it("is a KontextError subclass", () => {
    const err = new SearchError("no results", ErrorCode.SEARCH_FAILED);

    expect(err).toBeInstanceOf(KontextError);
    expect(err).toBeInstanceOf(SearchError);
    expect(err.name).toBe("SearchError");
  });
});

describe("ConfigError", () => {
  it("is a KontextError subclass", () => {
    const err = new ConfigError("bad value", ErrorCode.CONFIG_INVALID);

    expect(err).toBeInstanceOf(KontextError);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.name).toBe("ConfigError");
  });
});

describe("DatabaseError", () => {
  it("is a KontextError subclass", () => {
    const err = new DatabaseError("schema mismatch", ErrorCode.DB_CORRUPTED);

    expect(err).toBeInstanceOf(KontextError);
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err.name).toBe("DatabaseError");
  });
});

describe("ErrorCode", () => {
  it("has all expected codes", () => {
    expect(ErrorCode.NOT_INITIALIZED).toBe("NOT_INITIALIZED");
    expect(ErrorCode.INDEX_FAILED).toBe("INDEX_FAILED");
    expect(ErrorCode.PARSE_FAILED).toBe("PARSE_FAILED");
    expect(ErrorCode.CHUNK_FAILED).toBe("CHUNK_FAILED");
    expect(ErrorCode.EMBEDDER_FAILED).toBe("EMBEDDER_FAILED");
    expect(ErrorCode.SEARCH_FAILED).toBe("SEARCH_FAILED");
    expect(ErrorCode.CONFIG_INVALID).toBe("CONFIG_INVALID");
    expect(ErrorCode.DB_CORRUPTED).toBe("DB_CORRUPTED");
    expect(ErrorCode.DB_WRITE_FAILED).toBe("DB_WRITE_FAILED");
    expect(ErrorCode.WATCHER_FAILED).toBe("WATCHER_FAILED");
    expect(ErrorCode.LLM_FAILED).toBe("LLM_FAILED");
  });
});
