import { getD1 } from "@/db";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./domain";
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

function protectOwnerMembership(membership: TeamMembershipRecord): void {
  if (membership.role === "owner") {
    throw new ConflictError("Owner membership cannot be changed");
  }
}

function staleMembership(): ConflictError {
  return new ConflictError("Team membership was changed in another session");
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
