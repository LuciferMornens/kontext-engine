export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    language TEXT NOT NULL,
    hash TEXT NOT NULL,
    last_indexed INTEGER NOT NULL,
    size INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    type TEXT NOT NULL,
    name TEXT,
    parent TEXT,
    text TEXT NOT NULL,
    imports JSON,
    exports INTEGER DEFAULT 0,
    hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    target_chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    type TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name);
  CREATE INDEX IF NOT EXISTS idx_deps_source ON dependencies(source_chunk_id);
  CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_chunk_id);
`;

export const FTS_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    name, text, parent,
    content=chunks,
    content_rowid=id
  );
`;

export const FTS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, name, text, parent)
    VALUES (new.id, new.name, new.text, new.parent);
  END;

  CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, name, text, parent)
    VALUES ('delete', old.id, old.name, old.text, old.parent);
  END;

  CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, name, text, parent)
    VALUES ('delete', old.id, old.name, old.text, old.parent);
    INSERT INTO chunks_fts(rowid, name, text, parent)
    VALUES (new.id, new.name, new.text, new.parent);
  END;
`;

export const VECTOR_TABLE_SQL = (dimensions: number): string =>
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
    embedding float[${dimensions}]
  );`;
