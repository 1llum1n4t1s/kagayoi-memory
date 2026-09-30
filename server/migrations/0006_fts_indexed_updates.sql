-- 派生状態だけの更新ではFTS本文を再索引しない。
DROP TRIGGER IF EXISTS memories_after_update;
CREATE TRIGGER memories_after_update
AFTER UPDATE ON memories
WHEN old.content IS NOT new.content OR old.container_tag IS NOT new.container_tag
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, container_tag)
  VALUES ('delete', old.rowid, old.content, old.container_tag);
  INSERT INTO memories_fts(rowid, content, container_tag)
  VALUES (new.rowid, new.content, new.container_tag);
END;
