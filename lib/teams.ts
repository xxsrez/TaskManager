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

export async function listTeams(currentUser: UserRecord): Promise<TeamCatalog> {
  const db = getD1();
  const [teamRows, membershipRows] = await db.batch<DbRow>([
    db.prepare(
      `SELECT t.*, current_membership.id AS current_membership_id,
          current_membership.role AS current_membership_role,
          current_membership.status AS current_membership_status,
          current_membership.deactivated_at AS current_membership_deactivated_at,
          current_membership.version AS current_membership_version,
          current_membership.created_at AS current_membership_created_at,
          current_membership.updated_at AS current_membership_updated_at,
          (SELECT COUNT(*) FROM team_memberships active_member
            WHERE active_member.team_id = t.id AND active_member.status = 'active') AS active_member_count
       FROM teams t
       JOIN team_memberships current_membership
         ON current_membership.team_id = t.id
        AND current_membership.user_id = ?
        AND current_membership.status = 'active'
       WHERE t.archived_at IS NULL
       ORDER BY lower(t.name), t.id`,
    ).bind(currentUser.id),
    db.prepare(
      `SELECT membership.*, users.display_name, users.email,
          current_membership.role AS current_membership_role
       FROM team_memberships membership
       JOIN users ON users.id = membership.user_id
       JOIN team_memberships current_membership
         ON current_membership.team_id = membership.team_id
        AND current_membership.user_id = ?
        AND current_membership.status = 'active'
       JOIN teams t ON t.id = membership.team_id AND t.archived_at IS NULL
       WHERE membership.status = 'active' OR current_membership.role = 'owner'
       ORDER BY membership.team_id,
         CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
         lower(users.display_name), membership.id`,
    ).bind(currentUser.id),
  ]);

  const membershipsByTeam = new Map<string, TeamMembershipRecord[]>();
  for (const row of membershipRows.results) {
    const membership = mapMembership(row);
    const entries = membershipsByTeam.get(membership.teamId) ?? [];
    entries.push(membership);
    membershipsByTeam.set(membership.teamId, entries);
  }
  return {
    teams: teamRows.results.map((row) =>
      mapTeam(row, currentUser, membershipsByTeam.get(String(row.id)) ?? []),
    ),
  };
}

export async function getTeam(
  currentUser: UserRecord,
  teamRef: string,
): Promise<TeamRecord> {
  const catalog = await listTeams(currentUser);
  const team = catalog.teams.find(
    (candidate) => candidate.id === teamRef || candidate.publicId === teamRef,
  );
  if (!team) throw new NotFoundError("Team not found");
  return team;
}

export async function createTeam(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<TeamRecord> {
  const name = teamName(input.name);
  const db = getD1();
  const now = new Date().toISOString();
  const teamId = `team_${crypto.randomUUID()}`;
  const membershipId = `team_member_${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(
      `INSERT INTO teams
        (id, public_id, owner_user_id, name, archived_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(teamId, crypto.randomUUID(), currentUser.id, name, now, now),
    db.prepare(
      `INSERT INTO team_memberships
        (id, team_id, user_id, role, status, deactivated_at, version, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', NULL, 1, ?, ?)`,
    ).bind(membershipId, teamId, currentUser.id, now, now),
  ]);
  return getTeam(currentUser, teamId);
}

export async function updateTeam(
  currentUser: UserRecord,
  teamRef: string,
  input: Record<string, unknown>,
): Promise<TeamRecord> {
  const team = await requireTeamOwner(currentUser, teamRef);
  const version = requiredVersion(input.version);
  const nextName = Object.hasOwn(input, "name") ? teamName(input.name) : team.name;
  const nextArchivedAt = Object.hasOwn(input, "archived")
    ? input.archived === true
      ? new Date().toISOString()
      : null
    : team.archivedAt;
  const now = new Date().toISOString();
  const result = await getD1().prepare(
    `UPDATE teams SET name = ?, archived_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ?`,
  ).bind(nextName, nextArchivedAt, now, team.id, version).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Team changed in another session");
  }
  if (nextArchivedAt) return { ...team, name: nextName, archivedAt: nextArchivedAt, version: version + 1, updatedAt: now };
  return getTeam(currentUser, team.id);
}

