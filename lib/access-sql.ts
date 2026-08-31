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
      OR ${effectiveGrantRoleSql(`(
        (grant_source.resource_type = 'project' AND grant_source.resource_id = ${taskAlias}.project_id)
        OR (grant_source.resource_type = 'task' AND grant_source.resource_id = ${taskAlias}.id)
      )`)} IS NOT NULL
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ? OR ${effectiveGrantRoleSql(
        `grant_source.resource_type = 'task' AND grant_source.resource_id = ${taskAlias}.id`,
      )} IS NOT NULL
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
      ) OR ${effectiveGrantRoleSql(`(
        (grant_source.resource_type = 'project' AND grant_source.resource_id = ${taskAlias}.project_id)
        OR (grant_source.resource_type = 'task' AND grant_source.resource_id = ${taskAlias}.id)
      )`)} IN ('editor', 'manager', 'owner')
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ? OR ${effectiveGrantRoleSql(
        `grant_source.resource_type = 'task' AND grant_source.resource_id = ${taskAlias}.id`,
      )} IN ('editor', 'manager', 'owner')
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
        ${effectiveGrantRoleSql(`(
          (grant_source.resource_type = 'project' AND grant_source.resource_id = ${taskAlias}.project_id)
          OR (grant_source.resource_type = 'task' AND grant_source.resource_id = ${taskAlias}.id)
        )`)}
      )
      WHEN ${taskAlias}.owner_user_id = ? THEN 'owner'
      ELSE (
        ${effectiveGrantRoleSql(
          `grant_source.resource_type = 'task' AND grant_source.resource_id = ${taskAlias}.id`,
        )}
      )
    END`;
}

export function projectAccessRoleSql(projectAlias: string, includeDeleted = false): string {
  assertSqlAlias(projectAlias);
  return `CASE
    WHEN ${includeDeleted ? "0" : `${projectAlias}.deleted_at IS NOT NULL`} THEN NULL
    WHEN ${projectAlias}.owner_user_id = ? THEN 'owner' ELSE ${effectiveGrantRoleSql(
      `grant_source.resource_type = 'project' AND grant_source.resource_id = ${projectAlias}.id`,
    )} END`;
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
        ${effectiveGrantRoleSql(
          `grant_source.resource_type = 'project' AND grant_source.resource_id = ${viewAlias}.scope_project_id`,
        )}
      )
      WHEN ${viewAlias}.owner_user_id = ? THEN 'owner'
      ELSE (
        ${effectiveGrantRoleSql(
          `grant_source.resource_type = 'saved_view' AND grant_source.resource_id = ${viewAlias}.id`,
        )}
      )
    END`;
}

/**
 * Union direct grants with active, non-revoked Team grants for the current
 * principal. The principal placeholder is deliberately outside the union so
 * each public fragment keeps its historical bind count while still taking the
 * maximum role from every matching Team.
 */
function effectiveGrantRoleSql(resourcePredicate: string): string {
  return `(SELECT CASE COALESCE(MAX(CASE grant_source.resource_type
      WHEN 'project' THEN CASE grant_source.permission
        WHEN 'full_access' THEN 3
        WHEN 'manager' THEN 3
        WHEN 'editor' THEN 2
        WHEN 'viewer' THEN 1
      END
      WHEN 'task' THEN CASE grant_source.permission
        WHEN 'full_access' THEN 2
        WHEN 'editor' THEN 2
        WHEN 'viewer' THEN 1
      END
      WHEN 'saved_view' THEN CASE grant_source.permission
        WHEN 'full_access' THEN 2
        WHEN 'editor' THEN 2
        WHEN 'viewer' THEN 1
      END
    END), 0)
      WHEN 3 THEN 'manager'
      WHEN 2 THEN 'editor'
      WHEN 1 THEN 'viewer'
      ELSE NULL
    END
    FROM (SELECT ? AS principal_id) principal
    JOIN (
      SELECT access_grant.grantee_user_id AS principal_id,
             access_grant.resource_type, access_grant.resource_id,
             access_grant.permission
      FROM access_grants access_grant
      WHERE access_grant.revoked_at IS NULL
      UNION ALL
      SELECT team_membership.user_id AS principal_id,
             team_grant.resource_type, team_grant.resource_id,
             team_grant.permission
      FROM team_grants team_grant
      JOIN team_memberships team_membership
        ON team_membership.team_id = team_grant.team_id
       AND team_membership.status = 'active'
      JOIN teams grant_team
        ON grant_team.id = team_grant.team_id
       AND grant_team.archived_at IS NULL
      WHERE team_grant.revoked_at IS NULL
    ) grant_source ON grant_source.principal_id = principal.principal_id
    WHERE ${resourcePredicate})`;
}

/** Return an ACL-only Team membership check for an already selected principal. */
export function activeTeamGrantExistsSql(
  resourceType: "project" | "task" | "saved_view",
  resourceIdExpression: string,
  principalExpression: string,
  permission?: "manager" | "editor" | "viewer",
): string {
  return `EXISTS (
    SELECT 1 FROM team_grants team_grant
    JOIN team_memberships team_membership
      ON team_membership.team_id = team_grant.team_id
     AND team_membership.status = 'active'
    JOIN teams grant_team
      ON grant_team.id = team_grant.team_id
     AND grant_team.archived_at IS NULL
    WHERE team_grant.resource_type = '${resourceType}'
      AND team_grant.resource_id = ${resourceIdExpression}
      AND team_grant.revoked_at IS NULL
      ${permission ? `AND team_grant.permission = '${permission}'` : ""}
      AND team_membership.user_id = ${principalExpression}
  )`;
}

function assertSqlAlias(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error("Invalid SQL alias");
  }
}
