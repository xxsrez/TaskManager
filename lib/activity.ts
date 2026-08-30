import { getD1 } from "@/db";
import { ValidationError } from "./domain";
import { getTask } from "./repository";
import type { ActivityEventRecord, ActivityPage, UserRecord } from "./types";

type DbRow = Record<string, unknown>;
const MAX_ACTIVITY_PAGE = 50;

export async function listTaskActivity(
  currentUser: UserRecord,
  taskReference: string,
  input: { limit?: number; cursor?: string | null } = {},
): Promise<ActivityPage> {
  const task = await getTask(currentUser, taskReference);
  const limit = boundedLimit(input.limit);
  const before = input.cursor ? decodeCursor(input.cursor, task.id) : null;
  const predicates = ["event.task_id = ?", relationActivityVisibilitySql("event")];
  const visibilityParameters = [currentUser.id, currentUser.id];
  const parameters: unknown[] = [task.id, ...visibilityParameters];
  if (before) {
    predicates.push("(event.created_at < ? OR (event.created_at = ? AND event.id < ?))");
    parameters.push(before.createdAt, before.createdAt, before.id);
  }
  parameters.push(limit + 1);
  const db = getD1();
  const [rows, count] = await db.batch<DbRow>([
    db.prepare(
      `SELECT event.* FROM activity_events event WHERE ${predicates.join(" AND ")}
       ORDER BY event.created_at DESC, event.id DESC LIMIT ?`,
    ).bind(...parameters),
    db.prepare(
      `SELECT COUNT(*) AS total_count FROM activity_events event
       WHERE event.task_id = ? AND ${relationActivityVisibilitySql("event")}`,
    ).bind(task.id, ...visibilityParameters),
  ]);
  const hasMore = rows.results.length > limit;
  const visible = rows.results.slice(0, limit).map(mapActivityEvent);
  const last = visible.at(-1);
  return {
    events: visible,
    totalCount: Number(count.results[0]?.total_count ?? 0),
    hasMore,
    nextCursor: hasMore && last
      ? encodeCursor(task.id, last.createdAt, last.id)
      : null,
  };
}

function mapActivityEvent(row: DbRow): ActivityEventRecord {
  const actorKind = String(row.actor_kind);
  if (actorKind !== "user" && actorKind !== "historical" && actorKind !== "system") {
    throw new Error("Activity actor kind is unsupported");
  }
  const source = String(row.source);
  if (source !== "native" && source !== "linear") {
    throw new Error("Activity source is unsupported");
  }
  const eventType = String(row.event_type);
  const payload = safeObject(row.payload_json);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    schemaVersion: 1,
    eventType,
    actor: {
      id: row.actor_user_id == null ? null : String(row.actor_user_id),
      displayName: String(row.actor_name),
      kind: actorKind,
    },
    payload: privacyMinimizedActivityPayload(eventType, payload),
    source: source === "native" ? "native" : "historical",
    createdAt: String(row.created_at),
  };
}

function relationActivityVisibilitySql(alias: string): string {
  const peerTaskId = relationPeerTaskIdSql(alias);
  return `(
    ${alias}.event_type NOT IN ('relation_created', 'relation_updated', 'relation_deleted')
    OR EXISTS (
      SELECT 1 FROM tasks activity_peer
      JOIN projects activity_peer_project
        ON activity_peer_project.id = activity_peer.project_id
      WHERE activity_peer.id = (${peerTaskId})
        AND activity_peer.deleted_at IS NULL
        AND activity_peer_project.deleted_at IS NULL
        AND (
          activity_peer_project.owner_user_id = ?
          OR EXISTS (
            SELECT 1 FROM access_grants activity_peer_grant
            WHERE activity_peer_grant.resource_type = 'project'
              AND activity_peer_grant.resource_id = activity_peer_project.id
              AND activity_peer_grant.grantee_user_id = ?
              AND activity_peer_grant.revoked_at IS NULL
          )
        )
    )
  )`;
}

function relationPeerTaskIdSql(alias: string): string {
  return `COALESCE(
    json_extract(${alias}.payload_json, '$.peerTaskId'),
    CASE
      WHEN json_extract(${alias}.payload_json, '$.relation.sourceTaskId') = ${alias}.task_id
        THEN json_extract(${alias}.payload_json, '$.relation.targetTaskId')
      WHEN json_extract(${alias}.payload_json, '$.relation.targetTaskId') = ${alias}.task_id
        THEN json_extract(${alias}.payload_json, '$.relation.sourceTaskId')
      WHEN json_extract(${alias}.payload_json, '$.after.sourceTaskId') = ${alias}.task_id
        THEN json_extract(${alias}.payload_json, '$.after.targetTaskId')
      WHEN json_extract(${alias}.payload_json, '$.after.targetTaskId') = ${alias}.task_id
        THEN json_extract(${alias}.payload_json, '$.after.sourceTaskId')
      WHEN json_extract(${alias}.payload_json, '$.before.sourceTaskId') = ${alias}.task_id
        THEN json_extract(${alias}.payload_json, '$.before.targetTaskId')
      WHEN json_extract(${alias}.payload_json, '$.before.targetTaskId') = ${alias}.task_id
        THEN json_extract(${alias}.payload_json, '$.before.sourceTaskId')
    END
  )`;
}

function privacyMinimizedActivityPayload(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!eventType.startsWith("relation_")) return payload;
  return sanitize(payload) as Record<string, unknown>;

  function sanitize(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sanitize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .filter(([key]) =>
          key !== "peerTaskId" && key !== "sourceTaskId" && key !== "targetTaskId"
        )
        .map(([key, value]) => [key, sanitize(value)]),
    );
  }
}

function boundedLimit(value: number | undefined) {
  if (value === undefined) return 25;
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACTIVITY_PAGE) {
    throw new ValidationError(`Activity limit must be between 1 and ${MAX_ACTIVITY_PAGE}`);
  }
  return value;
}

function encodeCursor(taskId: string, createdAt: string, id: string) {
  return btoa(JSON.stringify({ taskId, createdAt, id }));
}

function decodeCursor(value: string, taskId: string) {
  try {
    const parsed = JSON.parse(atob(value)) as Record<string, unknown>;
    if (
      parsed.taskId !== taskId || typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string"
    ) throw new Error("invalid");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ValidationError("Activity cursor is invalid");
  }
}

function safeObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
