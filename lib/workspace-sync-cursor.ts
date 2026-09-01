const LEGACY_CURSOR_PREFIX = "tm-workspace-sync:v1:";
const VERSION_TWO_CURSOR_PREFIX = "tm-workspace-sync:v2:";
const CURSOR_PREFIX = "tm-workspace-sync:v3:";
// Seven-day generations remain comfortably inside the 30-day event retention
// window while avoiding a new cursor on every idle poll.
export const WORKSPACE_SYNC_CURSOR_GENERATION_MS = 7 * 24 * 60 * 60 * 1_000;
export const EMPTY_TEAM_ACCESS_FINGERPRINT = "none";

export type WorkspaceSyncCursorState = {
  sequence: number;
  teamAccessFingerprint: string | null;
  issuedGeneration: number | null;
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
  route_owner_user_id: string | null;
  current_state: string;
  marker_sequence: number;
};

export function encodeWorkspaceSyncCursor(
  sequence: number,
  teamAccessFingerprint = EMPTY_TEAM_ACCESS_FINGERPRINT,
  issuedAt = Date.now(),
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Workspace sync sequence must be a non-negative integer");
  }
  if (!validFingerprint(teamAccessFingerprint)) {
    throw new Error("Workspace sync Team fingerprint is invalid");
  }
  const issuedGeneration = workspaceSyncCursorGeneration(issuedAt);
  return encode(
    `${CURSOR_PREFIX}${sequence}:${teamAccessFingerprint}:${issuedGeneration}`,
  );
}

export function encodeLegacyWorkspaceSyncCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Workspace sync sequence must be a non-negative integer");
  }
  return encode(`${LEGACY_CURSOR_PREFIX}${sequence}`);
}

export function encodeVersionTwoWorkspaceSyncCursor(
  sequence: number,
  teamAccessFingerprint = EMPTY_TEAM_ACCESS_FINGERPRINT,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Workspace sync sequence must be a non-negative integer");
  }
  if (!validFingerprint(teamAccessFingerprint)) {
    throw new Error("Workspace sync Team fingerprint is invalid");
  }
  return encode(
    `${VERSION_TWO_CURSOR_PREFIX}${sequence}:${teamAccessFingerprint}`,
  );
}

