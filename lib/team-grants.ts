import { getD1 } from "@/db";
import {
  canAssignRole,
  type AccessRole,
  type GrantRole,
} from "./access";
import {
  projectEffectiveRoleRankSql,
  savedViewEffectiveRoleRankSql,
  taskEffectiveRoleRankSql,
} from "./access-sql";
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
import type {
  TeamGrantList,
  TeamGrantPermission,
  TeamGrantRecord,
  TeamGrantResourceType,
  UserRecord,
} from "./types";

type DbRow = Record<string, unknown>;

type ShareTarget = TeamGrantList["target"];

export async function listTeamGrants(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamGrantList> {
  const target = await loadShareTarget(
    currentUser,
    resourceType(input.resourceType),
    resourceReference(input.resourceId),
  );
  assertTargetManager(target.accessRole);
  return buildTeamGrantList(target);
}

export async function createTeamGrant(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamGrantList> {
  const target = await loadShareTarget(
    currentUser,
    resourceType(input.resourceType),
    resourceReference(input.resourceId),
  );
  const permission = grantPermission(target.resourceType, input.permission);
  assertCanAssign(target.accessRole, target.resourceType, permission);
  const teamId = await loadActiveTeamId(currentUser.id, resourceReference(input.teamId));
  const existing = await loadGrantByRoute(teamId, target.resourceType, target.resourceId);
  if (existing && existing.revokedAt === null) {
    throw new ConflictError("That Team already has active access");
  }

  const db = getD1();
  const now = new Date().toISOString();
  let mutation: D1PreparedStatement;
  if (existing) {
    const version = expectedVersion(input.version);
    if (version !== existing.version) throw staleGrant();
    mutation = db.prepare(
      `UPDATE team_grants
       SET permission = ?, granted_by_user_id = ?, revoked_at = NULL,
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND revoked_at IS NOT NULL
         AND ${createManagementGuardSql(target.resourceType)}`,
    ).bind(
      permission,
      currentUser.id,
      now,
      existing.id,
      version,
      currentUser.id,
      teamId,
      target.resourceId,
    );
  } else {
    const grantId = `team_grant_${crypto.randomUUID()}`;
    mutation = db.prepare(
      `INSERT INTO team_grants
        (id, team_id, resource_type, resource_id, permission,
         granted_by_user_id, revoked_at, version, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?
       FROM (SELECT ? AS user_id) grant_actor
       WHERE ${createManagementGuardBodySql(target.resourceType)}
       ON CONFLICT(team_id, resource_type, resource_id) DO NOTHING`,
    ).bind(
      grantId,
      teamId,
      target.resourceType,
      target.resourceId,
      permission,
      currentUser.id,
      now,
      now,
      currentUser.id,
      teamId,
      target.resourceId,
    );
  }
  const result = await mutation.run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team access or grant changed in another session");
  }
  return buildTeamGrantList(target);
}

export async function updateTeamGrant(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamGrantList> {
  const grant = await loadGrantForManagement(currentUser, resourceReference(input.grantId));
  const version = expectedVersion(input.version);
  if (version !== grant.record.version) throw staleGrant();
  assertCanAssign(
    grant.target.accessRole,
    grant.target.resourceType,
    grant.record.permission,
  );

  const action = input.action ?? "role";
  let permission = grant.record.permission;
  let lifecyclePredicate: string;
  let lifecycleUpdate: string;
  if (action === "reactivate") {
    if (grant.record.revokedAt === null) {
      throw new ConflictError("Team access is already active");
    }
    permission = Object.hasOwn(input, "permission")
      ? grantPermission(grant.target.resourceType, input.permission)
      : grant.record.permission;
    assertCanAssign(grant.target.accessRole, grant.target.resourceType, permission);
    lifecyclePredicate = "revoked_at IS NOT NULL";
    lifecycleUpdate = "revoked_at = NULL,";
  } else if (action === "role") {
    if (grant.record.revokedAt !== null) {
      throw new ConflictError("Reactivate Team access before changing its role");
    }
    permission = grantPermission(grant.target.resourceType, input.permission);
    assertCanAssign(grant.target.accessRole, grant.target.resourceType, permission);
    lifecyclePredicate = "revoked_at IS NULL";
    lifecycleUpdate = "";
  } else {
    throw new ValidationError("Unsupported Team grant action");
  }

  const db = getD1();
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE team_grants
     SET permission = ?, granted_by_user_id = ?, ${lifecycleUpdate}
       version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND ${lifecyclePredicate}
       AND ${activeTeamManagementGuardSql(grant.target.resourceType)}`,
  ).bind(
    permission,
    currentUser.id,
    now,
    grant.record.id,
    version,
    currentUser.id,
    grant.record.teamId,
    grant.target.resourceId,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) throw staleGrant();
  return buildTeamGrantList(grant.target);
}

export async function revokeTeamGrant(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamGrantList> {
  const grant = await loadGrantForManagement(currentUser, resourceReference(input.grantId));
  const version = expectedVersion(input.version);
  if (version !== grant.record.version) throw staleGrant();
  if (grant.record.revokedAt !== null) {
    throw new ConflictError("Team access is already revoked");
  }
  assertCanAssign(
    grant.target.accessRole,
    grant.target.resourceType,
    grant.record.permission,
  );
  const now = new Date().toISOString();
  const db = getD1();
  const result = await db.prepare(
    `UPDATE team_grants
     SET revoked_at = ?, granted_by_user_id = ?,
       version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND revoked_at IS NULL
       AND ${targetManagementGuardSql(grant.target.resourceType)}`,
  ).bind(
    now,
    currentUser.id,
    now,
    grant.record.id,
    version,
    currentUser.id,
    grant.target.resourceId,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) throw staleGrant();
  return buildTeamGrantList(grant.target);
}

async function loadShareTarget(
  currentUser: UserRecord,
  type: TeamGrantResourceType,
  reference: string,
): Promise<ShareTarget> {
  if (type === "project") {
    const project = await loadAccessibleProject(currentUser.id, reference);
    return {
      resourceType: type,
      resourceId: project.id,
      publicId: project.publicId,
      name: project.name,
      accessRole: project.accessRole,
    };
  }
  if (type === "task") {
    const task = await getTask(currentUser, reference);
    return {
      resourceType: type,
      resourceId: task.id,
      publicId: task.publicId,
      name: task.title,
      accessRole: task.accessRole,
    };
  }
  const view = await loadAccessibleView(currentUser.id, reference);
  if (view.scopeProjectId !== null) {
    throw new ValidationError("Project-scoped Views inherit Project access");
  }
  return {
    resourceType: type,
    resourceId: view.id,
    publicId: view.publicId,
    name: view.name,
    accessRole: view.accessRole,
  };
}

async function loadActiveTeamId(userId: string, reference: string): Promise<string> {
  const row = await getD1().prepare(
    `SELECT team.id
     FROM teams team
     JOIN team_memberships membership ON membership.team_id = team.id
       AND membership.user_id = ?
       AND membership.status = 'active'
       AND membership.deactivated_at IS NULL
     WHERE team.archived_at IS NULL
       AND (team.id = ? OR team.public_id = ?)
     ORDER BY CASE WHEN team.id = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  ).bind(userId, reference, reference, reference).first<{ id: string }>();
  if (!row) throw new NotFoundError("Team not found");
  return String(row.id);
}

async function loadGrantForManagement(
  currentUser: UserRecord,
  grantId: string,
): Promise<{ record: TeamGrantRecord; target: ShareTarget }> {
  const row = await getD1().prepare(
    `${teamGrantProjection()}
     WHERE grant.id = ?
     LIMIT 1`,
  ).bind(grantId).first<DbRow>();
  if (!row) throw new NotFoundError("Team grant not found");
  const record = mapTeamGrant(row);
  let target: ShareTarget;
  try {
    target = await loadShareTarget(
      currentUser,
      record.resourceType,
      record.resourceId,
    );
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ValidationError) {
      throw new NotFoundError("Team grant not found");
    }
    throw error;
  }
  assertTargetManager(target.accessRole);
  return { record, target };
}

