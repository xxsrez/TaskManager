import { getD1 } from "@/db";
import {
  canAssignRole,
  canManageGrant,
  normalizeGrantRole,
  type AccessRole,
  type GrantRole,
  type ShareableResourceType,
} from "./access";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";
import {
  projectAccessRoleSql,
  savedViewAccessRoleSql,
  taskAccessRoleSql,
} from "./access-sql";
import type {
  TeamGrantRecord,
  TeamMembershipRecord,
  TeamRecord,
  TeamsCatalog,
  UserRecord,
} from "./types";

type DbRow = Record<string, unknown>;

export async function getTeamsCatalog(user: UserRecord): Promise<TeamsCatalog> {
  const db = getD1();
  const [teams, memberships] = await db.batch<DbRow>([
    db.prepare(
      `SELECT t.*,
          CASE WHEN t.owner_user_id = ? THEN 'owner' ELSE actor_membership.role END
            AS membership_role,
          (SELECT COUNT(*) FROM team_memberships active_membership
           WHERE active_membership.team_id = t.id
             AND active_membership.status = 'active'
             AND active_membership.deactivated_at IS NULL) AS active_member_count
       FROM teams t
       LEFT JOIN team_memberships actor_membership
         ON actor_membership.team_id = t.id
        AND actor_membership.user_id = ?
        AND actor_membership.status = 'active'
        AND actor_membership.deactivated_at IS NULL
       WHERE t.archived_at IS NULL
         AND (t.owner_user_id = ? OR actor_membership.id IS NOT NULL)
       ORDER BY lower(t.name), t.id`,
    ).bind(user.id, user.id, user.id),
    db.prepare(
      `SELECT membership.*, member.display_name, member.email
       FROM team_memberships membership
       JOIN teams team ON team.id = membership.team_id
       JOIN users member ON member.id = membership.user_id
       WHERE team.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM users access_actor
           WHERE access_actor.id = ? AND (
             team.owner_user_id = access_actor.id OR EXISTS (
               SELECT 1 FROM team_memberships actor_membership
               WHERE actor_membership.team_id = team.id
                 AND actor_membership.user_id = access_actor.id
                 AND actor_membership.status = 'active'
                 AND actor_membership.deactivated_at IS NULL
             )
           ))
       ORDER BY membership.team_id,
         CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
         CASE membership.status WHEN 'active' THEN 0 ELSE 1 END,
         lower(member.display_name), membership.id`,
    ).bind(user.id),
  ]);
  return {
    teams: teams.results.map(mapTeam),
    memberships: memberships.results.map(mapMembership),
  };
}

export async function createTeam(user: UserRecord, input: Record<string, unknown>) {
  const name = teamName(input.name);
  const id = `team_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const results = await getD1().batch([
    getD1().prepare(
      `INSERT INTO teams
        (id, public_id, owner_user_id, name, archived_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(id, crypto.randomUUID(), user.id, name, now, now),
    getD1().prepare(
      `INSERT INTO team_memberships
        (id, team_id, user_id, role, status, deactivated_at, version, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', NULL, 1, ?, ?)`,
    ).bind(`team_membership_${crypto.randomUUID()}`, id, user.id, now, now),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team creation did not complete atomically");
  }
}

