import { getD1 } from "@/db";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";
import type {
  TeamDetail,
  TeamList,
  TeamMembershipRecord,
  TeamMembershipRole,
  TeamMembershipStatus,
  TeamRecord,
  UserRecord,
} from "./types";

type DbRow = Record<string, unknown>;

type AccessibleTeam = {
  team: TeamRecord;
  currentMembership: TeamMembershipRecord;
};

export async function createTeam(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamDetail> {
  const teamId = `team_${crypto.randomUUID()}`;
  const membershipId = `membership_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const db = getD1();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO teams
        (id, public_id, owner_user_id, name, archived_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(teamId, crypto.randomUUID(), currentUser.id, teamName(input.name), now, now),
    db.prepare(
      `INSERT INTO team_memberships
        (id, team_id, user_id, role, status, deactivated_at, version, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', NULL, 1, ?, ?)`,
    ).bind(membershipId, teamId, currentUser.id, now, now),
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new ConflictError("Team creation did not commit atomically");
  }
  return getTeamDetail(currentUser, teamId);
}

export async function listTeams(currentUser: UserRecord): Promise<TeamList> {
  const rows = await getD1().prepare(
    `SELECT
       t.id AS team_id, t.public_id AS team_public_id,
       t.owner_user_id AS team_owner_user_id, t.name AS team_name,
       t.archived_at AS team_archived_at, t.version AS team_version,
       t.created_at AS team_created_at, t.updated_at AS team_updated_at,
       tm.id AS membership_id, tm.user_id AS membership_user_id,
       tm.role AS membership_role, tm.status AS membership_status,
       tm.deactivated_at AS membership_deactivated_at,
       tm.version AS membership_version,
       tm.created_at AS membership_created_at,
       tm.updated_at AS membership_updated_at,
       u.display_name AS membership_display_name,
       u.email AS membership_email,
       (SELECT COUNT(*) FROM team_memberships active_members
        WHERE active_members.team_id = t.id AND active_members.status = 'active')
         AS active_member_count
     FROM team_memberships tm
     JOIN teams t ON t.id = tm.team_id
     JOIN users u ON u.id = tm.user_id
     WHERE tm.user_id = ? AND tm.status = 'active' AND t.archived_at IS NULL
     ORDER BY lower(t.name), t.id`,
  ).bind(currentUser.id).all<DbRow>();

  return {
    teams: rows.results.map((row) => ({
      team: mapTeam(row),
      currentMembership: mapMembership(row),
      activeMemberCount: Number(row.active_member_count ?? 0),
    })),
  };
}

export async function getTeamDetail(
  currentUser: UserRecord,
  teamRef: string,
): Promise<TeamDetail> {
  const access = await loadAccessibleTeam(currentUser.id, teamRef);
  return buildTeamDetail(access);
}

