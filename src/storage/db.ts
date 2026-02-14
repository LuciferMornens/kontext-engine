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
  getVectorCount,
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

export interface ChunkWithFile {
  id: number;
  fileId: number;
  filePath: string;
  language: string;
  lineStart: number;
  lineEnd: number;
  type: string;
  name: string | null;
  parent: string | null;
  text: string;
  exports: boolean;
}

export interface ChunkSearchFilters {
  name?: string;
  nameMode?: "exact" | "prefix" | "contains";
  type?: string;
  parent?: string;
  language?: string;
}

export interface FTSResult {
  chunkId: number;
  name: string | null;
  rank: number;
}

/** Main database interface. Provides CRUD for files, chunks, vectors, FTS, and stats. */
export interface KontextDatabase {
  // Files
  upsertFile(file: FileInput): number;
  getFile(filePath: string): FileRecord | null;
  getFilesByHash(hashes: Map<string, string>): Map<string, FileRecord>;
  deleteFile(filePath: string): void;

  // Chunks
  insertChunks(fileId: number, chunks: ChunkInput[]): number[];
  getChunksByFile(fileId: number): ChunkRecord[];
  getChunksByIds(ids: number[]): ChunkWithFile[];
  deleteChunksByFile(fileId: number): void;

  // Dependencies
  insertDependency(sourceChunkId: number, targetChunkId: number, type: string): void;
  getDependencies(chunkId: number): { targetChunkId: number; type: string }[];
  getReverseDependencies(chunkId: number): { sourceChunkId: number; type: string }[];

  // Vectors
  insertVector(chunkId: number, vector: Float32Array): void;
  searchVectors(query: Float32Array, limit: number): VectorResult[];

  // AST / structured search
  searchChunks(filters: ChunkSearchFilters, limit: number): ChunkWithFile[];

  // FTS
  searchFTS(query: string, limit: number): FTSResult[];

  // All file paths (for incremental diff)
  getAllFilePaths(): string[];

  // Stats
  getFileCount(): number;
  getChunkCount(): number;
  getVectorCount(): number;
  getLanguageBreakdown(): Map<string, number>;
  getLastIndexed(): string | null;

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

/** Create or open a SQLite database at the given path. Initializes schema and loads sqlite-vec. */
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

  const stmtInsertDep = db.prepare(
    "INSERT INTO dependencies (source_chunk_id, target_chunk_id, type) VALUES (?, ?, ?)",
  );

  const stmtGetDeps = db.prepare(
    "SELECT target_chunk_id as targetChunkId, type FROM dependencies WHERE source_chunk_id = ?",
  );

  const stmtGetReverseDeps = db.prepare(
    "SELECT source_chunk_id as sourceChunkId, type FROM dependencies WHERE target_chunk_id = ?",
  );

  const stmtFileCount = db.prepare("SELECT COUNT(*) as count FROM files");
  const stmtChunkCount = db.prepare("SELECT COUNT(*) as count FROM chunks");
  const stmtLanguageBreakdown = db.prepare(
    "SELECT language, COUNT(*) as count FROM files GROUP BY language ORDER BY count DESC",
  );
  const stmtLastIndexed = db.prepare(
    "SELECT MAX(last_indexed) as lastIndexed FROM files",
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

    getAllFilePaths(): string[] {
      const rows = stmtGetAllFiles.all() as FileRecord[];
      return rows.map((r) => r.path);
    },

    getFileCount(): number {
      return (stmtFileCount.get() as { count: number }).count;
    },

    getChunkCount(): number {
      return (stmtChunkCount.get() as { count: number }).count;
    },

    getVectorCount(): number {
      return getVectorCount(db);
    },

    getLanguageBreakdown(): Map<string, number> {
      const rows = stmtLanguageBreakdown.all() as { language: string; count: number }[];
      const map = new Map<string, number>();
      for (const row of rows) {
        map.set(row.language, row.count);
      }
      return map;
    },

    getLastIndexed(): string | null {
      const row = stmtLastIndexed.get() as { lastIndexed: string | null };
      return row.lastIndexed;
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

    getChunksByIds(ids: number[]): ChunkWithFile[] {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT c.id, c.file_id as fileId, f.path as filePath, f.language,
                  c.line_start as lineStart, c.line_end as lineEnd,
                  c.type, c.name, c.parent, c.text, c.exports as exports
           FROM chunks c
           JOIN files f ON f.id = c.file_id
           WHERE c.id IN (${placeholders})`,
        )
        .all(...ids) as {
        id: number;
        fileId: number;
        filePath: string;
        language: string;
        lineStart: number;
        lineEnd: number;
        type: string;
        name: string | null;
        parent: string | null;
        text: string;
        exports: number;
      }[];
      return rows.map((r) => ({
        ...r,
        exports: r.exports === 1,
      }));
    },

    searchChunks(filters: ChunkSearchFilters, limit: number): ChunkWithFile[] {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filters.name) {
        switch (filters.nameMode ?? "contains") {
          case "exact":
            conditions.push("c.name = ?");
            params.push(filters.name);
            break;
          case "prefix":
            conditions.push("c.name LIKE ? || '%'");
            params.push(filters.name);
            break;
          case "contains":
            conditions.push("c.name LIKE '%' || ? || '%'");
            params.push(filters.name);
            break;
        }
      }

      if (filters.type) {
        conditions.push("c.type = ?");
        params.push(filters.type);
      }

      if (filters.parent) {
        conditions.push("c.parent = ?");
        params.push(filters.parent);
      }

      if (filters.language) {
        conditions.push("f.language = ?");
        params.push(filters.language);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const sql = `
        SELECT c.id, c.file_id as fileId, f.path as filePath, f.language,
               c.line_start as lineStart, c.line_end as lineEnd,
               c.type, c.name, c.parent, c.text, c.exports as exports
        FROM chunks c
        JOIN files f ON f.id = c.file_id
        ${where}
        ORDER BY c.name, c.line_start
        LIMIT ?
      `;

      params.push(limit);
      const rows = db.prepare(sql).all(...params) as {
        id: number;
        fileId: number;
        filePath: string;
        language: string;
        lineStart: number;
        lineEnd: number;
        type: string;
        name: string | null;
        parent: string | null;
        text: string;
        exports: number;
      }[];
      return rows.map((r) => ({
        ...r,
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

    insertDependency(sourceChunkId: number, targetChunkId: number, type: string): void {
      stmtInsertDep.run(sourceChunkId, targetChunkId, type);
    },

    getDependencies(chunkId: number): { targetChunkId: number; type: string }[] {
      return stmtGetDeps.all(chunkId) as { targetChunkId: number; type: string }[];
    },

    getReverseDependencies(chunkId: number): { sourceChunkId: number; type: string }[] {
      return stmtGetReverseDeps.all(chunkId) as { sourceChunkId: number; type: string }[];
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
