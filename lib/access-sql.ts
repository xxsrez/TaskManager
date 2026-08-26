/**
 * SQL fragments for resource visibility and effective roles.
 *
 * Every fragment keeps its placeholder order explicit: callers bind the
 * current user once per `?`, in source order. Keeping these policies here
 * prevents UI and Agent read models from drifting apart.
 */

export function accessibleTaskWhere(taskAlias: string): string {
  assertSqlAlias(taskAlias);
  return `${taskAlias}.deleted_at IS NULL AND (${taskAlias}.project_id IS NULL OR EXISTS (
    SELECT 1 FROM projects visible_project
    WHERE visible_project.id = ${taskAlias}.project_id
      AND visible_project.deleted_at IS NULL
  )) AND (
    (${taskAlias}.project_id IS NOT NULL AND (
      EXISTS (SELECT 1 FROM projects access_project
        WHERE access_project.id = ${taskAlias}.project_id AND access_project.owner_user_id = ?)
      OR EXISTS (SELECT 1 FROM access_grants access_grant
        WHERE access_grant.resource_type = 'project'
          AND access_grant.resource_id = ${taskAlias}.project_id
          AND access_grant.grantee_user_id = ? AND access_grant.revoked_at IS NULL)
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ? OR EXISTS (
        SELECT 1 FROM access_grants access_grant
        WHERE access_grant.resource_type = 'task'
          AND access_grant.resource_id = ${taskAlias}.id
          AND access_grant.grantee_user_id = ? AND access_grant.revoked_at IS NULL
      )
    ))
  )`;
}

export function editableTaskWhere(taskAlias: string): string {
  assertSqlAlias(taskAlias);
  return `${taskAlias}.deleted_at IS NULL AND (${taskAlias}.project_id IS NULL OR EXISTS (
    SELECT 1 FROM projects visible_project
    WHERE visible_project.id = ${taskAlias}.project_id
      AND visible_project.deleted_at IS NULL
  )) AND (
    (${taskAlias}.project_id IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM projects access_project
        WHERE access_project.id = ${taskAlias}.project_id AND access_project.owner_user_id = ?
      ) OR EXISTS (
        SELECT 1 FROM access_grants access_grant
        WHERE access_grant.resource_type = 'project'
          AND access_grant.resource_id = ${taskAlias}.project_id
          AND access_grant.grantee_user_id = ? AND access_grant.revoked_at IS NULL
          AND access_grant.permission IN ('editor', 'manager', 'full_access')
      )
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ? OR EXISTS (
        SELECT 1 FROM access_grants access_grant
        WHERE access_grant.resource_type = 'task'
          AND access_grant.resource_id = ${taskAlias}.id
          AND access_grant.grantee_user_id = ? AND access_grant.revoked_at IS NULL
          AND access_grant.permission IN ('editor', 'full_access')
      )
    ))
  )`;
}

export function taskAccessRoleSql(
  taskAlias: string,
  projectAlias: string,
  includeDeleted = false,
): string {
  assertSqlAlias(taskAlias);
  assertSqlAlias(projectAlias);
  return `CASE
      WHEN ${includeDeleted ? "0" : `${taskAlias}.deleted_at IS NOT NULL OR (${taskAlias}.project_id IS NOT NULL AND ${projectAlias}.deleted_at IS NOT NULL)`} THEN NULL
      WHEN ${taskAlias}.project_id IS NOT NULL AND ${projectAlias}.owner_user_id = ? THEN 'owner'
      WHEN ${taskAlias}.project_id IS NOT NULL THEN (
        SELECT CASE access_grant.permission
          WHEN 'full_access' THEN 'manager'
          WHEN 'manager' THEN 'manager'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM access_grants access_grant
        WHERE access_grant.resource_type = 'project'
          AND access_grant.resource_id = ${taskAlias}.project_id
          AND access_grant.grantee_user_id = ?
          AND access_grant.revoked_at IS NULL
        LIMIT 1
      )
      WHEN ${taskAlias}.owner_user_id = ? THEN 'owner'
      ELSE (
        SELECT CASE access_grant.permission
          WHEN 'full_access' THEN 'editor'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM access_grants access_grant
        WHERE access_grant.resource_type = 'task'
          AND access_grant.resource_id = ${taskAlias}.id
          AND access_grant.grantee_user_id = ?
          AND access_grant.revoked_at IS NULL
        LIMIT 1
      )
    END`;
}

export function projectAccessRoleSql(projectAlias: string, includeDeleted = false): string {
  assertSqlAlias(projectAlias);
  return `CASE
    WHEN ${includeDeleted ? "0" : `${projectAlias}.deleted_at IS NOT NULL`} THEN NULL
    WHEN ${projectAlias}.owner_user_id = ? THEN 'owner' ELSE (
      SELECT CASE access_grant.permission
        WHEN 'full_access' THEN 'manager'
        WHEN 'manager' THEN 'manager'
        WHEN 'editor' THEN 'editor'
        WHEN 'viewer' THEN 'viewer'
      END
      FROM access_grants access_grant
      WHERE access_grant.resource_type = 'project'
        AND access_grant.resource_id = ${projectAlias}.id
        AND access_grant.grantee_user_id = ?
        AND access_grant.revoked_at IS NULL
      LIMIT 1
    ) END`;
}

export function savedViewAccessRoleSql(
  viewAlias: string,
  projectAlias: string,
  includeDeleted = false,
): string {
  assertSqlAlias(viewAlias);
  assertSqlAlias(projectAlias);
  return `CASE
      WHEN ${includeDeleted ? "0" : `${viewAlias}.deleted_at IS NOT NULL OR (${viewAlias}.scope_project_id IS NOT NULL AND ${projectAlias}.deleted_at IS NOT NULL)`} THEN NULL
      WHEN ${viewAlias}.scope_project_id IS NOT NULL AND ${projectAlias}.owner_user_id = ? THEN 'owner'
      WHEN ${viewAlias}.scope_project_id IS NOT NULL THEN (
        SELECT CASE access_grant.permission
          WHEN 'full_access' THEN 'manager'
          WHEN 'manager' THEN 'manager'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM access_grants access_grant
        WHERE access_grant.resource_type = 'project'
          AND access_grant.resource_id = ${viewAlias}.scope_project_id
          AND access_grant.grantee_user_id = ?
          AND access_grant.revoked_at IS NULL
        LIMIT 1
      )
      WHEN ${viewAlias}.owner_user_id = ? THEN 'owner'
      ELSE (
        SELECT CASE access_grant.permission
          WHEN 'full_access' THEN 'editor'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM access_grants access_grant
        WHERE access_grant.resource_type = 'saved_view'
          AND access_grant.resource_id = ${viewAlias}.id
          AND access_grant.grantee_user_id = ?
          AND access_grant.revoked_at IS NULL
        LIMIT 1
      )
    END`;
}

function assertSqlAlias(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error("Invalid SQL alias");
  }
}
