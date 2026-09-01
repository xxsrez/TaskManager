import { getD1 } from "@/db";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";
import type {
  TeamDetailRecord,
  TeamMembershipRecord,
  TeamMembershipStatus,
  TeamRecord,
  UserRecord,
} from "./types";

type DbRow = Record<string, unknown>;

export async function listTeams(currentUser: UserRecord): Promise<TeamRecord[]> {
  const rows = await getD1().prepare(
    `${teamProjection("t")}
     WHERE t.archived_at IS NULL
       AND current_membership.status = 'active'
     ORDER BY lower(t.name), t.id`,
  ).bind(currentUser.id, currentUser.id).all<DbRow>();
  return rows.results.map(mapTeam);
}

export async function getTeam(
  currentUser: UserRecord,
  teamRef: string,
): Promise<TeamDetailRecord> {
  const team = await loadAccessibleTeam(currentUser, teamRef);
  const members = await listTeamMembers(team.id);
  return { ...team, members };
}

export async function createTeam(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamDetailRecord> {
  const name = teamName(input.name);
  const teamId = `team:${crypto.randomUUID()}`;
  const membershipId = `team-membership:${crypto.randomUUID()}`;
  const publicId = crypto.randomUUID();
  const now = new Date().toISOString();
  const db = getD1();
  await db.batch([
    db.prepare(
      `INSERT INTO teams
        (id, public_id, owner_user_id, name, archived_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(teamId, publicId, currentUser.id, name, now, now),
    db.prepare(
      `INSERT INTO team_memberships
        (id, team_id, user_id, role, status, deactivated_at, version, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', NULL, 1, ?, ?)`,
    ).bind(membershipId, teamId, currentUser.id, now, now),
  ]);
  return getTeam(currentUser, publicId);
}

export async function addTeamMember(
  currentUser: UserRecord,
  teamRef: string,
  input: Record<string, unknown>,
): Promise<TeamDetailRecord> {
  const team = await loadAccessibleTeam(currentUser, teamRef);
  assertCanManage(team);
  const email = normalizedEmail(input.email);
  const users = await getD1().prepare(
    `SELECT * FROM users WHERE lower(email) = ? ORDER BY id LIMIT 2`,
  ).bind(email).all<DbRow>();
  if (users.results.length !== 1) {
    throw new ValidationError("Choose one registered user by verified email");
  }
  const userId = String(users.results[0].id);
  const existing = await getD1().prepare(
    `SELECT id, status FROM team_memberships WHERE team_id = ? AND user_id = ?`,
  ).bind(team.id, userId).first<{ id: string; status: TeamMembershipStatus }>();
  if (existing) {
    throw new ConflictError(
      existing.status === "active"
        ? "User is already an active Team member"
        : "Reactivate the existing Team membership",
    );
  }
  const now = new Date().toISOString();
  const result = await getD1().prepare(
    `INSERT INTO team_memberships
      (id, team_id, user_id, role, status, deactivated_at, version, created_at, updated_at)
     SELECT ?, t.id, ?, 'member', 'active', NULL, 1, ?, ?
     FROM teams t
     WHERE t.id = ? AND t.owner_user_id = ? AND t.archived_at IS NULL`,
  ).bind(
    `team-membership:${crypto.randomUUID()}`,
    userId,
    now,
    now,
    team.id,
    currentUser.id,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) throw new NotFoundError("Team not found");
  return getTeam(currentUser, team.id);
}

export async function setTeamMembershipStatus(
  currentUser: UserRecord,
  teamRef: string,
  membershipId: string,
  input: Record<string, unknown>,
): Promise<TeamDetailRecord> {
  const team = await loadAccessibleTeam(currentUser, teamRef);
  assertCanManage(team);
  const version = expectedVersion(input.version);
  const status = membershipStatus(input.status);
  const current = await getD1().prepare(
    `SELECT * FROM team_memberships WHERE id = ? AND team_id = ?`,
  ).bind(membershipId, team.id).first<DbRow>();
  if (!current) throw new NotFoundError("Team membership not found");
  if (String(current.role) === "owner") {
    throw new ValidationError("Team owner membership must remain active");
  }
  if (Number(current.version) !== version) throw staleMembership();
  if (String(current.status) === status) return getTeam(currentUser, team.id);
  const now = new Date().toISOString();
  const result = await getD1().prepare(
    `UPDATE team_memberships
     SET status = ?, deactivated_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND team_id = ? AND version = ? AND role = 'member'
       AND EXISTS (
         SELECT 1 FROM teams t
         WHERE t.id = team_memberships.team_id
           AND t.owner_user_id = ? AND t.archived_at IS NULL
       )`,
  ).bind(
    status,
    status === "inactive" ? now : null,
    now,
    membershipId,
    team.id,
    version,
    currentUser.id,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) throw staleMembership();
  return getTeam(currentUser, team.id);
}

export async function deleteTeamMembership(
  currentUser: UserRecord,
  teamRef: string,
  membershipId: string,
  input: Record<string, unknown>,
): Promise<TeamDetailRecord> {
  const team = await loadAccessibleTeam(currentUser, teamRef);
  assertCanManage(team);
  const version = expectedVersion(input.version);
  const current = await getD1().prepare(
    `SELECT role, version FROM team_memberships WHERE id = ? AND team_id = ?`,
  ).bind(membershipId, team.id).first<{ role: string; version: number }>();
  if (!current) throw new NotFoundError("Team membership not found");
  if (current.role === "owner") {
    throw new ValidationError("Team owner membership cannot be deleted");
  }
  if (Number(current.version) !== version) throw staleMembership();
  const result = await getD1().prepare(
    `DELETE FROM team_memberships
     WHERE id = ? AND team_id = ? AND version = ? AND role = 'member'
       AND EXISTS (
         SELECT 1 FROM teams t
         WHERE t.id = team_memberships.team_id
           AND t.owner_user_id = ? AND t.archived_at IS NULL
       )`,
  ).bind(membershipId, team.id, version, currentUser.id).run();
  if ((result.meta.changes ?? 0) !== 1) throw staleMembership();
  return getTeam(currentUser, team.id);
}

async function loadAccessibleTeam(
  currentUser: UserRecord,
  teamRef: string,
): Promise<TeamRecord> {
  const row = await getD1().prepare(
    `${teamProjection("t")}
     WHERE (t.id = ? OR t.public_id = ?) AND t.archived_at IS NULL
       AND current_membership.status = 'active'
     LIMIT 1`,
  ).bind(currentUser.id, currentUser.id, teamRef, teamRef).first<DbRow>();
  if (!row) throw new NotFoundError("Team not found");
  return mapTeam(row);
}

async function listTeamMembers(teamId: string): Promise<TeamMembershipRecord[]> {
  const rows = await getD1().prepare(
    `SELECT m.*, u.display_name, u.email
     FROM team_memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,
       CASE m.status WHEN 'active' THEN 0 ELSE 1 END,
       lower(u.display_name), m.id`,
  ).bind(teamId).all<DbRow>();
  return rows.results.map(mapMembership);
}

function teamProjection(alias: string): string {
  return `SELECT ${alias}.*,
      current_membership.id AS current_membership_id,
      current_membership.user_id AS current_membership_user_id,
      current_membership.role AS current_membership_role,
      current_membership.status AS current_membership_status,
      current_membership.deactivated_at AS current_membership_deactivated_at,
      current_membership.version AS current_membership_version,
      current_membership.created_at AS current_membership_created_at,
      current_membership.updated_at AS current_membership_updated_at,
      current_user.display_name AS current_membership_display_name,
      current_user.email AS current_membership_email,
      (SELECT COUNT(*) FROM team_memberships active_membership
       WHERE active_membership.team_id = ${alias}.id
         AND active_membership.status = 'active') AS active_member_count,
      CASE WHEN ${alias}.owner_user_id = ? THEN 1 ELSE 0 END AS can_manage_members
    FROM teams ${alias}
    JOIN team_memberships current_membership
      ON current_membership.team_id = ${alias}.id AND current_membership.user_id = ?
    JOIN users current_user ON current_user.id = current_membership.user_id`;
}

function mapTeam(row: DbRow): TeamRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    activeMemberCount: Number(row.active_member_count ?? 0),
    canManageMembers: Number(row.can_manage_members ?? 0) === 1,
    currentMembership: {
      id: String(row.current_membership_id),
      teamId: String(row.id),
      userId: String(row.current_membership_user_id),
      displayName: String(row.current_membership_display_name),
      email: String(row.current_membership_email),
      role: row.current_membership_role === "owner" ? "owner" : "member",
      status: row.current_membership_status === "inactive" ? "inactive" : "active",
      deactivatedAt: nullableString(row.current_membership_deactivated_at),
      version: Number(row.current_membership_version),
      createdAt: String(row.current_membership_created_at),
      updatedAt: String(row.current_membership_updated_at),
    },
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
    deactivatedAt: nullableString(row.deactivated_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function teamName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > 100) {
    throw new ValidationError("Team name must contain 1 to 100 characters");
  }
  return name;
}

function normalizedEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    throw new ValidationError("Enter a registered user email");
  }
  return email;
}

function membershipStatus(value: unknown): TeamMembershipStatus {
  if (value !== "active" && value !== "inactive") {
    throw new ValidationError("Team membership status must be active or inactive");
  }
  return value;
}

function expectedVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError("A positive version is required");
  }
  return version;
}

function assertCanManage(team: TeamRecord): void {
  if (!team.canManageMembers) {
    throw new PermissionError("Only the Team owner can manage members");
  }
}

function staleMembership(): ConflictError {
  return new ConflictError("Team membership changed; reload and retry");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
