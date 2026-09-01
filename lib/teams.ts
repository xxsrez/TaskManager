import { getD1 } from "@/db";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./domain";
import type {
  TeamCatalog,
  TeamMembershipRecord,
  TeamMembershipStatus,
  TeamRecord,
  UserRecord,
} from "./types";

type DbRow = Record<string, unknown>;

const teamProjection = `
  t.id, t.public_id, t.owner_user_id, t.name, t.archived_at,
  t.version, t.created_at, t.updated_at,
  actor_membership.id AS actor_membership_id,
  actor_membership.role AS actor_membership_role,
  actor_membership.status AS actor_membership_status,
  actor_membership.deactivated_at AS actor_membership_deactivated_at,
  actor_membership.version AS actor_membership_version,
  actor_membership.created_at AS actor_membership_created_at,
  actor_membership.updated_at AS actor_membership_updated_at`;

export async function listTeams(currentUser: UserRecord): Promise<TeamCatalog> {
  const rows = await getD1()
    .prepare(
      `SELECT ${teamProjection}
       FROM teams t
       JOIN team_memberships actor_membership
         ON actor_membership.team_id = t.id
        AND actor_membership.user_id = ?
        AND actor_membership.status = 'active'
        AND actor_membership.deactivated_at IS NULL
       WHERE t.archived_at IS NULL
       ORDER BY lower(t.name), t.id`,
    )
    .bind(currentUser.id)
    .all<DbRow>();

  const teams = await Promise.all(
    rows.results.map((row) => hydrateTeam(currentUser, row)),
  );
  return { teams };
}

export async function getTeam(
  currentUser: UserRecord,
  teamReference: string,
): Promise<TeamRecord> {
  const row = await getD1()
    .prepare(
      `SELECT ${teamProjection}
       FROM teams t
       JOIN team_memberships actor_membership
         ON actor_membership.team_id = t.id
        AND actor_membership.user_id = ?
        AND actor_membership.status = 'active'
        AND actor_membership.deactivated_at IS NULL
       WHERE t.archived_at IS NULL AND (t.id = ? OR t.public_id = ?)`,
    )
    .bind(currentUser.id, teamReference, teamReference)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Team not found");
  return hydrateTeam(currentUser, row);
}

export async function createTeam(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamRecord> {
  const name = teamName(input.name);
  const id = `team_${crypto.randomUUID()}`;
  const publicId = `team_${crypto.randomUUID()}`;
  const membershipId = `team_membership_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const results = await getD1().batch([
    getD1()
      .prepare(
        `INSERT INTO teams
          (id, public_id, owner_user_id, name, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(id, publicId, currentUser.id, name, now, now),
    getD1()
      .prepare(
        `INSERT INTO team_memberships
          (id, team_id, user_id, role, status, deactivated_at,
           version, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', 'active', NULL, 1, ?, ?)`,
      )
      .bind(membershipId, id, currentUser.id, now, now),
  ]);
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1
  ) {
    throw new ConflictError("Team was not created");
  }
  return getTeam(currentUser, id);
}

export async function addTeamMember(
  currentUser: UserRecord,
  teamReference: string,
  input: Record<string, unknown>,
): Promise<TeamRecord> {
  const team = await loadManagedTeam(currentUser, teamReference);
  const email = normalizedEmail(input.email);
  const target = await getD1()
    .prepare("SELECT id FROM users WHERE lower(email) = ? LIMIT 2")
    .bind(email)
    .all<{ id: string }>();
  if (target.results.length !== 1) {
    throw new ValidationError("Choose one registered user");
  }

  const userId = target.results[0]!.id;
  const existing = await getD1()
    .prepare(
      `SELECT id, status, version FROM team_memberships
       WHERE team_id = ? AND user_id = ?`,
    )
    .bind(team.id, userId)
    .first<{ id: string; status: string; version: number }>();
  if (existing?.status === "active") return getTeam(currentUser, team.id);

  const now = new Date().toISOString();
  if (existing) {
    const version = requiredVersion(input.version);
    const result = await getD1()
      .prepare(
        `UPDATE team_memberships
         SET status = 'active', deactivated_at = NULL,
             version = version + 1, updated_at = ?
         WHERE id = ? AND team_id = ? AND version = ? AND status = 'inactive'`,
      )
      .bind(now, existing.id, team.id, version)
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ConflictError("Membership changed in another session");
    }
  } else {
    const result = await getD1()
      .prepare(
        `INSERT INTO team_memberships
          (id, team_id, user_id, role, status, deactivated_at,
           version, created_at, updated_at)
         VALUES (?, ?, ?, 'member', 'active', NULL, 1, ?, ?)`,
      )
      .bind(
        `team_membership_${crypto.randomUUID()}`,
        team.id,
        userId,
        now,
        now,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ConflictError("Membership was not created");
    }
  }
  return getTeam(currentUser, team.id);
}

