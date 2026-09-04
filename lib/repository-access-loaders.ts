import { canEditContent, type AccessRole } from "./access";
import {
  projectAccessRoleSql,
  projectEffectiveRoleRankSql,
  savedViewAccessRoleSql,
  taskAccessRoleSql,
} from "./access-sql";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";
import {
  mapProject,
  mapRelease,
  mapStatus,
  mapTask,
  mapView,
  type DbRow,
} from "./repository-mappers";
import type { ReleaseRecord, TaskRecord } from "./types";
import { getD1 } from "@/db";

export async function loadAccessibleTasks(
  userId: string,
  taskIds: string[],
  maskProjectMetadata = false,
) {
  if (!taskIds.length) return [];
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT t.*,
           CASE WHEN t.release_id IS NULL OR EXISTS (
             SELECT 1 FROM releases active_release
             WHERE active_release.id = t.release_id
               AND active_release.deleted_at IS NULL
           ) THEN t.release_id ELSE NULL END AS visible_release_id,
           CASE WHEN t.parent_task_id IS NULL OR EXISTS (
             SELECT 1 FROM tasks active_parent
             LEFT JOIN projects active_parent_project
               ON active_parent_project.id = active_parent.project_id
             WHERE active_parent.id = t.parent_task_id
               AND active_parent.deleted_at IS NULL
               AND (active_parent.project_id IS NULL
                 OR active_parent_project.deleted_at IS NULL)
           ) THEN t.parent_task_id ELSE NULL END AS visible_parent_task_id,
           ${taskAccessRoleSql("t", "p")} AS access_role,
           ${projectAccessRoleSql("p")} AS project_access_role
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.id IN (${placeholders}) OR t.public_id IN (${placeholders})
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, userId, userId, userId, userId, ...taskIds, ...taskIds)
    .all<DbRow>();
  if (rows.results.length !== taskIds.length) {
    throw new NotFoundError("One or more tasks were not found");
  }
  const taskByAddress = new Map<string, TaskRecord>();
  for (const row of rows.results) {
    const task = mapTask(maskProjectMetadata ? row : {
      ...row,
      project_access_role: row.project_id == null ? null : "internal",
    });
    taskByAddress.set(task.id, task);
    taskByAddress.set(task.publicId, task);
  }
  return taskIds.map((taskId) => taskByAddress.get(taskId)!);
}

export async function loadAccessibleTask(
  userId: string,
  taskId: string,
  maskProjectMetadata = false,
) {
  const [task] = await loadAccessibleTasks(userId, [taskId], maskProjectMetadata);
  return task!;
}

export async function loadAccessibleProject(userId: string, projectId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT p.*,
           ${projectAccessRoleSql("p")} AS access_role
         FROM projects p WHERE p.id = ? OR p.public_id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, projectId, projectId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Project not found");
  return mapProject(row);
}

export async function loadAccessibleRelease(userId: string, releaseId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT r.*,
           ${projectAccessRoleSql("p")} AS access_role
         FROM releases r JOIN projects p ON p.id = r.project_id
         WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL
           AND (r.id = ? OR r.public_id = ?)
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, releaseId, releaseId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Release not found");
  return mapRelease(row);
}

export async function loadAccessibleStoredRelease(userId: string, releaseId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT r.*,
           ${projectAccessRoleSql("p")} AS access_role
         FROM releases r JOIN projects p ON p.id = r.project_id
         WHERE p.deleted_at IS NULL AND r.id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, releaseId)
    .first<DbRow>();
  if (!row) {
    throw new ConflictError(
      "Task Release or Project access changed before the mutation",
    );
  }
  return mapRelease(row);
}

export async function loadAccessibleView(userId: string, viewId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT v.*,
           ${savedViewAccessRoleSql("v", "p")} AS access_role
         FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
         WHERE v.id = ? OR v.public_id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, userId, userId, viewId, viewId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("View not found");
  return mapView(row);
}

export function requireContentEdit(role: AccessRole) {
  if (!canEditContent(role)) {
    throw new PermissionError("Editor access is required");
  }
}

export function assertReleasedCompositionChange(
  currentRelease: ReleaseRecord | null,
  nextRelease: ReleaseRecord | null,
  input: Record<string, unknown>,
) {
  if (currentRelease?.id === nextRelease?.id) return;
  if (
    (currentRelease?.status === "released" || nextRelease?.status === "released")
    && input.confirmReleasedComposition !== true
  ) {
    throw new ValidationError("Confirm changing the composition of a released Release");
  }
}

export async function loadStatus(
  ownerUserId: string,
  statusId: string | null,
  options: { allowArchived?: boolean } = {},
) {
  const row = statusId
    ? await getD1()
        .prepare(
          `SELECT * FROM workflow_statuses
           WHERE id = ? AND owner_user_id = ?${options.allowArchived ? "" : " AND archived_at IS NULL"}`,
        )
        .bind(statusId, ownerUserId)
        .first<DbRow>()
    : await getD1()
        .prepare(
          `SELECT * FROM workflow_statuses
           WHERE owner_user_id = ? AND archived_at IS NULL
           ORDER BY is_default DESC, position ASC LIMIT 1`,
        )
        .bind(ownerUserId)
        .first<DbRow>();
  if (!row) throw new ValidationError("Status is not available for this task");
  return mapStatus(row);
}

export function requestedAssigneeUserId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 200) {
    throw new ValidationError("Assignee is invalid");
  }
  return value;
}

export async function assertTaskAssigneeAccess(
  assigneeUserId: string | null,
  ownerUserId: string,
  projectId: string | null,
  taskId: string | null,
) {
  if (assigneeUserId === null) return;

  let row: DbRow | null;
  if (projectId) {
    row = await getD1()
      .prepare(
        `SELECT u.id FROM users u
         JOIN projects p ON p.id = ?
         WHERE u.id = ? AND (
           ${projectEffectiveRoleRankSql("p", "u.id")} > 0
           OR (? IS NOT NULL AND EXISTS (
             SELECT 1 FROM team_grants explicit_task_grant
             JOIN teams explicit_task_team
               ON explicit_task_team.id = explicit_task_grant.team_id
               AND explicit_task_team.archived_at IS NULL
             JOIN team_memberships explicit_task_member
               ON explicit_task_member.team_id = explicit_task_team.id
               AND explicit_task_member.user_id = u.id
               AND explicit_task_member.status = 'active'
               AND explicit_task_member.deactivated_at IS NULL
             WHERE explicit_task_grant.resource_type = 'task'
               AND explicit_task_grant.resource_id = ?
               AND explicit_task_grant.revoked_at IS NULL
           ))
         )`,
      )
      .bind(projectId, assigneeUserId, taskId, taskId)
      .first<DbRow>();
  } else if (assigneeUserId === ownerUserId) {
    row = { id: assigneeUserId };
  } else if (taskId) {
    row = await getD1()
      .prepare(
        `SELECT u.id FROM users u
         WHERE u.id = ? AND EXISTS (
           SELECT 1 FROM access_grants ag
           WHERE ag.resource_type = 'task'
             AND ag.resource_id = ?
             AND ag.grantee_user_id = u.id
             AND ag.revoked_at IS NULL
         )`,
      )
      .bind(assigneeUserId, taskId)
      .first<DbRow>();
  } else {
    row = null;
  }

  if (!row) {
    throw new ValidationError("Assignee must have access to the task");
  }
}
