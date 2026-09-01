import { getD1 } from "@/db";
import { canEditContent } from "./access";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
  statusTimestamps,
} from "./domain";
import { getTask } from "./repository";
import type { TaskRecord, TaskRelationRecord, UserRecord } from "./types";
import {
  activityBatchAssertion,
  activityEventStatement,
} from "./activity-write";

type DbRow = Record<string, unknown>;

export type TaskRelationType = TaskRelationRecord["type"];
export type TaskRelationDirection = "outgoing" | "incoming";

type RelationInput = {
  type: TaskRelationType;
  direction: TaskRelationDirection;
};

const relationProjection = `id, source_task_id, target_task_id, type,
  version, created_at, updated_at`;

export async function createTaskRelation(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
): Promise<TaskRelationRecord> {
  assertOnlyKeys(input, [
    "targetTaskId",
    "type",
    "direction",
    "idempotencyKey",
    "taskVersion",
  ]);
  const targetTaskId = requiredString(input.targetTaskId, "Target task");
  const idempotencyKey = boundedKey(input.idempotencyKey);
  const [anchor, peer] = await Promise.all([
    getTask(currentUser, taskId),
    getTask(currentUser, targetTaskId),
  ]);
  const semantic = normalizeRelation(
    anchor.id,
    peer.id,
    relationInput(input),
  );
  assertEditableRelationTasks(anchor, peer, semantic.type);

  const existingRetry = await findIdempotentRelation(
    currentUser.id,
    idempotencyKey,
  );
  if (existingRetry) {
    if (!sameSemantic(existingRetry, semantic)) {
      throw new ConflictError(
        "The idempotency key belongs to another relation command",
      );
    }
    return existingRetry;
  }
  if (await findLogicalRelation(semantic)) {
    throw new ConflictError("This relation already exists");
  }

  const relationId = `relation_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const db = getD1();
  const activity = relationActivityStatements(
    db,
    currentUser,
    [anchor.id, peer.id],
    "relation_created",
    { relation: { id: relationId, ...semantic } },
    now,
  );
  const insert = db
    .prepare(
      `INSERT INTO task_relations (
         id, source_task_id, target_task_id, type, creator_user_id,
         idempotency_key, version, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?
       WHERE ${editableParticipantExists("source_task")}
         AND ${editableParticipantExists("target_task")}
         ${semantic.type === "duplicate_of"
           ? `AND ${sameProjectParticipants()}
              AND EXISTS (SELECT 1 FROM tasks duplicate_source WHERE duplicate_source.id = ? AND duplicate_source.version = ?)`
           : ""}`,
    )
    .bind(
      relationId,
      semantic.sourceTaskId,
      semantic.targetTaskId,
      semantic.type,
      currentUser.id,
      idempotencyKey,
      now,
      now,
      semantic.sourceTaskId,
      currentUser.id,
      currentUser.id,
      semantic.targetTaskId,
      currentUser.id,
      currentUser.id,
      ...(semantic.type === "duplicate_of"
        ? [
            semantic.targetTaskId,
            semantic.sourceTaskId,
            semantic.sourceTaskId,
            expectedTaskVersion(input.taskVersion, anchor),
          ]
        : []),
    );

  try {
    if (semantic.type === "duplicate_of") {
      const source = semantic.sourceTaskId === anchor.id ? anchor : peer;
      const status = await loadDuplicateStatus(source.ownerUserId);
      const taskVersion = expectedTaskVersion(input.taskVersion, source);
      const timestamps = statusTimestamps(status.category, source, now);
      const duplicateActivity = relationActivityStatements(
        db,
        currentUser,
        [anchor.id, peer.id],
        "relation_created",
        {
          relation: { id: relationId, ...semantic },
          changes: {
            status: {
              taskId: source.id,
              before: { id: source.statusId },
              after: { id: status.id, name: status.name },
            },
          },
        },
        now,
      );
      const results = await db.batch([
        insert,
        activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
        duplicateStatusUpdate(
          db,
          currentUser.id,
          source.id,
          taskVersion,
          status.id,
          timestamps,
          now,
        ),
        activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
        ...duplicateActivity,
        touchTaskActivity(db, anchor.id, now),
        touchTaskActivity(db, peer.id, now),
      ]);
      if (
        (results[0]?.meta.changes ?? 0) < 1 ||
        (results[2]?.meta.changes ?? 0) < 1
      ) {
        throw new ConflictError("A task changed before the relation was saved");
      }
    } else {
      const results = await db.batch([
        insert,
        activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
        ...activity,
        touchTaskActivity(db, anchor.id, now),
        touchTaskActivity(db, peer.id, now),
      ]);
      if ((results[0]?.meta.changes ?? 0) < 1) {
        throw new ConflictError("Task access changed before the relation was saved");
      }
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    if (isConstraintError(error)) {
      const retry = await findIdempotentRelation(currentUser.id, idempotencyKey);
      if (retry && sameSemantic(retry, semantic)) return retry;
      throw new ConflictError(relationConstraintMessage(error));
    }
    throw error;
  }

  return loadRelation(relationId);
}

export async function updateTaskRelation(
  currentUser: UserRecord,
  taskId: string,
  relationId: string,
  input: Record<string, unknown>,
): Promise<TaskRelationRecord> {
  assertOnlyKeys(input, ["version", "type", "direction", "taskVersion"]);
  const anchor = await getTask(currentUser, taskId);
  const current = await loadTaskRelation(relationId, anchor.id);
  const peerId = current.sourceTaskId === anchor.id
    ? current.targetTaskId
    : current.sourceTaskId;
  const peer = await getTask(currentUser, peerId);
  assertEditableProjectTasks(anchor, peer);
  const expectedVersion = positiveInteger(input.version, "Relation version");
  if (expectedVersion !== current.version) {
    throw new ConflictError("Relation was changed in another session");
  }
  const semantic = normalizeRelation(
    anchor.id,
    peer.id,
    relationInput(input),
  );
  assertEditableRelationTasks(anchor, peer, semantic.type);
  if (sameSemantic(current, semantic)) return current;

  const collision = await findLogicalRelation(semantic);
  if (collision && collision.id !== current.id) {
    throw new ConflictError("This relation already exists");
  }
  const now = new Date().toISOString();
  const db = getD1();
  const activity = relationActivityStatements(
    db,
    currentUser,
    [anchor.id, peer.id],
    "relation_updated",
    { before: current, after: { ...current, ...semantic, version: current.version + 1 } },
    now,
  );
  const update = db
    .prepare(
      `UPDATE task_relations SET
         source_task_id = ?, target_task_id = ?, type = ?,
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?
         AND ${editableParticipantExists("source_task")}
         AND ${editableParticipantExists("target_task")}
         ${semantic.type === "duplicate_of"
           ? `AND ${sameProjectParticipants()}
              AND EXISTS (SELECT 1 FROM tasks duplicate_source WHERE duplicate_source.id = ? AND duplicate_source.version = ?)`
           : ""}`,
    )
    .bind(
      semantic.sourceTaskId,
      semantic.targetTaskId,
      semantic.type,
      now,
      current.id,
      expectedVersion,
      semantic.sourceTaskId,
      currentUser.id,
      currentUser.id,
      semantic.targetTaskId,
      currentUser.id,
      currentUser.id,
      ...(semantic.type === "duplicate_of"
        ? [
            semantic.targetTaskId,
            semantic.sourceTaskId,
            semantic.sourceTaskId,
            expectedTaskVersion(input.taskVersion, anchor),
          ]
        : []),
    );

  try {
    if (semantic.type === "duplicate_of") {
      const source = semantic.sourceTaskId === anchor.id ? anchor : peer;
      const status = await loadDuplicateStatus(source.ownerUserId);
      const taskVersion = expectedTaskVersion(input.taskVersion, source);
      const timestamps = statusTimestamps(status.category, source, now);
      const duplicateActivity = relationActivityStatements(
        db,
        currentUser,
        [anchor.id, peer.id],
        "relation_updated",
        {
          before: current,
          after: { ...current, ...semantic, version: current.version + 1 },
          changes: {
            status: {
              taskId: source.id,
              before: { id: source.statusId },
              after: { id: status.id, name: status.name },
            },
          },
        },
        now,
      );
      const results = await db.batch([
        update,
        activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
        duplicateStatusUpdate(
          db,
          currentUser.id,
          source.id,
          taskVersion,
          status.id,
          timestamps,
          now,
        ),
        activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
        ...duplicateActivity,
        touchTaskActivity(db, anchor.id, now),
        touchTaskActivity(db, peer.id, now),
      ]);
      if (
        (results[0]?.meta.changes ?? 0) < 1 ||
        (results[2]?.meta.changes ?? 0) < 1
      ) {
        throw new ConflictError("A task or relation changed before save");
      }
    } else {
      const results = await db.batch([
        update,
        activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
        ...activity,
        touchTaskActivity(db, anchor.id, now),
        touchTaskActivity(db, peer.id, now),
      ]);
      if ((results[0]?.meta.changes ?? 0) < 1) {
        throw new ConflictError("A task or relation changed before save");
      }
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    if (isConstraintError(error)) {
      throw new ConflictError(relationConstraintMessage(error));
    }
    throw error;
  }
  return loadRelation(relationId);
}

export async function deleteTaskRelation(
  currentUser: UserRecord,
  taskId: string,
  relationId: string,
  input: Record<string, unknown>,
): Promise<{ deleted: true; relation: TaskRelationRecord }> {
  assertOnlyKeys(input, ["version"]);
  const anchor = await getTask(currentUser, taskId);
  const relation = await loadTaskRelation(relationId, anchor.id);
  const peer = await getTask(
    currentUser,
    relation.sourceTaskId === anchor.id
      ? relation.targetTaskId
      : relation.sourceTaskId,
  );
  assertEditableProjectTasks(anchor, peer);
  const expectedVersion = positiveInteger(input.version, "Relation version");
  if (relation.version !== expectedVersion) {
    throw new ConflictError("Relation was changed in another session");
  }
  const now = new Date().toISOString();
  const db = getD1();
  const activity = relationActivityStatements(
    db,
    currentUser,
    [anchor.id, peer.id],
    "relation_deleted",
    { relation },
    now,
  );
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
      `DELETE FROM task_relations
       WHERE id = ? AND version = ?
         AND ${editableParticipantExists("source_task")}
         AND ${editableParticipantExists("target_task")}`,
      ).bind(
      relation.id,
      expectedVersion,
      relation.sourceTaskId,
      currentUser.id,
      currentUser.id,
      relation.targetTaskId,
      currentUser.id,
      currentUser.id,
      ),
      activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
      ...activity,
      touchTaskActivity(db, anchor.id, now),
      touchTaskActivity(db, peer.id, now),
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("A task or relation changed before removal");
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new ConflictError("A task or relation changed before removal");
  }
  return { deleted: true, relation };
}

function touchTaskActivity(db: D1Database, taskId: string, now: string) {
  return db.prepare(
    `UPDATE tasks SET updated_at = CASE
       WHEN updated_at >= ?
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
       ELSE ? END
     WHERE id = ?`,
  ).bind(now, now, taskId);
}

function relationActivityStatements(
  db: D1Database,
  currentUser: UserRecord,
  taskIds: [string, string],
  eventType: "relation_created" | "relation_updated" | "relation_deleted",
  payload: Record<string, unknown>,
  createdAt: string,
) {
  return taskIds.map((taskId, index) => {
    const endpointPayload = index === 0 || !("changes" in payload)
      ? payload
      : Object.fromEntries(
          Object.entries(payload).filter(([key]) => key !== "changes"),
        );
    return activityEventStatement(db, currentUser, {
      taskId,
      eventType,
      payload: {
        ...endpointPayload,
        peerTaskId: taskIds[index === 0 ? 1 : 0],
      },
      createdAt,
    }).statement;
  });
}

export function normalizeRelation(
  anchorTaskId: string,
  peerTaskId: string,
  input: RelationInput,
): Pick<TaskRelationRecord, "sourceTaskId" | "targetTaskId" | "type"> {
  if (anchorTaskId === peerTaskId) {
    throw new ValidationError("A task cannot relate to itself");
  }
  if (input.type === "duplicate_of" && input.direction !== "outgoing") {
    throw new ValidationError(
      "Mark the duplicate task from its own details and choose its canonical task",
    );
  }
  if (input.type === "related") {
    const [sourceTaskId, targetTaskId] = [anchorTaskId, peerTaskId].sort();
    return { sourceTaskId: sourceTaskId!, targetTaskId: targetTaskId!, type: input.type };
  }
  return input.direction === "outgoing"
    ? { sourceTaskId: anchorTaskId, targetTaskId: peerTaskId, type: input.type }
    : { sourceTaskId: peerTaskId, targetTaskId: anchorTaskId, type: input.type };
}

async function loadRelation(id: string): Promise<TaskRelationRecord> {
  const row = await getD1()
    .prepare(`SELECT ${relationProjection} FROM task_relations WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<DbRow>();
  if (!row) throw new ConflictError("Relation was changed or removed");
  return mapRelation(row);
}

async function loadTaskRelation(
  id: string,
  taskId: string,
): Promise<TaskRelationRecord> {
  const row = await getD1()
    .prepare(
      `SELECT ${relationProjection} FROM task_relations
       WHERE id = ? AND (source_task_id = ? OR target_task_id = ?) LIMIT 1`,
    )
    .bind(id, taskId, taskId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Relation not found");
  return mapRelation(row);
}

async function findIdempotentRelation(
  creatorUserId: string,
  idempotencyKey: string,
) {
  const row = await getD1()
    .prepare(
      `SELECT ${relationProjection} FROM task_relations
       WHERE creator_user_id = ? AND idempotency_key = ? LIMIT 1`,
    )
    .bind(creatorUserId, idempotencyKey)
    .first<DbRow>();
  return row ? mapRelation(row) : null;
}

async function findLogicalRelation(
  semantic: Pick<TaskRelationRecord, "sourceTaskId" | "targetTaskId" | "type">,
) {
  const row = await getD1()
    .prepare(
      `SELECT ${relationProjection} FROM task_relations
       WHERE type = ? AND (
         (source_task_id = ? AND target_task_id = ?)
         OR (type IN ('blocks', 'related') AND source_task_id = ? AND target_task_id = ?)
       ) LIMIT 1`,
    )
    .bind(
      semantic.type,
      semantic.sourceTaskId,
      semantic.targetTaskId,
      semantic.targetTaskId,
      semantic.sourceTaskId,
    )
    .first<DbRow>();
  return row ? mapRelation(row) : null;
}

async function loadDuplicateStatus(ownerUserId: string) {
  const row = await getD1()
    .prepare(
      `SELECT id, name, category FROM workflow_statuses
       WHERE owner_user_id = ? AND system_role = 'duplicate'
         AND archived_at IS NULL LIMIT 1`,
    )
    .bind(ownerUserId)
    .first<{ id: string; name: string; category: string }>();
  if (!row || row.category !== "canceled") {
    throw new ValidationError("Reserved Duplicate status is not available");
  }
  return { id: row.id, name: row.name, category: "canceled" as const };
}

function duplicateStatusUpdate(
  db: D1Database,
  currentUserId: string,
  taskId: string,
  expectedVersion: number,
  statusId: string,
  timestamps: {
    startedAt: string | null;
    completedAt: string | null;
    canceledAt: string | null;
  },
  now: string,
) {
  return db
    .prepare(
      `UPDATE tasks SET status_id = ?, started_at = ?, completed_at = ?,
         canceled_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND ${editableProjectTask("tasks")}`,
    )
    .bind(
      statusId,
      timestamps.startedAt,
      timestamps.completedAt,
      timestamps.canceledAt,
      now,
      taskId,
      expectedVersion,
      currentUserId,
      currentUserId,
    );
}

function editableParticipantExists(alias: string) {
  return `EXISTS (
    SELECT 1 FROM tasks ${alias}
    WHERE ${alias}.id = ?
      AND ${editableProjectTask(alias)}
  )`;
}

function sameProjectParticipants() {
  return `EXISTS (
    SELECT 1
    FROM tasks same_source
    JOIN tasks same_target ON same_target.id = ?
      AND same_target.project_id = same_source.project_id
    WHERE same_source.id = ? AND same_source.project_id IS NOT NULL
  )`;
}

function editableProjectTask(alias: string) {
  return `(
    ${alias}.project_id IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM projects editable_project
        WHERE editable_project.id = ${alias}.project_id
          AND editable_project.owner_user_id = ?
      ) OR EXISTS (SELECT 1 FROM (SELECT ? AS user_id) access_actor
        WHERE EXISTS (
          SELECT 1 FROM access_grants editable_grant
          WHERE editable_grant.resource_type = 'project'
            AND editable_grant.resource_id = ${alias}.project_id
            AND editable_grant.grantee_user_id = access_actor.user_id
            AND editable_grant.revoked_at IS NULL
            AND editable_grant.permission IN ('editor', 'manager', 'full_access')
        ) OR EXISTS (
          SELECT 1 FROM team_memberships membership
          JOIN team_grants team_grant ON team_grant.team_id = membership.team_id
            AND team_grant.revoked_at IS NULL
          WHERE membership.user_id = access_actor.user_id
            AND membership.status = 'active'
            AND team_grant.permission IN ('editor', 'manager')
            AND ((team_grant.resource_type = 'project'
                  AND team_grant.resource_id = ${alias}.project_id)
              OR (team_grant.resource_type = 'task'
                  AND team_grant.resource_id = ${alias}.id))
        ))
    )
  )`;
}

function assertEditableProjectTasks(...tasks: TaskRecord[]) {
  for (const task of tasks) {
    if (!task.projectId) {
      throw new ValidationError("Relations require both tasks to belong to a project");
    }
    if (!canEditContent(task.accessRole)) {
      throw new PermissionError("Editor access to both tasks is required");
    }
  }
}

function assertEditableRelationTasks(
  anchor: TaskRecord,
  peer: TaskRecord,
  type: TaskRelationType,
) {
  assertEditableProjectTasks(anchor, peer);
  if (type === "duplicate_of" && anchor.projectId !== peer.projectId) {
    throw new ValidationError(
      "Duplicate relations require both tasks to belong to the same Project",
    );
  }
}

function relationInput(input: Record<string, unknown>): RelationInput {
  const type = input.type;
  const direction = input.direction;
  if (type !== "blocks" && type !== "related" && type !== "duplicate_of") {
    throw new ValidationError("Unknown relation type");
  }
  if (direction !== "outgoing" && direction !== "incoming") {
    throw new ValidationError("Unknown relation direction");
  }
  return { type, direction };
}

function expectedTaskVersion(value: unknown, source: TaskRecord) {
  const version = positiveInteger(value, "Task version");
  if (version !== source.version) {
    throw new ConflictError("Task was changed in another session");
  }
  return version;
}

function positiveInteger(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return number;
}

function boundedKey(value: unknown) {
  const key = requiredString(value, "Idempotency key");
  if (key.length > 200) {
    throw new ValidationError("Idempotency key is limited to 200 characters");
  }
  return key;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${label} is required`);
  }
  return value.trim();
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: string[]) {
  const accepted = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!accepted.has(key)) throw new ValidationError(`Unknown field: ${key}`);
  }
}

function sameSemantic(
  relation: Pick<TaskRelationRecord, "sourceTaskId" | "targetTaskId" | "type">,
  semantic: Pick<TaskRelationRecord, "sourceTaskId" | "targetTaskId" | "type">,
) {
  return relation.sourceTaskId === semantic.sourceTaskId &&
    relation.targetTaskId === semantic.targetTaskId &&
    relation.type === semantic.type;
}

function mapRelation(row: DbRow): TaskRelationRecord {
  return {
    id: String(row.id),
    sourceTaskId: String(row.source_task_id),
    targetTaskId: String(row.target_task_id),
    type: String(row.type) as TaskRelationType,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}

function relationConstraintMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /duplicate_source/.test(message)
    ? "A duplicate task can have only one canonical target"
    : "This relation conflicts with an existing relation";
}
