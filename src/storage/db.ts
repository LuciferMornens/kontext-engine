import path from "node:path";
import fs from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  SCHEMA_SQL,
  FTS_SQL,
  FTS_TRIGGERS_SQL,
  VECTOR_TABLE_SQL,
  SCHEMA_VERSION as SCHEMA_V,
} from "./schema.js";
import {
  insertVector as vecInsert,
  deleteVectorsByChunkIds,
  searchVectors as vecSearch,
} from "./vectors.js";
import type { VectorResult } from "./vectors.js";

export { SCHEMA_VERSION } from "./schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FileInput {
  path: string;
  language: string;
  hash: string;
  size: number;
}

export interface FileRecord {
  id: number;
  path: string;
  language: string;
  hash: string;
  lastIndexed: number;
  size: number;
}

export interface ChunkInput {
  lineStart: number;
  lineEnd: number;
  type: string;
  name: string | null;
  parent: string | null;
  text: string;
  imports: string[];
  exports: boolean;
  hash: string;
}

export interface ChunkRecord {
  id: number;
  fileId: number;
  lineStart: number;
  lineEnd: number;
  type: string;
  name: string | null;
  parent: string | null;
  text: string;
  imports: string[];
  exports: boolean;
  hash: string;
}

export interface FTSResult {
  chunkId: number;
  name: string | null;
  rank: number;
}

export interface KontextDatabase {
  // Files
  upsertFile(file: FileInput): number;
  getFile(filePath: string): FileRecord | null;
  getFilesByHash(hashes: Map<string, string>): Map<string, FileRecord>;
  deleteFile(filePath: string): void;

  // Chunks
  insertChunks(fileId: number, chunks: ChunkInput[]): number[];
  getChunksByFile(fileId: number): ChunkRecord[];
  deleteChunksByFile(fileId: number): void;

  // Vectors
  insertVector(chunkId: number, vector: Float32Array): void;
  searchVectors(query: Float32Array, limit: number): VectorResult[];

  // FTS
  searchFTS(query: string, limit: number): FTSResult[];

  // Transactions
  transaction<T>(fn: () => T): T;

