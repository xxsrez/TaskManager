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
  loadAccessibleProject,
  loadAccessibleTask,
  loadAccessibleView,
} from "./repository";
import { listTeams } from "./teams";
import type {
  TeamGrantCandidate,
  TeamGrantCatalog,
  TeamGrantRecord,
  UserRecord,
} from "./types";

type DbRow = Record<string, unknown>;

type TeamGrantTarget = {
  resourceType: ShareableResourceType;
  resourceId: string;
  ownerUserId: string;
  actorRole: AccessRole;
  inheritedProjectId: string | null;
};

export async function listTeamGrants(
  currentUser: UserRecord,
  resourceTypeInput: unknown,
  resourceIdInput: unknown,
): Promise<TeamGrantCatalog> {
  const target = await loadTeamGrantTarget(
    currentUser.id,
    teamGrantResourceType(resourceTypeInput),
    String(resourceIdInput ?? ""),
  );
  if (!canAssignRole(target.actorRole, target.resourceType, "viewer")) {
    throw new PermissionError("You cannot manage Team access to this resource");
  }
  const db = getD1();
  const directRows = await db.prepare(
    `${teamGrantProjection("team_grant")}
     WHERE team_grant.resource_type = ? AND team_grant.resource_id = ?
       AND team_grant.revoked_at IS NULL
     ORDER BY lower(team.name), team_grant.id`,
  ).bind(target.resourceType, target.resourceId).all<DbRow>();
  const inheritedRows = target.inheritedProjectId
    ? await db.prepare(
        `${teamGrantProjection("team_grant")}
         WHERE team_grant.resource_type = 'project'
           AND team_grant.resource_id = ?
           AND team_grant.revoked_at IS NULL
         ORDER BY lower(team.name), team_grant.id`,
      ).bind(target.inheritedProjectId).all<DbRow>()
    : { results: [] as DbRow[] };

  const accessibleTeams = (await listTeams(currentUser)).teams;
  const grantHistory = accessibleTeams.length
    ? await db.prepare(
        `SELECT team_id, id, version, revoked_at
         FROM team_grants
         WHERE resource_type = ? AND resource_id = ?
           AND team_id IN (${accessibleTeams.map(() => "?").join(", ")})`,
      ).bind(
        target.resourceType,
        target.resourceId,
        ...accessibleTeams.map((team) => team.id),
      ).all<{ team_id: string; id: string; version: number; revoked_at: string | null }>()
    : { results: [] as Array<{ team_id: string; id: string; version: number; revoked_at: string | null }> };
  const historyByTeam = new Map(grantHistory.results.map((row) => [row.team_id, row]));
  const availableTeams: TeamGrantCandidate[] = accessibleTeams.map((team) => {
    const history = historyByTeam.get(team.id);
    return {
      teamId: team.id,
      teamName: team.name,
      activeMemberCount: team.activeMemberCount,
      currentMembershipRole: team.currentMembership.role,
      existingGrantId: history?.id ?? null,
      existingGrantVersion: history ? Number(history.version) : null,
      existingGrantActive: Boolean(history && history.revoked_at === null),
    };
  });
  return {
    resourceType: target.resourceType,
    resourceId: target.resourceId,
    accessRole: target.actorRole,
    grants: directRows.results.map((row) => mapGrant(row, "direct")),
    inheritedGrants: inheritedRows.results.map((row) => mapGrant(row, "project")),
    availableTeams,
  };
}

