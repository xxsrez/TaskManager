/**
 * SQL fragments for resource visibility and effective roles.
 *
 * Every public role fragment deliberately keeps its historical placeholder
 * count and order. A one-row principal subquery makes those bindings reusable
 * by all direct and Team routes without multiplying caller parameters.
 */

export function accessibleTaskWhere(taskAlias: string): string {
  assertSqlAlias(taskAlias);
  return `${taskAlias}.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM projects visible_project
    WHERE visible_project.id = ${taskAlias}.project_id
      AND visible_project.deleted_at IS NULL
  ) AND COALESCE((
    SELECT ${taskRoleRankSql(
      taskAlias,
      "visible_project",
      "principal.project_owner_user_id",
      "principal.project_grantee_user_id",
      "principal.task_owner_user_id",
      "principal.task_grantee_user_id",
    )}
    FROM (SELECT ? AS project_owner_user_id, ? AS project_grantee_user_id,
      ? AS task_owner_user_id, ? AS task_grantee_user_id) principal
    JOIN projects visible_project ON visible_project.id = ${taskAlias}.project_id
  ), 0) > 0`;
}

export function editableTaskWhere(taskAlias: string): string {
  assertSqlAlias(taskAlias);
  return `${taskAlias}.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM projects editable_project
    WHERE editable_project.id = ${taskAlias}.project_id
      AND editable_project.deleted_at IS NULL
  ) AND COALESCE((
    SELECT ${taskRoleRankSql(
      taskAlias,
      "editable_project",
      "principal.project_owner_user_id",
      "principal.project_grantee_user_id",
      "principal.task_owner_user_id",
      "principal.task_grantee_user_id",
    )}
    FROM (SELECT ? AS project_owner_user_id, ? AS project_grantee_user_id,
      ? AS task_owner_user_id, ? AS task_grantee_user_id) principal
    JOIN projects editable_project ON editable_project.id = ${taskAlias}.project_id
  ), 0) >= 2`;
}

export function taskAccessRoleSql(
  taskAlias: string,
  projectAlias: string,
  includeDeleted = false,
): string {
  assertSqlAlias(taskAlias);
  assertSqlAlias(projectAlias);
  return `CASE
    WHEN ${includeDeleted ? "0" : `${taskAlias}.deleted_at IS NOT NULL OR ${projectAlias}.deleted_at IS NOT NULL`} THEN NULL
    ELSE (
      SELECT ${roleFromRankSql(taskRoleRankSql(
        taskAlias,
        projectAlias,
        "principal.project_owner_user_id",
        "principal.project_grantee_user_id",
        "principal.task_owner_user_id",
        "principal.task_grantee_user_id",
      ))}
      FROM (SELECT ? AS project_owner_user_id, ? AS project_grantee_user_id,
        ? AS task_owner_user_id, ? AS task_grantee_user_id) principal
    )
  END`;
}

