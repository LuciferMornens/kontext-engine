/** A single search result with chunk location, content, and relevance score (0–1). */
export interface SearchResult {
  chunkId: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  name: string | null;
  type: string;
  exported?: boolean;
  text: string;
  score: number;
  language: string;
}

/** Optional filters applied as post-processing on search results. */
export interface SearchFilters {
  language?: string;
}