export async function addTeamMember(
  user: UserRecord,
  teamRef: string,
  input: Record<string, unknown>,
) {
  const teamVersion = exactVersion(input.teamVersion, "Team");
  const team = await loadOwnedTeam(user.id, teamRef);
  if (team.version !== teamVersion) throw new ConflictError("Team changed in another session");
  const email = String(input.email ?? "").trim().toLowerCase();
  const matches = await getD1()
    .prepare("SELECT id FROM users WHERE lower(email) = ? ORDER BY id LIMIT 2")
    .bind(email)
    .all<{ id: string }>();
  if (matches.results.length === 0) {
    throw new NotFoundError("That user must sign in once before joining a Team");
  }
  if (matches.results.length > 1) throw new ValidationError("More than one account uses that email");
  const member = matches.results[0]!;
  if (member.id === team.ownerUserId) throw new ValidationError("The Team owner is already active");
  const now = new Date().toISOString();
  const nextTeamVersion = teamVersion + 1;
  const db = getD1();
  const results = await db.batch([
    db.prepare(
      `UPDATE teams SET version = version + 1, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
    ).bind(now, team.id, user.id, teamVersion),
    db.prepare(
      `INSERT INTO team_memberships
        (id, team_id, user_id, role, status, deactivated_at, version, created_at, updated_at)
       SELECT ?, team.id, ?, 'member', 'active', NULL, 1, ?, ?
       FROM teams team
       WHERE team.id = ? AND team.owner_user_id = ? AND team.version = ?
       ON CONFLICT(team_id, user_id) DO UPDATE SET
         role = 'member', status = 'active', deactivated_at = NULL,
         version = team_memberships.version + 1, updated_at = excluded.updated_at`,
    ).bind(
      `team_membership_${crypto.randomUUID()}`,
      member.id,
      now,
      now,
      team.id,
      user.id,
      nextTeamVersion,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team membership changed in another session");
  }
}

export async function updateTeamMember(
  user: UserRecord,
  teamRef: string,
  membershipRef: string,
  input: Record<string, unknown>,
) {
  const teamVersion = exactVersion(input.teamVersion, "Team");
  const membershipVersion = exactVersion(input.membershipVersion, "Membership");
  const status = input.status === "active" || input.status === "inactive"
    ? input.status
    : null;
  if (!status) throw new ValidationError("Choose an active or inactive membership state");
  const team = await loadOwnedTeam(user.id, teamRef);
  if (team.version !== teamVersion) throw new ConflictError("Team changed in another session");
  const membership = await loadManagedMembership(team.id, membershipRef);
  if (membership.role === "owner") throw new ValidationError("The Team owner cannot be deactivated");
  if (membership.version !== membershipVersion) {
    throw new ConflictError("Membership changed in another session");
  }
  const now = new Date().toISOString();
  const db = getD1();
  const results = await db.batch([
    db.prepare(
      `UPDATE team_memberships SET status = ?, deactivated_at = ?,
         version = version + 1, updated_at = ?
       WHERE id = ? AND team_id = ? AND role = 'member' AND version = ?
         AND EXISTS (SELECT 1 FROM teams team
           WHERE team.id = team_memberships.team_id
             AND team.owner_user_id = ? AND team.version = ? AND team.archived_at IS NULL)`,
    ).bind(
      status,
      status === "inactive" ? now : null,
      now,
      membership.id,
      team.id,
      membershipVersion,
      user.id,
      teamVersion,
    ),
    db.prepare(
      `UPDATE teams SET version = version + 1, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND version = ?
         AND EXISTS (SELECT 1 FROM team_memberships membership
           WHERE membership.id = ? AND membership.team_id = teams.id
             AND membership.version = ?)`,
    ).bind(now, team.id, user.id, teamVersion, membership.id, membershipVersion + 1),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Membership changed in another session");
  }
}

export async function deleteTeamMember(
  user: UserRecord,
  teamRef: string,
  membershipRef: string,
  input: Record<string, unknown>,
) {
  const teamVersion = exactVersion(input.teamVersion, "Team");
  const membershipVersion = exactVersion(input.membershipVersion, "Membership");
  const team = await loadOwnedTeam(user.id, teamRef);
  if (team.version !== teamVersion) throw new ConflictError("Team changed in another session");
  const membership = await loadManagedMembership(team.id, membershipRef);
  if (membership.role === "owner") throw new ValidationError("The Team owner cannot be removed");
  if (membership.version !== membershipVersion) {
    throw new ConflictError("Membership changed in another session");
  }
  const now = new Date().toISOString();
  const db = getD1();
  const results = await db.batch([
    db.prepare(
      `DELETE FROM team_memberships
       WHERE id = ? AND team_id = ? AND role = 'member' AND version = ?
         AND EXISTS (SELECT 1 FROM teams team
           WHERE team.id = team_memberships.team_id
             AND team.owner_user_id = ? AND team.version = ? AND team.archived_at IS NULL)`,
    ).bind(membership.id, team.id, membershipVersion, user.id, teamVersion),
    db.prepare(
      `UPDATE teams SET version = version + 1, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND version = ?
         AND NOT EXISTS (SELECT 1 FROM team_memberships membership
           WHERE membership.id = ? AND membership.team_id = teams.id)`,
    ).bind(now, team.id, user.id, teamVersion, membership.id),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Membership changed in another session");
  }
}

export async function getTeamGrantContext(
  user: UserRecord,
  input: { resourceType: string; resourceId: string },
): Promise<{ teams: TeamRecord[]; grants: TeamGrantRecord[]; actorRole: AccessRole }> {
  const resourceType = teamResourceType(input.resourceType);
  const target = await loadTeamShareTarget(user.id, resourceType, input.resourceId);
  const catalog = await getTeamsCatalog(user);
  const rows = await getD1().prepare(
    `SELECT grant_row.id, grant_row.team_id, team.name AS team_name,
       grant_row.resource_type, grant_row.resource_id, grant_row.permission,
       grant_row.version
     FROM team_grants grant_row
     JOIN teams team ON team.id = grant_row.team_id
     WHERE grant_row.resource_type = ? AND grant_row.resource_id = ?
       AND grant_row.revoked_at IS NULL
     ORDER BY lower(team.name), grant_row.id`,
  ).bind(resourceType, target.resourceId).all<DbRow>();
  return {
    teams: catalog.teams,
    grants: rows.results.map(mapGrant),
    actorRole: target.actorRole,
  };
}

export async function grantTeamAccess(user: UserRecord, input: Record<string, unknown>) {
  const resourceType = teamResourceType(input.resourceType);
  const resourceId = String(input.resourceId ?? "");
  const target = await loadTeamShareTarget(user.id, resourceType, resourceId);
  const permission = teamGrantRole(resourceType, input.permission);
  if (!canAssignRole(target.actorRole, resourceType, permission)) {
    throw new PermissionError("You cannot assign that Team role");
  }
  const team = await loadAccessibleTeam(user.id, String(input.teamId ?? ""));
  const existing = await getD1().prepare(
    `SELECT id, permission, version, revoked_at FROM team_grants
     WHERE team_id = ? AND resource_type = ? AND resource_id = ?`,
  ).bind(team.id, resourceType, target.resourceId).first<{
    id: string; permission: string; version: number; revoked_at: string | null;
  }>();
  const now = new Date().toISOString();
  if (!existing) {
    await getD1().prepare(
      `INSERT INTO team_grants
        (id, team_id, resource_type, resource_id, permission,
         granted_by_user_id, revoked_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(
      `team_grant_${crypto.randomUUID()}`,
      team.id,
      resourceType,
      target.resourceId,
      permission,
      user.id,
      now,
      now,
    ).run();
    return;
  }
  if (existing.revoked_at !== null) {
    const result = await getD1().prepare(
      `UPDATE team_grants SET permission = ?, granted_by_user_id = ?,
         revoked_at = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND revoked_at IS NOT NULL`,
    ).bind(permission, user.id, now, existing.id, existing.version).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ConflictError("Team grant changed in another session");
    }
    return;
  }
  const expectedVersion = exactVersion(input.version, "Team grant");
  const existingRole = teamGrantRole(resourceType, existing.permission);
  if (!canManageGrant(target.actorRole, resourceType, existingRole)) {
    throw new PermissionError("You cannot change that Team route");
  }
  const result = await getD1().prepare(
    `UPDATE team_grants SET permission = ?, granted_by_user_id = ?,
       revoked_at = NULL, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ?`,
  ).bind(permission, user.id, now, existing.id, expectedVersion).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team grant changed in another session");
  }
}

export async function revokeTeamAccess(user: UserRecord, input: Record<string, unknown>) {
  const resourceType = teamResourceType(input.resourceType);
  const resourceId = String(input.resourceId ?? "");
  const target = await loadTeamShareTarget(user.id, resourceType, resourceId);
  const team = await loadAccessibleTeam(user.id, String(input.teamId ?? ""));
  const expectedVersion = exactVersion(input.version, "Team grant");
  const existing = await getD1().prepare(
    `SELECT id, permission, version FROM team_grants
     WHERE team_id = ? AND resource_type = ? AND resource_id = ?
       AND revoked_at IS NULL`,
  ).bind(team.id, resourceType, target.resourceId).first<{
    id: string; permission: string; version: number;
  }>();
  if (!existing) throw new NotFoundError("Team grant not found");
  const existingRole = teamGrantRole(resourceType, existing.permission);
  if (!canManageGrant(target.actorRole, resourceType, existingRole)) {
    throw new PermissionError("You cannot remove that Team route");
  }
  const now = new Date().toISOString();
  const result = await getD1().prepare(
    `UPDATE team_grants SET revoked_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND revoked_at IS NULL`,
  ).bind(now, now, existing.id, expectedVersion).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team grant changed in another session");
  }
}

