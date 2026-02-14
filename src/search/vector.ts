import type { KontextDatabase, ChunkWithFile } from "../storage/db.js";
import type { Embedder } from "../indexer/embedder.js";
import type { SearchResult, SearchFilters } from "./types.js";

export type { SearchResult, SearchFilters } from "./types.js";

// ── Score normalization ──────────────────────────────────────────────────────

function distanceToScore(distance: number): number {
  return 1 / (1 + distance);
}

// ── Vector search ────────────────────────────────────────────────────────────

/** KNN vector similarity search. Scores normalized as 1/(1+distance). */
export async function vectorSearch(
  db: KontextDatabase,
  embedder: Embedder,
  query: string,
  limit: number,
  filters?: SearchFilters,
): Promise<SearchResult[]> {
  // 1. Embed the query
  const queryVec = await embedder.embedSingle(query);

  // 2. KNN search — fetch extra if filtering, to compensate for post-filter losses
  const fetchLimit = filters?.language ? limit * 3 : limit;
  const vectorResults = db.searchVectors(queryVec, fetchLimit);

  if (vectorResults.length === 0) return [];

  // 3. Fetch chunk + file metadata for all returned IDs
  const chunkIds = vectorResults.map((r) => r.chunkId);
  const chunks = db.getChunksByIds(chunkIds);

  // Build lookup map for O(1) access
  const chunkMap = new Map<number, ChunkWithFile>();
  for (const chunk of chunks) {
    chunkMap.set(chunk.id, chunk);
  }

  // 4. Join vector results with chunk metadata, apply filters
  const results: SearchResult[] = [];

  for (const vr of vectorResults) {
    const chunk = chunkMap.get(vr.chunkId);
    if (!chunk) continue;

    // Post-filter by language
    if (filters?.language && chunk.language !== filters.language) continue;

    results.push({
      chunkId: vr.chunkId,
      filePath: chunk.filePath,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      name: chunk.name,
      type: chunk.type,
      text: chunk.text,
      score: distanceToScore(vr.distance),
      language: chunk.language,
    });
  }

  // 5. Sort by score descending (highest first) and enforce limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