async function loadGrantByRoute(
  teamId: string,
  type: TeamGrantResourceType,
  resourceId: string,
): Promise<TeamGrantRecord | null> {
  const row = await getD1().prepare(
    `${teamGrantProjection()}
     WHERE grant.team_id = ?
       AND grant.resource_type = ?
       AND grant.resource_id = ?
     LIMIT 1`,
  ).bind(teamId, type, resourceId).first<DbRow>();
  return row ? mapTeamGrant(row) : null;
}

async function buildTeamGrantList(target: ShareTarget): Promise<TeamGrantList> {
  const rows = await getD1().prepare(
    `${teamGrantProjection()}
     WHERE grant.resource_type = ? AND grant.resource_id = ?
     ORDER BY grant.revoked_at IS NOT NULL, lower(team.name), grant.id`,
  ).bind(target.resourceType, target.resourceId).all<DbRow>();
  return { target, grants: rows.results.map(mapTeamGrant) };
}

function teamGrantProjection(): string {
  return `SELECT grant.*, team.public_id AS team_public_id,
    team.name AS team_name, team.archived_at AS team_archived_at
    FROM team_grants grant JOIN teams team ON team.id = grant.team_id`;
}

function createManagementGuardSql(type: TeamGrantResourceType): string {
  return `EXISTS (
    SELECT 1 FROM (SELECT ? AS user_id) grant_actor
    WHERE ${createManagementGuardBodySql(type)}
  )`;
}