export async function createTeamGrant(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamGrantCatalog> {
  const resourceType = teamGrantResourceType(input.resourceType);
  const resourceId = String(input.resourceId ?? "");
  const target = await loadTeamGrantTarget(currentUser.id, resourceType, resourceId);
  const permission = teamGrantPermission(resourceType, input.permission);
  if (!canAssignRole(target.actorRole, resourceType, permission)) {
    throw new PermissionError("You cannot assign that Team role");
  }
  const teamId = String(input.teamId ?? "");
  const team = (await listTeams(currentUser)).teams.find((candidate) => candidate.id === teamId);
  if (!team) throw new NotFoundError("Team not found");
  const db = getD1();
  const existing = await db.prepare(
    `SELECT id, permission, revoked_at, version FROM team_grants
     WHERE team_id = ? AND resource_type = ? AND resource_id = ?`,
  ).bind(team.id, resourceType, resourceId).first<{
    id: string;
    permission: string;
    revoked_at: string | null;
    version: number;
  }>();
  const now = new Date().toISOString();
  if (existing) {
    const version = requiredVersion(input.version);
    if (existing.revoked_at === null) {
      throw new ConflictError("That Team already has an active route to this resource");
    }
    const result = await db.prepare(
      `UPDATE team_grants SET permission = ?, granted_by_user_id = ?, revoked_at = NULL,
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND revoked_at IS NOT NULL`,
    ).bind(permission, currentUser.id, now, existing.id, version).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ConflictError("Team grant changed in another session");
    }
  } else {
    if (input.version !== undefined && input.version !== null) {
      throw new ConflictError("Team grant state changed in another session");
    }
    await db.prepare(
      `INSERT INTO team_grants
        (id, team_id, resource_type, resource_id, permission, granted_by_user_id,
         revoked_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(
      `team_grant_${crypto.randomUUID()}`,
      team.id,
      resourceType,
      resourceId,
      permission,
      currentUser.id,
      now,
      now,
    ).run();
  }
  return listTeamGrants(currentUser, resourceType, resourceId);
}

export async function updateTeamGrant(
  currentUser: UserRecord,
  grantId: string,
  input: Record<string, unknown>,
): Promise<TeamGrantCatalog> {
  const grant = await loadTeamGrantForManagement(currentUser, grantId);
  const version = requiredVersion(input.version);
  const permission = teamGrantPermission(grant.resourceType, input.permission);
  if (
    !canManageGrant(grant.actorRole, grant.resourceType, grant.permission)
    || !canAssignRole(grant.actorRole, grant.resourceType, permission)
  ) {
    throw new PermissionError("You cannot change that Team route");
  }
  const result = await getD1().prepare(
    `UPDATE team_grants SET permission = ?, granted_by_user_id = ?,
       version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND revoked_at IS NULL`,
  ).bind(permission, currentUser.id, new Date().toISOString(), grant.id, version).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team grant changed in another session");
  }
  return listTeamGrants(currentUser, grant.resourceType, grant.resourceId);
}

export async function revokeTeamGrant(
  currentUser: UserRecord,
  grantId: string,
  input: Record<string, unknown>,
): Promise<TeamGrantCatalog> {
  const grant = await loadTeamGrantForManagement(currentUser, grantId);
  const version = requiredVersion(input.version);
  if (!canManageGrant(grant.actorRole, grant.resourceType, grant.permission)) {
    throw new PermissionError("You cannot revoke that Team route");
  }
  const now = new Date().toISOString();
  const result = await getD1().prepare(
    `UPDATE team_grants SET revoked_at = ?, granted_by_user_id = ?,
       version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND revoked_at IS NULL`,
  ).bind(now, currentUser.id, now, grant.id, version).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team grant changed in another session");
  }
  return listTeamGrants(currentUser, grant.resourceType, grant.resourceId);
}

async function loadTeamGrantForManagement(currentUser: UserRecord, grantId: string) {
  const row = await getD1().prepare(
    `SELECT id, team_id, resource_type, resource_id, permission, version
     FROM team_grants WHERE id = ? AND revoked_at IS NULL`,
  ).bind(grantId).first<{
    id: string;
    team_id: string;
    resource_type: string;
    resource_id: string;
    permission: string;
    version: number;
  }>();
  if (!row) throw new NotFoundError("Team grant not found");
  const resourceType = teamGrantResourceType(row.resource_type);
  const target = await loadTeamGrantTarget(currentUser.id, resourceType, row.resource_id);
  const permission = normalizeGrantRole(resourceType, row.permission);
  if (!permission) throw new PermissionError("Team grant role is invalid");
  return {
    id: row.id,
    teamId: row.team_id,
    resourceType,
    resourceId: row.resource_id,
    permission,
    version: Number(row.version),
    actorRole: target.actorRole,
  };
}

async function loadTeamGrantTarget(
  userId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<TeamGrantTarget> {
  if (resourceType === "project") {
    const project = await loadAccessibleProject(userId, resourceId);
    return {
      resourceType,
      resourceId: project.id,
      ownerUserId: project.ownerUserId,
      actorRole: project.accessRole,
      inheritedProjectId: null,
    };
  }
  if (resourceType === "task") {
    const task = await loadAccessibleTask(userId, resourceId);
    if (!task.projectId) {
      throw new ValidationError("A Team Task route requires a Project Task");
    }
    return {
      resourceType,
      resourceId: task.id,
      ownerUserId: task.ownerUserId,
      actorRole: task.accessRole,
      inheritedProjectId: task.projectId,
    };
  }
  const view = await loadAccessibleView(userId, resourceId);
  if (view.scopeProjectId) {
    throw new ValidationError("Manage Team access on the Project instead");
  }
  return {
    resourceType,
    resourceId: view.id,
    ownerUserId: view.ownerUserId,
    actorRole: view.accessRole,
    inheritedProjectId: null,
  };
}

function teamGrantProjection(alias: string) {
  return `SELECT ${alias}.id, ${alias}.team_id, team.name AS team_name,
      ${alias}.resource_type, ${alias}.resource_id, ${alias}.permission,
      ${alias}.version, ${alias}.created_at, ${alias}.updated_at,
      (SELECT COUNT(*) FROM team_memberships active_member
       WHERE active_member.team_id = team.id AND active_member.status = 'active') AS active_member_count
    FROM team_grants ${alias} JOIN teams team ON team.id = ${alias}.team_id`;
}

function mapGrant(row: DbRow, route: "direct" | "project"): TeamGrantRecord {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    teamName: String(row.team_name),
    activeMemberCount: Number(row.active_member_count),
    resourceType: teamGrantResourceType(row.resource_type),
    resourceId: String(row.resource_id),
    permission: teamGrantPermission(
      teamGrantResourceType(row.resource_type),
      row.permission,
    ),
    route,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function teamGrantResourceType(value: unknown): ShareableResourceType {
  if (value === "project" || value === "task" || value === "saved_view") return value;
  throw new ValidationError("Unsupported Team grant target");
}

function teamGrantPermission(
  resourceType: ShareableResourceType,
  value: unknown,
): GrantRole {
  const permission = normalizeGrantRole(resourceType, value);
  if (!permission || permission === "manager" && resourceType !== "project") {
    throw new ValidationError("Choose a valid Team access role");
  }
  return permission;
}

function requiredVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("A current version is required");
  }
  return version;
}