export function workspaceSyncCursorGeneration(now = Date.now()): number {
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("Workspace sync cursor time must be non-negative");
  }
  return Math.floor(now / WORKSPACE_SYNC_CURSOR_GENERATION_MS);
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
      return sequence === null
        ? null
        : { sequence, teamAccessFingerprint: null, issuedGeneration: null };
    }
    if (decoded.startsWith(VERSION_TWO_CURSOR_PREFIX)) {
      const state = parseFingerprintPayload(
        decoded.slice(VERSION_TWO_CURSOR_PREFIX.length),
      );
      return state === null ? null : { ...state, issuedGeneration: null };
    }
    if (!decoded.startsWith(CURSOR_PREFIX)) return null;
    const payload = decoded.slice(CURSOR_PREFIX.length);
    const generationSeparator = payload.lastIndexOf(":");
    if (generationSeparator < 1) return null;
    const state = parseFingerprintPayload(payload.slice(0, generationSeparator));
    const issuedGeneration = parseSequence(payload.slice(generationSeparator + 1));
    if (state === null || issuedGeneration === null) return null;
    return { ...state, issuedGeneration };
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
  // The query returns one constant-size row per active Team route. It starts
  // from retained owner events and resolves only their exact entity ids, so a
  // large Project never serializes or even enumerates its child resources.
  // Cursor generations expire well before journal retention, which makes a
  // retained event a safe marker for every child/detail mutation observable by
  // a valid cursor. Labels have no catalog-create event, so the only bounded
  // fallback is one compact aggregate over each visible owner's small catalog;
  // it never returns names, descriptions, or resource-sized payloads.
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
  ), resource_routes AS (
    SELECT route.*,
      CASE route.resource_type
        WHEN 'project' THEN route_project.owner_user_id
        WHEN 'task' THEN COALESCE(
          route_task_project.owner_user_id,
          route_task.owner_user_id
        )
        WHEN 'saved_view' THEN route_view.owner_user_id
      END AS route_owner_user_id,
      CASE route.resource_type
        WHEN 'project' THEN route_project.version
        WHEN 'task' THEN route_task.version
        WHEN 'saved_view' THEN route_view.version
      END AS root_version,
      CASE route.resource_type
        WHEN 'project' THEN route_project.updated_at
        WHEN 'task' THEN route_task.updated_at
        WHEN 'saved_view' THEN route_view.updated_at
      END AS root_updated_at,
      route_task.status_id AS task_status_id,
      CASE route.resource_type
        WHEN 'project' THEN route_project.id IS NOT NULL
          AND route_project.deleted_at IS NULL
        WHEN 'task' THEN route_task.id IS NOT NULL
          AND route_task.deleted_at IS NULL
          AND (route_task.project_id IS NULL
            OR route_task_project.deleted_at IS NULL)
        WHEN 'saved_view' THEN route_view.id IS NOT NULL
          AND route_view.deleted_at IS NULL
          AND route_view.scope_project_id IS NULL
        ELSE 0
      END AS root_visible
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
  ), resource_roots AS MATERIALIZED (
    SELECT DISTINCT resource_type, resource_id, route_owner_user_id,
      root_version, root_updated_at, task_status_id, root_visible
    FROM resource_routes
  ), route_owner_ids AS MATERIALIZED (
    SELECT DISTINCT route_owner_user_id AS owner_user_id
    FROM resource_roots
    WHERE root_visible = 1 AND route_owner_user_id IS NOT NULL
  ), label_catalog_state AS MATERIALIZED (
    SELECT owner.owner_user_id,
      COUNT(label.id) AS label_count,
      COALESCE(SUM(label.version), 0) AS label_version_sum,
      MAX(label.updated_at) AS label_updated_at,
      MIN(label.id) AS label_min_id,
      MAX(label.id) AS label_max_id,
      COALESCE(SUM(length(label.id)), 0) AS label_id_length_sum
    FROM route_owner_ids owner
    LEFT JOIN labels label ON label.owner_user_id = owner.owner_user_id
    GROUP BY owner.owner_user_id
  ), label_group_catalog_state AS MATERIALIZED (
    SELECT owner.owner_user_id,
      COUNT(label_group.id) AS label_group_count,
      COALESCE(SUM(label_group.version), 0) AS label_group_version_sum,
      MAX(label_group.updated_at) AS label_group_updated_at,
      MIN(label_group.id) AS label_group_min_id,
      MAX(label_group.id) AS label_group_max_id,
      COALESCE(SUM(length(label_group.id)), 0) AS label_group_id_length_sum
    FROM route_owner_ids owner
    LEFT JOIN label_groups label_group
      ON label_group.owner_user_id = owner.owner_user_id
    GROUP BY owner.owner_user_id
  ), project_owner_ids AS MATERIALIZED (
    SELECT DISTINCT route_owner_user_id AS owner_user_id
    FROM resource_roots
    WHERE resource_type = 'project' AND root_visible = 1
      AND route_owner_user_id IS NOT NULL
  ), status_catalog_state AS MATERIALIZED (
    SELECT owner.owner_user_id,
      COUNT(status.id) AS status_count,
      COALESCE(SUM(status.version), 0) AS status_version_sum,
      MAX(status.updated_at) AS status_updated_at,
      MIN(status.id) AS status_min_id,
      MAX(status.id) AS status_max_id,
      COALESCE(SUM(length(status.id)), 0) AS status_id_length_sum
    FROM project_owner_ids owner
    LEFT JOIN workflow_statuses status
      ON status.owner_user_id = owner.owner_user_id
    GROUP BY owner.owner_user_id
  ), resource_state AS MATERIALIZED (
    SELECT route.resource_type, route.resource_id,
      printf(
        'root:%d:%Q:%d|labels:%d:%d:%Q:%Q:%Q:%d|groups:%d:%d:%Q:%Q:%Q:%d|statuses:%d:%d:%Q:%Q:%Q:%d|assigned:%Q:%d:%Q',
        COALESCE(route.root_version, -1), route.root_updated_at,
        route.root_visible,
        COALESCE(label.label_count, 0),
        COALESCE(label.label_version_sum, 0), label.label_updated_at,
        label.label_min_id, label.label_max_id,
        COALESCE(label.label_id_length_sum, 0),
        COALESCE(label_group.label_group_count, 0),
        COALESCE(label_group.label_group_version_sum, 0),
        label_group.label_group_updated_at, label_group.label_group_min_id,
        label_group.label_group_max_id,
        COALESCE(label_group.label_group_id_length_sum, 0),
        CASE WHEN route.resource_type = 'project'
          THEN COALESCE(status_catalog.status_count, 0) ELSE 0 END,
        CASE WHEN route.resource_type = 'project'
          THEN COALESCE(status_catalog.status_version_sum, 0) ELSE 0 END,
        CASE WHEN route.resource_type = 'project'
          THEN status_catalog.status_updated_at END,
        CASE WHEN route.resource_type = 'project'
          THEN status_catalog.status_min_id END,
        CASE WHEN route.resource_type = 'project'
          THEN status_catalog.status_max_id END,
        CASE WHEN route.resource_type = 'project'
          THEN COALESCE(status_catalog.status_id_length_sum, 0) ELSE 0 END,
        CASE WHEN route.resource_type = 'task' THEN assigned.id END,
        CASE WHEN route.resource_type = 'task'
          THEN COALESCE(assigned.version, 0) ELSE 0 END,
        CASE WHEN route.resource_type = 'task' THEN assigned.updated_at END
      ) AS current_state
    FROM resource_roots route
    LEFT JOIN label_catalog_state label
      ON route.root_visible = 1
      AND label.owner_user_id = route.route_owner_user_id
    LEFT JOIN label_group_catalog_state label_group
      ON route.root_visible = 1
      AND label_group.owner_user_id = route.route_owner_user_id
    LEFT JOIN status_catalog_state status_catalog
      ON route.root_visible = 1 AND route.resource_type = 'project'
      AND status_catalog.owner_user_id = route.route_owner_user_id
    LEFT JOIN workflow_statuses assigned
      ON route.root_visible = 1 AND route.resource_type = 'task'
      AND assigned.id = route.task_status_id
  ), route_owner_events AS MATERIALIZED (
    SELECT event.audience_user_id, event.sequence, event.entity_type,
      event.entity_id
    FROM workspace_change_events event
    JOIN route_owner_ids owner
      ON owner.owner_user_id = event.audience_user_id
    WHERE event.entity_type IN (
      'project', 'task', 'task_detail', 'task_comments', 'task_activity',
      'task_attachments', 'task_external_source', 'release', 'saved_view',
      'label_group', 'workspace'
    )
  ), resource_event_max AS MATERIALIZED (
    SELECT route.resource_type, route.resource_id,
      MAX(event.sequence) AS marker_sequence
    FROM route_owner_events event
    JOIN resource_roots route
      ON route.root_visible = 1
      AND route.route_owner_user_id = event.audience_user_id
    LEFT JOIN tasks event_task
      ON event.entity_id = event_task.id
      AND event.entity_type IN (
        'task', 'task_detail', 'task_comments', 'task_activity',
        'task_attachments', 'task_external_source', 'workspace'
      )
    LEFT JOIN releases event_release
      ON event.entity_id = event_release.id
      AND event.entity_type IN ('release', 'workspace')
    LEFT JOIN saved_views event_view
      ON event.entity_id = event_view.id
      AND event.entity_type IN ('saved_view', 'workspace')
    LEFT JOIN workflow_statuses event_status
      ON event.entity_id = event_status.id
      AND event.entity_type = 'workspace'
    WHERE (
      route.resource_type = 'project' AND (
        (event.entity_type IN ('project', 'workspace')
          AND event.entity_id = route.resource_id)
        OR (event.entity_type IN (
            'task', 'task_detail', 'task_comments', 'task_activity',
            'task_attachments', 'task_external_source', 'workspace'
          ) AND event_task.project_id = route.resource_id)
        OR (event.entity_type IN ('release', 'workspace')
          AND event_release.project_id = route.resource_id)
        OR (event.entity_type IN ('saved_view', 'workspace')
          AND event_view.scope_project_id = route.resource_id)
        OR event.entity_type = 'label_group'
        OR (event.entity_type = 'workspace' AND (
          event_status.owner_user_id = route.route_owner_user_id
          OR substr(event.entity_id, 1,
            length('status:' || route.route_owner_user_id || ':')) =
            'status:' || route.route_owner_user_id || ':'
        ))
      )
    ) OR (
      route.resource_type = 'task' AND (
        (event.entity_type IN (
            'task', 'task_detail', 'task_comments', 'task_activity',
            'task_attachments', 'task_external_source', 'workspace'
          ) AND event.entity_id = route.resource_id)
        OR event.entity_type = 'label_group'
        OR (event.entity_type = 'workspace'
          AND event.entity_id = route.task_status_id)
      )
    ) OR (
      route.resource_type = 'saved_view' AND (
        (event.entity_type IN ('saved_view', 'workspace')
          AND event.entity_id = route.resource_id)
        OR event.entity_type = 'label_group'
      )
    )
    GROUP BY route.resource_type, route.resource_id
  )
  SELECT route.team_id, route.team_version,
    route.membership_id, route.membership_version,
    route.grant_id, route.grant_version,
    route.permission, route.resource_type, route.resource_id,
    route.route_owner_user_id, state.current_state,
    COALESCE(events.marker_sequence, 0) AS marker_sequence
  FROM resource_routes route
  JOIN resource_state state
    ON state.resource_type = route.resource_type
    AND state.resource_id = route.resource_id
  LEFT JOIN resource_event_max events
    ON events.resource_type = route.resource_type
    AND events.resource_id = route.resource_id
  ORDER BY route.team_id, route.membership_id, route.grant_id`;
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
    row.route_owner_user_id,
    row.current_state,
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

function parseFingerprintPayload(
  payload: string,
): Pick<WorkspaceSyncCursorState, "sequence" | "teamAccessFingerprint"> | null {
  const separator = payload.indexOf(":");
  if (separator < 1) return null;
  const sequence = parseSequence(payload.slice(0, separator));
  const teamAccessFingerprint = payload.slice(separator + 1);
  if (sequence === null || !validFingerprint(teamAccessFingerprint)) return null;
  return { sequence, teamAccessFingerprint };
}

function validFingerprint(value: string): boolean {
  return /^(?:none|[a-f0-9]{64})$/u.test(value);
}
