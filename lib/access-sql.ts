/**
 * SQL fragments for resource visibility and effective roles.
 *
 * Each route subquery exposes a synthetic `user_id`, so direct and Team routes
 * share the same caller binding. This preserves the long-standing placeholder
 * contract while adding Team grants as an independent ACL channel.
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
        WHERE access_project.id = ${taskAlias}.project_id
          AND access_project.owner_user_id = ?)
      OR EXISTS (
        SELECT 1 FROM (
          SELECT access_grant.grantee_user_id AS user_id
          FROM access_grants access_grant
          WHERE access_grant.resource_type = 'project'
            AND access_grant.resource_id = ${taskAlias}.project_id
            AND access_grant.revoked_at IS NULL
          UNION ALL
          SELECT team_membership.user_id
          FROM team_grants team_grant
          JOIN team_memberships team_membership
            ON team_membership.team_id = team_grant.team_id
           AND team_membership.status = 'active'
           AND team_membership.deactivated_at IS NULL
          WHERE team_grant.revoked_at IS NULL AND (
            (team_grant.resource_type = 'project'
              AND team_grant.resource_id = ${taskAlias}.project_id)
            OR (team_grant.resource_type = 'task'
              AND team_grant.resource_id = ${taskAlias}.id)
          )
        ) access_route WHERE access_route.user_id = ?
      )
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ? OR EXISTS (
        SELECT 1 FROM (
          SELECT access_grant.grantee_user_id AS user_id
          FROM access_grants access_grant
          WHERE access_grant.resource_type = 'task'
            AND access_grant.resource_id = ${taskAlias}.id
            AND access_grant.revoked_at IS NULL
          UNION ALL
          SELECT team_membership.user_id
          FROM team_grants team_grant
          JOIN team_memberships team_membership
            ON team_membership.team_id = team_grant.team_id
           AND team_membership.status = 'active'
           AND team_membership.deactivated_at IS NULL
          WHERE team_grant.resource_type = 'task'
            AND team_grant.resource_id = ${taskAlias}.id
            AND team_grant.revoked_at IS NULL
        ) access_route WHERE access_route.user_id = ?
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
      EXISTS (SELECT 1 FROM projects access_project
        WHERE access_project.id = ${taskAlias}.project_id
          AND access_project.owner_user_id = ?)
      OR EXISTS (
        SELECT 1 FROM (
          SELECT access_grant.grantee_user_id AS user_id, access_grant.permission
          FROM access_grants access_grant
          WHERE access_grant.resource_type = 'project'
            AND access_grant.resource_id = ${taskAlias}.project_id
            AND access_grant.revoked_at IS NULL
          UNION ALL
          SELECT team_membership.user_id, team_grant.permission
          FROM team_grants team_grant
          JOIN team_memberships team_membership
            ON team_membership.team_id = team_grant.team_id
           AND team_membership.status = 'active'
           AND team_membership.deactivated_at IS NULL
          WHERE team_grant.revoked_at IS NULL AND (
            (team_grant.resource_type = 'project'
              AND team_grant.resource_id = ${taskAlias}.project_id)
            OR (team_grant.resource_type = 'task'
              AND team_grant.resource_id = ${taskAlias}.id)
          )
        ) access_route
        WHERE access_route.user_id = ?
          AND access_route.permission IN ('editor', 'manager', 'full_access')
      )
    )) OR (${taskAlias}.project_id IS NULL AND (
      ${taskAlias}.owner_user_id = ? OR EXISTS (
        SELECT 1 FROM (
          SELECT access_grant.grantee_user_id AS user_id, access_grant.permission
          FROM access_grants access_grant
          WHERE access_grant.resource_type = 'task'
            AND access_grant.resource_id = ${taskAlias}.id
            AND access_grant.revoked_at IS NULL
          UNION ALL
          SELECT team_membership.user_id, team_grant.permission
          FROM team_grants team_grant
          JOIN team_memberships team_membership
            ON team_membership.team_id = team_grant.team_id
           AND team_membership.status = 'active'
           AND team_membership.deactivated_at IS NULL
          WHERE team_grant.resource_type = 'task'
            AND team_grant.resource_id = ${taskAlias}.id
            AND team_grant.revoked_at IS NULL
        ) access_route
        WHERE access_route.user_id = ?
          AND access_route.permission IN ('editor', 'manager', 'full_access')
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
        SELECT CASE access_route.permission
          WHEN 'full_access' THEN 'manager'
          WHEN 'manager' THEN 'manager'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM (
          SELECT access_grant.grantee_user_id AS user_id, access_grant.permission
          FROM access_grants access_grant
          WHERE access_grant.resource_type = 'project'
            AND access_grant.resource_id = ${taskAlias}.project_id
            AND access_grant.revoked_at IS NULL
          UNION ALL
          SELECT team_membership.user_id, team_grant.permission
          FROM team_grants team_grant
          JOIN team_memberships team_membership
            ON team_membership.team_id = team_grant.team_id
           AND team_membership.status = 'active'
           AND team_membership.deactivated_at IS NULL
          WHERE team_grant.revoked_at IS NULL AND (
            (team_grant.resource_type = 'project'
              AND team_grant.resource_id = ${taskAlias}.project_id)
            OR (team_grant.resource_type = 'task'
              AND team_grant.resource_id = ${taskAlias}.id)
          )
        ) access_route
        WHERE access_route.user_id = ?
        ORDER BY CASE access_route.permission
          WHEN 'full_access' THEN 3 WHEN 'manager' THEN 3
          WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END DESC
        LIMIT 1
      )
      WHEN ${taskAlias}.owner_user_id = ? THEN 'owner'
      ELSE (
        SELECT CASE access_route.permission
          WHEN 'full_access' THEN 'editor'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM (
          SELECT access_grant.grantee_user_id AS user_id, access_grant.permission
          FROM access_grants access_grant
          WHERE access_grant.resource_type = 'task'
            AND access_grant.resource_id = ${taskAlias}.id
            AND access_grant.revoked_at IS NULL
          UNION ALL
          SELECT team_membership.user_id, team_grant.permission
          FROM team_grants team_grant
          JOIN team_memberships team_membership
            ON team_membership.team_id = team_grant.team_id
           AND team_membership.status = 'active'
           AND team_membership.deactivated_at IS NULL
          WHERE team_grant.resource_type = 'task'
            AND team_grant.resource_id = ${taskAlias}.id
            AND team_grant.revoked_at IS NULL
        ) access_route
        WHERE access_route.user_id = ?
        ORDER BY CASE access_route.permission
          WHEN 'full_access' THEN 2 WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 1 ELSE 0 END DESC
        LIMIT 1
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
    WHEN ${projectAlias}.owner_user_id = ? THEN 'owner' ELSE (
      SELECT CASE access_route.permission
        WHEN 'full_access' THEN 'manager'
        WHEN 'manager' THEN 'manager'
        WHEN 'editor' THEN 'editor'
        WHEN 'viewer' THEN 'viewer'
      END
      FROM (
        SELECT access_grant.grantee_user_id AS user_id, access_grant.permission
        FROM access_grants access_grant
        WHERE access_grant.resource_type = 'project'
          AND access_grant.resource_id = ${projectAlias}.id
          AND access_grant.revoked_at IS NULL
        UNION ALL
        SELECT team_membership.user_id, team_grant.permission
        FROM team_grants team_grant
        JOIN team_memberships team_membership
          ON team_membership.team_id = team_grant.team_id
         AND team_membership.status = 'active'
         AND team_membership.deactivated_at IS NULL
        WHERE team_grant.resource_type = 'project'
          AND team_grant.resource_id = ${projectAlias}.id
          AND team_grant.revoked_at IS NULL
      ) access_route
      WHERE access_route.user_id = ?
      ORDER BY CASE access_route.permission
        WHEN 'full_access' THEN 3 WHEN 'manager' THEN 3
        WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END DESC
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
        SELECT CASE access_route.permission
          WHEN 'full_access' THEN 'manager'
          WHEN 'manager' THEN 'manager'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM (
          SELECT access_grant.grantee_user_id AS user_id, access_grant.permission
          FROM access_grants access_grant
          WHERE access_grant.resource_type = 'project'
            AND access_grant.resource_id = ${viewAlias}.scope_project_id
            AND access_grant.revoked_at IS NULL
          UNION ALL
          SELECT team_membership.user_id, team_grant.permission
          FROM team_grants team_grant
          JOIN team_memberships team_membership
            ON team_membership.team_id = team_grant.team_id
           AND team_membership.status = 'active'
           AND team_membership.deactivated_at IS NULL
          WHERE team_grant.resource_type = 'project'
            AND team_grant.resource_id = ${viewAlias}.scope_project_id
            AND team_grant.revoked_at IS NULL
        ) access_route
        WHERE access_route.user_id = ?
        ORDER BY CASE access_route.permission
          WHEN 'full_access' THEN 3 WHEN 'manager' THEN 3
          WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END DESC
        LIMIT 1
      )
      WHEN ${viewAlias}.owner_user_id = ? THEN 'owner'
      ELSE (
        SELECT CASE access_route.permission
          WHEN 'full_access' THEN 'editor'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM (
          SELECT access_grant.grantee_user_id AS user_id, access_grant.permission
          FROM access_grants access_grant
          WHERE access_grant.resource_type = 'saved_view'
            AND access_grant.resource_id = ${viewAlias}.id
            AND access_grant.revoked_at IS NULL
          UNION ALL
          SELECT team_membership.user_id, team_grant.permission
          FROM team_grants team_grant
          JOIN team_memberships team_membership
            ON team_membership.team_id = team_grant.team_id
           AND team_membership.status = 'active'
           AND team_membership.deactivated_at IS NULL
          WHERE team_grant.resource_type = 'saved_view'
            AND team_grant.resource_id = ${viewAlias}.id
            AND team_grant.revoked_at IS NULL
        ) access_route
        WHERE access_route.user_id = ?
        ORDER BY CASE access_route.permission
          WHEN 'full_access' THEN 2 WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 1 ELSE 0 END DESC
        LIMIT 1
      )
    END`;
}

function assertSqlAlias(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error("Invalid SQL alias");
  }
}
