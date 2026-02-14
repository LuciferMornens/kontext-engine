import type { KontextDatabase, ChunkWithFile } from "../storage/db.js";
import type { SearchResult, SearchFilters } from "./types.js";

export type { SearchResult, SearchFilters } from "./types.js";

// ── Score normalization ──────────────────────────────────────────────────────

function bm25ToScore(rank: number): number {
  // FTS5 rank is negative (lower = better). Normalize to 0-1.
  return 1 / (1 + Math.abs(rank));
}

// ── FTS search ───────────────────────────────────────────────────────────────

/** Full-text search via SQLite FTS5 with BM25 ranking. Scores normalized as 1/(1+|rank|). */
export function ftsSearch(
  db: KontextDatabase,
  query: string,
  limit: number,
  filters?: SearchFilters,
): SearchResult[] {
  // 1. FTS5 search — fetch extra if filtering
  const fetchLimit = filters?.language ? limit * 3 : limit;
  const ftsResults = db.searchFTS(query, fetchLimit);

  if (ftsResults.length === 0) return [];

  // 2. Fetch chunk + file metadata
  const chunkIds = ftsResults.map((r) => r.chunkId);
  const chunks = db.getChunksByIds(chunkIds);

  const chunkMap = new Map<number, ChunkWithFile>();
  for (const chunk of chunks) {
    chunkMap.set(chunk.id, chunk);
  }

  // 3. Join FTS results with metadata, apply filters
  const results: SearchResult[] = [];

  for (const fts of ftsResults) {
    const chunk = chunkMap.get(fts.chunkId);
    if (!chunk) continue;

    if (filters?.language && chunk.language !== filters.language) continue;

    results.push({
      chunkId: fts.chunkId,
      filePath: chunk.filePath,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      name: chunk.name,
      type: chunk.type,
      text: chunk.text,
      score: bm25ToScore(fts.rank),
      language: chunk.language,
    });
  }

  // 4. Sort by score descending and enforce limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