async function loadOwnedTeam(userId: string, teamRef: string) {
  const row = await getD1().prepare(
    `SELECT * FROM teams
     WHERE (id = ? OR public_id = ?) AND owner_user_id = ? AND archived_at IS NULL`,
  ).bind(teamRef, teamRef, userId).first<DbRow>();
  if (!row) throw new NotFoundError("Team not found");
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    version: Number(row.version),
  };
}

async function loadAccessibleTeam(userId: string, teamRef: string) {
  const row = await getD1().prepare(
    `SELECT team.* FROM teams team
     WHERE (team.id = ? OR team.public_id = ?) AND team.archived_at IS NULL
       AND (team.owner_user_id = ? OR EXISTS (
         SELECT 1 FROM team_memberships membership
         WHERE membership.team_id = team.id AND membership.user_id = ?
           AND membership.status = 'active' AND membership.deactivated_at IS NULL
       ))`,
  ).bind(teamRef, teamRef, userId, userId).first<DbRow>();
  if (!row) throw new NotFoundError("Team not found");
  return { id: String(row.id) };
}

async function loadManagedMembership(teamId: string, membershipRef: string) {
  const row = await getD1().prepare(
    `SELECT id, role, version FROM team_memberships
     WHERE team_id = ? AND (id = ? OR user_id = ?)`,
  ).bind(teamId, membershipRef, membershipRef).first<DbRow>();
  if (!row) throw new NotFoundError("Membership not found");
  return {
    id: String(row.id),
    role: String(row.role),
    version: Number(row.version),
  };
}

