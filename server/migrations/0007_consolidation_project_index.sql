-- index.tsのCONSOLIDATION_PROJECT_KEY_SQLと同じ式で対象projectの走査を限定する。
CREATE INDEX idx_memories_consolidation_project
ON memories (
  CASE
    WHEN json_type(metadata_json, '$.sm_project_id') = 'text'
         AND length(trim(json_extract(metadata_json, '$.sm_project_id'))) > 0
      THEN 'project:' || json_extract(metadata_json, '$.sm_project_id')
    ELSE 'container:' || container_tag
  END
)
WHERE is_forgotten = 0 AND json_extract(metadata_json, '$.sm_consolidation') IS NOT 1;
