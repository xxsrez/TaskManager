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
  marker_kind: string;
  marker_id: string;
  marker_version: number | null;
  marker_sequence: number;
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
  // Current row versions cover resource mutations and membership changes.
  // The retained-journal marker is deliberately restricted to exact IDs in
  // each Team route and that resource owner's audience: an unrelated private
  // owner event must not become observable as a collaborator reset. Pruning a
  // matching marker may cause one conservative reset, then converges normally.
  return `WITH active_routes AS (
    SELECT team.id AS team_id, team.version AS team_version,
      membership.id AS membership_id,
      membership.version AS membership_version,
      grant.id AS grant_id, grant.version AS grant_version,
      grant.permission, grant.resource_type, grant.resource_id
    FROM team_memberships membership
    JOIN teams team ON team.id = membership.team_id
      AND team.archived_at IS NULL
    JOIN team_grants grant ON grant.team_id = team.id
      AND grant.revoked_at IS NULL
    WHERE membership.user_id = ?
      AND membership.status = 'active'
      AND membership.deactivated_at IS NULL
  ), route_roots AS (
    SELECT route.*,
      route.resource_type AS marker_kind,
      route.resource_id AS marker_id,
      CASE route.resource_type
        WHEN 'project' THEN route_project.version
        WHEN 'task' THEN route_task.version
        WHEN 'saved_view' THEN route_view.version
      END AS marker_version,
      COALESCE((
        SELECT MAX(event.sequence)
        FROM workspace_change_events event
        WHERE event.audience_user_id = CASE route.resource_type
          WHEN 'project' THEN route_project.owner_user_id
          WHEN 'task' THEN COALESCE(
            route_task_project.owner_user_id,
            route_task.owner_user_id
          )
          WHEN 'saved_view' THEN route_view.owner_user_id
        END AND (
          (route.resource_type = 'project' AND (
            (event.entity_type = 'project'
              AND event.entity_id = route.resource_id)
            OR (event.entity_type IN (
                'task', 'task_detail', 'task_comments', 'task_activity',
                'task_attachments', 'task_external_source'
              ) AND EXISTS (
                SELECT 1 FROM tasks event_task
                WHERE event_task.id = event.entity_id
                  AND event_task.project_id = route.resource_id
                  AND event_task.deleted_at IS NULL
              ))
            OR (event.entity_type = 'release' AND EXISTS (
                SELECT 1 FROM releases event_release
                WHERE event_release.id = event.entity_id
                  AND event_release.project_id = route.resource_id
                  AND event_release.deleted_at IS NULL
              ))
            OR (event.entity_type = 'saved_view' AND EXISTS (
                SELECT 1 FROM saved_views event_view
                WHERE event_view.id = event.entity_id
                  AND event_view.scope_project_id = route.resource_id
                  AND event_view.deleted_at IS NULL
              ))
          )) OR (route.resource_type = 'task'
            AND event.entity_id = route.resource_id
            AND event.entity_type IN (
              'task', 'task_detail', 'task_comments', 'task_activity',
              'task_attachments', 'task_external_source'
            )) OR (route.resource_type = 'saved_view'
            AND event.entity_type = 'saved_view'
            AND event.entity_id = route.resource_id)
        )
      ), 0) AS marker_sequence
    FROM active_routes route
    LEFT JOIN projects route_project
      ON route.resource_type = 'project'
      AND route_project.id = route.resource_id
    LEFT JOIN tasks route_task
      ON route.resource_type = 'task'
      AND route_task.id = route.resource_id
    LEFT JOIN projects route_task_project
      ON route_task_project.id = route_task.project_id
    LEFT JOIN saved_views route_view
      ON route.resource_type = 'saved_view'
      AND route_view.id = route.resource_id
  ), route_children AS (
    SELECT route.*, 'task' AS marker_kind, task.id AS marker_id,
      task.version AS marker_version, 0 AS marker_sequence
    FROM active_routes route
    JOIN projects route_project ON route_project.id = route.resource_id
      AND route_project.deleted_at IS NULL
    JOIN tasks task ON task.project_id = route_project.id
      AND task.deleted_at IS NULL
    WHERE route.resource_type = 'project'
    UNION ALL
    SELECT route.*, 'release' AS marker_kind, release.id AS marker_id,
      release.version AS marker_version, 0 AS marker_sequence
    FROM active_routes route
    JOIN projects route_project ON route_project.id = route.resource_id
      AND route_project.deleted_at IS NULL
    JOIN releases release ON release.project_id = route_project.id
      AND release.deleted_at IS NULL
    WHERE route.resource_type = 'project'
    UNION ALL
    SELECT route.*, 'saved_view' AS marker_kind, view.id AS marker_id,
      view.version AS marker_version, 0 AS marker_sequence
    FROM active_routes route
    JOIN projects route_project ON route_project.id = route.resource_id
      AND route_project.deleted_at IS NULL
    JOIN saved_views view ON view.scope_project_id = route_project.id
      AND view.deleted_at IS NULL
    WHERE route.resource_type = 'project'
  )
  SELECT * FROM route_roots
  UNION ALL
  SELECT * FROM route_children
  ORDER BY team_id, membership_id, grant_id, marker_kind, marker_id`;
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
    row.marker_kind,
    row.marker_id,
    row.marker_version == null ? null : Number(row.marker_version),
    Number(row.marker_sequence),
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
