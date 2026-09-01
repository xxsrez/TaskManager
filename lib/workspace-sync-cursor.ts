const LEGACY_CURSOR_PREFIX = "tm-workspace-sync:v1:";
const CURSOR_PREFIX = "tm-workspace-sync:v2:";
export const EMPTY_TEAM_ACCESS_FINGERPRINT = "none";

export type WorkspaceSyncCursorState = {
  sequence: number;
  teamAccessFingerprint: string | null;
};

export type TeamAccessFingerprintRow = {
  team_id: string;
  team_version: number;
  membership_id: string;
  membership_version: number;
  grant_id: string;
  grant_version: number;
  permission: string;
  resource_type: string;
  resource_id: string;
};

export function encodeWorkspaceSyncCursor(
  sequence: number,
  teamAccessFingerprint = EMPTY_TEAM_ACCESS_FINGERPRINT,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Workspace sync sequence must be a non-negative integer");
  }
  if (!validFingerprint(teamAccessFingerprint)) {
    throw new Error("Workspace sync Team fingerprint is invalid");
  }
  return encode(`${CURSOR_PREFIX}${sequence}:${teamAccessFingerprint}`);
}

export function encodeLegacyWorkspaceSyncCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Workspace sync sequence must be a non-negative integer");
  }
  return encode(`${LEGACY_CURSOR_PREFIX}${sequence}`);
}

export function decodeWorkspaceSyncCursor(value: string): number | null {
  return decodeWorkspaceSyncCursorState(value)?.sequence ?? null;
}

export function decodeWorkspaceSyncCursorState(
  value: string,
): WorkspaceSyncCursorState | null {
  if (!value || value.length > 256) return null;
  try {
    const decoded = decode(value);
    if (decoded.startsWith(LEGACY_CURSOR_PREFIX)) {
      const sequence = parseSequence(decoded.slice(LEGACY_CURSOR_PREFIX.length));
      return sequence === null ? null : { sequence, teamAccessFingerprint: null };
    }
    if (!decoded.startsWith(CURSOR_PREFIX)) return null;
    const payload = decoded.slice(CURSOR_PREFIX.length);
    const separator = payload.indexOf(":");
    if (separator < 1) return null;
    const sequence = parseSequence(payload.slice(0, separator));
    const teamAccessFingerprint = payload.slice(separator + 1);
    if (sequence === null || !validFingerprint(teamAccessFingerprint)) return null;
    return { sequence, teamAccessFingerprint };
  } catch {
    return null;
  }
}

export async function currentTeamAccessFingerprint(
  db: D1Database,
  userId: string,
): Promise<string> {
  const rows = await db.prepare(teamAccessFingerprintSql())
    .bind(userId)
    .all<TeamAccessFingerprintRow>();
  return teamAccessFingerprintFromRows(rows.results);
}

export function teamAccessFingerprintSql(): string {
  return `SELECT team.id AS team_id,
       team.version AS team_version,
       membership.id AS membership_id,
       membership.version AS membership_version,
       grant.id AS grant_id,
       grant.version AS grant_version,
       grant.permission, grant.resource_type, grant.resource_id
     FROM team_memberships membership
     JOIN teams team ON team.id = membership.team_id
       AND team.archived_at IS NULL
     JOIN team_grants grant ON grant.team_id = team.id
       AND grant.revoked_at IS NULL
     WHERE membership.user_id = ?
       AND membership.status = 'active'
       AND membership.deactivated_at IS NULL
     ORDER BY team.id, membership.id, grant.resource_type,
       grant.resource_id, grant.id`;
}

export async function teamAccessFingerprintFromRows(
  rows: TeamAccessFingerprintRow[],
): Promise<string> {
  if (rows.length === 0) return EMPTY_TEAM_ACCESS_FINGERPRINT;
  const canonical = rows.map((row) => [
    row.team_id,
    Number(row.team_version),
    row.membership_id,
    Number(row.membership_version),
    row.grant_id,
    Number(row.grant_version),
    row.permission,
    row.resource_type,
    row.resource_id,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function encode(value: string): string {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decode(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return atob(padded);
}

function parseSequence(value: string): number | null {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function validFingerprint(value: string): boolean {
  return /^(?:none|[a-f0-9]{64})$/u.test(value);
}
