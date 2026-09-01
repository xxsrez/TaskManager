/**
 * SQL fragments for resource visibility and effective roles.
 *
 * Every public fragment preserves its historical placeholder count. Each
 * non-owner branch binds one principal through a one-row table and joins all
 * direct and Team-derived role candidates to it. This lets SQLite choose the
 * strongest route without adding bind churn to repository callers.
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
      OR ${projectTaskRankSql(taskAlias, "?")} >= 1
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ? OR ${standaloneTaskRankSql(taskAlias, "?")} >= 1
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
      OR ${projectTaskRankSql(taskAlias, "?")} >= 2
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ? OR ${standaloneTaskRankSql(taskAlias, "?")} >= 2
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
      WHEN ${taskAlias}.project_id IS NOT NULL THEN ${roleFromRank(projectTaskRankSql(taskAlias, "?"))}
      WHEN ${taskAlias}.owner_user_id = ? THEN 'owner'
      ELSE ${roleFromRank(standaloneTaskRankSql(taskAlias, "?"))}
    END`;
}

export function projectAccessRoleSql(projectAlias: string, includeDeleted = false): string {
  assertSqlAlias(projectAlias);
  return `CASE
    WHEN ${includeDeleted ? "0" : `${projectAlias}.deleted_at IS NOT NULL`} THEN NULL
    WHEN ${projectAlias}.owner_user_id = ? THEN 'owner'
    ELSE ${roleFromRank(projectRankSql(`${projectAlias}.id`, "?"))}
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
      WHEN ${viewAlias}.scope_project_id IS NOT NULL AND ${projectAlias}.owner_user_id = ? THEN 'owner'
      WHEN ${viewAlias}.scope_project_id IS NOT NULL THEN ${roleFromRank(projectRankSql(`${viewAlias}.scope_project_id`, "?"))}
      WHEN ${viewAlias}.owner_user_id = ? THEN 'owner'
      ELSE ${roleFromRank(globalViewRankSql(viewAlias, "?"))}
    END`;
}

export function accessibleProjectWhere(projectAlias: string): string {
  assertSqlAlias(projectAlias);
  return `${projectAlias}.deleted_at IS NULL AND (
    ${projectAlias}.owner_user_id = ? OR ${projectRankSql(`${projectAlias}.id`, "?")} >= 1
  )`;
}

export function editableProjectWhere(projectAlias: string): string {
  assertSqlAlias(projectAlias);
  return `${projectAlias}.deleted_at IS NULL AND (
    ${projectAlias}.owner_user_id = ? OR ${projectRankSql(`${projectAlias}.id`, "?")} >= 2
  )`;
}

export function accessibleSavedViewWhere(viewAlias: string, projectAlias: string): string {
  assertSqlAlias(viewAlias);
  assertSqlAlias(projectAlias);
  return `${viewAlias}.deleted_at IS NULL
    AND (${viewAlias}.scope_project_id IS NULL OR ${projectAlias}.deleted_at IS NULL)
    AND (
      (${viewAlias}.scope_project_id IS NOT NULL AND (
        ${projectAlias}.owner_user_id = ? OR ${projectRankSql(`${viewAlias}.scope_project_id`, "?")} >= 1
      )) OR (${viewAlias}.scope_project_id IS NULL AND (
        ${viewAlias}.owner_user_id = ? OR ${globalViewRankSql(viewAlias, "?")} >= 1
      ))
    )`;
}

export function editableSavedViewWhere(viewAlias: string, projectAlias: string): string {
  assertSqlAlias(viewAlias);
  assertSqlAlias(projectAlias);
  return `${viewAlias}.deleted_at IS NULL
    AND (${viewAlias}.scope_project_id IS NULL OR ${projectAlias}.deleted_at IS NULL)
    AND (
      (${viewAlias}.scope_project_id IS NOT NULL AND (
        ${projectAlias}.owner_user_id = ? OR ${projectRankSql(`${viewAlias}.scope_project_id`, "?")} >= 2
      )) OR (${viewAlias}.scope_project_id IS NULL AND (
        ${viewAlias}.owner_user_id = ? OR ${globalViewRankSql(viewAlias, "?")} >= 2
      ))
    )`;
}

function projectTaskRankSql(taskAlias: string, principal: string): string {
  return principalRankSql(principal, [
    directCandidate("project", `${taskAlias}.project_id`, true),
    teamCandidate("project", `${taskAlias}.project_id`, true),
    teamCandidate("task", `${taskAlias}.id`, false),
  ]);
}

function standaloneTaskRankSql(taskAlias: string, principal: string): string {
  return principalRankSql(principal, [
    directCandidate("task", `${taskAlias}.id`, false),
    teamCandidate("task", `${taskAlias}.id`, false),
  ]);
}

function projectRankSql(resourceIdSql: string, principal: string): string {
  return principalRankSql(principal, [
    directCandidate("project", resourceIdSql, true),
    teamCandidate("project", resourceIdSql, true),
  ]);
}

function globalViewRankSql(viewAlias: string, principal: string): string {
  return principalRankSql(principal, [
    directCandidate("saved_view", `${viewAlias}.id`, false),
    teamCandidate("saved_view", `${viewAlias}.id`, false),
  ]);
}

function principalRankSql(principal: string, candidates: string[]): string {
  return `(SELECT MAX(candidate.role_rank)
    FROM (SELECT ${principal} AS principal_user_id) principal
    JOIN (${candidates.join(" UNION ALL ")}) candidate
      ON candidate.routed_user_id = principal.principal_user_id)`;
}

function directCandidate(
  resourceType: "project" | "task" | "saved_view",
  resourceIdSql: string,
  allowManager: boolean,
): string {
  return `SELECT access_grant.grantee_user_id AS routed_user_id,
      CASE access_grant.permission
        WHEN 'full_access' THEN ${allowManager ? 3 : 2}
        WHEN 'manager' THEN ${allowManager ? 3 : 0}
        WHEN 'editor' THEN 2
        WHEN 'viewer' THEN 1
        ELSE 0
      END AS role_rank
    FROM access_grants access_grant
    WHERE access_grant.resource_type = '${resourceType}'
      AND access_grant.resource_id = ${resourceIdSql}
      AND access_grant.revoked_at IS NULL`;
}

function teamCandidate(
  resourceType: "project" | "task" | "saved_view",
  resourceIdSql: string,
  allowManager: boolean,
): string {
  return `SELECT team_membership.user_id AS routed_user_id,
      CASE team_grant.permission
        WHEN 'manager' THEN ${allowManager ? 3 : 0}
        WHEN 'editor' THEN 2
        WHEN 'viewer' THEN 1
        ELSE 0
      END AS role_rank
    FROM team_grants team_grant
    JOIN teams access_team ON access_team.id = team_grant.team_id
      AND access_team.archived_at IS NULL
    JOIN team_memberships team_membership ON team_membership.team_id = access_team.id
      AND team_membership.status = 'active'
      AND team_membership.deactivated_at IS NULL
    WHERE team_grant.resource_type = '${resourceType}'
      AND team_grant.resource_id = ${resourceIdSql}
      AND team_grant.revoked_at IS NULL`;
}

function roleFromRank(rankSql: string): string {
  return `CASE ${rankSql}
    WHEN 3 THEN 'manager'
    WHEN 2 THEN 'editor'
    WHEN 1 THEN 'viewer'
    ELSE NULL
  END`;
}

function assertSqlAlias(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error("Invalid SQL alias");
  }
}
