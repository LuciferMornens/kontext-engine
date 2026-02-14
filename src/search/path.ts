import type { KontextDatabase } from "../storage/db.js";
import type { SearchResult } from "./types.js";

// ── Glob matching ────────────────────────────────────────────────────────────

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: ** (any path), * (any segment chars), ? (single char)
 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*" && pattern[i + 1] === "*") {
      // ** matches any number of path segments
      re += ".*";
      i += 2;
      // Skip trailing slash after **
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      // * matches anything except /
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }

  return new RegExp(`^${re}$`);
}

// ── Path search ──────────────────────────────────────────────────────────────

/** Search files by glob pattern. Converts globs to SQL LIKE clauses. */
export function pathSearch(
  db: KontextDatabase,
  pattern: string,
  limit: number,
): SearchResult[] {
  const allPaths = db.getAllFilePaths();
  const regex = globToRegExp(pattern);
  const matchingPaths = allPaths.filter((p) => regex.test(p));

  if (matchingPaths.length === 0) return [];

  // Get all chunks for matching files
  const results: SearchResult[] = [];

  for (const filePath of matchingPaths) {
    if (results.length >= limit) break;

    const file = db.getFile(filePath);
    if (!file) continue;

    const chunks = db.getChunksByFile(file.id);
    for (const chunk of chunks) {
      if (results.length >= limit) break;

      results.push({
        chunkId: chunk.id,
        filePath: file.path,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        name: chunk.name,
        type: chunk.type,
        text: chunk.text,
        score: 1.0,
        language: file.language,
      });
    }
  }

  return results;
}

// ── Path keyword search ──────────────────────────────────────────────────────

/** Score tiers for keyword-based path matching. */
const SCORE_DIR_EXACT = 1.0;
const SCORE_FILENAME = 0.9;
const SCORE_PARTIAL = 0.7;

/**
 * Search files by keyword matching against file paths.
 * Unlike glob-based pathSearch, this takes plain query terms and does
 * substring matching against indexed file paths.
 *
 * Scoring:
 * - Directory segment exact match → 1.0
 * - Filename (without extension) exact match → 0.9
 * - Partial path match (substring) → 0.7
 */
export function pathKeywordSearch(
  db: KontextDatabase,
  query: string,
  limit: number,
): SearchResult[] {
  const queryLower = query.toLowerCase();
  const allPaths = db.getAllFilePaths();

  // Score each path
  const scoredPaths: { filePath: string; score: number }[] = [];

  for (const filePath of allPaths) {
    const score = scorePathMatch(filePath, queryLower);
    if (score > 0) {
      scoredPaths.push({ filePath, score });
    }
  }

  if (scoredPaths.length === 0) return [];

  // Sort by score descending
  scoredPaths.sort((a, b) => b.score - a.score);

  // Collect chunks from matched files, respecting limit
  const results: SearchResult[] = [];

  for (const { filePath, score } of scoredPaths) {
    if (results.length >= limit) break;

    const file = db.getFile(filePath);
    if (!file) continue;

    const chunks = db.getChunksByFile(file.id);
    for (const chunk of chunks) {
      if (results.length >= limit) break;

      results.push({
        chunkId: chunk.id,
        filePath: file.path,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        name: chunk.name,
        type: chunk.type,
        text: chunk.text,
        score,
        language: file.language,
      });
    }
  }

  return results;
}

/** Score how well a file path matches a keyword query. Returns 0 for no match. */
function scorePathMatch(filePath: string, queryLower: string): number {
  const pathLower = filePath.toLowerCase();

  // Check directory segments for exact match
  const segments = pathLower.split("/");
  const dirSegments = segments.slice(0, -1); // all but filename
  for (const seg of dirSegments) {
    if (seg === queryLower) return SCORE_DIR_EXACT;
  }

  // Check filename (without extension) for exact match
  const fileName = segments[segments.length - 1];
  const fileNameNoExt = fileName.replace(/\.[^.]+$/, "");
  if (fileNameNoExt === queryLower) return SCORE_FILENAME;

  // Check for substring match anywhere in the path
  if (pathLower.includes(queryLower)) return SCORE_PARTIAL;

  return 0;
}

// ── Dependency trace (BFS) ───────────────────────────────────────────────────

const DEPTH_SCORE_BASE = 1.0;
const DEPTH_SCORE_DECAY = 0.2;

/** BFS traversal of the import/dependency graph. Scores decay with depth. */
export function dependencyTrace(
  db: KontextDatabase,
  chunkId: number,
  direction: "imports" | "importedBy",
  depth: number,
): SearchResult[] {
  const visited = new Set<number>();
  visited.add(chunkId); // Don't include the starting chunk itself

  const results: SearchResult[] = [];
  let frontier = [chunkId];

  for (let d = 0; d < depth; d++) {
    const nextFrontier: number[] = [];

    for (const currentId of frontier) {
      const neighbors = getNeighbors(db, currentId, direction);

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        nextFrontier.push(neighborId);
      }
    }

    if (nextFrontier.length === 0) break;

    // Fetch metadata for this depth level
    const chunks = db.getChunksByIds(nextFrontier);
    const score = DEPTH_SCORE_BASE - d * DEPTH_SCORE_DECAY;

    for (const chunk of chunks) {
      results.push({
        chunkId: chunk.id,
        filePath: chunk.filePath,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        name: chunk.name,
        type: chunk.type,
        text: chunk.text,
        score,
        language: chunk.language,
      });
    }

    frontier = nextFrontier;
  }

  return results;
}

function getNeighbors(
  db: KontextDatabase,
  chunkId: number,
  direction: "imports" | "importedBy",
): number[] {
  if (direction === "imports") {
    return db.getDependencies(chunkId).map((d) => d.targetChunkId);
  }
  return db.getReverseDependencies(chunkId).map((d) => d.sourceChunkId);
}
