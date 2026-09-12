CREATE TABLE memory_consolidation_projects (
  project_key TEXT PRIMARY KEY,
  project_id TEXT,
  source_container_tag TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  initial_backfill_completed INTEGER NOT NULL DEFAULT 0 CHECK (initial_backfill_completed IN (0, 1)),
  active_consolidation_id TEXT,
  last_success_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memory_consolidations (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  memory_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'invalid')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_key, revision),
  FOREIGN KEY (project_key) REFERENCES memory_consolidation_projects(project_key) ON DELETE CASCADE,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_memory_consolidations_active_project
  ON memory_consolidations(project_key)
  WHERE status = 'active';

CREATE INDEX idx_memory_consolidations_status
  ON memory_consolidations(status, updated_at DESC);

CREATE TABLE memory_consolidation_sources (
  consolidation_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  PRIMARY KEY (consolidation_id, memory_id),
  FOREIGN KEY (consolidation_id) REFERENCES memory_consolidations(id) ON DELETE CASCADE,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX idx_memory_consolidation_sources_memory
  ON memory_consolidation_sources(memory_id, source_revision);
