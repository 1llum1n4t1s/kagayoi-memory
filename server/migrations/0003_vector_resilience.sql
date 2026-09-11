ALTER TABLE memories ADD COLUMN embedding_json TEXT;
ALTER TABLE memories ADD COLUMN vector_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (vector_status IN ('pending', 'queued', 'indexed', 'failed', 'disabled'));
ALTER TABLE memories ADD COLUMN vector_mutation_id TEXT;
ALTER TABLE memories ADD COLUMN vector_attempted_at TEXT;

CREATE INDEX idx_memories_vector_reconcile
  ON memories(vector_status, is_forgotten, vector_attempted_at)
  WHERE embedding_json IS NOT NULL;
