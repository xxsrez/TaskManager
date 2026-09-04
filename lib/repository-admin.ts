import { assertAdmin, buildAdminOverview } from "./admin";
import { scanAttachmentStorageOwnership } from "./attachment-storage-audit";
import { getRuntimeEnvironment } from "./runtime-environment";
import { mapAdminUserAggregate, type DbRow } from "./repository-mappers";
import type { UserRecord } from "./types";
import { getD1 } from "@/db";

function adminEmailsFromEnvironment(): string {
  return getRuntimeEnvironment().TASK_MANAGER_ADMIN_EMAILS ?? "";
}
export async function getAdminOverview(
  currentUser: UserRecord,
  configuredAdminEmails = adminEmailsFromEnvironment(),
) {
  assertAdmin(currentUser, configuredAdminEmails);
  const db = getD1();
  const [rows, storage] = await Promise.all([
    db
    .prepare(
      `SELECT
         u.id, u.display_name, u.email, u.created_at, u.updated_at,
         COALESCE(task_stats.task_count, 0) AS task_count,
         COALESCE(task_stats.recent_task_count, 0) AS recent_task_count,
         task_stats.last_task_activity_at,
         COALESCE(project_stats.project_count, 0) AS project_count,
         project_stats.last_project_activity_at,
         COALESCE(release_stats.release_count, 0) AS release_count,
         release_stats.last_release_activity_at,
         COALESCE(view_stats.view_count, 0) AS view_count,
         view_stats.last_view_activity_at,
         COALESCE(attachment_stats.attachment_count, 0) AS attachment_count,
         COALESCE(attachment_stats.attachment_bytes, 0) AS attachment_bytes,
         COALESCE(attachment_stats.pending_attachment_count, 0) AS pending_attachment_count,
         COALESCE(attachment_stats.failed_attachment_count, 0) AS failed_attachment_count,
         COALESCE(attachment_stats.deleted_attachment_count, 0) AS deleted_attachment_count
       FROM users u
       LEFT JOIN (
         SELECT t.owner_user_id,
                COUNT(*) AS task_count,
                SUM(CASE
                  WHEN datetime(t.updated_at) >= datetime('now', '-7 days')
                  THEN 1 ELSE 0
                END) AS recent_task_count,
                MAX(t.updated_at) AS last_task_activity_at
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.deleted_at IS NULL
           AND (t.project_id IS NULL OR p.deleted_at IS NULL)
         GROUP BY t.owner_user_id
       ) task_stats ON task_stats.owner_user_id = u.id
       LEFT JOIN (
         SELECT owner_user_id,
                COUNT(*) AS project_count,
                MAX(updated_at) AS last_project_activity_at
         FROM projects WHERE deleted_at IS NULL
         GROUP BY owner_user_id
       ) project_stats ON project_stats.owner_user_id = u.id
       LEFT JOIN (
         SELECT r.owner_user_id,
                COUNT(*) AS release_count,
                MAX(r.updated_at) AS last_release_activity_at
         FROM releases r JOIN projects p ON p.id = r.project_id
         WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL
         GROUP BY r.owner_user_id
       ) release_stats ON release_stats.owner_user_id = u.id
       LEFT JOIN (
         SELECT v.owner_user_id,
                COUNT(*) AS view_count,
                MAX(v.updated_at) AS last_view_activity_at
         FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
         WHERE v.deleted_at IS NULL
           AND (v.scope_project_id IS NULL OR p.deleted_at IS NULL)
         GROUP BY v.owner_user_id
       ) view_stats ON view_stats.owner_user_id = u.id
       LEFT JOIN (
         SELECT COALESCE(p.owner_user_id, t.owner_user_id) AS owner_user_id,
                COUNT(*) AS attachment_count,
                COALESCE(SUM(a.byte_size), 0) AS attachment_bytes,
                SUM(CASE WHEN a.state IN ('pending', 'uploading') THEN 1 ELSE 0 END)
                  AS pending_attachment_count,
                SUM(CASE WHEN a.state = 'failed' THEN 1 ELSE 0 END)
                  AS failed_attachment_count,
                SUM(CASE WHEN a.state = 'deleted' THEN 1 ELSE 0 END)
                  AS deleted_attachment_count
         FROM attachments a JOIN tasks t ON t.id = a.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.deleted_at IS NULL
           AND (t.project_id IS NULL OR p.deleted_at IS NULL)
         GROUP BY COALESCE(p.owner_user_id, t.owner_user_id)
       ) attachment_stats ON attachment_stats.owner_user_id = u.id
       ORDER BY datetime(u.updated_at) DESC, datetime(u.created_at) DESC`,
    )
    .all<DbRow>(),
    scanAttachmentStorageOwnership(db),
  ]);

  return buildAdminOverview(
    rows.results.map(mapAdminUserAggregate),
    configuredAdminEmails,
    Date.now(),
    storage,
  );
}