export async function setTeamMemberStatus(
  currentUser: UserRecord,
  teamReference: string,
  membershipId: string,
  input: Record<string, unknown>,
): Promise<TeamRecord> {
  const team = await loadManagedTeam(currentUser, teamReference);
  const status = membershipStatus(input.status);
  const version = requiredVersion(input.version);
  const membership = await loadManagedMembership(team.id, membershipId);
  if (membership.role === "owner") {
    throw new ValidationError("The Team owner membership must stay active");
  }
  if (membership.status === status) return getTeam(currentUser, team.id);

  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE team_memberships
       SET status = ?, deactivated_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND team_id = ? AND version = ? AND role = 'member'`,
    )
    .bind(
      status,
      status === "inactive" ? now : null,
      now,
      membershipId,
      team.id,
      version,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Membership changed in another session");
  }
  return getTeam(currentUser, team.id);
}

export async function deleteTeamMember(
  currentUser: UserRecord,
  teamReference: string,
  membershipId: string,
  input: Record<string, unknown>,
): Promise<TeamRecord> {
  const team = await loadManagedTeam(currentUser, teamReference);
  const version = requiredVersion(input.version);
  const membership = await loadManagedMembership(team.id, membershipId);
  if (membership.role === "owner") {
    throw new ValidationError("The Team owner membership cannot be removed");
  }
  const result = await getD1()
    .prepare(
      `DELETE FROM team_memberships
       WHERE id = ? AND team_id = ? AND version = ? AND role = 'member'`,
    )
    .bind(membershipId, team.id, version)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Membership changed in another session");
  }
  return getTeam(currentUser, team.id);
}

async function loadManagedTeam(
  currentUser: UserRecord,
  teamReference: string,
) {
  const row = await getD1()
    .prepare(
      `SELECT t.id FROM teams t
       JOIN team_memberships actor_membership
         ON actor_membership.team_id = t.id
        AND actor_membership.user_id = ?
        AND actor_membership.role = 'owner'
        AND actor_membership.status = 'active'
        AND actor_membership.deactivated_at IS NULL
       WHERE t.owner_user_id = ? AND t.archived_at IS NULL
         AND (t.id = ? OR t.public_id = ?)`,
    )
    .bind(currentUser.id, currentUser.id, teamReference, teamReference)
    .first<{ id: string }>();
  if (!row) throw new NotFoundError("Team not found");
  return row;
}

async function loadManagedMembership(teamId: string, membershipId: string) {
  const row = await getD1()
    .prepare(
      `SELECT id, role, status, version FROM team_memberships
       WHERE id = ? AND team_id = ?`,
    )
    .bind(membershipId, teamId)
    .first<{
      id: string;
      role: "owner" | "member";
      status: TeamMembershipStatus;
      version: number;
    }>();
  if (!row) throw new NotFoundError("Membership not found");
  return row;
}

async function hydrateTeam(
  currentUser: UserRecord,
  row: DbRow,
): Promise<TeamRecord> {
  const canManageMembers = String(row.owner_user_id) === currentUser.id &&
    String(row.actor_membership_role) === "owner";
  const members = await getD1()
    .prepare(
      `SELECT m.*, u.display_name, u.email
       FROM team_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ${canManageMembers ? "" : "AND m.status = 'active'"}
       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,
                lower(u.display_name), u.id`,
    )
    .bind(String(row.id))
    .all<DbRow>();
  const mappedMembers = members.results.map(mapMembership);
  const currentMembership = mappedMembers.find(
    (membership) => membership.userId === currentUser.id,
  ) ?? mapActorMembership(currentUser, row);
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    currentMembership,
    members: mappedMembers,
    activeMemberCount: mappedMembers.filter(
      (membership) => membership.status === "active",
    ).length,
    canManageMembers,
  };
}

function mapActorMembership(
  currentUser: UserRecord,
  row: DbRow,
): TeamMembershipRecord {
  return {
    id: String(row.actor_membership_id),
    teamId: String(row.id),
    userId: currentUser.id,
    displayName: currentUser.displayName,
    email: currentUser.email,
    role: String(row.actor_membership_role) as "owner" | "member",
    status: String(row.actor_membership_status) as TeamMembershipStatus,
    deactivatedAt: nullableString(row.actor_membership_deactivated_at),
    version: Number(row.actor_membership_version),
    createdAt: String(row.actor_membership_created_at),
    updatedAt: String(row.actor_membership_updated_at),
  };
}

function mapMembership(row: DbRow): TeamMembershipRecord {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    email: String(row.email),
    role: String(row.role) as "owner" | "member",
    status: String(row.status) as TeamMembershipStatus,
    deactivatedAt: nullableString(row.deactivated_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function teamName(value: unknown) {
  if (typeof value !== "string") throw new ValidationError("Team name is required");
  const name = value.trim();
  if (!name || name.length > 100) {
    throw new ValidationError("Team name must be 1 to 100 characters");
  }
  return name;
}

function normalizedEmail(value: unknown) {
  if (typeof value !== "string") throw new ValidationError("Email is required");
  const email = value.trim().toLocaleLowerCase();
  if (!email || email.length > 320 || !email.includes("@")) {
    throw new ValidationError("Enter a valid registered email");
  }
  return email;
}

function requiredVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError("A current version is required");
  }
  return version;
}

function membershipStatus(value: unknown): TeamMembershipStatus {
  if (value !== "active" && value !== "inactive") {
    throw new ValidationError("Choose an active or inactive membership state");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