export function projectAccessRoleSql(
  projectAlias: string,
  includeDeleted = false,
): string {
  assertSqlAlias(projectAlias);
  return `CASE
    WHEN ${includeDeleted ? "0" : `${projectAlias}.deleted_at IS NOT NULL`} THEN NULL
    ELSE (
      SELECT ${roleFromRankSql(projectRoleRankSql(
        projectAlias,
        "principal.owner_user_id",
        "principal.grantee_user_id",
      ))}
      FROM (SELECT ? AS owner_user_id, ? AS grantee_user_id) principal
    )
  END`;
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
    ELSE (
      SELECT ${roleFromRankSql(savedViewRoleRankSql(
        viewAlias,
        projectAlias,
        "principal.project_owner_user_id",
        "principal.project_grantee_user_id",
        "principal.view_owner_user_id",
        "principal.view_grantee_user_id",
      ))}
      FROM (SELECT ? AS project_owner_user_id, ? AS project_grantee_user_id,
        ? AS view_owner_user_id, ? AS view_grantee_user_id) principal
    )
  END`;
}

/** Effective Project role rank for an already-bound SQL principal expression. */
export function projectEffectiveRoleRankSql(
  projectAlias: string,
  userExpression: string,
): string {
  assertSqlAlias(projectAlias);
  assertPrincipalExpression(userExpression);
  return projectRoleRankSql(projectAlias, userExpression, userExpression);
}

/** Effective Task role rank, including Project inheritance and explicit Team grants. */
export function taskEffectiveRoleRankSql(
  taskAlias: string,
  projectAlias: string,
  userExpression: string,
): string {
  assertSqlAlias(taskAlias);
  assertSqlAlias(projectAlias);
  assertPrincipalExpression(userExpression);
  return taskRoleRankSql(
    taskAlias,
    projectAlias,
    userExpression,
    userExpression,
    userExpression,
    userExpression,
  );
}

/** Effective Saved View role rank for an already-bound SQL principal expression. */
export function savedViewEffectiveRoleRankSql(
  viewAlias: string,
  projectAlias: string,
  userExpression: string,
): string {
  assertSqlAlias(viewAlias);
  assertSqlAlias(projectAlias);
  assertPrincipalExpression(userExpression);
  return savedViewRoleRankSql(
    viewAlias,
    projectAlias,
    userExpression,
    userExpression,
    userExpression,
    userExpression,
  );
}

function projectRoleRankSql(
  projectAlias: string,
  ownerUserExpression: string,
  granteeUserExpression: string,
): string {
  return `MAX(
    CASE WHEN ${projectAlias}.owner_user_id = ${ownerUserExpression} THEN 4 ELSE 0 END,
    COALESCE((
      SELECT MAX(${projectPermissionRankSql("direct_project_grant.permission")})
      FROM access_grants direct_project_grant
      WHERE direct_project_grant.resource_type = 'project'
        AND direct_project_grant.resource_id = ${projectAlias}.id
        AND direct_project_grant.grantee_user_id = ${granteeUserExpression}
        AND direct_project_grant.revoked_at IS NULL
    ), 0),
    COALESCE((
      SELECT MAX(${projectPermissionRankSql("team_project_grant.permission")})
      FROM team_grants team_project_grant
      JOIN teams access_team ON access_team.id = team_project_grant.team_id
        AND access_team.archived_at IS NULL
      JOIN team_memberships access_membership
        ON access_membership.team_id = access_team.id
        AND access_membership.user_id = ${granteeUserExpression}
        AND access_membership.status = 'active'
        AND access_membership.deactivated_at IS NULL
      WHERE team_project_grant.resource_type = 'project'
        AND team_project_grant.resource_id = ${projectAlias}.id
        AND team_project_grant.revoked_at IS NULL
    ), 0)
  )`;
}

function taskRoleRankSql(
  taskAlias: string,
  projectAlias: string,
  projectOwnerUserExpression: string,
  projectGranteeUserExpression: string,
  taskOwnerUserExpression: string,
  taskGranteeUserExpression: string,
): string {
  return `MAX(
    CASE
      WHEN ${taskAlias}.project_id IS NOT NULL
        AND ${projectAlias}.owner_user_id = ${projectOwnerUserExpression} THEN 4
      WHEN ${taskAlias}.project_id IS NULL
        AND ${taskAlias}.owner_user_id = ${taskOwnerUserExpression} THEN 4
      ELSE 0
    END,
    COALESCE((
      SELECT MAX(CASE
        WHEN ${taskAlias}.project_id IS NOT NULL
          THEN ${projectPermissionRankSql("direct_task_grant.permission")}
        ELSE ${taskPermissionRankSql("direct_task_grant.permission")}
      END)
      FROM access_grants direct_task_grant
      WHERE direct_task_grant.revoked_at IS NULL
        AND direct_task_grant.grantee_user_id = CASE
          WHEN ${taskAlias}.project_id IS NOT NULL THEN ${projectGranteeUserExpression}
          ELSE ${taskGranteeUserExpression}
        END
        AND (
          (${taskAlias}.project_id IS NOT NULL
            AND direct_task_grant.resource_type = 'project'
            AND direct_task_grant.resource_id = ${taskAlias}.project_id)
          OR (${taskAlias}.project_id IS NULL
            AND direct_task_grant.resource_type = 'task'
            AND direct_task_grant.resource_id = ${taskAlias}.id)
        )
    ), 0),
    COALESCE((
      SELECT MAX(CASE
        WHEN team_task_grant.resource_type = 'project'
          THEN ${projectPermissionRankSql("team_task_grant.permission")}
        ELSE ${taskPermissionRankSql("team_task_grant.permission")}
      END)
      FROM team_grants team_task_grant
      JOIN teams access_team ON access_team.id = team_task_grant.team_id
        AND access_team.archived_at IS NULL
      JOIN team_memberships access_membership
        ON access_membership.team_id = access_team.id
        AND access_membership.user_id = ${taskGranteeUserExpression}
        AND access_membership.status = 'active'
        AND access_membership.deactivated_at IS NULL
      WHERE team_task_grant.revoked_at IS NULL
        AND (
          (team_task_grant.resource_type = 'project'
            AND team_task_grant.resource_id = ${taskAlias}.project_id)
          OR (team_task_grant.resource_type = 'task'
            AND team_task_grant.resource_id = ${taskAlias}.id)
        )
    ), 0)
  )`;
}

function savedViewRoleRankSql(
  viewAlias: string,
  projectAlias: string,
  projectOwnerUserExpression: string,
  projectGranteeUserExpression: string,
  viewOwnerUserExpression: string,
  viewGranteeUserExpression: string,
): string {
  return `MAX(
    CASE
      WHEN ${viewAlias}.scope_project_id IS NOT NULL
        AND ${projectAlias}.owner_user_id = ${projectOwnerUserExpression} THEN 4
      WHEN ${viewAlias}.scope_project_id IS NULL
        AND ${viewAlias}.owner_user_id = ${viewOwnerUserExpression} THEN 4
      ELSE 0
    END,
    COALESCE((
      SELECT MAX(CASE
        WHEN ${viewAlias}.scope_project_id IS NOT NULL
          THEN ${projectPermissionRankSql("direct_view_grant.permission")}
        ELSE ${taskPermissionRankSql("direct_view_grant.permission")}
      END)
      FROM access_grants direct_view_grant
      WHERE direct_view_grant.revoked_at IS NULL
        AND direct_view_grant.grantee_user_id = CASE
          WHEN ${viewAlias}.scope_project_id IS NOT NULL THEN ${projectGranteeUserExpression}
          ELSE ${viewGranteeUserExpression}
        END
        AND (
          (${viewAlias}.scope_project_id IS NOT NULL
            AND direct_view_grant.resource_type = 'project'
            AND direct_view_grant.resource_id = ${viewAlias}.scope_project_id)
          OR (${viewAlias}.scope_project_id IS NULL
            AND direct_view_grant.resource_type = 'saved_view'
            AND direct_view_grant.resource_id = ${viewAlias}.id)
        )
    ), 0),
    COALESCE((
      SELECT MAX(CASE
        WHEN team_view_grant.resource_type = 'project'
          THEN ${projectPermissionRankSql("team_view_grant.permission")}
        ELSE ${taskPermissionRankSql("team_view_grant.permission")}
      END)
      FROM team_grants team_view_grant
      JOIN teams access_team ON access_team.id = team_view_grant.team_id
        AND access_team.archived_at IS NULL
      JOIN team_memberships access_membership
        ON access_membership.team_id = access_team.id
        AND access_membership.user_id = ${viewGranteeUserExpression}
        AND access_membership.status = 'active'
        AND access_membership.deactivated_at IS NULL
      WHERE team_view_grant.revoked_at IS NULL
        AND (
          (team_view_grant.resource_type = 'project'
            AND team_view_grant.resource_id = ${viewAlias}.scope_project_id)
          OR (${viewAlias}.scope_project_id IS NULL
            AND team_view_grant.resource_type = 'saved_view'
            AND team_view_grant.resource_id = ${viewAlias}.id)
        )
    ), 0)
  )`;
}

function roleFromRankSql(rankSql: string): string {
  return `CASE ${rankSql}
    WHEN 4 THEN 'owner'
    WHEN 3 THEN 'manager'
    WHEN 2 THEN 'editor'
    WHEN 1 THEN 'viewer'
    ELSE NULL
  END`;
}

function projectPermissionRankSql(expression: string): string {
  return `CASE ${expression}
    WHEN 'full_access' THEN 3
    WHEN 'manager' THEN 3
    WHEN 'editor' THEN 2
    WHEN 'viewer' THEN 1
    ELSE 0
  END`;
}

function taskPermissionRankSql(expression: string): string {
  return `CASE ${expression}
    WHEN 'full_access' THEN 2
    WHEN 'editor' THEN 2
    WHEN 'viewer' THEN 1
    ELSE 0
  END`;
}

function assertSqlAlias(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error("Invalid SQL alias");
  }
}

function assertPrincipalExpression(value: string): void {
  if (value !== "?" && !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error("Invalid SQL principal expression");
  }
}
