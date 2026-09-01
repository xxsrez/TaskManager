import { getD1 } from "@/db";
import {
  canAssignRole,
  normalizeGrantRole,
  type AccessRole,
  type GrantRole,
} from "./access";
import {
  projectAccessRoleSql,
  savedViewAccessRoleSql,
  taskAccessRoleSql,
} from "./access-sql";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";
import type {
  TeamGrantRecord,
  TeamGrantResourceType,
  UserRecord,
} from "./types";

type DbRow = Record<string, unknown>;

export async function listTeamGrants(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamGrantRecord[]> {
  const resourceType = teamGrantResourceType(input.resourceType);
  const target = await loadManageableTarget(
    currentUser.id,
    resourceType,
    requiredResourceRef(input.resourceId),
  );
  assertCanManageTarget(target.actorRole, resourceType, "viewer");
  const rows = await getD1().prepare(
    `${teamGrantProjection()}
     WHERE team_grant.resource_type = ? AND team_grant.resource_id = ?
       AND team_grant.revoked_at IS NULL
     ORDER BY lower(team.name), team_grant.id`,
  ).bind(resourceType, target.id).all<DbRow>();
  return rows.results.map(mapTeamGrant);
}

export async function grantTeamAccess(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamGrantRecord[]> {
  const resourceType = teamGrantResourceType(input.resourceType);
  const target = await loadManageableTarget(
    currentUser.id,
    resourceType,
    requiredResourceRef(input.resourceId),
  );
  const permission = requestedTeamGrantRole(resourceType, input.permission);
  assertCanManageTarget(target.actorRole, resourceType, permission);
  const team = await loadSelectableTeam(currentUser.id, requiredTeamRef(input.teamRef));
  const now = new Date().toISOString();
  await getD1().prepare(
    `INSERT INTO team_grants
       (id, team_id, resource_type, resource_id, permission,
        granted_by_user_id, revoked_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
     ON CONFLICT(team_id, resource_type, resource_id)
     DO UPDATE SET permission = excluded.permission,
       granted_by_user_id = excluded.granted_by_user_id,
       revoked_at = NULL, version = team_grants.version + 1,
       updated_at = excluded.updated_at`,
  ).bind(
    `team-grant:${crypto.randomUUID()}`,
    team.id,
    resourceType,
    target.id,
    permission,
    currentUser.id,
    now,
    now,
  ).run();
  return listTeamGrants(currentUser, {
    resourceType,
    resourceId: target.id,
  });
}

export async function updateTeamAccess(
  currentUser: UserRecord,
  grantId: string,
  input: Record<string, unknown>,
): Promise<TeamGrantRecord[]> {
  const grant = await loadGrantForManagement(currentUser.id, grantId);
  const version = expectedVersion(input.version);
  if (grant.version !== version) throw staleGrant();
  const permission = requestedTeamGrantRole(grant.resourceType, input.permission);
  assertCanManageTarget(grant.actorRole, grant.resourceType, permission);
  const now = new Date().toISOString();
  const result = await getD1().prepare(
    `UPDATE team_grants
     SET permission = ?, granted_by_user_id = ?, version = version + 1,
       updated_at = ?
     WHERE id = ? AND version = ? AND revoked_at IS NULL`,
  ).bind(permission, currentUser.id, now, grantId, version).run();
  if ((result.meta.changes ?? 0) !== 1) throw staleGrant();
  return listTeamGrants(currentUser, {
    resourceType: grant.resourceType,
    resourceId: grant.resourceId,
  });
}

export async function revokeTeamAccess(
  currentUser: UserRecord,
  grantId: string,
  input: Record<string, unknown>,
): Promise<TeamGrantRecord[]> {
  const grant = await loadGrantForManagement(currentUser.id, grantId);
  const version = expectedVersion(input.version);
  if (grant.version !== version) throw staleGrant();
  assertCanManageTarget(grant.actorRole, grant.resourceType, grant.permission);
  const now = new Date().toISOString();
  const result = await getD1().prepare(
    `UPDATE team_grants
     SET revoked_at = ?, granted_by_user_id = ?, version = version + 1,
       updated_at = ?
     WHERE id = ? AND version = ? AND revoked_at IS NULL`,
  ).bind(now, currentUser.id, now, grantId, version).run();
  if ((result.meta.changes ?? 0) !== 1) throw staleGrant();
  return listTeamGrants(currentUser, {
    resourceType: grant.resourceType,
    resourceId: grant.resourceId,
  });
}

async function loadSelectableTeam(userId: string, teamRef: string) {
  const team = await getD1().prepare(
    `SELECT team.id, team.public_id, team.name
     FROM teams team
     JOIN team_memberships membership
       ON membership.team_id = team.id AND membership.user_id = ?
     WHERE (team.id = ? OR team.public_id = ?)
       AND team.archived_at IS NULL
       AND membership.status = 'active' AND membership.deactivated_at IS NULL
     LIMIT 1`,
  ).bind(userId, teamRef, teamRef).first<{ id: string; public_id: string; name: string }>();
  if (!team) throw new NotFoundError("Team not found");
  return team;
}

async function loadManageableTarget(
  userId: string,
  resourceType: TeamGrantResourceType,
  resourceRef: string,
): Promise<{ id: string; actorRole: AccessRole }> {
  let row: DbRow | null;
  if (resourceType === "project") {
    row = await getD1().prepare(
      `SELECT p.id, ${projectAccessRoleSql("p")} AS actor_role
       FROM projects p
       WHERE (p.id = ? OR p.public_id = ?) AND p.deleted_at IS NULL
         AND p.archived_at IS NULL
       LIMIT 1`,
    ).bind(userId, userId, resourceRef, resourceRef).first<DbRow>();
  } else if (resourceType === "task") {
    row = await getD1().prepare(
      `SELECT t.id, ${taskAccessRoleSql("t", "p")} AS actor_role
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE (t.id = ? OR t.public_id = ? OR t.identifier = ?)
         AND t.deleted_at IS NULL AND t.archived_at IS NULL
       LIMIT 1`,
    ).bind(
      userId,
      userId,
      userId,
      userId,
      resourceRef,
      resourceRef,
      resourceRef,
    ).first<DbRow>();
  } else {
    row = await getD1().prepare(
      `SELECT view.id, view.scope_project_id,
         ${savedViewAccessRoleSql("view", "p")} AS actor_role
       FROM saved_views view LEFT JOIN projects p ON p.id = view.scope_project_id
       WHERE (view.id = ? OR view.public_id = ?) AND view.deleted_at IS NULL
         AND view.archived_at IS NULL
       LIMIT 1`,
    ).bind(
      userId,
      userId,
      userId,
      userId,
      resourceRef,
      resourceRef,
    ).first<DbRow>();
    if (row?.scope_project_id != null) {
      throw new ValidationError("Project Saved Views inherit Project access");
    }
  }
  if (!row || !isAccessRole(row.actor_role)) {
    throw new NotFoundError("Share target not found");
  }
  return { id: String(row.id), actorRole: row.actor_role };
}

async function loadGrantForManagement(userId: string, grantId: string) {
  const row = await getD1().prepare(
    `SELECT resource_type, resource_id, permission, version
     FROM team_grants WHERE id = ? AND revoked_at IS NULL`,
  ).bind(grantId).first<DbRow>();
  if (!row) throw new NotFoundError("Team grant not found");
  const resourceType = teamGrantResourceType(row.resource_type);
  const permission = normalizeGrantRole(resourceType, row.permission);
  if (!permission) throw new PermissionError("Team grant role is invalid");
  const target = await loadManageableTarget(userId, resourceType, String(row.resource_id));
  assertCanManageTarget(target.actorRole, resourceType, permission);
  return {
    resourceType,
    resourceId: target.id,
    actorRole: target.actorRole,
    permission,
    version: Number(row.version),
  };
}

function teamGrantProjection(): string {
  return `SELECT team_grant.*, team.public_id AS team_public_id,
      team.name AS team_name
    FROM team_grants team_grant
    JOIN teams team ON team.id = team_grant.team_id`;
}

function mapTeamGrant(row: DbRow): TeamGrantRecord {
  const resourceType = teamGrantResourceType(row.resource_type);
  const permission = normalizeGrantRole(resourceType, row.permission);
  if (!permission) throw new ValidationError("Stored Team grant role is invalid");
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    teamPublicId: String(row.team_public_id),
    teamName: String(row.team_name),
    resourceType,
    resourceId: String(row.resource_id),
    permission,
    revokedAt: nullableString(row.revoked_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function assertCanManageTarget(
  actorRole: AccessRole,
  resourceType: TeamGrantResourceType,
  permission: GrantRole,
): void {
  const allowed = resourceType === "project"
    ? canAssignRole(actorRole, resourceType, permission)
    : (actorRole === "owner" || actorRole === "manager") &&
      (permission === "editor" || permission === "viewer");
  if (!allowed) throw new PermissionError("You cannot manage Team access to this resource");
}

function requestedTeamGrantRole(
  resourceType: TeamGrantResourceType,
  value: unknown,
): GrantRole {
  const role = normalizeGrantRole(resourceType, value);
  if (!role || value === "full_access") {
    throw new ValidationError("Choose a valid Team access role");
  }
  return role;
}

function teamGrantResourceType(value: unknown): TeamGrantResourceType {
  if (value === "project" || value === "task" || value === "saved_view") return value;
  throw new ValidationError("Unsupported Team share target");
}

function requiredResourceRef(value: unknown): string {
  const ref = typeof value === "string" ? value.trim() : "";
  if (!ref) throw new ValidationError("Share target is required");
  return ref;
}

function requiredTeamRef(value: unknown): string {
  const ref = typeof value === "string" ? value.trim() : "";
  if (!ref) throw new ValidationError("Choose a Team");
  return ref;
}

function expectedVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError("A positive Team grant version is required");
  }
  return version;
}

function isAccessRole(value: unknown): value is AccessRole {
  return value === "owner" || value === "manager" ||
    value === "editor" || value === "viewer";
}

function staleGrant(): ConflictError {
  return new ConflictError("Team access changed; reload and retry");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
