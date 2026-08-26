export type BackupScalar = string | number | null;
export type BackupRow = Record<string, BackupScalar>;

// Purge claims and idempotency receipts are operational state, not logical
// backup content. Restore must discard claims that could otherwise act on
// records re-created from a snapshot.
export const systemRestoreOperationalResetSql =
  "DELETE FROM entity_purge_jobs";

export const projectRestorePurgeJobCleanupSql = `DELETE FROM entity_purge_jobs
WHERE
  (entity_type = 'project' AND (
    entity_id = ? OR entity_id IN (
      SELECT json_extract(row_json, '$.id') FROM user_import_rows
      WHERE import_id = ? AND row_type = 'projects'
    )
  )) OR
  (entity_type = 'release' AND (
    entity_id IN (SELECT id FROM releases WHERE project_id = ?) OR
    entity_id IN (
      SELECT json_extract(row_json, '$.id') FROM user_import_rows
      WHERE import_id = ? AND row_type = 'releases'
    )
  )) OR
  (entity_type = 'task' AND (
    entity_id IN (SELECT id FROM tasks WHERE project_id = ?) OR
    entity_id IN (
      SELECT json_extract(row_json, '$.id') FROM user_import_rows
      WHERE import_id = ? AND row_type = 'tasks'
    )
  )) OR
  (entity_type = 'saved_view' AND (
    entity_id IN (SELECT id FROM saved_views WHERE scope_project_id = ?) OR
    entity_id IN (
      SELECT json_extract(row_json, '$.id') FROM user_import_rows
      WHERE import_id = ? AND row_type = 'saved_views'
    )
  ))`;

export function projectRestorePurgeJobCleanupParameters(
  projectId: string,
  importId: string,
) {
  return [
    projectId,
    importId,
    projectId,
    importId,
    projectId,
    importId,
    projectId,
    importId,
  ];
}
