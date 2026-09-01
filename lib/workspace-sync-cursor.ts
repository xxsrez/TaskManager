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
  route_owner_user_id: string | null;
  current_state: string;
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
  // The query returns one compact row per active Team route. Current rows are
  // serialized deterministically inside SQLite, so additions and removals
  // remain detectable without returning one D1 result row per child resource.
  // route_owner_events is materialized once for all visible route owners; this
  // avoids the former routes x retained-events correlated scan. Exact current
  // detail rows complement the journal, so retention pruning cannot erase a
  // durable change. Cost remains linear in current Team-visible resources,
  // their detail rows, catalog rows, and retained events for their owners.
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
      root_version, root_updated_at, root_visible
    FROM resource_routes
  ), project_route_ids AS MATERIALIZED (
    SELECT resource_id FROM resource_roots
    WHERE resource_type = 'project' AND root_visible = 1
  ), task_route_ids AS MATERIALIZED (
    SELECT resource_id FROM resource_roots
    WHERE resource_type = 'task' AND root_visible = 1
  ), project_tasks AS MATERIALIZED (
    SELECT task.project_id AS resource_id, task.id, task.version,
      task.updated_at, task.status_id, task.comment_count
    FROM project_route_ids route
    JOIN tasks task ON task.project_id = route.resource_id
      AND task.deleted_at IS NULL
  ), route_tasks AS MATERIALIZED (
    SELECT 'project' AS resource_type, resource_id, id, version,
      updated_at, status_id, comment_count
    FROM project_tasks
    UNION ALL
    SELECT 'task', task.id, task.id, task.version, task.updated_at,
      task.status_id, task.comment_count
    FROM task_route_ids route
    JOIN tasks task ON task.id = route.resource_id
      AND task.deleted_at IS NULL
  ), visible_task_ids AS MATERIALIZED (
    SELECT DISTINCT id FROM route_tasks
  ), task_detail_marker_rows AS MATERIALIZED (
    -- Supported comment/activity/label/relation writes monotonically touch
    -- task.updated_at. Attachments and external records do not, so only these
    -- independently mutable detail rows need their own persistent state.
    SELECT attachment.task_id, 'attachment' AS marker_kind,
      attachment.id AS marker_id,
      printf('%d:%Q:%Q:%Q', attachment.version, attachment.updated_at,
        attachment.state, attachment.deleted_at) AS marker_value
    FROM visible_task_ids visible
    JOIN attachments attachment ON attachment.task_id = visible.id
    UNION ALL
    SELECT external.target_id, 'external_record', external.id,
      printf('%Q', external.imported_at)
    FROM visible_task_ids visible
    JOIN external_records external
      ON external.target_type = 'task' AND external.target_id = visible.id
  ), task_detail_ordered AS MATERIALIZED (
    SELECT task_id,
      printf('%d:%s%d:%s%d:%s',
          length(marker_kind), marker_kind,
          length(marker_id), marker_id,
          length(marker_value), marker_value) AS marker_payload
    FROM task_detail_marker_rows
    ORDER BY task_id, marker_kind, marker_id, marker_value
  ), task_detail_state AS (
    SELECT task_id, group_concat(marker_payload, '') AS marker_state
    FROM task_detail_ordered GROUP BY task_id
  ), route_owner_ids AS MATERIALIZED (
    SELECT DISTINCT route_owner_user_id AS owner_user_id
    FROM resource_roots
    WHERE root_visible = 1 AND route_owner_user_id IS NOT NULL
  ), label_catalog_marker_rows AS MATERIALIZED (
    SELECT label.owner_user_id, 'label' AS marker_kind,
      label.id AS marker_id,
      printf('%d:%Q:%Q', label.version, label.updated_at, label.group_id)
        AS marker_value
    FROM route_owner_ids owner
    JOIN labels label ON label.owner_user_id = owner.owner_user_id
    UNION ALL
    SELECT label_group.owner_user_id, 'label_group', label_group.id,
      printf('%d:%Q', label_group.version, label_group.updated_at)
    FROM route_owner_ids owner
    JOIN label_groups label_group
      ON label_group.owner_user_id = owner.owner_user_id
  ), label_catalog_ordered AS MATERIALIZED (
    SELECT owner_user_id,
      printf('%d:%s%d:%s%d:%s',
          length(marker_kind), marker_kind,
          length(marker_id), marker_id,
          length(marker_value), marker_value) AS marker_payload
    FROM label_catalog_marker_rows
    ORDER BY owner_user_id, marker_kind, marker_id, marker_value
  ), label_catalog_state AS (
    SELECT owner_user_id, group_concat(marker_payload, '') AS marker_state
    FROM label_catalog_ordered GROUP BY owner_user_id
  ), project_owner_ids AS MATERIALIZED (
    SELECT DISTINCT route_owner_user_id AS owner_user_id
    FROM resource_roots
    WHERE resource_type = 'project' AND root_visible = 1
      AND route_owner_user_id IS NOT NULL
  ), status_catalog_marker_rows AS (
    SELECT status.owner_user_id, status.id AS marker_id,
      printf('%d:%Q', status.version, status.updated_at) AS marker_value
    FROM project_owner_ids owner
    JOIN workflow_statuses status
      ON status.owner_user_id = owner.owner_user_id
  ), status_catalog_ordered AS MATERIALIZED (
    SELECT owner_user_id,
      printf('%d:%s%d:%s', length(marker_id), marker_id,
        length(marker_value), marker_value) AS marker_payload
    FROM status_catalog_marker_rows
    ORDER BY owner_user_id, marker_id, marker_value
  ), status_catalog_state AS (
    SELECT owner_user_id, group_concat(marker_payload, '') AS marker_state
    FROM status_catalog_ordered GROUP BY owner_user_id
  ), resource_content_marker_rows AS MATERIALIZED (
    SELECT route.resource_type, route.resource_id,
      'root' AS marker_kind, route.resource_id AS marker_id,
      printf('%d:%Q:%d', COALESCE(route.root_version, -1),
        route.root_updated_at, route.root_visible) AS marker_value
    FROM resource_roots route
    UNION ALL
    SELECT task.resource_type, task.resource_id, 'task', task.id,
      printf('%d:%Q:%Q:%d:%Q', task.version, task.updated_at,
        task.status_id, task.comment_count,
        COALESCE(detail.marker_state, ''))
    FROM route_tasks task
    LEFT JOIN task_detail_state detail ON detail.task_id = task.id
    UNION ALL
    SELECT 'project', release.project_id, 'release', release.id,
      printf('%d:%Q', release.version, release.updated_at)
    FROM project_route_ids route
    JOIN releases release ON release.project_id = route.resource_id
      AND release.deleted_at IS NULL
    UNION ALL
    SELECT 'project', view.scope_project_id, 'saved_view', view.id,
      printf('%d:%Q', view.version, view.updated_at)
    FROM project_route_ids route
    JOIN saved_views view ON view.scope_project_id = route.resource_id
      AND view.deleted_at IS NULL
  ), resource_catalog_marker_rows AS MATERIALIZED (
    SELECT route.resource_type, route.resource_id, 'label_catalog',
      route.route_owner_user_id, COALESCE(catalog.marker_state, '')
    FROM resource_roots route
    LEFT JOIN label_catalog_state catalog
      ON catalog.owner_user_id = route.route_owner_user_id
    WHERE route.root_visible = 1
    UNION ALL
    SELECT 'project', route.resource_id, 'status_catalog',
      route.route_owner_user_id, COALESCE(catalog.marker_state, '')
    FROM resource_roots route
    LEFT JOIN status_catalog_state catalog
      ON catalog.owner_user_id = route.route_owner_user_id
    WHERE route.resource_type = 'project' AND route.root_visible = 1
    UNION ALL
    SELECT 'task', route.resource_id, 'workflow_status', status.id,
      printf('%d:%Q', status.version, status.updated_at)
    FROM resource_roots route
    JOIN tasks task ON route.resource_type = 'task'
      AND task.id = route.resource_id
    JOIN workflow_statuses status ON status.id = task.status_id
    WHERE route.root_visible = 1
  ), resource_marker_rows AS MATERIALIZED (
    SELECT * FROM resource_content_marker_rows
    UNION ALL
    SELECT * FROM resource_catalog_marker_rows
  ), resource_marker_ordered AS MATERIALIZED (
    SELECT resource_type, resource_id,
      printf('%d:%s%d:%s%d:%s',
          length(marker_kind), marker_kind,
          length(marker_id), marker_id,
          length(marker_value), marker_value) AS marker_payload
    FROM resource_marker_rows
    ORDER BY resource_type, resource_id, marker_kind, marker_id, marker_value
  ), resource_state AS (
    SELECT resource_type, resource_id,
      group_concat(marker_payload, '') AS current_state
    FROM resource_marker_ordered GROUP BY resource_type, resource_id
  ), task_event_kinds(entity_type) AS (
    VALUES ('task'), ('task_detail'), ('task_comments'), ('task_activity'),
      ('task_attachments'), ('task_external_source')
  ), route_event_entities AS MATERIALIZED (
    SELECT route.resource_type, route.resource_id,
      route.route_owner_user_id AS audience_user_id,
      route.resource_type AS entity_type, route.resource_id AS entity_id
    FROM resource_roots route
    WHERE route.root_visible = 1 AND route.resource_type <> 'task'
    UNION
    SELECT task.resource_type, task.resource_id,
      route.route_owner_user_id, kind.entity_type, task.id
    FROM route_tasks task
    JOIN resource_roots route
      ON route.resource_type = task.resource_type
      AND route.resource_id = task.resource_id
    CROSS JOIN task_event_kinds kind
    UNION
    SELECT 'project', release.project_id, route.route_owner_user_id,
      'release', release.id
    FROM project_route_ids project_route
    JOIN releases release ON release.project_id = project_route.resource_id
      AND release.deleted_at IS NULL
    JOIN resource_roots route ON route.resource_type = 'project'
      AND route.resource_id = project_route.resource_id
    UNION
    SELECT 'project', view.scope_project_id, route.route_owner_user_id,
      'saved_view', view.id
    FROM project_route_ids project_route
    JOIN saved_views view ON view.scope_project_id = project_route.resource_id
      AND view.deleted_at IS NULL
    JOIN resource_roots route ON route.resource_type = 'project'
      AND route.resource_id = project_route.resource_id
  ), route_owner_events AS MATERIALIZED (
    SELECT event.audience_user_id, event.sequence,
      event.entity_type, event.entity_id
    FROM workspace_change_events event
    JOIN (
      SELECT DISTINCT audience_user_id FROM route_event_entities
      WHERE audience_user_id IS NOT NULL
    ) owner ON owner.audience_user_id = event.audience_user_id
    WHERE event.entity_type IN (
      'project', 'task', 'task_detail', 'task_comments', 'task_activity',
      'task_attachments', 'task_external_source', 'release', 'saved_view'
    )
  ), resource_event_max AS (
    SELECT entity.resource_type, entity.resource_id,
      MAX(event.sequence) AS marker_sequence
    FROM route_event_entities entity
    JOIN route_owner_events event
      ON event.audience_user_id = entity.audience_user_id
      AND event.entity_type = entity.entity_type
      AND event.entity_id = entity.entity_id
    GROUP BY entity.resource_type, entity.resource_id
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

function validFingerprint(value: string): boolean {
  return /^(?:none|[a-f0-9]{64})$/u.test(value);
}
