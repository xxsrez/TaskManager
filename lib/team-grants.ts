import { getD1 } from "@/db";
import {
  canAssignRole,
  canManageGrant,
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
  getTask,
  loadAccessibleProject,
  loadAccessibleView,
} from "./repository";
import type { TeamGrantRecord, UserRecord } from "./types";

type GrantTarget = {
  resourceType: ShareableResourceType;
  resourceId: string;
  actorRole: "owner" | "manager" | "editor" | "viewer";
};

export async function listTeamGrants(
  currentUser: UserRecord,
  resourceTypeValue: unknown,
  resourceIdValue: unknown,
): Promise<{ teamGrants: TeamGrantRecord[] }> {
  const target = await loadGrantTarget(currentUser, resourceTypeValue, resourceIdValue);
  const rows = await getD1()
    .prepare(
      `SELECT tg.*, t.name AS team_name
       FROM team_grants tg JOIN teams t ON t.id = tg.team_id
       WHERE tg.resource_type = ? AND tg.resource_id = ?
         AND tg.revoked_at IS NULL AND t.archived_at IS NULL
       ORDER BY lower(t.name), tg.id`,
    )
    .bind(target.resourceType, target.resourceId)
    .all<Record<string, unknown>>();
  return { teamGrants: rows.results.map(mapTeamGrant) };
}

export async function grantTeamAccess(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<{ teamGrants: TeamGrantRecord[] }> {
  const target = await loadGrantTarget(currentUser, input.resourceType, input.resourceId);
  const permission = requestedGrantRole(input.permission);
  if (!canAssignRole(target.actorRole, target.resourceType, permission)) {
    throw new PermissionError("You cannot grant that Team role");
  }
  const team = await loadSelectableTeam(currentUser, input.teamId);
  const existing = await getD1()
    .prepare(
      `SELECT id, permission, revoked_at FROM team_grants
       WHERE team_id = ? AND resource_type = ? AND resource_id = ?`,
    )
    .bind(team.id, target.resourceType, target.resourceId)
    .first<{ id: string; permission: string; revoked_at: string | null }>();
  if (existing && existing.revoked_at === null) {
    if (existing.permission !== permission) {
      throw new ConflictError("That Team already has a different active role");
    }
    return listTeamGrants(currentUser, target.resourceType, target.resourceId);
  }

  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `INSERT INTO team_grants
        (id, team_id, resource_type, resource_id, permission,
         granted_by_user_id, revoked_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
       ON CONFLICT(team_id, resource_type, resource_id)
       DO UPDATE SET permission = excluded.permission,
         granted_by_user_id = excluded.granted_by_user_id,
         revoked_at = NULL, version = team_grants.version + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(
      `team_grant_${crypto.randomUUID()}`,
      team.id,
      target.resourceType,
      target.resourceId,
      permission,
      currentUser.id,
      now,
      now,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team grant was not created");
  }
  return listTeamGrants(currentUser, target.resourceType, target.resourceId);
}

export async function updateTeamAccess(
  currentUser: UserRecord,
  grantIdValue: unknown,
  input: Record<string, unknown>,
): Promise<{ teamGrants: TeamGrantRecord[] }> {
  const grant = await loadManagedGrant(currentUser, grantIdValue);
  const permission = requestedGrantRole(input.permission);
  if (
    !canManageGrant(grant.target.actorRole, grant.target.resourceType, grant.permission) ||
    !canAssignRole(grant.target.actorRole, grant.target.resourceType, permission)
  ) {
    throw new PermissionError("You cannot change that Team role");
  }
  const version = requiredVersion(input.version);
  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE team_grants
       SET permission = ?, granted_by_user_id = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND revoked_at IS NULL`,
    )
    .bind(permission, currentUser.id, now, grant.id, version)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team grant changed in another session");
  }
  return listTeamGrants(currentUser, grant.target.resourceType, grant.target.resourceId);
}

export async function revokeTeamAccess(
  currentUser: UserRecord,
  grantIdValue: unknown,
  input: Record<string, unknown>,
): Promise<{ teamGrants: TeamGrantRecord[] }> {
  const grant = await loadManagedGrant(currentUser, grantIdValue);
  if (!canManageGrant(grant.target.actorRole, grant.target.resourceType, grant.permission)) {
    throw new PermissionError("You cannot revoke that Team role");
  }
  const version = requiredVersion(input.version);
  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE team_grants
       SET revoked_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND revoked_at IS NULL`,
    )
    .bind(now, now, grant.id, version)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team grant changed in another session");
  }
  return listTeamGrants(currentUser, grant.target.resourceType, grant.target.resourceId);
}

async function loadManagedGrant(currentUser: UserRecord, grantIdValue: unknown) {
  const grantId = requiredReference(grantIdValue, "Team grant");
  const row = await getD1()
    .prepare(
      `SELECT id, resource_type, resource_id, permission
       FROM team_grants WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(grantId)
    .first<{ id: string; resource_type: string; resource_id: string; permission: string }>();
  if (!row) throw new NotFoundError("Team grant not found");
  const target = await loadGrantTarget(currentUser, row.resource_type, row.resource_id);
  return { id: row.id, target, permission: requestedGrantRole(row.permission) };
}

async function loadGrantTarget(
  currentUser: UserRecord,
  resourceTypeValue: unknown,
  resourceIdValue: unknown,
): Promise<GrantTarget> {
  const resourceType = shareableResourceType(resourceTypeValue);
  const reference = requiredReference(resourceIdValue, "Resource");
  if (resourceType === "project") {
    const project = await loadAccessibleProject(currentUser.id, reference);
    return { resourceType, resourceId: project.id, actorRole: project.accessRole };
  }
  if (resourceType === "task") {
    const task = await getTask(currentUser, reference);
    return { resourceType, resourceId: task.id, actorRole: task.accessRole };
  }
  const view = await loadAccessibleView(currentUser.id, reference);
  if (view.scopeProjectId) throw new ValidationError("Manage access on the Project instead");
  return { resourceType, resourceId: view.id, actorRole: view.accessRole };
}

async function loadSelectableTeam(currentUser: UserRecord, teamIdValue: unknown) {
  const teamId = requiredReference(teamIdValue, "Team");
  const row = await getD1()
    .prepare(
      `SELECT t.id FROM teams t
       JOIN team_memberships m ON m.team_id = t.id
       WHERE (t.id = ? OR t.public_id = ?) AND t.archived_at IS NULL
         AND m.user_id = ? AND m.status = 'active'
         AND m.deactivated_at IS NULL`,
    )
    .bind(teamId, teamId, currentUser.id)
    .first<{ id: string }>();
  if (!row) throw new NotFoundError("Team not found");
  return row;
}

function mapTeamGrant(row: Record<string, unknown>): TeamGrantRecord {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    teamName: String(row.team_name),
    resourceType: String(row.resource_type) as TeamGrantRecord["resourceType"],
    resourceId: String(row.resource_id),
    permission: requestedGrantRole(row.permission),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function shareableResourceType(value: unknown): ShareableResourceType {
  if (value === "project" || value === "task" || value === "saved_view") return value;
  throw new ValidationError("Unsupported Team grant target");
}

function requestedGrantRole(value: unknown): GrantRole {
  if (value === "manager" || value === "editor" || value === "viewer") return value;
  throw new ValidationError("Choose a valid Team access role");
}

function requiredReference(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.length > 200) {
    throw new ValidationError(`${label} reference is required`);
  }
  return value;
}

function requiredVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError("A current version is required");
  }
  return version;
}