function activeTeamManagementGuardSql(type: TeamGrantResourceType): string {
  return `EXISTS (
    SELECT 1 FROM (SELECT ? AS user_id) grant_actor
    WHERE EXISTS (
      SELECT 1 FROM teams guarded_team
      WHERE guarded_team.id = ? AND guarded_team.archived_at IS NULL
    ) AND ${targetManagementGuardBodySql(type)}
  )`;
}

function targetManagementGuardSql(type: TeamGrantResourceType): string {
  return `EXISTS (
    SELECT 1 FROM (SELECT ? AS user_id) grant_actor
    WHERE ${targetManagementGuardBodySql(type)}
  )`;
}

function targetManagementGuardBodySql(type: TeamGrantResourceType): string {
  const targetAuthority = type === "project"
    ? `EXISTS (
        SELECT 1 FROM projects guarded_project
        WHERE guarded_project.id = ?
          AND guarded_project.deleted_at IS NULL
          AND ${projectEffectiveRoleRankSql("guarded_project", "grant_actor.user_id")} >= 3
      )`
    : type === "task"
      ? `EXISTS (
          SELECT 1 FROM tasks guarded_task
          JOIN projects guarded_project ON guarded_project.id = guarded_task.project_id
          WHERE guarded_task.id = ?
            AND guarded_task.deleted_at IS NULL
            AND guarded_project.deleted_at IS NULL
            AND ${taskEffectiveRoleRankSql(
              "guarded_task",
              "guarded_project",
              "grant_actor.user_id",
            )} >= 3
        )`
      : `EXISTS (
          SELECT 1 FROM saved_views guarded_view
          LEFT JOIN projects guarded_project
            ON guarded_project.id = guarded_view.scope_project_id
          WHERE guarded_view.id = ?
            AND guarded_view.scope_project_id IS NULL
            AND guarded_view.deleted_at IS NULL
            AND ${savedViewEffectiveRoleRankSql(
              "guarded_view",
              "guarded_project",
              "grant_actor.user_id",
            )} >= 3
        )`;
  return targetAuthority;
}

function createManagementGuardBodySql(type: TeamGrantResourceType): string {
  return `EXISTS (
    SELECT 1 FROM teams selected_team
    JOIN team_memberships selected_membership
      ON selected_membership.team_id = selected_team.id
      AND selected_membership.user_id = grant_actor.user_id
      AND selected_membership.status = 'active'
      AND selected_membership.deactivated_at IS NULL
    WHERE selected_team.id = ? AND selected_team.archived_at IS NULL
  ) AND ${targetManagementGuardBodySql(type)}`;
}

function mapTeamGrant(row: DbRow): TeamGrantRecord {
  const type = resourceType(row.resource_type);
  const permission = grantPermission(type, row.permission);
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    teamPublicId: String(row.team_public_id),
    teamName: String(row.team_name),
    teamArchivedAt: nullableString(row.team_archived_at),
    resourceType: type,
    resourceId: String(row.resource_id),
    permission,
    grantedByUserId: String(row.granted_by_user_id),
    revokedAt: nullableString(row.revoked_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function resourceType(value: unknown): TeamGrantResourceType {
  if (value === "project" || value === "task" || value === "saved_view") return value;
  throw new ValidationError("Unsupported Team share target");
}

function resourceReference(value: unknown): string {
  const reference = typeof value === "string" ? value.trim() : "";
  if (!reference) throw new NotFoundError("Share target not found");
  return reference;
}

function grantPermission(
  type: TeamGrantResourceType,
  value: unknown,
): TeamGrantPermission {
  if (value === "viewer" || value === "editor") return value;
  if (type === "project" && value === "manager") return value;
  throw new ValidationError("Choose a valid Team access role");
}

function assertTargetManager(role: AccessRole): void {
  if (role !== "owner" && role !== "manager") {
    throw new NotFoundError("Team share target not found");
  }
}

function assertCanAssign(
  actorRole: AccessRole,
  type: TeamGrantResourceType,
  permission: TeamGrantPermission,
): void {
  assertTargetManager(actorRole);
  const directPolicyType = type === "task" && actorRole === "manager"
    ? "project"
    : type;
  if (!canAssignRole(actorRole, directPolicyType, permission as GrantRole)) {
    throw new PermissionError("You cannot assign that Team role");
  }
}

function expectedVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("Team grant version is required");
  }
  return version;
}

function staleGrant(): ConflictError {
  return new ConflictError("Team grant was changed in another session");
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
