import type { KontextDatabase } from "../storage/db.js";
import type { SearchResult } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ASTFilters {
  name?: string;
  type?: string;
  parent?: string;
  language?: string;
  matchMode?: "exact" | "prefix" | "fuzzy";
}

// ── Score constants ──────────────────────────────────────────────────────────

const SCORE_EXACT = 1.0;
const SCORE_PREFIX = 0.8;
const SCORE_FUZZY = 0.5;

// ── AST search ───────────────────────────────────────────────────────────────

/** AST-aware symbol search by name, type, parent, and language. Supports exact/prefix/fuzzy matching. */
export function astSearch(
  db: KontextDatabase,
  filters: ASTFilters,
  limit: number,
): SearchResult[] {
  const matchMode = filters.matchMode ?? "fuzzy";

  const nameMode =
    matchMode === "exact"
      ? ("exact" as const)
      : matchMode === "prefix"
        ? ("prefix" as const)
        : ("contains" as const);

  const score =
    matchMode === "exact"
      ? SCORE_EXACT
      : matchMode === "prefix"
        ? SCORE_PREFIX
        : SCORE_FUZZY;

  const chunks = db.searchChunks(
    {
      name: filters.name,
      nameMode,
      type: filters.type,
      parent: filters.parent,
      language: filters.language,
    },
    limit,
  );

  return chunks.map((chunk) => ({
    chunkId: chunk.id,
    filePath: chunk.filePath,
    lineStart: chunk.lineStart,
    lineEnd: chunk.lineEnd,
    name: chunk.name,
    type: chunk.type,
    exported: chunk.exports,
    text: chunk.text,
    score,
    language: chunk.language,
  }));
}