export async function addTeamMembership(
  currentUser: UserRecord,
  teamRef: string,
  input: Record<string, unknown>,
): Promise<TeamRecord> {
  const team = await requireTeamOwner(currentUser, teamRef);
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!email) throw new ValidationError("Member email is required");
  const db = getD1();
  const matches = await db.prepare(
    "SELECT id FROM users WHERE lower(email) = ? ORDER BY id LIMIT 2",
  ).bind(email).all<{ id: string }>();
  if (matches.results.length === 0) {
    throw new NotFoundError("That user must sign in once before joining a Team");
  }
  if (matches.results.length > 1) {
    throw new ValidationError("More than one account uses that email");
  }
  const userId = matches.results[0]!.id;
  const existing = await db.prepare(
    "SELECT id, status FROM team_memberships WHERE team_id = ? AND user_id = ?",
  ).bind(team.id, userId).first<{ id: string; status: string }>();
  if (existing) {
    throw new ConflictError(
      existing.status === "active"
        ? "That user is already an active Team member"
        : "That membership is inactive; reactivate its current version",
    );
  }
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO team_memberships
      (id, team_id, user_id, role, status, deactivated_at, version, created_at, updated_at)
     VALUES (?, ?, ?, 'member', 'active', NULL, 1, ?, ?)`,
  ).bind(`team_member_${crypto.randomUUID()}`, team.id, userId, now, now).run();
  return getTeam(currentUser, team.id);
}

export async function setTeamMembershipStatus(
  currentUser: UserRecord,
  teamRef: string,
  membershipId: string,
  input: Record<string, unknown>,
): Promise<TeamRecord> {
  const team = await requireTeamOwner(currentUser, teamRef);
  const version = requiredVersion(input.version);
  const status = membershipStatus(input.status);
  const membership = team.members.find((candidate) => candidate.id === membershipId);
  if (!membership) throw new NotFoundError("Membership not found");
  if (membership.role === "owner") {
    throw new ValidationError("The Team owner membership must stay active");
  }
  if (membership.version !== version) {
    throw new ConflictError("Membership changed in another session");
  }
  if (membership.status === status) return team;
  const now = new Date().toISOString();
  const result = await getD1().prepare(
    `UPDATE team_memberships
     SET status = ?, deactivated_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND team_id = ? AND version = ?`,
  ).bind(status, status === "inactive" ? now : null, now, membership.id, team.id, version).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Membership changed in another session");
  }
  return getTeam(currentUser, team.id);
}

export async function deleteTeamMembership(
  currentUser: UserRecord,
  teamRef: string,
  membershipId: string,
  input: Record<string, unknown>,
): Promise<TeamRecord> {
  const team = await requireTeamOwner(currentUser, teamRef);
  const version = requiredVersion(input.version);
  const membership = team.members.find((candidate) => candidate.id === membershipId);
  if (!membership) throw new NotFoundError("Membership not found");
  if (membership.role === "owner") {
    throw new ValidationError("The Team owner membership cannot be deleted");
  }
  const result = await getD1().prepare(
    "DELETE FROM team_memberships WHERE id = ? AND team_id = ? AND version = ?",
  ).bind(membership.id, team.id, version).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Membership changed in another session");
  }
  return getTeam(currentUser, team.id);
}

async function requireTeamOwner(currentUser: UserRecord, teamRef: string) {
  const team = await getTeam(currentUser, teamRef);
  if (!team.canManageMembers) throw new NotFoundError("Team not found");
  return team;
}

function mapTeam(
  row: DbRow,
  currentUser: UserRecord,
  members: TeamMembershipRecord[],
): TeamRecord {
  const currentMembership = members.find(
    (membership) => membership.userId === currentUser.id,
  ) ?? {
    id: String(row.current_membership_id),
    teamId: String(row.id),
    userId: currentUser.id,
    displayName: currentUser.displayName,
    email: currentUser.email,
    role: String(row.current_membership_role) as "owner" | "member",
    status: String(row.current_membership_status) as TeamMembershipStatus,
    deactivatedAt: nullableString(row.current_membership_deactivated_at),
    version: Number(row.current_membership_version),
    createdAt: String(row.current_membership_created_at),
    updatedAt: String(row.current_membership_updated_at),
  };
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
    members,
    activeMemberCount: Number(row.active_member_count),
    canManageMembers: currentMembership.role === "owner",
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

function teamName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name || name.length > 100) {
    throw new ValidationError("Team name must be between 1 and 100 characters");
  }
  return name;
}

function membershipStatus(value: unknown): TeamMembershipStatus {
  if (value === "active" || value === "inactive") return value;
  throw new ValidationError("Membership status must be active or inactive");
}

function requiredVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("A current version is required");
  }
  return version;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
