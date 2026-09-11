ALTER TABLE memories ADD COLUMN topic_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (topic_status IN ('pending', 'processing', 'done', 'failed', 'disabled'));
ALTER TABLE memories ADD COLUMN topic_model TEXT;
ALTER TABLE memories ADD COLUMN topics_extracted_at TEXT;
ALTER TABLE memories ADD COLUMN topic_revision TEXT;

CREATE TABLE memory_topics (
  memory_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  topic TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, topic_key),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX idx_memory_topics_topic
  ON memory_topics(topic_key, memory_id);