  // Maintenance
  vacuum(): void;
  close(): void;
  getSchemaVersion(): number;
  pragma(key: string): string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DIMENSIONS = 384;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createDatabase(
  dbPath: string,
  dimensions: number = DEFAULT_DIMENSIONS,
): KontextDatabase {
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new BetterSqlite3(dbPath);

  // Enable WAL mode and foreign keys
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Run schema migrations
  initializeSchema(db, dimensions);

  // ── Prepared statements ──────────────────────────────────────────────────

  const stmtUpsertFile = db.prepare(`
    INSERT INTO files (path, language, hash, last_indexed, size)
    VALUES (@path, @language, @hash, @lastIndexed, @size)
    ON CONFLICT(path) DO UPDATE SET
      language = excluded.language,
      hash = excluded.hash,
      last_indexed = excluded.last_indexed,
      size = excluded.size
  `);

  const stmtGetFile = db.prepare(
    "SELECT id, path, language, hash, last_indexed as lastIndexed, size FROM files WHERE path = ?",
  );

  const stmtDeleteFile = db.prepare("DELETE FROM files WHERE path = ?");

  const stmtInsertChunk = db.prepare(`
    INSERT INTO chunks (file_id, line_start, line_end, type, name, parent, text, imports, exports, hash)
    VALUES (@fileId, @lineStart, @lineEnd, @type, @name, @parent, @text, @imports, @exports, @hash)
  `);

  const stmtGetChunksByFile = db.prepare(
    "SELECT id, file_id as fileId, line_start as lineStart, line_end as lineEnd, type, name, parent, text, imports, exports, hash FROM chunks WHERE file_id = ? ORDER BY line_start",
  );

  const stmtGetChunkIdsByFile = db.prepare(
    "SELECT id FROM chunks WHERE file_id = ?",
  );

  const stmtDeleteChunksByFile = db.prepare(
    "DELETE FROM chunks WHERE file_id = ?",
  );

  const stmtSearchFTS = db.prepare(
    "SELECT rowid as chunkId, name, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
  );

  const stmtGetAllFiles = db.prepare(
    "SELECT id, path, language, hash, last_indexed as lastIndexed, size FROM files",
  );

  // ── Implementation ───────────────────────────────────────────────────────

  return {
    upsertFile(file: FileInput): number {
      const result = stmtUpsertFile.run({
        path: file.path,
        language: file.language,
        hash: file.hash,
        lastIndexed: Date.now(),
        size: file.size,
      });
      if (result.changes > 0 && result.lastInsertRowid) {
        return Number(result.lastInsertRowid);
      }
      // On update, fetch the id
      const existing = stmtGetFile.get(file.path) as FileRecord | undefined;
      return existing?.id ?? 0;
    },

    getFile(filePath: string): FileRecord | null {
      const row = stmtGetFile.get(filePath) as FileRecord | undefined;
      return row ?? null;
    },

    getFilesByHash(hashes: Map<string, string>): Map<string, FileRecord> {
      const result = new Map<string, FileRecord>();
      const allFiles = stmtGetAllFiles.all() as FileRecord[];
      for (const file of allFiles) {
        const expectedHash = hashes.get(file.path);
        if (expectedHash !== undefined && expectedHash === file.hash) {
          result.set(file.path, file);
        }
      }
      return result;
    },

    deleteFile(filePath: string): void {
      // Get chunk ids first for vector cleanup
      const file = stmtGetFile.get(filePath) as FileRecord | undefined;
      if (file) {
        const chunkRows = stmtGetChunkIdsByFile.all(file.id) as { id: number }[];
        const chunkIds = chunkRows.map((r) => r.id);
        if (chunkIds.length > 0) {
          deleteVectorsByChunkIds(db, chunkIds);
        }
      }
      // CASCADE will handle chunks and FTS triggers
      stmtDeleteFile.run(filePath);
    },

    insertChunks(fileId: number, chunks: ChunkInput[]): number[] {
      const ids: number[] = [];
      for (const chunk of chunks) {
        const result = stmtInsertChunk.run({
          fileId,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          type: chunk.type,
          name: chunk.name,
          parent: chunk.parent,
          text: chunk.text,
          imports: JSON.stringify(chunk.imports),
          exports: chunk.exports ? 1 : 0,
          hash: chunk.hash,
        });
        ids.push(Number(result.lastInsertRowid));
      }
      return ids;
    },

    getChunksByFile(fileId: number): ChunkRecord[] {
      const rows = stmtGetChunksByFile.all(fileId) as {
        id: number;
        fileId: number;
        lineStart: number;
        lineEnd: number;
        type: string;
        name: string | null;
        parent: string | null;
        text: string;
        imports: string;
        exports: number;
        hash: string;
      }[];

      return rows.map((r) => ({
        ...r,
        imports: JSON.parse(r.imports) as string[],
        exports: r.exports === 1,
      }));
    },

    deleteChunksByFile(fileId: number): void {
      const chunkRows = stmtGetChunkIdsByFile.all(fileId) as { id: number }[];
      const chunkIds = chunkRows.map((r) => r.id);
      if (chunkIds.length > 0) {
        deleteVectorsByChunkIds(db, chunkIds);
      }
      stmtDeleteChunksByFile.run(fileId);
    },

    insertVector(chunkId: number, vector: Float32Array): void {
      vecInsert(db, chunkId, vector);
    },

    searchVectors(query: Float32Array, limit: number): VectorResult[] {
      return vecSearch(db, query, limit);
    },

    searchFTS(query: string, limit: number): FTSResult[] {
      const rows = stmtSearchFTS.all(query, limit) as {
        chunkId: number;
        name: string | null;
        rank: number;
      }[];
      return rows;
    },

    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    vacuum(): void {
      db.exec("VACUUM");
    },

    close(): void {
      db.close();
    },

    getSchemaVersion(): number {
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      return row ? parseInt(row.value, 10) : 0;
    },

    pragma(key: string): string {
      const result = db.pragma(key) as { journal_mode: string }[];
      if (Array.isArray(result) && result.length > 0) {
        return Object.values(result[0])[0] as string;
      }
      return String(result);
    },
  };
}

// ── Schema initialization ────────────────────────────────────────────────────

function initializeSchema(
  db: BetterSqlite3.Database,
  dimensions: number,
): void {
  const currentVersion = getMetaVersion(db);

  if (currentVersion >= SCHEMA_V) return;

  db.exec(SCHEMA_SQL);
  db.exec(VECTOR_TABLE_SQL(dimensions));
  db.exec(FTS_SQL);
  db.exec(FTS_TRIGGERS_SQL);

  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(SCHEMA_V));
}

function getMetaVersion(db: BetterSqlite3.Database): number {
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    // meta table doesn't exist yet
    return 0;
  }
}
