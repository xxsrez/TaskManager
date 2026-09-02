/**
 * Referential cleanup after an access route disappears. Assignment and lead
 * fields are cleared only when the principal has no owner, direct-user, or
 * remaining active Team route to the resource.
 */
export function clearLostAccessForUserStatements(
  db: D1Database,
  userId: string,
  now: string,
): D1PreparedStatement[] {
  return [
    db.prepare(
      `UPDATE tasks SET assignee_user_id = NULL,
         version = version + 1, updated_at = ?
       WHERE assignee_user_id = ?
         AND NOT (${principalTaskAccessSql("tasks", "tasks.assignee_user_id")})`,
    ).bind(now, userId),
    db.prepare(
      `UPDATE projects SET lead_user_id = NULL,
         version = version + 1, updated_at = ?
       WHERE lead_user_id = ?
         AND NOT (${principalProjectAccessSql("projects", "projects.lead_user_id")})`,
    ).bind(now, userId),
  ];
}

export function clearLostAccessForTeamStatements(
  db: D1Database,
  teamId: string,
  now: string,
): D1PreparedStatement[] {
  return [
    db.prepare(
      `UPDATE tasks SET assignee_user_id = NULL,
         version = version + 1, updated_at = ?
       WHERE assignee_user_id IN (
         SELECT user_id FROM team_memberships
         WHERE team_id = ? AND status = 'active' AND deactivated_at IS NULL
       ) AND NOT (${principalTaskAccessSql("tasks", "tasks.assignee_user_id")})`,
    ).bind(now, teamId),
    db.prepare(
      `UPDATE projects SET lead_user_id = NULL,
         version = version + 1, updated_at = ?
       WHERE lead_user_id IN (
         SELECT user_id FROM team_memberships
         WHERE team_id = ? AND status = 'active' AND deactivated_at IS NULL
       ) AND NOT (${principalProjectAccessSql("projects", "projects.lead_user_id")})`,
    ).bind(now, teamId),
  ];
}

function principalTaskAccessSql(taskAlias: string, principalSql: string) {
  return `(
    (${taskAlias}.project_id IS NOT NULL AND (
      EXISTS (SELECT 1 FROM projects access_project
        WHERE access_project.id = ${taskAlias}.project_id
          AND access_project.deleted_at IS NULL
          AND access_project.owner_user_id = ${principalSql})
      OR EXISTS (SELECT 1 FROM access_grants direct_project_grant
        WHERE direct_project_grant.resource_type = 'project'
          AND direct_project_grant.resource_id = ${taskAlias}.project_id
          AND direct_project_grant.grantee_user_id = ${principalSql}
          AND direct_project_grant.revoked_at IS NULL)
      OR ${principalTeamTaskRouteSql(taskAlias, principalSql, true)}
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ${principalSql}
      OR EXISTS (SELECT 1 FROM access_grants direct_task_grant
        WHERE direct_task_grant.resource_type = 'task'
          AND direct_task_grant.resource_id = ${taskAlias}.id
          AND direct_task_grant.grantee_user_id = ${principalSql}
          AND direct_task_grant.revoked_at IS NULL)
      OR ${principalTeamTaskRouteSql(taskAlias, principalSql, false)}
    ))
  )`;
}

function principalProjectAccessSql(projectAlias: string, principalSql: string) {
  return `(
    ${projectAlias}.owner_user_id = ${principalSql}
    OR EXISTS (SELECT 1 FROM access_grants direct_project_grant
      WHERE direct_project_grant.resource_type = 'project'
        AND direct_project_grant.resource_id = ${projectAlias}.id
        AND direct_project_grant.grantee_user_id = ${principalSql}
        AND direct_project_grant.revoked_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM team_memberships access_membership
      JOIN teams access_team ON access_team.id = access_membership.team_id
        AND access_team.archived_at IS NULL
      JOIN team_grants access_team_grant
        ON access_team_grant.team_id = access_membership.team_id
        AND access_team_grant.revoked_at IS NULL
      WHERE access_membership.user_id = ${principalSql}
        AND access_membership.status = 'active'
        AND access_membership.deactivated_at IS NULL
        AND access_team_grant.resource_type = 'project'
        AND access_team_grant.resource_id = ${projectAlias}.id
    )
  )`;
}

function principalTeamTaskRouteSql(
  taskAlias: string,
  principalSql: string,
  includeProject: boolean,
) {
  return `EXISTS (
    SELECT 1 FROM team_memberships access_membership
    JOIN teams access_team ON access_team.id = access_membership.team_id
      AND access_team.archived_at IS NULL
    JOIN team_grants access_team_grant
      ON access_team_grant.team_id = access_membership.team_id
      AND access_team_grant.revoked_at IS NULL
    WHERE access_membership.user_id = ${principalSql}
      AND access_membership.status = 'active'
      AND access_membership.deactivated_at IS NULL AND (
        ${includeProject ? `(access_team_grant.resource_type = 'project'
          AND access_team_grant.resource_id = ${taskAlias}.project_id) OR` : ""}
        (access_team_grant.resource_type = 'task'
          AND access_team_grant.resource_id = ${taskAlias}.id)
      )
  )`;
}
