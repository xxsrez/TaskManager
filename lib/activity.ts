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
  const predicates = ["task_id = ?"];
  const parameters: unknown[] = [task.id];
  if (before) {
    predicates.push("(created_at < ? OR (created_at = ? AND id < ?))");
    parameters.push(before.createdAt, before.createdAt, before.id);
  }
  parameters.push(limit + 1);
  const db = getD1();
  const [rows, count] = await db.batch<DbRow>([
    db.prepare(
      `SELECT * FROM activity_events WHERE ${predicates.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(...parameters),
    db.prepare(
      "SELECT COUNT(*) AS total_count FROM activity_events WHERE task_id = ?",
    ).bind(task.id),
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
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    schemaVersion: 1,
    eventType: String(row.event_type),
    actor: {
      id: row.actor_user_id == null ? null : String(row.actor_user_id),
      displayName: String(row.actor_name),
      kind: actorKind,
    },
    payload: safeObject(row.payload_json),
    source: source === "native" ? "native" : "historical",
    createdAt: String(row.created_at),
  };
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
