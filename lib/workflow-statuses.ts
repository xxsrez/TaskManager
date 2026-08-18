import { getD1 } from "@/db";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./domain";
import type {
  StatusCategory,
  UserRecord,
  WorkflowStatusRecord,
} from "./types";

type DbRow = Record<string, unknown>;

export type WorkflowStatusSettingsRecord = WorkflowStatusRecord & {
  taskCount: number;
  savedViewCount: number;
};

const categories: readonly StatusCategory[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
];
const defaultCategories = new Set<StatusCategory>(["backlog", "unstarted"]);

export async function listWorkflowStatuses(
  currentUser: UserRecord,
): Promise<WorkflowStatusSettingsRecord[]> {
  const rows = await getD1()
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.status_id = s.id) AS task_count,
        (SELECT COUNT(*) FROM saved_views v
         WHERE instr(v.query_json, '"' || s.id || '"') > 0) AS saved_view_count
       FROM workflow_statuses s
       WHERE s.owner_user_id = ?
       ORDER BY s.position, s.created_at, s.id`,
    )
    .bind(currentUser.id)
    .all<DbRow>();
  return rows.results.map(mapStatus);
}

export async function createWorkflowStatus(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const name = statusName(input.name);
  const category = statusCategory(input.category);
  const color = statusColor(input.color);
  const makeDefault = input.isDefault === true;
  if (makeDefault && !defaultCategories.has(category)) {
    throw new ValidationError("Only Backlog or Unstarted can be the default status");
  }
  const db = getD1();
  await assertUniqueName(currentUser.id, name);
  const position = await db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM workflow_statuses WHERE owner_user_id = ?",
    )
    .bind(currentUser.id)
    .first<{ position: number }>();
  const id = `status:${currentUser.id}:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (makeDefault) {
    statements.push(
      db.prepare(
        `UPDATE workflow_statuses
         SET is_default = 0, version = version + 1, updated_at = ?
         WHERE owner_user_id = ? AND is_default = 1`,
      ).bind(now, currentUser.id),
    );
  }
  statements.push(
    db.prepare(
      `INSERT INTO workflow_statuses
        (id, owner_user_id, name, category, color, position, is_default,
         system_role, archived_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
    ).bind(
      id,
      currentUser.id,
      name,
      category,
      color,
      position?.position ?? 0,
      makeDefault ? 1 : 0,
      now,
      now,
    ),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    translateUniqueName(error);
  }
  return listWorkflowStatuses(currentUser);
}

export async function updateWorkflowStatus(
  currentUser: UserRecord,
  statusId: string,
  input: Record<string, unknown>,
) {
  const current = await loadOwnedStatus(currentUser.id, statusId);
  const version = expectedVersion(input.version);
  if (current.version !== version) throw staleStatus();
  if (Object.hasOwn(input, "category") && input.category !== current.category) {
    throw new ValidationError("Workflow status category cannot be changed");
  }
  const name = Object.hasOwn(input, "name") ? statusName(input.name) : current.name;
  const color = Object.hasOwn(input, "color") ? statusColor(input.color) : current.color;
  const makeDefault = input.isDefault === true;
  if (current.systemRole === "duplicate" && name !== current.name) {
    throw new ValidationError("The reserved Duplicate status cannot be renamed");
  }
  if (makeDefault && !defaultCategories.has(current.category)) {
    throw new ValidationError("Only Backlog or Unstarted can be the default status");
  }
  if (name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
    await assertUniqueName(currentUser.id, name, current.id);
  }
  const db = getD1();
  const now = new Date().toISOString();
  let result: D1Result<unknown>;
  try {
    if (makeDefault) {
      result = await db.prepare(
        `UPDATE workflow_statuses
         SET name = CASE WHEN id = ? THEN ? ELSE name END,
             color = CASE WHEN id = ? THEN ? ELSE color END,
             is_default = CASE WHEN id = ? THEN 1 ELSE 0 END,
             version = version + 1, updated_at = ?
         WHERE owner_user_id = ? AND (id = ? OR is_default = 1)
           AND EXISTS (
             SELECT 1 FROM workflow_statuses target
             WHERE target.id = ? AND target.owner_user_id = ?
               AND target.version = ? AND target.archived_at IS NULL
           )`,
      ).bind(
        statusId, name, statusId, color, statusId, now,
        currentUser.id, statusId, statusId, currentUser.id, version,
      ).run();
    } else {
      result = await db.prepare(
        `UPDATE workflow_statuses
         SET name = ?, color = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND version = ?`,
      ).bind(name, color, now, statusId, currentUser.id, version).run();
    }
  } catch (error) {
    translateUniqueName(error);
  }
  if ((result!.meta.changes ?? 0) < 1) throw staleStatus();
  return listWorkflowStatuses(currentUser);
}

export async function moveWorkflowStatus(
  currentUser: UserRecord,
  statusId: string,
  input: Record<string, unknown>,
) {
  const current = await loadOwnedStatus(currentUser.id, statusId);
  const version = expectedVersion(input.version);
  if (current.version !== version) throw staleStatus();
  const direction = input.direction;
  if (direction !== "up" && direction !== "down") {
    throw new ValidationError("Workflow status direction must be up or down");
  }
  const db = getD1();
  const peer = await db.prepare(
    `SELECT * FROM workflow_statuses
     WHERE owner_user_id = ? AND category = ? AND archived_at IS NULL
       AND ${direction === "up" ? "position < ?" : "position > ?"}
     ORDER BY position ${direction === "up" ? "DESC" : "ASC"}, id
     LIMIT 1`,
  ).bind(currentUser.id, current.category, current.position).first<DbRow>();
  if (!peer) return listWorkflowStatuses(currentUser);
  const peerStatus = mapStatus(peer);
  const peerVersion = expectedVersion(input.peerVersion);
  if (peerStatus.version !== peerVersion) throw staleStatus();
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE workflow_statuses
     SET position = CASE WHEN id = ? THEN ? ELSE ? END,
         version = version + 1, updated_at = ?
     WHERE owner_user_id = ? AND (
       (id = ? AND version = ?) OR (id = ? AND version = ?)
     )`,
  ).bind(
    statusId,
    peerStatus.position,
    current.position,
    now,
    currentUser.id,
    statusId,
    version,
    peerStatus.id,
    peerVersion,
  ).run();
  const moved = await db.prepare(
    `SELECT id, position, version FROM workflow_statuses
     WHERE owner_user_id = ? AND id IN (?, ?)`,
  ).bind(currentUser.id, statusId, peerStatus.id).all<DbRow>();
  const movedCurrent = moved.results.find((row) => row.id === statusId);
  const movedPeer = moved.results.find((row) => row.id === peerStatus.id);
  if (
    (result.meta.changes ?? 0) < 1 ||
    Number(movedCurrent?.position) !== peerStatus.position ||
    Number(movedCurrent?.version) !== version + 1 ||
    Number(movedPeer?.position) !== current.position ||
    Number(movedPeer?.version) !== peerVersion + 1
  ) throw staleStatus();
  return listWorkflowStatuses(currentUser);
}

