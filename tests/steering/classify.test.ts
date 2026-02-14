import { describe, it, expect } from "vitest";
import { classifyQuery } from "../../src/steering/classify.js";

describe("classifyQuery", () => {
  it("classifies symbol queries and boosts AST", () => {
    const result = classifyQuery("computeChanges");
    expect(result.kind).toBe("symbol");
    expect(result.multipliers.ast).toBe(1.5);
    expect(result.multipliers.vector).toBe(0.5);
  });

  it("classifies path queries and boosts path search", () => {
    const result = classifyQuery("src/indexer/incremental.ts");
    expect(result.kind).toBe("path");
    expect(result.multipliers.path).toBe(2.0);
    expect(result.multipliers.ast).toBe(0.5);
  });

  it("classifies natural language queries and boosts vector search", () => {
    const result = classifyQuery("how does the indexer work");
    expect(result.kind).toBe("natural_language");
    expect(result.multipliers.vector).toBe(1.5);
    expect(result.multipliers.path).toBe(1.2);
    expect(result.multipliers.ast).toBe(0.7);
  });

  it("classifies short plain queries as keyword", () => {
    const result = classifyQuery("indexer chunker");
    expect(result.kind).toBe("keyword");
    expect(result.multipliers.vector).toBe(1.0);
    expect(result.multipliers.fts).toBe(1.0);
    expect(result.multipliers.ast).toBe(1.0);
    expect(result.multipliers.path).toBe(1.0);
  });
});
