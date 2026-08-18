import type { UserRecord } from "./types";

export type NativeActivityInput = {
  id?: string;
  taskId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export function newActivityId() {
  return `activity_${crypto.randomUUID()}`;
}

export function activityEventStatement(
  db: D1Database,
  currentUser: UserRecord,
  input: NativeActivityInput,
) {
  const id = input.id ?? newActivityId();
  return {
    id,
    statement: db.prepare(
      `INSERT INTO activity_events
        (id, task_id, schema_version, event_type, actor_kind, actor_user_id,
         actor_name, payload_json, source, created_at)
       VALUES (?, ?, 1, ?, 'user', ?, ?, ?, 'native', ?)`,
    ).bind(
      id,
      input.taskId,
      input.eventType,
      currentUser.id,
      currentUser.displayName,
      JSON.stringify(input.payload),
      input.createdAt,
    ),
  };
}

export function activityEventAfterPreviousChange(
  db: D1Database,
  currentUser: UserRecord,
  input: NativeActivityInput,
) {
  const id = input.id ?? newActivityId();
  return {
    id,
    statement: db.prepare(
      `INSERT INTO activity_events
        (id, task_id, schema_version, event_type, actor_kind, actor_user_id,
         actor_name, payload_json, source, created_at)
       SELECT ?, ?, 1, ?, 'user', ?, ?, ?, 'native', ?
       WHERE changes() > 0`,
    ).bind(
      id,
      input.taskId,
      input.eventType,
      currentUser.id,
      currentUser.displayName,
      JSON.stringify(input.payload),
      input.createdAt,
    ),
  };
}

export function activityBatchAssertion(
  db: D1Database,
  assertionId: string,
  now: string,
) {
  return db.prepare(
    `INSERT INTO activity_events
      (id, task_id, schema_version, event_type, actor_kind, actor_name,
       payload_json, source, created_at)
     SELECT ?, NULL, 1, 'assertion', 'system', 'System', '{}', 'native', ?
     WHERE changes() = 0`,
  ).bind(assertionId, now);
}

export function changedFields(
  entries: Array<[string, unknown, unknown]>,
) {
  return Object.fromEntries(entries
    .filter(([, before, after]) => !sameValue(before, after))
    .map(([field, before, after]) => [field, { before, after }]));
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