export async function updateTeam(
  currentUser: UserRecord,
  teamRef: string,
  input: Record<string, unknown>,
): Promise<TeamDetail> {
  const access = await loadAccessibleTeam(currentUser.id, teamRef);
  assertTeamOwner(access.team, currentUser.id);
  const version = expectedVersion(input.version, "Team");
  if (access.team.version !== version) throw staleTeam();
  const result = await getD1().prepare(
    `UPDATE teams
     SET name = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
  ).bind(
    teamName(input.name),
    new Date().toISOString(),
    access.team.id,
    currentUser.id,
    version,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) throw staleTeam();
  return getTeamDetail(currentUser, access.team.id);
}

export async function listTeamMembers(
  currentUser: UserRecord,
  teamRef: string,
): Promise<{ members: TeamMembershipRecord[] }> {
  const access = await loadAccessibleTeam(currentUser.id, teamRef);
  return { members: await loadTeamMembers(access.team.id) };
}

export async function addTeamMember(
  currentUser: UserRecord,
  teamRef: string,
  input: Record<string, unknown>,
): Promise<TeamDetail> {
  const access = await loadAccessibleTeam(currentUser.id, teamRef);
  assertTeamOwner(access.team, currentUser.id);
  const targetUserId = await resolveRegisteredUserId(input.email);
  const db = getD1();
  const now = new Date().toISOString();

  await db.prepare(
    `INSERT INTO team_memberships
      (id, team_id, user_id, role, status, deactivated_at, version, created_at, updated_at)
     VALUES (?, ?, ?, 'member', 'active', NULL, 1, ?, ?)
     ON CONFLICT(team_id, user_id) DO NOTHING`,
  ).bind(
    `membership_${crypto.randomUUID()}`,
    access.team.id,
    targetUserId,
    now,
    now,
  ).run();

  const membership = await loadMembershipByUser(access.team.id, targetUserId);
  if (!membership) {
    throw new ConflictError("Team membership changed before it could be read back");
  }
  if (membership.status === "inactive") {
    throw new ConflictError("Inactive Team membership must be reactivated explicitly");
  }
  return buildTeamDetail(access);
}

export async function updateTeamMembership(
  currentUser: UserRecord,
  teamRef: string,
  membershipId: string,
  input: Record<string, unknown>,
): Promise<TeamDetail> {
  const access = await loadAccessibleTeam(currentUser.id, teamRef);
  assertTeamOwner(access.team, currentUser.id);
  const membership = await loadMembership(access.team.id, membershipId);
  if (
    membership.role === "owner" ||
    membership.userId === access.team.ownerUserId
  ) {
    throw new ValidationError("The Team owner membership cannot be changed");
  }
  const version = expectedVersion(input.version, "Team membership");
  if (membership.version !== version) throw staleMembership();
  const now = new Date().toISOString();
  const action = input.action;
  let result: D1Result<unknown>;

  if (action === "deactivate") {
    if (membership.status !== "active") {
      throw new ConflictError("Team membership is already inactive");
    }
    result = await getD1().prepare(
      `UPDATE team_memberships
       SET status = 'inactive', deactivated_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND team_id = ? AND role <> 'owner'
         AND status = 'active' AND version = ?`,
    ).bind(now, now, membership.id, access.team.id, version).run();
  } else if (action === "reactivate") {
    if (membership.status !== "inactive") {
      throw new ConflictError("Team membership is already active");
    }
    result = await getD1().prepare(
      `UPDATE team_memberships
       SET status = 'active', deactivated_at = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND team_id = ? AND role <> 'owner'
         AND status = 'inactive' AND version = ?`,
    ).bind(now, membership.id, access.team.id, version).run();
  } else {
    throw new ValidationError("Unsupported Team membership action");
  }

  if ((result.meta.changes ?? 0) !== 1) throw staleMembership();
  return buildTeamDetail(access);
}

export async function deleteTeamMembership(
  currentUser: UserRecord,
  teamRef: string,
  membershipId: string,
  input: Record<string, unknown>,
): Promise<TeamDetail> {
  const access = await loadAccessibleTeam(currentUser.id, teamRef);
  assertTeamOwner(access.team, currentUser.id);
  const membership = await loadMembership(access.team.id, membershipId);
  if (
    membership.role === "owner" ||
    membership.userId === access.team.ownerUserId
  ) {
    throw new ValidationError("The Team owner membership cannot be deleted");
  }
  const version = expectedVersion(input.version, "Team membership");
  if (membership.version !== version) throw staleMembership();
  const result = await getD1().prepare(
    `DELETE FROM team_memberships
     WHERE id = ? AND team_id = ? AND role <> 'owner' AND version = ?`,
  ).bind(membership.id, access.team.id, version).run();
  if ((result.meta.changes ?? 0) !== 1) throw staleMembership();
  return buildTeamDetail(access);
}

async function buildTeamDetail(access: AccessibleTeam): Promise<TeamDetail> {
  return {
    team: access.team,
    currentMembership: access.currentMembership,
    members: await loadTeamMembers(access.team.id),
  };
}

async function loadAccessibleTeam(
  userId: string,
  teamRef: string,
): Promise<AccessibleTeam> {
  const normalizedRef = String(teamRef ?? "").trim();
  if (!normalizedRef) throw new NotFoundError("Team not found");
  const row = await getD1().prepare(
    `SELECT
       t.id AS team_id, t.public_id AS team_public_id,
       t.owner_user_id AS team_owner_user_id, t.name AS team_name,
       t.archived_at AS team_archived_at, t.version AS team_version,
       t.created_at AS team_created_at, t.updated_at AS team_updated_at,
       tm.id AS membership_id, tm.user_id AS membership_user_id,
       tm.role AS membership_role, tm.status AS membership_status,
       tm.deactivated_at AS membership_deactivated_at,
       tm.version AS membership_version,
       tm.created_at AS membership_created_at,
       tm.updated_at AS membership_updated_at,
       u.display_name AS membership_display_name,
       u.email AS membership_email
     FROM teams t
     JOIN team_memberships tm ON tm.team_id = t.id
     JOIN users u ON u.id = tm.user_id
     WHERE tm.user_id = ? AND tm.status = 'active' AND t.archived_at IS NULL
       AND (t.id = ? OR t.public_id = ?)
     ORDER BY CASE WHEN t.id = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  ).bind(userId, normalizedRef, normalizedRef, normalizedRef).first<DbRow>();
  if (!row) throw new NotFoundError("Team not found");
  return { team: mapTeam(row), currentMembership: mapMembership(row) };
}

