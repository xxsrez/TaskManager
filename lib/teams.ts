import { getD1 } from "@/db";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";
import {
  canAssignRole,
  type AccessRole,
} from "./access";
import {
  loadAccessibleProject,
  loadAccessibleTask,
  loadAccessibleView,
} from "./repository";
import type { UserRecord } from "./types";

type DbRow = Record<string, unknown>;

export type TeamRecord = {
  id: string;
  publicId: string;
  ownerUserId: string;
  name: string;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type TeamMembershipRecord = {
  id: string;
  teamId: string;
  userId: string;
  displayName: string;
  email: string;
  role: "owner" | "member";
  status: "active" | "inactive";
  deactivatedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type TeamDetail = {
  team: TeamRecord;
  members: TeamMembershipRecord[];
};

export type TeamGrantResourceType = "project" | "task" | "saved_view";
export type TeamGrantPermission = "manager" | "editor" | "viewer";

export type TeamGrantRecord = {
  id: string;
  teamId: string;
  resourceType: TeamGrantResourceType;
  resourceId: string;
  permission: TeamGrantPermission;
  grantedByUserId: string;
  revokedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export async function listTeams(
  currentUser: UserRecord,
): Promise<{ teams: TeamRecord[] }> {
  const rows = await getD1()
    .prepare(
      `SELECT t.*
       FROM teams t
       JOIN team_memberships tm ON tm.team_id = t.id
       WHERE tm.user_id = ? AND tm.status = 'active'
         AND t.archived_at IS NULL
       ORDER BY lower(t.name), t.created_at, t.id`,
    )
    .bind(currentUser.id)
    .all<DbRow>();
  return { teams: rows.results.map(mapTeam) };
}

export async function createTeam(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<{ team: TeamRecord; membership: TeamMembershipRecord }> {
  assertOnlyKeys(input, ["name"]);
  const name = teamName(input.name);
  const teamId = `team_${crypto.randomUUID()}`;
  const membershipId = `team_membership_${crypto.randomUUID()}`;
  const publicId = crypto.randomUUID();
  const now = new Date().toISOString();
  const db = getD1();

  await db.batch([
    db
      .prepare(
        `INSERT INTO teams
          (id, public_id, owner_user_id, name, archived_at, version,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
      )
      .bind(teamId, publicId, currentUser.id, name, now, now),
    db
      .prepare(
        `INSERT INTO team_memberships
          (id, team_id, user_id, role, status, deactivated_at, version,
           created_at, updated_at)
         VALUES (?, ?, ?, 'owner', 'active', NULL, 1, ?, ?)`,
      )
      .bind(membershipId, teamId, currentUser.id, now, now),
  ]);

  const detail = await loadTeamDetailForActiveMember(currentUser.id, publicId);
  const membership = detail.members.find((item) => item.id === membershipId);
  if (!membership) throw new Error("Team owner membership could not be read back");
  return { team: detail.team, membership };
}

export async function getTeamDetail(
  currentUser: UserRecord,
  teamReference: string,
): Promise<TeamDetail> {
  return loadTeamDetailForActiveMember(currentUser.id, teamReference);
}

export async function listTeamMembers(
  currentUser: UserRecord,
  teamReference: string,
): Promise<{ members: TeamMembershipRecord[] }> {
  const detail = await loadTeamDetailForActiveMember(currentUser.id, teamReference);
  return { members: detail.members };
}

export async function addTeamMember(
  currentUser: UserRecord,
  teamReference: string,
  input: Record<string, unknown>,
): Promise<{ membership: TeamMembershipRecord }> {
  assertOnlyKeys(input, ["email"]);
  const team = await loadTeamForOwner(currentUser.id, teamReference);
  const email = memberEmail(input.email);
  const users = await getD1()
    .prepare(
      `SELECT id
       FROM users
       WHERE lower(email) = ?
       ORDER BY id
       LIMIT 2`,
    )
    .bind(email)
    .all<{ id: string }>();
  if (users.results.length === 0) throw new NotFoundError("Registered user not found");
  if (users.results.length > 1) {
    throw new ValidationError("More than one account uses that email");
  }
  const userId = String(users.results[0]!.id);
  const teamId = String(team.id);
  const db = getD1();
  const existing = await loadMembership(teamId, undefined, userId);
  if (existing) {
    if (existing.status === "active") return { membership: existing };
    throw new ConflictError(
      "Membership is inactive; reactivate it with its current version",
    );
  }

  const membershipId = `team_membership_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO team_memberships
          (id, team_id, user_id, role, status, deactivated_at, version,
           created_at, updated_at)
         VALUES (?, ?, ?, 'member', 'active', NULL, 1, ?, ?)`,
      )
      .bind(membershipId, teamId, userId, now, now)
      .run();
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    const raced = await loadMembership(teamId, undefined, userId);
    if (raced?.status === "active") return { membership: raced };
    if (raced) {
      throw new ConflictError(
        "Membership is inactive; reactivate it with its current version",
      );
    }
    throw error;
  }

  const membership = await loadMembership(teamId, membershipId);
  if (!membership) throw new Error("Team membership could not be read back");
  return { membership };
}

export async function updateTeamMembership(
  currentUser: UserRecord,
  teamReference: string,
  membershipId: string,
  input: Record<string, unknown>,
): Promise<{ membership: TeamMembershipRecord }> {
  assertOnlyKeys(input, ["status", "version"]);
  const team = await loadTeamForOwner(currentUser.id, teamReference);
  const teamId = String(team.id);
  const status = membershipStatus(input.status);
  const expectedVersion = requiredVersion(input.version);
  const current = await loadMembership(teamId, membershipId);
  if (!current) throw new NotFoundError("Team membership not found");
  protectOwnerMembership(current);
  if (current.version !== expectedVersion) throw staleMembership();
  if (current.status === status) return { membership: current };

  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE team_memberships
       SET status = ?, deactivated_at = ?, version = version + 1,
           updated_at = ?
       WHERE id = ? AND team_id = ? AND role = 'member' AND version = ?`,
    )
    .bind(
      status,
      status === "inactive" ? now : null,
      now,
      membershipId,
      teamId,
      expectedVersion,
    )
    .run();
  if ((result.meta.changes ?? 0) < 1) throw staleMembership();
  const updated = await loadMembership(teamId, membershipId);
  if (!updated) throw new ConflictError("Team membership was removed before read-back");
  return { membership: updated };
}

export async function deleteTeamMembership(
  currentUser: UserRecord,
  teamReference: string,
  membershipId: string,
  input: Record<string, unknown>,
): Promise<{ deleted: true; membership: TeamMembershipRecord }> {
  assertOnlyKeys(input, ["version"]);
  const team = await loadTeamForOwner(currentUser.id, teamReference);
  const teamId = String(team.id);
  const expectedVersion = requiredVersion(input.version);
  const current = await loadMembership(teamId, membershipId);
  if (!current) throw new NotFoundError("Team membership not found");
  protectOwnerMembership(current);
  if (current.version !== expectedVersion) throw staleMembership();

  const result = await getD1()
    .prepare(
      `DELETE FROM team_memberships
       WHERE id = ? AND team_id = ? AND role = 'member' AND version = ?`,
    )
    .bind(membershipId, teamId, expectedVersion)
    .run();
  if ((result.meta.changes ?? 0) < 1) throw staleMembership();
  return { deleted: true, membership: current };
}

/**
 * List active Team grants either for one Team or for one resource. A
 * resource-scoped list is an access-management read and therefore requires
 * the same target authority as assigning the least privileged role.
 */
export async function listTeamGrants(
  currentUser: UserRecord,
  teamReference: string,
  resourceType?: unknown,
  resourceReference?: unknown,
): Promise<{ grants: TeamGrantRecord[] }> {
  const hasResourceType = resourceType !== undefined && resourceType !== null && resourceType !== "";
  const hasResourceReference = resourceReference !== undefined && resourceReference !== null && resourceReference !== "";
  if (hasResourceType !== hasResourceReference) {
    throw new ValidationError("resourceType and resourceId are required together");
  }

  const team = teamReference
    ? await loadTeamForActiveMember(currentUser.id, teamReference)
    : null;
  const normalizedResourceType = hasResourceType
    ? teamGrantResourceType(resourceType)
    : null;
  const target = normalizedResourceType
    ? await resolveTeamGrantTarget(
      currentUser,
      normalizedResourceType,
      String(resourceReference),
      "viewer",
    )
    : null;
  if (!team && !target) throw teamNotFound();

  const resourceScoped = normalizedResourceType !== null && target !== null;
  const predicates = [
    "tg.revoked_at IS NULL",
    "t.archived_at IS NULL",
  ];
  const parameters: unknown[] = [];
  if (!resourceScoped) {
    predicates.push("tm.user_id = ?", "tm.status = 'active'");
    parameters.push(currentUser.id);
  }
  if (team) {
    predicates.push("tg.team_id = ?");
    parameters.push(team.id);
  }
  if (normalizedResourceType && target) {
    predicates.push("tg.resource_type = ?", "tg.resource_id = ?");
    parameters.push(normalizedResourceType, target.resourceId);
  }
  const rows = await getD1()
    .prepare(
      `SELECT tg.id, tg.team_id, tg.resource_type, tg.resource_id, tg.permission,
              tg.granted_by_user_id, tg.revoked_at, tg.version, tg.created_at, tg.updated_at
       FROM team_grants tg
       JOIN teams t ON t.id = tg.team_id
       ${resourceScoped ? "" : "JOIN team_memberships tm ON tm.team_id = tg.team_id"}
       WHERE ${predicates.join(" AND ")}
       ORDER BY tg.created_at DESC, tg.id DESC`,
    )
    .bind(...parameters)
    .all<DbRow>();
  return { grants: rows.results.map(mapTeamGrant) };
}

/**
 * Create, update, or reactivate the single Team grant for a resource. The
 * target is resolved and authorized before any write; no access_grants row is
 * touched by this lifecycle.
 */
export async function upsertTeamGrant(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<{ grant: TeamGrantRecord }> {
  assertOnlyKeys(input, [
    "teamId",
    "teamReference",
    "resourceType",
    "resourceId",
    "permission",
    "version",
  ]);
  const teamReference = String(input.teamId ?? input.teamReference ?? "");
  const team = await loadTeamForActiveMember(currentUser.id, teamReference);
  const teamId = String(team.id);
  const resourceType = teamGrantResourceType(input.resourceType);
  const resourceReference = String(input.resourceId ?? "");
  const permission = teamGrantPermission(resourceType, input.permission);
  const target = await resolveTeamGrantTarget(
    currentUser,
    resourceType,
    resourceReference,
    permission,
  );
  assertTeamGrantAuthority(target.actorRole, resourceType, permission);

  const existing = await loadTeamGrant(teamId, resourceType, target.resourceId);
  const expectedVersion = input.version === undefined
    ? null
    : requiredGrantVersion(input.version);
  const now = new Date().toISOString();
  const db = getD1();

  if (existing) {
    if (expectedVersion !== null && existing.version !== expectedVersion) {
      throw staleTeamGrant();
    }
    if (
      existing.permission === permission &&
      existing.revokedAt === null
    ) {
      return { grant: existing };
    }
    if (expectedVersion === null) {
      throw new ValidationError("Team grant version is required");
    }
    const result = await db
      .prepare(
        `UPDATE team_grants
         SET permission = ?, granted_by_user_id = ?, revoked_at = NULL,
             version = version + 1, updated_at = ?
         WHERE id = ? AND team_id = ?
           AND version = ?`,
      )
      .bind(
        permission,
        currentUser.id,
        now,
        existing.id,
        teamId,
        expectedVersion,
      )
      .run();
    if ((result.meta.changes ?? 0) < 1) throw staleTeamGrant();
    const updated = await loadTeamGrantById(teamId, existing.id);
    if (!updated) throw new ConflictError("Team grant disappeared before read-back");
    return { grant: updated };
  }

  const grantId = `team_grant_${crypto.randomUUID()}`;
  try {
    await db
      .prepare(
        `INSERT INTO team_grants
          (id, team_id, resource_type, resource_id, permission,
           granted_by_user_id, revoked_at, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
      )
      .bind(
        grantId,
        teamId,
        resourceType,
        target.resourceId,
        permission,
        currentUser.id,
        now,
        now,
      )
      .run();
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    const raced = await loadTeamGrant(teamId, resourceType, target.resourceId);
    if (!raced) throw error;
    if (raced.permission === permission && raced.revokedAt === null) {
      return { grant: raced };
    }
    throw staleTeamGrant();
  }
  const created = await loadTeamGrantById(teamId, grantId);
  if (!created) throw new Error("Team grant could not be read back");
  return { grant: created };
}

export const createTeamGrant = upsertTeamGrant;

export async function updateTeamGrant(
  currentUser: UserRecord,
  grantReference: string,
  input: Record<string, unknown>,
): Promise<{ grant: TeamGrantRecord }> {
  assertOnlyKeys(input, ["permission", "version"]);
  const expectedVersion = requiredGrantVersion(input.version);
  const located = await loadTeamGrantForActiveMember(currentUser.id, grantReference);
  if (!located || located.grant.revokedAt !== null) throw teamGrantNotFound();
  const teamId = String(located.team.id);
  const permission = teamGrantPermission(
    located.grant.resourceType,
    input.permission,
  );
  const target = await resolveTeamGrantTarget(
    currentUser,
    located.grant.resourceType,
    located.grant.resourceId,
    permission,
  );
  assertTeamGrantAuthority(
    target.actorRole,
    located.grant.resourceType,
    located.grant.permission,
  );
  assertTeamGrantAuthority(
    target.actorRole,
    located.grant.resourceType,
    permission,
  );
  if (located.grant.version !== expectedVersion) throw staleTeamGrant();

  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE team_grants
       SET permission = ?, granted_by_user_id = ?, version = version + 1,
           updated_at = ?
       WHERE id = ? AND team_id = ? AND revoked_at IS NULL AND version = ?`,
    )
    .bind(
      permission,
      currentUser.id,
      now,
      located.grant.id,
      teamId,
      expectedVersion,
    )
    .run();
  if ((result.meta.changes ?? 0) < 1) throw staleTeamGrant();
  const updated = await loadTeamGrantById(teamId, located.grant.id);
  if (!updated) throw new ConflictError("Team grant disappeared before read-back");
  return { grant: updated };
}

export const patchTeamGrant = updateTeamGrant;

export async function revokeTeamGrant(
  currentUser: UserRecord,
  grantReference: string,
  input: Record<string, unknown>,
): Promise<{ deleted: true; grant: TeamGrantRecord }> {
  assertOnlyKeys(input, ["version"]);
  const expectedVersion = requiredGrantVersion(input.version);
  const located = await loadTeamGrantForActiveMember(currentUser.id, grantReference);
  if (!located || located.grant.revokedAt !== null) throw teamGrantNotFound();
  const teamId = String(located.team.id);
  const target = await resolveTeamGrantTarget(
    currentUser,
    located.grant.resourceType,
    located.grant.resourceId,
    located.grant.permission,
  );
  assertTeamGrantAuthority(
    target.actorRole,
    located.grant.resourceType,
    located.grant.permission,
  );
  if (located.grant.version !== expectedVersion) throw staleTeamGrant();

  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE team_grants
       SET revoked_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND team_id = ? AND revoked_at IS NULL AND version = ?`,
    )
    .bind(now, now, located.grant.id, teamId, expectedVersion)
    .run();
  if ((result.meta.changes ?? 0) < 1) throw staleTeamGrant();
  const revoked = await loadTeamGrantById(teamId, located.grant.id);
  if (!revoked) throw new ConflictError("Team grant disappeared before read-back");
  return { deleted: true, grant: revoked };
}

export const deleteTeamGrant = revokeTeamGrant;

type TeamGrantTarget = {
  resourceId: string;
  ownerUserId: string;
  actorRole: AccessRole;
};

async function resolveTeamGrantTarget(
  currentUser: UserRecord,
  resourceType: TeamGrantResourceType,
  resourceReference: string,
  permission: TeamGrantPermission,
): Promise<TeamGrantTarget> {
  if (!resourceReference) throw new NotFoundError("Share target not found");
  if (resourceType === "project") {
    const project = await loadAccessibleProject(currentUser.id, resourceReference);
    assertTeamGrantAuthority(project.accessRole, resourceType, permission);
    return {
      resourceId: project.id,
      ownerUserId: project.ownerUserId,
      actorRole: project.accessRole,
    };
  }
  if (resourceType === "task") {
    const task = await loadAccessibleTask(currentUser.id, resourceReference);
    if (!task.projectId) {
      throw new ValidationError("Team grants require a project Task");
    }
    let project;
    try {
      project = await loadAccessibleProject(currentUser.id, task.projectId);
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundError("Share target not found");
      throw error;
    }
    assertTeamGrantAuthority(project.accessRole, resourceType, permission);
    return {
      resourceId: task.id,
      ownerUserId: project.ownerUserId,
      actorRole: project.accessRole,
    };
  }

  const view = await loadAccessibleView(currentUser.id, resourceReference);
  if (view.scopeProjectId) {
    throw new ValidationError("Team grants require a global Saved View");
  }
  assertTeamGrantAuthority(view.accessRole, resourceType, permission);
  return {
    resourceId: view.id,
    ownerUserId: view.ownerUserId,
    actorRole: view.accessRole,
  };
}

function assertTeamGrantAuthority(
  actorRole: AccessRole,
  resourceType: TeamGrantResourceType,
  permission: TeamGrantPermission,
): void {
  if (resourceType === "project") {
    if (!canAssignRole(actorRole, "project", permission)) {
      throw new PermissionError("You cannot assign that Team role");
    }
    return;
  }
  if (resourceType === "task") {
    if ((actorRole !== "owner" && actorRole !== "manager") || permission === "manager") {
      throw new PermissionError("Only a Project owner or manager can assign Task Team access");
    }
    return;
  }
  if (actorRole !== "owner" || permission === "manager") {
    throw new PermissionError("Only the Saved View owner can assign Team access");
  }
}

async function loadTeamGrant(
  teamId: string,
  resourceType: TeamGrantResourceType,
  resourceId: string,
): Promise<TeamGrantRecord | null> {
  const row = await getD1()
    .prepare(
      `SELECT id, team_id, resource_type, resource_id, permission,
              granted_by_user_id, revoked_at, version, created_at, updated_at
       FROM team_grants
       WHERE team_id = ? AND resource_type = ? AND resource_id = ?
       LIMIT 1`,
    )
    .bind(teamId, resourceType, resourceId)
    .first<DbRow>();
  return row ? mapTeamGrant(row) : null;
}

async function loadTeamGrantById(
  teamId: string,
  grantId: string,
): Promise<TeamGrantRecord | null> {
  const row = await getD1()
    .prepare(
      `SELECT id, team_id, resource_type, resource_id, permission,
              granted_by_user_id, revoked_at, version, created_at, updated_at
       FROM team_grants
       WHERE team_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(teamId, grantId)
    .first<DbRow>();
  return row ? mapTeamGrant(row) : null;
}

async function loadTeamGrantForActiveMember(
  userId: string,
  grantReference: string,
): Promise<{ team: DbRow; grant: TeamGrantRecord } | null> {
  const row = await getD1()
    .prepare(
      `SELECT tg.id, tg.team_id, tg.resource_type, tg.resource_id,
              tg.permission, tg.granted_by_user_id, tg.revoked_at,
              tg.version, tg.created_at, tg.updated_at,
              t.id AS active_team_id, t.public_id AS active_team_public_id,
              t.owner_user_id AS active_team_owner_user_id,
              t.name AS active_team_name, t.archived_at AS active_team_archived_at,
              t.version AS active_team_version,
              t.created_at AS active_team_created_at,
              t.updated_at AS active_team_updated_at
       FROM team_grants tg
       JOIN teams t ON t.id = tg.team_id AND t.archived_at IS NULL
       JOIN team_memberships tm
         ON tm.team_id = t.id AND tm.user_id = ? AND tm.status = 'active'
       WHERE tg.id = ?
       LIMIT 1`,
    )
    .bind(userId, grantReference)
    .first<DbRow>();
  if (!row) return null;
  const team: DbRow = {
    id: row.active_team_id,
    public_id: row.active_team_public_id,
    owner_user_id: row.active_team_owner_user_id,
    name: row.active_team_name,
    archived_at: row.active_team_archived_at,
    version: row.active_team_version,
    created_at: row.active_team_created_at,
    updated_at: row.active_team_updated_at,
  };
  return { team, grant: mapTeamGrant(row) };
}

async function loadTeamDetailForActiveMember(
  userId: string,
  teamReference: string,
): Promise<TeamDetail> {
  const team = await loadTeamForActiveMember(userId, teamReference);
  const rows = await getD1()
    .prepare(
      `SELECT tm.id, tm.team_id, tm.user_id, tm.role, tm.status,
              tm.deactivated_at, tm.version, tm.created_at, tm.updated_at,
              u.display_name, u.email
       FROM team_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = ?
       ORDER BY CASE WHEN tm.status = 'active' THEN 0 ELSE 1 END,
                lower(u.display_name), lower(u.email), tm.id`,
    )
    .bind(team.id)
    .all<DbRow>();
  return {
    team: mapTeam(team),
    members: rows.results.map(mapMembership),
  };
}

async function loadTeamForActiveMember(
  userId: string,
  teamReference: string,
): Promise<DbRow> {
  const row = await getD1()
    .prepare(
      `SELECT t.*
       FROM teams t
       JOIN team_memberships tm ON tm.team_id = t.id
       WHERE (t.public_id = ? OR t.id = ?)
         AND t.archived_at IS NULL
         AND tm.user_id = ? AND tm.status = 'active'
       LIMIT 1`,
    )
    .bind(teamReference, teamReference, userId)
    .first<DbRow>();
  if (!row) throw teamNotFound();
  return row;
}

async function loadTeamForOwner(
  userId: string,
  teamReference: string,
): Promise<DbRow> {
  const row = await getD1()
    .prepare(
      `SELECT t.*
       FROM teams t
       JOIN team_memberships tm ON tm.team_id = t.id
       WHERE (t.public_id = ? OR t.id = ?)
         AND t.archived_at IS NULL
         AND t.owner_user_id = ? AND tm.user_id = ?
         AND tm.role = 'owner' AND tm.status = 'active'
       LIMIT 1`,
    )
    .bind(teamReference, teamReference, userId, userId)
    .first<DbRow>();
  if (!row) throw teamNotFound();
  return row;
}

async function loadMembership(
  teamId: string,
  membershipId?: string,
  userId?: string,
): Promise<TeamMembershipRecord | null> {
  const predicates = ["tm.team_id = ?"];
  const parameters: unknown[] = [teamId];
  if (membershipId !== undefined) {
    predicates.push("tm.id = ?");
    parameters.push(membershipId);
  }
  if (userId !== undefined) {
    predicates.push("tm.user_id = ?");
    parameters.push(userId);
  }
  const row = await getD1()
    .prepare(
      `SELECT tm.id, tm.team_id, tm.user_id, tm.role, tm.status,
              tm.deactivated_at, tm.version, tm.created_at, tm.updated_at,
              u.display_name, u.email
       FROM team_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE ${predicates.join(" AND ")}
       LIMIT 1`,
    )
    .bind(...parameters)
    .first<DbRow>();
  return row ? mapMembership(row) : null;
}

function mapTeam(row: DbRow): TeamRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMembership(row: DbRow): TeamMembershipRecord {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    email: String(row.email),
    role: String(row.role) as TeamMembershipRecord["role"],
    status: String(row.status) as TeamMembershipRecord["status"],
    deactivatedAt: nullableString(row.deactivated_at),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTeamGrant(row: DbRow): TeamGrantRecord {
  const resourceType = teamGrantResourceType(row.resource_type);
  const permission = teamGrantPermission(resourceType, row.permission);
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    resourceType,
    resourceId: String(row.resource_id),
    permission,
    grantedByUserId: String(row.granted_by_user_id),
    revokedAt: nullableString(row.revoked_at),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function teamName(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Team name is required");
  const name = value.trim();
  if (!name || name.length > 100) {
    throw new ValidationError("Team name must be between 1 and 100 characters");
  }
  return name;
}

function memberEmail(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Member email is required");
  const email = value.trim().toLowerCase();
  if (!email || email.length > 320) {
    throw new ValidationError("Member email must be a registered email");
  }
  return email;
}

function membershipStatus(value: unknown): TeamMembershipRecord["status"] {
  if (value !== "active" && value !== "inactive") {
    throw new ValidationError("Membership status must be active or inactive");
  }
  return value;
}

function requiredVersion(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    throw new ValidationError("Membership version is required");
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError("Membership version is required");
  }
  return version;
}

function requiredGrantVersion(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    throw new ValidationError("Team grant version is required");
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError("Team grant version is required");
  }
  return version;
}

function teamGrantResourceType(value: unknown): TeamGrantResourceType {
  if (value === "project" || value === "task" || value === "saved_view") {
    return value;
  }
  throw new ValidationError("Unsupported Team grant target");
}

function teamGrantPermission(
  resourceType: TeamGrantResourceType,
  value: unknown,
): TeamGrantPermission {
  if (value === "manager" && resourceType === "project") return "manager";
  if (value === "editor" || value === "viewer") return value;
  throw new ValidationError("Choose a valid Team access role");
}

function protectOwnerMembership(membership: TeamMembershipRecord): void {
  if (membership.role === "owner") {
    throw new ConflictError("Owner membership cannot be changed");
  }
}

function staleMembership(): ConflictError {
  return new ConflictError("Team membership was changed in another session");
}

function staleTeamGrant(): ConflictError {
  return new ConflictError("Team grant was changed in another session");
}

function teamGrantNotFound(): NotFoundError {
  return new NotFoundError("Team grant not found");
}

function teamNotFound(): NotFoundError {
  return new NotFoundError("Team not found");
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  const unsupported = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unsupported) throw new ValidationError(`Unsupported Team field: ${unsupported}`);
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
