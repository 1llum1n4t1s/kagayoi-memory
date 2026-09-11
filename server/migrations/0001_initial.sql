CREATE TABLE IF NOT EXISTS container_tags (
  tag TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  custom_id TEXT NOT NULL,
  container_tag TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  entity_context TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  is_forgotten INTEGER NOT NULL DEFAULT 0 CHECK (is_forgotten IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (container_tag, custom_id),
  FOREIGN KEY (container_tag) REFERENCES container_tags(tag) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memories_container_updated
  ON memories(container_tag, is_forgotten, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  container_tag UNINDEXED,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_after_insert
AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, container_tag)
  VALUES (new.rowid, new.content, new.container_tag);
END;

CREATE TRIGGER IF NOT EXISTS memories_after_delete
AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, container_tag)
  VALUES ('delete', old.rowid, old.content, old.container_tag);
END;

CREATE TRIGGER IF NOT EXISTS memories_after_update
AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, container_tag)
  VALUES ('delete', old.rowid, old.content, old.container_tag);
  INSERT INTO memories_fts(rowid, content, container_tag)
  VALUES (new.rowid, new.content, new.container_tag);
END;