async function loadTeamMembers(teamId: string): Promise<TeamMembershipRecord[]> {
  const rows = await getD1().prepare(
    `SELECT
       tm.id AS membership_id, tm.team_id AS team_id,
       tm.user_id AS membership_user_id, tm.role AS membership_role,
       tm.status AS membership_status,
       tm.deactivated_at AS membership_deactivated_at,
       tm.version AS membership_version,
       tm.created_at AS membership_created_at,
       tm.updated_at AS membership_updated_at,
       u.display_name AS membership_display_name,
       u.email AS membership_email
     FROM team_memberships tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ?
     ORDER BY tm.role = 'owner' DESC, tm.status = 'active' DESC,
       lower(u.display_name), tm.id`,
  ).bind(teamId).all<DbRow>();
  return rows.results.map(mapMembership);
}

async function loadMembership(
  teamId: string,
  membershipId: string,
): Promise<TeamMembershipRecord> {
  const row = await membershipStatement(
    "tm.team_id = ? AND tm.id = ?",
    teamId,
    String(membershipId ?? ""),
  ).first<DbRow>();
  if (!row) throw new NotFoundError("Team membership not found");
  return mapMembership(row);
}

async function loadMembershipByUser(
  teamId: string,
  userId: string,
): Promise<TeamMembershipRecord | null> {
  const row = await membershipStatement(
    "tm.team_id = ? AND tm.user_id = ?",
    teamId,
    userId,
  ).first<DbRow>();
  return row ? mapMembership(row) : null;
}

function membershipStatement(predicate: string, ...bindings: string[]) {
  return getD1().prepare(
    `SELECT
       tm.id AS membership_id, tm.team_id AS team_id,
       tm.user_id AS membership_user_id, tm.role AS membership_role,
       tm.status AS membership_status,
       tm.deactivated_at AS membership_deactivated_at,
       tm.version AS membership_version,
       tm.created_at AS membership_created_at,
       tm.updated_at AS membership_updated_at,
       u.display_name AS membership_display_name,
       u.email AS membership_email
     FROM team_memberships tm
     JOIN users u ON u.id = tm.user_id
     WHERE ${predicate}
     LIMIT 1`,
  ).bind(...bindings);
}

async function resolveRegisteredUserId(value: unknown): Promise<string> {
  if (typeof value !== "string") {
    throw new ValidationError("Verified email is required");
  }
  const email = value.trim().toLowerCase();
  if (!email || email.length > 320) {
    throw new ValidationError("Verified email is invalid");
  }
  const matches = await getD1().prepare(
    `SELECT DISTINCT u.id
     FROM user_identities identity
     JOIN users u ON u.id = identity.user_id
     WHERE lower(trim(identity.verified_email)) = ?
     ORDER BY u.id
     LIMIT 2`,
  ).bind(email).all<{ id: string }>();
  if (matches.results.length === 0) {
    throw new NotFoundError("That user must sign in once before joining a Team");
  }
  if (matches.results.length > 1) {
    throw new ValidationError("More than one account uses that verified email");
  }
  return matches.results[0]!.id;
}

function assertTeamOwner(team: TeamRecord, userId: string) {
  if (team.ownerUserId !== userId) {
    throw new PermissionError("Only the Team owner can manage it");
  }
}

function teamName(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Team name is required");
  const name = value.trim();
  if (!name) throw new ValidationError("Team name is required");
  if (name.length > 100) {
    throw new ValidationError("Team name must be 100 characters or fewer");
  }
  return name;
}

function expectedVersion(value: unknown, label: string): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError(`${label} version is required`);
  }
  return version;
}

function staleTeam() {
  return new ConflictError("Team was changed in another session");
}

function staleMembership() {
  return new ConflictError("Team membership was changed in another session");
}

function mapTeam(row: DbRow): TeamRecord {
  return {
    id: String(row.team_id),
    publicId: String(row.team_public_id),
    ownerUserId: String(row.team_owner_user_id),
    name: String(row.team_name),
    archivedAt: nullableString(row.team_archived_at),
    version: Number(row.team_version),
    createdAt: String(row.team_created_at),
    updatedAt: String(row.team_updated_at),
  };
}

function mapMembership(row: DbRow): TeamMembershipRecord {
  const role = String(row.membership_role) as TeamMembershipRole;
  const status = String(row.membership_status) as TeamMembershipStatus;
  if (role !== "owner" && role !== "member") {
    throw new ValidationError("Unknown Team membership role");
  }
  if (status !== "active" && status !== "inactive") {
    throw new ValidationError("Unknown Team membership status");
  }
  return {
    id: String(row.membership_id),
    teamId: String(row.team_id),
    userId: String(row.membership_user_id),
    displayName: String(row.membership_display_name),
    email: String(row.membership_email),
    role,
    status,
    deactivatedAt: nullableString(row.membership_deactivated_at),
    version: Number(row.membership_version),
    createdAt: String(row.membership_created_at),
    updatedAt: String(row.membership_updated_at),
  };
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