export async function archiveWorkflowStatus(
  currentUser: UserRecord,
  statusId: string,
  input: Record<string, unknown>,
) {
  const current = await loadOwnedStatus(currentUser.id, statusId);
  const version = expectedVersion(input.version);
  if (current.version !== version) throw staleStatus();
  if (current.archivedAt) throw new ConflictError("Workflow status is already archived");
  if (current.systemRole === "duplicate") {
    throw new ValidationError("The reserved Duplicate status cannot be archived");
  }
  const db = getD1();
  const usage = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE status_id = ?) AS task_count,
       (SELECT COUNT(*) FROM saved_views WHERE instr(query_json, '"' || ? || '"') > 0) AS view_count,
       (SELECT COUNT(*) FROM workflow_statuses
        WHERE owner_user_id = ? AND category = ? AND archived_at IS NULL) AS active_count`,
  ).bind(statusId, statusId, currentUser.id, current.category)
    .first<{ task_count: number; view_count: number; active_count: number }>();
  if (Number(usage?.active_count ?? 0) <= 1) {
    throw new ValidationError("A workflow category must keep at least one active status");
  }
  const replacementRequired = current.isDefault || Number(usage?.task_count ?? 0) > 0 || Number(usage?.view_count ?? 0) > 0;
  const replacementId = typeof input.replacementStatusId === "string"
    ? input.replacementStatusId
    : null;
  const replacement = replacementId
    ? await loadOwnedStatus(currentUser.id, replacementId)
    : null;
  if (replacementRequired && !replacement) {
    throw new ValidationError("Choose an active replacement before archiving this status");
  }
  if (replacement && (
    replacement.id === current.id ||
    replacement.category !== current.category ||
    replacement.archivedAt
  )) {
    throw new ValidationError("Replacement must be another active status in the same category");
  }
  const now = new Date().toISOString();
  const guard = `EXISTS (
    SELECT 1 FROM workflow_statuses target
    WHERE target.id = ? AND target.owner_user_id = ?
      AND target.version = ? AND target.archived_at IS NULL
  )`;
  const statements: D1PreparedStatement[] = [];
  if (replacement) {
    statements.push(
      db.prepare(
        `UPDATE tasks SET status_id = ?, version = version + 1, updated_at = ?
         WHERE status_id = ? AND ${guard}`,
      ).bind(replacement.id, now, statusId, statusId, currentUser.id, version),
      db.prepare(
        `UPDATE saved_views
         SET query_json = replace(query_json, '"' || ? || '"', '"' || ? || '"'),
             version = version + 1, updated_at = ?
         WHERE instr(query_json, '"' || ? || '"') > 0 AND ${guard}`,
      ).bind(statusId, replacement.id, now, statusId, statusId, currentUser.id, version),
    );
    if (current.isDefault) {
      statements.push(
        db.prepare(
          `UPDATE workflow_statuses
           SET is_default = 1, version = version + 1, updated_at = ?
           WHERE id = ? AND owner_user_id = ? AND archived_at IS NULL
             AND ${guard}`,
        ).bind(
          now,
          replacement.id,
          currentUser.id,
          statusId,
          currentUser.id,
          version,
        ),
      );
    }
  }
  statements.push(
    db.prepare(
      `UPDATE workflow_statuses
       SET archived_at = ?, is_default = 0, version = version + 1, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
    ).bind(now, now, statusId, currentUser.id, version),
  );
  await db.batch(statements);
  const archived = await db.prepare(
    "SELECT archived_at, version FROM workflow_statuses WHERE id = ? AND owner_user_id = ?",
  ).bind(statusId, currentUser.id).first<{ archived_at: string | null; version: number }>();
  if (
    !archived?.archived_at ||
    Number(archived.version) !== version + 1
  ) throw staleStatus();
  return listWorkflowStatuses(currentUser);
}

