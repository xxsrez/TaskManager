/**
 * SQL fragments for resource visibility and strongest effective roles.
 *
 * Placeholder counts deliberately match the pre-Teams contract so existing
 * repository call sites keep their established bind order. Each non-owner
 * branch resolves one bound actor through `users`, then reuses that row from
 * every direct and Team route in the branch.
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
      OR EXISTS (SELECT 1 FROM users access_actor
        WHERE access_actor.id = ? AND (
          EXISTS (SELECT 1 FROM access_grants access_grant
            WHERE access_grant.resource_type = 'project'
              AND access_grant.resource_id = ${taskAlias}.project_id
              AND access_grant.grantee_user_id = access_actor.id
              AND access_grant.revoked_at IS NULL)
          OR EXISTS (SELECT 1 FROM team_memberships team_membership
            JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
            WHERE team_membership.user_id = access_actor.id
              AND team_membership.status = 'active'
              AND team_membership.deactivated_at IS NULL
              AND team_grant.revoked_at IS NULL
              AND ((team_grant.resource_type = 'project'
                AND team_grant.resource_id = ${taskAlias}.project_id)
                OR (team_grant.resource_type = 'task'
                  AND team_grant.resource_id = ${taskAlias}.id)))
        ))
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ? OR EXISTS (SELECT 1 FROM users access_actor
        WHERE access_actor.id = ? AND (
          EXISTS (SELECT 1 FROM access_grants access_grant
            WHERE access_grant.resource_type = 'task'
              AND access_grant.resource_id = ${taskAlias}.id
              AND access_grant.grantee_user_id = access_actor.id
              AND access_grant.revoked_at IS NULL)
          OR EXISTS (SELECT 1 FROM team_memberships team_membership
            JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
            WHERE team_membership.user_id = access_actor.id
              AND team_membership.status = 'active'
              AND team_membership.deactivated_at IS NULL
              AND team_grant.resource_type = 'task'
              AND team_grant.resource_id = ${taskAlias}.id
              AND team_grant.revoked_at IS NULL)
        ))
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
      EXISTS (SELECT 1 FROM projects access_project
        WHERE access_project.id = ${taskAlias}.project_id AND access_project.owner_user_id = ?)
      OR EXISTS (SELECT 1 FROM users access_actor
        WHERE access_actor.id = ? AND (
          EXISTS (SELECT 1 FROM access_grants access_grant
            WHERE access_grant.resource_type = 'project'
              AND access_grant.resource_id = ${taskAlias}.project_id
              AND access_grant.grantee_user_id = access_actor.id
              AND access_grant.revoked_at IS NULL
              AND access_grant.permission IN ('editor', 'manager', 'full_access'))
          OR EXISTS (SELECT 1 FROM team_memberships team_membership
            JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
            WHERE team_membership.user_id = access_actor.id
              AND team_membership.status = 'active'
              AND team_membership.deactivated_at IS NULL
              AND team_grant.revoked_at IS NULL
              AND team_grant.permission IN ('editor', 'manager')
              AND ((team_grant.resource_type = 'project'
                AND team_grant.resource_id = ${taskAlias}.project_id)
                OR (team_grant.resource_type = 'task'
                  AND team_grant.resource_id = ${taskAlias}.id)))
        ))
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ? OR EXISTS (SELECT 1 FROM users access_actor
        WHERE access_actor.id = ? AND (
          EXISTS (SELECT 1 FROM access_grants access_grant
            WHERE access_grant.resource_type = 'task'
              AND access_grant.resource_id = ${taskAlias}.id
              AND access_grant.grantee_user_id = access_actor.id
              AND access_grant.revoked_at IS NULL
              AND access_grant.permission IN ('editor', 'full_access'))
          OR EXISTS (SELECT 1 FROM team_memberships team_membership
            JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
            WHERE team_membership.user_id = access_actor.id
              AND team_membership.status = 'active'
              AND team_membership.deactivated_at IS NULL
              AND team_grant.resource_type = 'task'
              AND team_grant.resource_id = ${taskAlias}.id
              AND team_grant.permission = 'editor'
              AND team_grant.revoked_at IS NULL)
        ))
    ))
  )`;
}

export function editableProjectWhere(projectAlias: string): string {
  assertSqlAlias(projectAlias);
  return `${projectAlias}.deleted_at IS NULL AND (
    ${projectAlias}.owner_user_id = ? OR EXISTS (SELECT 1 FROM users access_actor
      WHERE access_actor.id = ? AND (
        EXISTS (SELECT 1 FROM access_grants access_grant
          WHERE access_grant.resource_type = 'project'
            AND access_grant.resource_id = ${projectAlias}.id
            AND access_grant.grantee_user_id = access_actor.id
            AND access_grant.revoked_at IS NULL
            AND access_grant.permission IN ('editor', 'manager', 'full_access'))
        OR EXISTS (SELECT 1 FROM team_memberships team_membership
          JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
          WHERE team_membership.user_id = access_actor.id
            AND team_membership.status = 'active'
            AND team_membership.deactivated_at IS NULL
            AND team_grant.resource_type = 'project'
            AND team_grant.resource_id = ${projectAlias}.id
            AND team_grant.permission IN ('editor', 'manager')
            AND team_grant.revoked_at IS NULL)
      ))
  )`;
}

export function editableSavedViewWhere(viewAlias: string): string {
  assertSqlAlias(viewAlias);
  return `${viewAlias}.deleted_at IS NULL AND (
    (${viewAlias}.scope_project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM projects editable_project
      WHERE editable_project.id = ${viewAlias}.scope_project_id
        AND ${editableProjectWhere("editable_project")}
    )) OR (${viewAlias}.scope_project_id IS NULL AND (
      ${viewAlias}.owner_user_id = ? OR EXISTS (SELECT 1 FROM users access_actor
        WHERE access_actor.id = ? AND (
          EXISTS (SELECT 1 FROM access_grants access_grant
            WHERE access_grant.resource_type = 'saved_view'
              AND access_grant.resource_id = ${viewAlias}.id
              AND access_grant.grantee_user_id = access_actor.id
              AND access_grant.revoked_at IS NULL
              AND access_grant.permission IN ('editor', 'full_access'))
          OR EXISTS (SELECT 1 FROM team_memberships team_membership
            JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
            WHERE team_membership.user_id = access_actor.id
              AND team_membership.status = 'active'
              AND team_membership.deactivated_at IS NULL
              AND team_grant.resource_type = 'saved_view'
              AND team_grant.resource_id = ${viewAlias}.id
              AND team_grant.permission = 'editor'
              AND team_grant.revoked_at IS NULL)
        ))
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
        SELECT CASE
          WHEN ${projectTeamRoleExists(taskAlias, "manager")} THEN 'manager'
          WHEN ${projectTaskTeamRoleExists(taskAlias, "editor")} THEN 'editor'
          WHEN ${projectTaskTeamRoleExists(taskAlias, "viewer")} THEN 'viewer'
        END FROM users access_actor WHERE access_actor.id = ?
      )
      WHEN ${taskAlias}.owner_user_id = ? THEN 'owner'
      ELSE (
        SELECT CASE
          WHEN ${standaloneTaskTeamRoleExists(taskAlias, "editor")} THEN 'editor'
          WHEN ${standaloneTaskTeamRoleExists(taskAlias, "viewer")} THEN 'viewer'
        END FROM users access_actor WHERE access_actor.id = ?
      )
    END`;
}

export function projectAccessRoleSql(projectAlias: string, includeDeleted = false): string {
  assertSqlAlias(projectAlias);
  return `CASE
    WHEN ${includeDeleted ? "0" : `${projectAlias}.deleted_at IS NOT NULL`} THEN NULL
    WHEN ${projectAlias}.owner_user_id = ? THEN 'owner' ELSE (
      SELECT CASE
        WHEN ${projectRoleExists(projectAlias, "manager")} THEN 'manager'
        WHEN ${projectRoleExists(projectAlias, "editor")} THEN 'editor'
        WHEN ${projectRoleExists(projectAlias, "viewer")} THEN 'viewer'
      END FROM users access_actor WHERE access_actor.id = ?
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
        SELECT CASE
          WHEN ${scopedViewProjectRoleExists(viewAlias, "manager")} THEN 'manager'
          WHEN ${scopedViewProjectRoleExists(viewAlias, "editor")} THEN 'editor'
          WHEN ${scopedViewProjectRoleExists(viewAlias, "viewer")} THEN 'viewer'
        END FROM users access_actor WHERE access_actor.id = ?
      )
      WHEN ${viewAlias}.owner_user_id = ? THEN 'owner'
      ELSE (
        SELECT CASE
          WHEN ${globalViewRoleExists(viewAlias, "editor")} THEN 'editor'
          WHEN ${globalViewRoleExists(viewAlias, "viewer")} THEN 'viewer'
        END FROM users access_actor WHERE access_actor.id = ?
      )
    END`;
}

function projectRoleExists(projectAlias: string, role: "manager" | "editor" | "viewer") {
  const directRoles = role === "manager" ? "('manager', 'full_access')" : `('${role}')`;
  return `EXISTS (SELECT 1 FROM access_grants access_grant
    WHERE access_grant.resource_type = 'project'
      AND access_grant.resource_id = ${projectAlias}.id
      AND access_grant.grantee_user_id = access_actor.id
      AND access_grant.revoked_at IS NULL
      AND access_grant.permission IN ${directRoles})
    OR EXISTS (SELECT 1 FROM team_memberships team_membership
      JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
      WHERE team_membership.user_id = access_actor.id
        AND team_membership.status = 'active'
        AND team_membership.deactivated_at IS NULL
        AND team_grant.resource_type = 'project'
        AND team_grant.resource_id = ${projectAlias}.id
        AND team_grant.permission = '${role}'
        AND team_grant.revoked_at IS NULL)`;
}

function projectTeamRoleExists(taskAlias: string, role: "manager") {
  const directRoles = "('manager', 'full_access')";
  return `EXISTS (SELECT 1 FROM access_grants access_grant
    WHERE access_grant.resource_type = 'project'
      AND access_grant.resource_id = ${taskAlias}.project_id
      AND access_grant.grantee_user_id = access_actor.id
      AND access_grant.revoked_at IS NULL
      AND access_grant.permission IN ${directRoles})
    OR EXISTS (SELECT 1 FROM team_memberships team_membership
      JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
      WHERE team_membership.user_id = access_actor.id
        AND team_membership.status = 'active'
        AND team_membership.deactivated_at IS NULL
        AND team_grant.resource_type = 'project'
        AND team_grant.resource_id = ${taskAlias}.project_id
        AND team_grant.permission = '${role}'
        AND team_grant.revoked_at IS NULL)`;
}

function projectTaskTeamRoleExists(taskAlias: string, role: "editor" | "viewer") {
  return `EXISTS (SELECT 1 FROM access_grants access_grant
    WHERE access_grant.resource_type = 'project'
      AND access_grant.resource_id = ${taskAlias}.project_id
      AND access_grant.grantee_user_id = access_actor.id
      AND access_grant.revoked_at IS NULL
      AND access_grant.permission = '${role}')
    OR EXISTS (SELECT 1 FROM team_memberships team_membership
      JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
      WHERE team_membership.user_id = access_actor.id
        AND team_membership.status = 'active'
        AND team_membership.deactivated_at IS NULL
        AND team_grant.revoked_at IS NULL
        AND team_grant.permission = '${role}'
        AND ((team_grant.resource_type = 'project'
          AND team_grant.resource_id = ${taskAlias}.project_id)
          OR (team_grant.resource_type = 'task'
            AND team_grant.resource_id = ${taskAlias}.id)))`;
}

function standaloneTaskTeamRoleExists(taskAlias: string, role: "editor" | "viewer") {
  const directRoles = role === "editor" ? "('editor', 'full_access')" : "('viewer')";
  return `EXISTS (SELECT 1 FROM access_grants access_grant
    WHERE access_grant.resource_type = 'task'
      AND access_grant.resource_id = ${taskAlias}.id
      AND access_grant.grantee_user_id = access_actor.id
      AND access_grant.revoked_at IS NULL
      AND access_grant.permission IN ${directRoles})
    OR EXISTS (SELECT 1 FROM team_memberships team_membership
      JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
      WHERE team_membership.user_id = access_actor.id
        AND team_membership.status = 'active'
        AND team_membership.deactivated_at IS NULL
        AND team_grant.resource_type = 'task'
        AND team_grant.resource_id = ${taskAlias}.id
        AND team_grant.permission = '${role}'
        AND team_grant.revoked_at IS NULL)`;
}

function scopedViewProjectRoleExists(viewAlias: string, role: "manager" | "editor" | "viewer") {
  const directRoles = role === "manager" ? "('manager', 'full_access')" : `('${role}')`;
  return `EXISTS (SELECT 1 FROM access_grants access_grant
    WHERE access_grant.resource_type = 'project'
      AND access_grant.resource_id = ${viewAlias}.scope_project_id
      AND access_grant.grantee_user_id = access_actor.id
      AND access_grant.revoked_at IS NULL
      AND access_grant.permission IN ${directRoles})
    OR EXISTS (SELECT 1 FROM team_memberships team_membership
      JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
      WHERE team_membership.user_id = access_actor.id
        AND team_membership.status = 'active'
        AND team_membership.deactivated_at IS NULL
        AND team_grant.resource_type = 'project'
        AND team_grant.resource_id = ${viewAlias}.scope_project_id
        AND team_grant.permission = '${role}'
        AND team_grant.revoked_at IS NULL)`;
}

function globalViewRoleExists(viewAlias: string, role: "editor" | "viewer") {
  const directRoles = role === "editor" ? "('editor', 'full_access')" : "('viewer')";
  return `EXISTS (SELECT 1 FROM access_grants access_grant
    WHERE access_grant.resource_type = 'saved_view'
      AND access_grant.resource_id = ${viewAlias}.id
      AND access_grant.grantee_user_id = access_actor.id
      AND access_grant.revoked_at IS NULL
      AND access_grant.permission IN ${directRoles})
    OR EXISTS (SELECT 1 FROM team_memberships team_membership
      JOIN team_grants team_grant ON team_grant.team_id = team_membership.team_id
      WHERE team_membership.user_id = access_actor.id
        AND team_membership.status = 'active'
        AND team_membership.deactivated_at IS NULL
        AND team_grant.resource_type = 'saved_view'
        AND team_grant.resource_id = ${viewAlias}.id
        AND team_grant.permission = '${role}'
        AND team_grant.revoked_at IS NULL)`;
}

function assertSqlAlias(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error("Invalid SQL alias");
  }
}
