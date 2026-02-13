import type BetterSqlite3 from "better-sqlite3";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VectorResult {
  chunkId: number;
  distance: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ── Operations ───────────────────────────────────────────────────────────────

export function insertVector(
  db: BetterSqlite3.Database,
  chunkId: number,
  vector: Float32Array,
): void {
  // sqlite-vec requires literal integer rowid — parameterized rowid fails
  db.prepare(
    `INSERT INTO chunk_vectors(rowid, embedding) VALUES (${chunkId}, ?)`,
  ).run(vecToBuffer(vector));
}

export function deleteVectorsByChunkIds(
  db: BetterSqlite3.Database,
  chunkIds: number[],
): void {
  if (chunkIds.length === 0) return;
  const placeholders = chunkIds.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM chunk_vectors WHERE rowid IN (${placeholders})`,
  ).run(...chunkIds);
}

export function searchVectors(
  db: BetterSqlite3.Database,
  query: Float32Array,
  limit: number,
): VectorResult[] {
  const rows = db
    .prepare(
      `SELECT rowid, distance
       FROM chunk_vectors
       WHERE embedding MATCH ?
         AND k = ${limit}
       ORDER BY distance`,
    )
    .all(vecToBuffer(query)) as { rowid: number; distance: number }[];

  return rows.map((r) => ({
    chunkId: r.rowid,
    distance: r.distance,
  }));
}