export async function restoreWorkflowStatus(
  currentUser: UserRecord,
  statusId: string,
  input: Record<string, unknown>,
) {
  const version = expectedVersion(input.version);
  const db = getD1();
  await db.prepare(
    `UPDATE workflow_statuses
     SET archived_at = NULL, version = version + 1, updated_at = ?
     WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NOT NULL`,
  ).bind(new Date().toISOString(), statusId, currentUser.id, version).run();
  const restored = await db.prepare(
    "SELECT archived_at, version FROM workflow_statuses WHERE id = ? AND owner_user_id = ?",
  ).bind(statusId, currentUser.id).first<{ archived_at: string | null; version: number }>();
  if (!restored || restored.archived_at !== null || Number(restored.version) !== version + 1) {
    throw staleStatus();
  }
  return listWorkflowStatuses(currentUser);
}

async function loadOwnedStatus(ownerUserId: string, statusId: string) {
  const row = await getD1().prepare(
    "SELECT * FROM workflow_statuses WHERE id = ? AND owner_user_id = ?",
  ).bind(statusId, ownerUserId).first<DbRow>();
  if (!row) throw new NotFoundError("Workflow status not found");
  return mapStatus(row);
}

async function assertUniqueName(ownerUserId: string, name: string, exceptId?: string) {
  const row = await getD1().prepare(
    `SELECT id FROM workflow_statuses
     WHERE owner_user_id = ? AND lower(name) = lower(?)
       AND (? IS NULL OR id <> ?) LIMIT 1`,
  ).bind(ownerUserId, name, exceptId ?? null, exceptId ?? null).first();
  if (row) throw new ValidationError("Workflow status names must be unique");
}

function mapStatus(row: DbRow): WorkflowStatusSettingsRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    category: String(row.category) as StatusCategory,
    color: String(row.color),
    position: Number(row.position),
    isDefault: Boolean(row.is_default),
    systemRole: row.system_role === "duplicate" ? "duplicate" : null,
    archivedAt: typeof row.archived_at === "string" ? row.archived_at : null,
    version: Number(row.version ?? 1),
    taskCount: Number(row.task_count ?? 0),
    savedViewCount: Number(row.saved_view_count ?? 0),
  };
}

function statusName(value: unknown) {
  if (typeof value !== "string") throw new ValidationError("Workflow status name is required");
  const name = value.trim();
  if (!name || name.length > 80) {
    throw new ValidationError("Workflow status name must be between 1 and 80 characters");
  }
  return name;
}

function statusColor(value: unknown) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new ValidationError("Workflow status color must be a six-digit hex color");
  }
  return value.toLowerCase();
}

function statusCategory(value: unknown): StatusCategory {
  if (typeof value !== "string" || !categories.includes(value as StatusCategory)) {
    throw new ValidationError("Workflow status category is invalid");
  }
  return value as StatusCategory;
}

function expectedVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw staleStatus();
  return version;
}

function staleStatus() {
  return new ConflictError("Workflow status was changed in another session");
}

function translateUniqueName(error: unknown): never {
  if (error instanceof Error && /UNIQUE constraint failed: workflow_statuses\.owner_user_id, workflow_statuses\.name/i.test(error.message)) {
    throw new ValidationError("Workflow status names must be unique");
  }
  throw error;
}
