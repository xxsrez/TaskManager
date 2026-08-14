export const linearApplyGuardSql = `INSERT INTO user_import_rows (import_id, row_type, ordinal, row_json)
  SELECT NULL, 'apply_guard', 0, '{}' WHERE EXISTS (
    SELECT 1 FROM projects p JOIN user_import_rows r
      ON r.import_id = ? AND r.row_type = 'projects' AND p.id = json_extract(r.row_json, '$.id')
      WHERE p.owner_user_id <> ?
    UNION ALL
    SELECT 1 FROM releases x JOIN projects p ON p.id = x.project_id JOIN user_import_rows r
      ON r.import_id = ? AND r.row_type = 'releases' AND x.id = json_extract(r.row_json, '$.id')
      WHERE p.owner_user_id <> ?
    UNION ALL
    SELECT 1 FROM tasks x LEFT JOIN projects p ON p.id = x.project_id JOIN user_import_rows r
      ON r.import_id = ? AND r.row_type = 'tasks' AND x.id = json_extract(r.row_json, '$.id')
      WHERE coalesce(p.owner_user_id, x.owner_user_id) <> ?
    UNION ALL
    SELECT 1 FROM saved_views x LEFT JOIN projects p ON p.id = x.scope_project_id JOIN user_import_rows r
      ON r.import_id = ? AND r.row_type = 'saved_views' AND x.id = json_extract(r.row_json, '$.id')
      WHERE coalesce(p.owner_user_id, x.owner_user_id) <> ?
    UNION ALL
    SELECT 1 FROM workflow_statuses x JOIN user_import_rows r
      ON r.import_id = ? AND r.row_type = 'workflow_statuses' AND x.id = json_extract(r.row_json, '$.id')
      WHERE x.owner_user_id <> ?
    UNION ALL
    SELECT 1 FROM labels x JOIN user_import_rows r
      ON r.import_id = ? AND r.row_type = 'labels' AND x.id = json_extract(r.row_json, '$.id')
      WHERE x.owner_user_id <> ?
    UNION ALL
    SELECT 1 FROM external_records x JOIN user_import_rows r
      ON r.import_id = ? AND r.row_type = 'external_records' AND x.id = json_extract(r.row_json, '$.id')
      WHERE x.owner_user_id <> ?
    UNION ALL
    SELECT 1 FROM user_import_rows r
      WHERE r.import_id = ? AND r.row_type = 'tasks'
        AND json_extract(r.row_json, '$.assignee_user_id') IS NOT NULL
        AND json_extract(r.row_json, '$.assignee_user_id') <> ?
        AND (
          json_extract(r.row_json, '$.project_id') IS NULL OR NOT EXISTS (
            SELECT 1 FROM access_grants ag WHERE ag.resource_type = 'project'
              AND ag.resource_id = json_extract(r.row_json, '$.project_id')
              AND ag.grantee_user_id = json_extract(r.row_json, '$.assignee_user_id')
              AND ag.revoked_at IS NULL
          )
        )
    UNION ALL
    SELECT 1 FROM user_import_rows r
      WHERE r.import_id = ? AND r.row_type = 'projects'
        AND json_extract(r.row_json, '$.lead_user_id') IS NOT NULL
        AND json_extract(r.row_json, '$.lead_user_id') <> ?
        AND NOT EXISTS (
          SELECT 1 FROM access_grants ag WHERE ag.resource_type = 'project'
            AND ag.resource_id = json_extract(r.row_json, '$.id')
            AND ag.grantee_user_id = json_extract(r.row_json, '$.lead_user_id')
            AND ag.revoked_at IS NULL
        )
  )`;

export function linearApplyGuardBindings(importId: string, ownerUserId: string) {
  return Array.from({ length: 9 }, () => [importId, ownerUserId]).flat();
}
