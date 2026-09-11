ALTER TABLE memories ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (embedding_status IN ('pending', 'processing', 'done', 'failed', 'disabled'));
ALTER TABLE memories ADD COLUMN fact_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (fact_status IN ('pending', 'processing', 'done', 'failed', 'disabled'));
ALTER TABLE memories ADD COLUMN embedding_model TEXT;
ALTER TABLE memories ADD COLUMN fact_model TEXT;
ALTER TABLE memories ADD COLUMN embedded_at TEXT;
ALTER TABLE memories ADD COLUMN facts_extracted_at TEXT;
ALTER TABLE memories ADD COLUMN enrichment_error TEXT;

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  container_tag TEXT NOT NULL,
  source_memory_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  predicate_key TEXT NOT NULL,
  object_key TEXT NOT NULL,
  is_exclusive INTEGER NOT NULL DEFAULT 0 CHECK (is_exclusive IN (0, 1)),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (container_tag, source_memory_id, subject_key, predicate_key, object_key),
  FOREIGN KEY (container_tag) REFERENCES container_tags(tag) ON DELETE CASCADE,
  FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX idx_facts_container_status
  ON facts(container_tag, status, updated_at DESC);
CREATE INDEX idx_facts_identity
  ON facts(container_tag, subject_key, predicate_key, status);
CREATE INDEX idx_facts_source
  ON facts(source_memory_id);

CREATE TABLE fact_relations (
  id TEXT PRIMARY KEY,
  container_tag TEXT NOT NULL,
  from_fact_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'supersedes', 'related')),
  to_fact_id TEXT NOT NULL,
  source_memory_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  UNIQUE (from_fact_id, relation, to_fact_id),
  FOREIGN KEY (container_tag) REFERENCES container_tags(tag) ON DELETE CASCADE,
  FOREIGN KEY (from_fact_id) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (to_fact_id) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX idx_fact_relations_container
  ON fact_relations(container_tag, relation, created_at DESC);
CREATE INDEX idx_fact_relations_target
  ON fact_relations(to_fact_id);