async function loadTeamShareTarget(
  userId: string,
  resourceType: ShareableResourceType,
  resourceRef: string,
) {
  if (resourceType === "project") {
    const row = await getD1().prepare(
      `WITH scoped AS (
         SELECT project.id, project.owner_user_id,
           ${projectAccessRoleSql("project")} AS access_role
         FROM projects project
         WHERE project.id = ? OR project.public_id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    ).bind(userId, userId, resourceRef, resourceRef).first<DbRow>();
    if (!row) throw new NotFoundError("Project not found");
    return {
      resourceId: String(row.id),
      ownerUserId: String(row.owner_user_id),
      actorRole: accessRole(row.access_role),
    };
  }
  if (resourceType === "task") {
    const row = await getD1().prepare(
      `WITH scoped AS (
         SELECT task.id, task.owner_user_id, task.project_id,
           ${taskAccessRoleSql("task", "project")} AS access_role
         FROM tasks task LEFT JOIN projects project ON project.id = task.project_id
         WHERE task.id = ? OR task.public_id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    ).bind(
      userId,
      userId,
      userId,
      userId,
      resourceRef,
      resourceRef,
    ).first<DbRow>();
    if (!row) throw new NotFoundError("Task not found");
    const ownerUserId = row.project_id
      ? await getD1().prepare("SELECT owner_user_id FROM projects WHERE id = ?")
          .bind(String(row.project_id)).first<{ owner_user_id: string }>()
      : null;
    return {
      resourceId: String(row.id),
      ownerUserId: ownerUserId?.owner_user_id ?? String(row.owner_user_id),
      actorRole: accessRole(row.access_role),
    };
  }
  const row = await getD1().prepare(
    `WITH scoped AS (
       SELECT view_row.id, view_row.owner_user_id, view_row.scope_project_id,
         ${savedViewAccessRoleSql("view_row", "project")} AS access_role
       FROM saved_views view_row
       LEFT JOIN projects project ON project.id = view_row.scope_project_id
       WHERE view_row.id = ? OR view_row.public_id = ?
     ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
  ).bind(
    userId,
    userId,
    userId,
    userId,
    resourceRef,
    resourceRef,
  ).first<DbRow>();
  if (!row) throw new NotFoundError("View not found");
  if (row.scope_project_id) {
    throw new ValidationError("Manage Team access on the Project for this saved view");
  }
  return {
    resourceId: String(row.id),
    ownerUserId: String(row.owner_user_id),
    actorRole: accessRole(row.access_role),
  };
}

function teamName(value: unknown) {
  const name = String(value ?? "").trim();
  if (name.length < 1 || name.length > 100) {
    throw new ValidationError("Team name must be between 1 and 100 characters");
  }
  return name;
}

function exactVersion(value: unknown, label: string) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError(`${label} version is required`);
  }
  return version;
}

function teamResourceType(value: unknown): ShareableResourceType {
  if (value === "project" || value === "task" || value === "saved_view") return value;
  throw new ValidationError("Unsupported Team grant target");
}

function teamGrantRole(resourceType: ShareableResourceType, value: unknown): GrantRole {
  const role = normalizeGrantRole(resourceType, value);
  if (!role) throw new ValidationError("Choose a valid Team access role");
  return role;
}

function accessRole(value: unknown): AccessRole {
  if (value === "owner" || value === "manager" || value === "editor" || value === "viewer") {
    return value;
  }
  throw new NotFoundError("Resource not found");
}

function mapTeam(row: DbRow): TeamRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    membershipRole: row.membership_role === "owner" ? "owner" : "member",
    activeMemberCount: Number(row.active_member_count ?? 0),
  };
}

function mapMembership(row: DbRow): TeamMembershipRecord {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    email: String(row.email),
    role: row.role === "owner" ? "owner" : "member",
    status: row.status === "inactive" ? "inactive" : "active",
    deactivatedAt: row.deactivated_at == null ? null : String(row.deactivated_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapGrant(row: DbRow): TeamGrantRecord {
  const resourceType = teamResourceType(row.resource_type);
  return {
    grantId: String(row.id),
    teamId: String(row.team_id),
    teamName: String(row.team_name),
    resourceType,
    resourceId: String(row.resource_id),
    permission: teamGrantRole(resourceType, row.permission),
    version: Number(row.version),
  };
}
