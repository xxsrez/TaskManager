import { getD1 } from "@/db";
import { canEditContent } from "./access";
import {
  activityBatchAssertion,
  activityEventAfterPreviousChange,
  newActivityId,
} from "./activity-write";
import {
  purgeProjectAttachmentObjects,
  purgeTaskAttachmentObjects,
} from "./attachments";
import {
  projectAccessRoleSql,
  savedViewAccessRoleSql,
  taskAccessRoleSql,
} from "./access-sql";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";
import type {
  AccessRole,
  DeletionPreview,
  DeletableEntityType,
  ReleaseDeletionPreview,
  RecentlyDeletedPage,
  RecentlyDeletedRecord,
  UserRecord,
} from "./types";

type DbRow = Record<string, unknown>;

const RETENTION_DAYS = 30;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAINTENANCE_BATCH_SIZE = 25;
export const PERMANENT_DELETE_CONFIRMATION = "DELETE PERMANENTLY";

type LifecycleRow = {
  id: string;
  publicId: string;
  version: number;
  deletedAt: string | null;
  deletedByUserId: string | null;
  purgeAfter: string | null;
  accessRole: AccessRole;
  projectId: string | null;
  projectDeletedAt: string | null;
  releaseStatus: "planned" | "active" | "released" | "canceled" | null;
};

export type EntityDeletionResult = {
  type: DeletableEntityType;
  id: string;
  publicId: string;
  version: number;
  deletedAt: string | null;
  purgeAfter: string | null;
};

export async function deleteEntity(
  currentUser: UserRecord,
  type: DeletableEntityType,
  reference: string,
  expectedVersion: number,
  now = new Date(),
  options: { confirmReleasedComposition?: boolean } = {},
): Promise<EntityDeletionResult> {
  assertExpectedVersion(expectedVersion);
  const current = await loadLifecycleRow(currentUser.id, type, reference);
  requireEditor(current.accessRole);
  if (await hasPurgeJob(type, current.id)) {
    throw new ConflictError(`${entityLabel(type)} permanent deletion has started`);
  }
  if (current.projectDeletedAt) {
    throw new ConflictError("Restore the Project before changing a child entity");
  }
  if (current.deletedAt) {
    if (isIdempotentReplay(current.version, expectedVersion)) {
      return lifecycleResult(type, current);
    }
    throw new ConflictError(`${entityLabel(type)} was changed in another session`);
  }
  if (current.version !== expectedVersion) {
    throw new ConflictError(`${entityLabel(type)} was changed in another session`);
  }
  if (
    type === "release" && current.releaseStatus === "released" &&
    options.confirmReleasedComposition !== true
  ) {
    throw new ValidationError("Confirm deleting the composition of a released Release");
  }

  const deletedAt = now.toISOString();
  const purgeAfter = new Date(
    now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const row = type === "task"
    ? await deleteTaskWithActivity(
        currentUser,
        current,
        expectedVersion,
        deletedAt,
        purgeAfter,
      )
    : await updateLifecycle(
        type,
        current.id,
        expectedVersion,
        currentUser.id,
        deletedAt,
        purgeAfter,
      );
  return lifecycleResult(type, row);
}

export async function restoreEntity(
  currentUser: UserRecord,
  type: DeletableEntityType,
  reference: string,
  expectedVersion: number,
  now = new Date(),
): Promise<EntityDeletionResult> {
  assertExpectedVersion(expectedVersion);
  const current = await loadLifecycleRow(currentUser.id, type, reference);
  requireEditor(current.accessRole);
  if (await hasPurgeJob(type, current.id)) {
    throw new ConflictError(`${entityLabel(type)} permanent deletion has started`);
  }
  if (current.projectDeletedAt) {
    throw new ConflictError("Restore the Project before restoring a child entity");
  }
  if (!current.deletedAt) {
    if (isIdempotentReplay(current.version, expectedVersion)) {
      return lifecycleResult(type, current);
    }
    throw new ConflictError(`${entityLabel(type)} is not deleted`);
  }
  if (current.version !== expectedVersion) {
    throw new ConflictError(`${entityLabel(type)} was changed in another session`);
  }
  if (!current.purgeAfter || Date.parse(current.purgeAfter) <= now.getTime()) {
    throw new ConflictError(`${entityLabel(type)} recovery period has expired`);
  }

  const restoredAt = now.toISOString();
  const row = type === "task"
    ? await restoreTaskWithActivity(currentUser, current, expectedVersion, restoredAt)
    : await updateLifecycle(
        type,
        current.id,
        expectedVersion,
        null,
        null,
        null,
      );
  return lifecycleResult(type, row);
}

export async function purgeEntity(
  currentUser: UserRecord,
  type: DeletableEntityType,
  reference: string,
  expectedVersion: number,
  confirmation: unknown,
): Promise<{ type: DeletableEntityType; id: string; purged: true }> {
  assertExpectedVersion(expectedVersion);
  if (confirmation !== PERMANENT_DELETE_CONFIRMATION) {
    throw new ValidationError(
      `Type ${PERMANENT_DELETE_CONFIRMATION} to permanently delete this entity`,
    );
  }
  const completed = await loadCompletedPurgeReceipt(
    currentUser.id,
    type,
    reference,
    expectedVersion,
    new Date(),
  );
  if (completed) return { type, id: completed.entity_id, purged: true };
  const current = await loadLifecycleRow(currentUser.id, type, reference);
  if (current.accessRole !== "owner") {
    throw new PermissionError("Owner access is required for permanent deletion");
  }
  if (current.projectDeletedAt) {
    throw new ConflictError("Permanently delete the Project instead of its shadowed child");
  }
  if (!current.deletedAt) {
    throw new ConflictError(`${entityLabel(type)} must be deleted before permanent deletion`);
  }
  if (current.version !== expectedVersion) {
    throw new ConflictError(`${entityLabel(type)} was changed in another session`);
  }

  const purgeStartedAt = new Date().toISOString();
  await claimPurge(currentUser.id, type, current, purgeStartedAt);
  if (type === "task") {
    await purgeTask(currentUser.id, current, purgeStartedAt);
  } else if (type === "project") {
    await purgeProject(currentUser.id, current, purgeStartedAt);
  } else if (type === "release") {
    await purgeRelease(currentUser.id, current, purgeStartedAt);
  } else {
    await purgeSavedView(currentUser.id, current, purgeStartedAt);
  }
  return { type, id: current.id, purged: true };
}

export async function listRecentlyDeleted(
  currentUser: UserRecord,
  input: {
    limit?: number;
    cursor?: string | null;
    type?: DeletableEntityType;
    search?: string | null;
  } = {},
): Promise<RecentlyDeletedPage> {
  const limit = normalizeLimit(input.limit);
  if (input.type !== undefined && !isEntityType(input.type)) {
    throw new ValidationError("Recently deleted entity type is invalid");
  }
  const search = normalizeSearch(input.search);
  const cursor = decodeCursor(input.cursor ?? null);
  if (cursor && (
    cursor.filterType !== (input.type ?? null) || cursor.search !== search
  )) {
    throw new ValidationError("Recently deleted cursor does not match the active filters");
  }
  const cursorPredicate = cursor
    ? `WHERE (deleted_entities.deleted_at < ? OR (
         deleted_entities.deleted_at = ? AND (
           deleted_entities.entity_type > ? OR (
             deleted_entities.entity_type = ? AND deleted_entities.id > ?
           )
         )
       ))`
    : "";
  const cursorParameters = cursor
    ? [cursor.deletedAt, cursor.deletedAt, cursor.type, cursor.type, cursor.id]
    : [];
  const typePredicate = input.type ? "AND deleted_entities.entity_type = ?" : "";
  const typeParameters = input.type ? [input.type] : [];
  const searchPredicate = search
    ? `AND (LOWER(deleted_entities.display_name) LIKE ? ESCAPE '\\'
         OR LOWER(deleted_entities.public_id) LIKE ? ESCAPE '\\'
         OR LOWER(COALESCE(deleted_entities.context_name, '')) LIKE ? ESCAPE '\\')`
    : "";
  const searchParameters = search
    ? Array(3).fill(`%${escapeLike(search)}%`)
    : [];
  const rows = await getD1().prepare(
    `WITH deleted_entities AS (
       SELECT 'task' AS entity_type, t.id, t.public_id,
         t.identifier || ' ' || t.title AS display_name,
         p.name AS context_name, t.deleted_at, t.deleted_by_user_id,
         t.purge_after, t.version, job.started_at AS purge_started_at,
         ${taskAccessRoleSql("t", "p", true)} AS access_role
       FROM tasks t JOIN projects p ON p.id = t.project_id
       LEFT JOIN entity_purge_jobs job
         ON job.entity_type = 'task' AND job.entity_id = t.id
       WHERE t.deleted_at IS NOT NULL AND p.deleted_at IS NULL
       UNION ALL
       SELECT 'project', p.id, p.public_id, p.name, NULL,
         p.deleted_at, p.deleted_by_user_id, p.purge_after, p.version,
         job.started_at,
         ${projectAccessRoleSql("p", true)} AS access_role
       FROM projects p LEFT JOIN entity_purge_jobs job
         ON job.entity_type = 'project' AND job.entity_id = p.id
       WHERE p.deleted_at IS NOT NULL
       UNION ALL
       SELECT 'release', r.id, r.public_id, r.name, p.name,
         r.deleted_at, r.deleted_by_user_id, r.purge_after, r.version,
         job.started_at,
         ${projectAccessRoleSql("p", true)} AS access_role
       FROM releases r JOIN projects p ON p.id = r.project_id
       LEFT JOIN entity_purge_jobs job
         ON job.entity_type = 'release' AND job.entity_id = r.id
       WHERE r.deleted_at IS NOT NULL AND p.deleted_at IS NULL
       UNION ALL
       SELECT 'saved_view', v.id, v.public_id, v.name, p.name,
         v.deleted_at, v.deleted_by_user_id, v.purge_after, v.version,
         job.started_at,
         ${savedViewAccessRoleSql("v", "p", true)} AS access_role
       FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
       LEFT JOIN entity_purge_jobs job
         ON job.entity_type = 'saved_view' AND job.entity_id = v.id
       WHERE v.deleted_at IS NOT NULL
         AND (v.scope_project_id IS NULL OR p.deleted_at IS NULL)
     )
     SELECT deleted_entities.*, actor.display_name AS deleted_by_name
     FROM deleted_entities
     JOIN users actor ON actor.id = deleted_entities.deleted_by_user_id
     ${cursorPredicate}
     ${cursorPredicate ? "AND" : "WHERE"} access_role IS NOT NULL
     ${typePredicate}
     ${searchPredicate}
     ORDER BY deleted_entities.deleted_at DESC,
       deleted_entities.entity_type ASC, deleted_entities.id ASC
     LIMIT ?`,
  ).bind(
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    ...cursorParameters,
    ...typeParameters,
    ...searchParameters,
    limit + 1,
  ).all<DbRow>();
  const visible = rows.results.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) => mapRecentlyDeleted(row, currentUser.id)),
    page: {
      hasMore: rows.results.length > limit,
      nextCursor: rows.results.length > limit && last
        ? encodeCursor({
            deletedAt: String(last.deleted_at),
            type: String(last.entity_type) as DeletableEntityType,
            id: String(last.id),
            filterType: input.type ?? null,
            search,
          })
        : null,
    },
  };
}

export async function getDeletionPreview(
  currentUser: UserRecord,
  type: DeletableEntityType,
  reference: string,
  expectedVersion: number,
): Promise<DeletionPreview> {
  if (!isEntityType(type)) throw new ValidationError("Deleted entity type is invalid");
  assertExpectedVersion(expectedVersion);
  const current = await loadLifecycleRow(currentUser.id, type, reference);
  if (current.accessRole !== "owner") {
    throw new PermissionError("Owner access is required for permanent deletion");
  }
  if (current.projectDeletedAt) {
    throw new ConflictError("Permanently delete the Project instead of its shadowed child");
  }
  if (!current.deletedAt) {
    throw new ConflictError(`${entityLabel(type)} must be deleted before permanent deletion`);
  }
  if (current.version !== expectedVersion) {
    throw new ConflictError(`${entityLabel(type)} was changed in another session`);
  }

  const row = await loadDeletionImpact(type, current.id);
  if (!row) throw new NotFoundError(`${entityLabel(type)} not found`);
  return {
    type,
    id: current.id,
    publicId: current.publicId,
    displayName: String(row.display_name),
    context: nullableString(row.context_name),
    version: current.version,
    confirmation: PERMANENT_DELETE_CONFIRMATION,
    impact: {
      tasks: Number(row.task_count ?? 0),
      releases: Number(row.release_count ?? 0),
      savedViews: Number(row.saved_view_count ?? 0),
      comments: Number(row.comment_count ?? 0),
      attachments: Number(row.attachment_count ?? 0),
      releaseMemberships: Number(row.release_membership_count ?? 0),
    },
  };
}

export async function getReleaseDeletionPreview(
  currentUser: UserRecord,
  reference: string,
  expectedVersion: number,
): Promise<ReleaseDeletionPreview> {
  assertExpectedVersion(expectedVersion);
  const current = await loadLifecycleRow(currentUser.id, "release", reference);
  if (current.deletedAt || current.projectDeletedAt) {
    throw new NotFoundError("Release not found");
  }
  requireEditor(current.accessRole);
  if (current.version !== expectedVersion) {
    throw new ConflictError("Release was changed in another session");
  }
  const row = await getD1().prepare(
    `SELECT r.name AS display_name, p.name AS context_name, r.status,
       (SELECT COUNT(*) FROM tasks t WHERE t.release_id = r.id) AS task_memberships
     FROM releases r JOIN projects p ON p.id = r.project_id
     WHERE r.id = ? AND r.version = ? AND r.deleted_at IS NULL
       AND p.deleted_at IS NULL`,
  ).bind(current.id, expectedVersion).first<DbRow>();
  if (!row) throw new ConflictError("Release was changed in another session");
  const status = String(row.status) as ReleaseDeletionPreview["status"];
  return {
    type: "release",
    id: current.id,
    publicId: current.publicId,
    displayName: String(row.display_name),
    context: String(row.context_name),
    version: current.version,
    status,
    taskMemberships: Number(row.task_memberships ?? 0),
    requiresReleasedCompositionConfirmation: status === "released",
  };
}

async function loadDeletionImpact(type: DeletableEntityType, id: string) {
  const db = getD1();
  if (type === "project") {
    return db.prepare(
      `SELECT p.name AS display_name, NULL AS context_name,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
         (SELECT COUNT(*) FROM releases r WHERE r.project_id = p.id) AS release_count,
         (SELECT COUNT(*) FROM saved_views v WHERE v.scope_project_id = p.id) AS saved_view_count,
         (SELECT COUNT(*) FROM comments c JOIN tasks t ON t.id = c.task_id
           WHERE t.project_id = p.id) AS comment_count,
         (SELECT COUNT(*) FROM attachments a JOIN tasks t ON t.id = a.task_id
           WHERE t.project_id = p.id) AS attachment_count,
         0 AS release_membership_count
       FROM projects p WHERE p.id = ? AND p.deleted_at IS NOT NULL`,
    ).bind(id).first<DbRow>();
  }
  if (type === "release") {
    return db.prepare(
      `SELECT r.name AS display_name, p.name AS context_name,
         0 AS task_count, 0 AS release_count, 0 AS saved_view_count,
         0 AS comment_count, 0 AS attachment_count,
         (SELECT COUNT(*) FROM tasks t WHERE t.release_id = r.id)
           AS release_membership_count
       FROM releases r JOIN projects p ON p.id = r.project_id
       WHERE r.id = ? AND r.deleted_at IS NOT NULL AND p.deleted_at IS NULL`,
    ).bind(id).first<DbRow>();
  }
  if (type === "task") {
    return db.prepare(
      `SELECT t.identifier || ' ' || t.title AS display_name,
         p.name AS context_name, 1 AS task_count, 0 AS release_count,
         0 AS saved_view_count, t.comment_count AS comment_count,
         (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id)
           AS attachment_count,
         0 AS release_membership_count
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id = ? AND t.deleted_at IS NOT NULL AND p.deleted_at IS NULL`,
    ).bind(id).first<DbRow>();
  }
  return db.prepare(
    `SELECT v.name AS display_name, p.name AS context_name,
       0 AS task_count, 0 AS release_count, 1 AS saved_view_count,
       0 AS comment_count, 0 AS attachment_count, 0 AS release_membership_count
     FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
     WHERE v.id = ? AND v.deleted_at IS NOT NULL
       AND (v.scope_project_id IS NULL OR p.deleted_at IS NULL)`,
  ).bind(id).first<DbRow>();
}

/**
 * Bounded Sites-worker-compatible maintenance. A failed R2 cleanup leaves the
 * D1 tombstone intact, so the next invocation can retry truthfully.
 */
export async function purgeExpiredDeletedEntities(
  now = new Date(),
  limit = MAINTENANCE_BATCH_SIZE,
) {
  const boundedLimit = Math.min(MAINTENANCE_BATCH_SIZE, Math.max(1, Math.trunc(limit)));
  await getD1().prepare(
    `DELETE FROM entity_purge_jobs WHERE rowid IN (
       SELECT rowid FROM entity_purge_jobs
       WHERE completed_at IS NOT NULL AND receipt_expires_at <= ?
       ORDER BY receipt_expires_at LIMIT ?
     )`,
  ).bind(now.toISOString(), boundedLimit).run();
  const rows = await getD1().prepare(
    `SELECT entity_type, id, version, owner_user_id FROM (
       SELECT 'project' AS entity_type, p.id, p.version, p.owner_user_id,
         p.purge_after FROM projects p WHERE p.deleted_at IS NOT NULL
       UNION ALL
       SELECT 'release', r.id, r.version, p.owner_user_id, r.purge_after
         FROM releases r JOIN projects p ON p.id = r.project_id
         WHERE r.deleted_at IS NOT NULL AND p.deleted_at IS NULL
       UNION ALL
       SELECT 'task', t.id, t.version, p.owner_user_id, t.purge_after
         FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.deleted_at IS NOT NULL AND p.deleted_at IS NULL
       UNION ALL
       SELECT 'saved_view', v.id, v.version,
         COALESCE(p.owner_user_id, v.owner_user_id), v.purge_after
         FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
         WHERE v.deleted_at IS NOT NULL
           AND (v.scope_project_id IS NULL OR p.deleted_at IS NULL)
     ) due
     WHERE purge_after <= ?
     ORDER BY purge_after, entity_type, id LIMIT ?`,
  ).bind(now.toISOString(), boundedLimit).all<DbRow>();
  let purged = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      const owner = await loadMaintenanceOwner(String(row.owner_user_id));
      await purgeEntity(
        owner,
        String(row.entity_type) as DeletableEntityType,
        String(row.id),
        Number(row.version),
        PERMANENT_DELETE_CONFIRMATION,
      );
      purged += 1;
    } catch {
      failed += 1;
    }
  }
  return { processed: rows.results.length, purged, failed };
}

async function deleteTaskWithActivity(
  currentUser: UserRecord,
  current: LifecycleRow,
  expectedVersion: number,
  deletedAt: string,
  purgeAfter: string,
) {
  const db = getD1();
  const activity = activityEventAfterPreviousChange(db, currentUser, {
    taskId: current.id,
    eventType: "task_deleted",
    payload: { deletedAt, purgeAfter },
    createdAt: deletedAt,
  });
  const [updated] = await db.batch<DbRow>([
    db.prepare(
      `UPDATE tasks SET deleted_at = ?, deleted_by_user_id = ?, purge_after = ?,
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM projects p
           WHERE p.id = tasks.project_id AND p.deleted_at IS NULL)
       RETURNING id, public_id, version, deleted_at, deleted_by_user_id, purge_after`,
    ).bind(
      deletedAt,
      currentUser.id,
      purgeAfter,
      deletedAt,
      current.id,
      expectedVersion,
    ),
    activity.statement,
    activityBatchAssertion(db, `assert:${newActivityId()}`, deletedAt),
    db.prepare(
      `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
       SELECT child.id, 'task' FROM tasks child
       WHERE child.parent_task_id = ? AND child.deleted_at IS NULL`,
    ).bind(current.id),
    db.prepare(
      `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
       SELECT child.id, 'task_detail' FROM tasks child
       WHERE child.parent_task_id = ? AND child.deleted_at IS NULL`,
    ).bind(current.id),
    db.prepare(
      `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
       SELECT related.id, 'task_detail' FROM tasks related
       WHERE related.deleted_at IS NULL AND related.id IN (
         SELECT CASE WHEN relation.source_task_id = ?
           THEN relation.target_task_id ELSE relation.source_task_id END
         FROM task_relations relation
         WHERE relation.source_task_id = ? OR relation.target_task_id = ?
       )`,
    ).bind(current.id, current.id, current.id),
  ]);
  const row = updated.results[0] as DbRow | undefined;
  if (!row) throw new ConflictError("Task was changed in another session");
  return lifecycleRowFromMutation(row, current);
}

async function restoreTaskWithActivity(
  currentUser: UserRecord,
  current: LifecycleRow,
  expectedVersion: number,
  restoredAt: string,
) {
  const db = getD1();
  const activity = activityEventAfterPreviousChange(db, currentUser, {
    taskId: current.id,
    eventType: "task_delete_restored",
    payload: { deletedAt: current.deletedAt, restoredAt },
    createdAt: restoredAt,
  });
  const [updated] = await db.batch<DbRow>([
    db.prepare(
      `UPDATE tasks SET deleted_at = NULL, deleted_by_user_id = NULL,
         purge_after = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NOT NULL AND purge_after > ?
         AND NOT EXISTS (SELECT 1 FROM entity_purge_jobs job
           WHERE job.entity_type = 'task' AND job.entity_id = tasks.id)
         AND EXISTS (SELECT 1 FROM projects p
           WHERE p.id = tasks.project_id AND p.deleted_at IS NULL)
       RETURNING id, public_id, version, deleted_at, deleted_by_user_id, purge_after`,
    ).bind(restoredAt, current.id, expectedVersion, restoredAt),
    activity.statement,
    activityBatchAssertion(db, `assert:${newActivityId()}`, restoredAt),
    db.prepare(
      `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
       SELECT child.id, 'task' FROM tasks child
       WHERE child.parent_task_id = ? AND child.deleted_at IS NULL`,
    ).bind(current.id),
    db.prepare(
      `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
       SELECT child.id, 'task_detail' FROM tasks child
       WHERE child.parent_task_id = ? AND child.deleted_at IS NULL`,
    ).bind(current.id),
    db.prepare(
      `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
       SELECT related.id, 'task_detail' FROM tasks related
       WHERE related.deleted_at IS NULL AND related.id IN (
         SELECT CASE WHEN relation.source_task_id = ?
           THEN relation.target_task_id ELSE relation.source_task_id END
         FROM task_relations relation
         WHERE relation.source_task_id = ? OR relation.target_task_id = ?
       )`,
    ).bind(current.id, current.id, current.id),
  ]);
  const row = updated.results[0] as DbRow | undefined;
  if (!row) throw new ConflictError("Task was changed in another session");
  return lifecycleRowFromMutation(row, current);
}

async function updateLifecycle(
  type: Exclude<DeletableEntityType, "task">,
  id: string,
  expectedVersion: number,
  deletedByUserId: string | null,
  deletedAt: string | null,
  purgeAfter: string | null,
) {
  const table = tableFor(type);
  const projectGuard = type === "release"
    ? `AND EXISTS (SELECT 1 FROM projects live_project
         WHERE live_project.id = releases.project_id
           AND live_project.deleted_at IS NULL)`
    : type === "saved_view"
      ? `AND (saved_views.scope_project_id IS NULL OR EXISTS (
           SELECT 1 FROM projects live_project
           WHERE live_project.id = saved_views.scope_project_id
             AND live_project.deleted_at IS NULL))`
      : "";
  const result = await getD1().prepare(
    `UPDATE ${table}
     SET deleted_at = ?, deleted_by_user_id = ?, purge_after = ?,
       version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND deleted_at IS ${deletedAt ? "NULL" : "NOT NULL"}
       AND NOT EXISTS (SELECT 1 FROM entity_purge_jobs job
         WHERE job.entity_type = ? AND job.entity_id = ${table}.id)
       ${projectGuard}
     RETURNING id, public_id, version, deleted_at, deleted_by_user_id, purge_after`,
  ).bind(
    deletedAt,
    deletedByUserId,
    purgeAfter,
    new Date().toISOString(),
    id,
    expectedVersion,
    type,
  ).first<DbRow>();
  if (!result) {
    throw new ConflictError(`${entityLabel(type)} was changed in another session`);
  }
  return lifecycleRowFromMutation(result);
}

async function loadLifecycleRow(
  userId: string,
  type: DeletableEntityType,
  reference: string,
): Promise<LifecycleRow> {
  const db = getD1();
  let row: DbRow | null = null;
  if (type === "task") {
    row = await db.prepare(
      `SELECT t.*, p.deleted_at AS project_deleted_at,
         ${taskAccessRoleSql("t", "p", true)} AS access_role
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id = ? OR t.public_id = ? LIMIT 1`,
    ).bind(userId, userId, userId, userId, reference, reference).first<DbRow>();
  } else if (type === "project") {
    row = await db.prepare(
      `SELECT p.*, NULL AS project_deleted_at,
         ${projectAccessRoleSql("p", true)} AS access_role
       FROM projects p WHERE p.id = ? OR p.public_id = ? LIMIT 1`,
    ).bind(userId, userId, reference, reference).first<DbRow>();
  } else if (type === "release") {
    row = await db.prepare(
      `SELECT r.*, p.deleted_at AS project_deleted_at,
         ${projectAccessRoleSql("p", true)} AS access_role
       FROM releases r JOIN projects p ON p.id = r.project_id
       WHERE r.id = ? OR r.public_id = ? LIMIT 1`,
    ).bind(userId, userId, reference, reference).first<DbRow>();
  } else {
    row = await db.prepare(
      `SELECT v.*, p.deleted_at AS project_deleted_at,
         ${savedViewAccessRoleSql("v", "p", true)} AS access_role
       FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
       WHERE v.id = ? OR v.public_id = ? LIMIT 1`,
    ).bind(userId, userId, userId, userId, reference, reference).first<DbRow>();
  }
  if (!row?.access_role) throw new NotFoundError(`${entityLabel(type)} not found`);
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    version: Number(row.version),
    deletedAt: nullableString(row.deleted_at),
    deletedByUserId: nullableString(row.deleted_by_user_id),
    purgeAfter: nullableString(row.purge_after),
    accessRole: String(row.access_role) as AccessRole,
    projectId: nullableString(row.project_id),
    projectDeletedAt: nullableString(row.project_deleted_at),
    releaseStatus: type === "release" ? nullableReleaseStatus(row.status) : null,
  };
}

async function purgeTask(
  actorUserId: string,
  current: LifecycleRow,
  completedAt: string,
) {
  const db = getD1();
  const attachments = await db.prepare(
    "SELECT id, stored_file_id FROM attachments WHERE task_id = ?",
  ).bind(current.id).all<{ id: string; stored_file_id: string | null }>();
  if (attachments.results.length) await purgeTaskAttachmentObjects(current.id);
  const storedFileIds = attachments.results.flatMap((row) =>
    row.stored_file_id ? [row.stored_file_id] : []
  );
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE tasks SET parent_task_id = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE parent_task_id = ?").bind(current.id),
    db.prepare("DELETE FROM comment_attachment_refs WHERE task_id = ?").bind(current.id),
    db.prepare("DELETE FROM attachment_migration_outcomes WHERE task_id = ?").bind(current.id),
    db.prepare("DELETE FROM activity_migration_outcomes WHERE task_id = ?").bind(current.id),
    db.prepare("DELETE FROM activity_events WHERE task_id = ?").bind(current.id),
    db.prepare("DELETE FROM comment_migration_outcomes WHERE task_id = ?").bind(current.id),
    db.prepare("DELETE FROM comment_reactions WHERE comment_id IN (SELECT id FROM comments WHERE task_id = ?)").bind(current.id),
    db.prepare("DELETE FROM comments WHERE task_id = ?").bind(current.id),
    db.prepare("DELETE FROM task_relations WHERE source_task_id = ? OR target_task_id = ?").bind(current.id, current.id),
    db.prepare("DELETE FROM task_label_group_values WHERE task_id = ?").bind(current.id),
    db.prepare("DELETE FROM task_labels WHERE task_id = ?").bind(current.id),
    db.prepare("DELETE FROM task_identifier_aliases WHERE task_id = ?").bind(current.id),
    db.prepare("DELETE FROM external_records WHERE target_type = 'task' AND target_id = ?").bind(current.id),
    db.prepare("DELETE FROM attachments WHERE task_id = ?").bind(current.id),
    ...(storedFileIds.length
      ? [db.prepare(
          `DELETE FROM stored_files WHERE id IN (${placeholders(storedFileIds)})
           AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.stored_file_id = stored_files.id)`,
        ).bind(...storedFileIds)]
      : []),
    db.prepare(
      `DELETE FROM tasks WHERE id = ? AND version = ? AND deleted_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM projects p
         WHERE p.id = tasks.project_id AND p.owner_user_id = ?
           AND p.deleted_at IS NULL)
       RETURNING id`,
    ).bind(current.id, current.version, actorUserId),
    purgeReceiptCompletionStatement(db, actorUserId, "task", current, completedAt),
  ];
  const results = await db.batch<DbRow>(statements);
  assertPhysicalDelete(results.at(-2), "Task");
  assertPurgeReceipt(results.at(-1), "Task");
}

async function purgeRelease(
  actorUserId: string,
  current: LifecycleRow,
  completedAt: string,
) {
  const db = getD1();
  const results = await db.batch<DbRow>([
    db.prepare(
      `UPDATE tasks SET release_id = NULL, version = version + 1,
         updated_at = CURRENT_TIMESTAMP WHERE release_id = ?`,
    ).bind(current.id),
    db.prepare("DELETE FROM external_records WHERE target_type = 'release' AND target_id = ?").bind(current.id),
    db.prepare(
      `DELETE FROM releases WHERE id = ? AND version = ? AND deleted_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM projects p
         WHERE p.id = releases.project_id AND p.owner_user_id = ?
           AND p.deleted_at IS NULL)
       RETURNING id`,
    ).bind(current.id, current.version, actorUserId),
    purgeReceiptCompletionStatement(db, actorUserId, "release", current, completedAt),
  ]);
  assertPhysicalDelete(results.at(-2), "Release");
  assertPurgeReceipt(results.at(-1), "Release");
}

async function purgeSavedView(
  actorUserId: string,
  current: LifecycleRow,
  completedAt: string,
) {
  const db = getD1();
  const results = await db.batch<DbRow>([
    db.prepare("DELETE FROM external_records WHERE target_type = 'saved_view' AND target_id = ?").bind(current.id),
    db.prepare(
      `DELETE FROM saved_views WHERE id = ? AND version = ? AND deleted_at IS NOT NULL
       AND ((scope_project_id IS NULL AND owner_user_id = ?) OR EXISTS (
         SELECT 1 FROM projects p
         WHERE p.id = saved_views.scope_project_id AND p.owner_user_id = ?
           AND p.deleted_at IS NULL
       )) RETURNING id`,
    ).bind(current.id, current.version, actorUserId, actorUserId),
    // Keep grants until after the entity DELETE trigger captures its complete
    // audience; the grant trigger then publishes an additional safe reset.
    db.prepare("DELETE FROM access_grants WHERE resource_type = 'saved_view' AND resource_id = ?").bind(current.id),
    purgeReceiptCompletionStatement(db, actorUserId, "saved_view", current, completedAt),
  ]);
  assertPhysicalDelete(results[1], "Saved View");
  assertPurgeReceipt(results.at(-1), "Saved View");
}

async function purgeProject(
  actorUserId: string,
  current: LifecycleRow,
  completedAt: string,
) {
  const db = getD1();
  const [attachments] = await db.batch<DbRow>([
    db.prepare(
      `SELECT a.stored_file_id FROM attachments a
       JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?`,
    ).bind(current.id),
  ]);
  if (attachments.results.length) await purgeProjectAttachmentObjects(current.id);
  const storedFileIds = attachments.results.flatMap((row) =>
    row.stored_file_id ? [String(row.stored_file_id)] : []
  );
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM comment_attachment_refs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id),
    db.prepare("DELETE FROM attachment_migration_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id),
    db.prepare("DELETE FROM activity_migration_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id),
    db.prepare("DELETE FROM activity_events WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id),
    db.prepare("DELETE FROM comment_migration_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id),
    db.prepare("DELETE FROM comment_reactions WHERE comment_id IN (SELECT c.id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ?)").bind(current.id),
    db.prepare("DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id),
    db.prepare("DELETE FROM task_relations WHERE source_task_id IN (SELECT id FROM tasks WHERE project_id = ?) OR target_task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id, current.id),
    db.prepare("DELETE FROM task_label_group_values WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id),
    db.prepare("DELETE FROM task_labels WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id),
    db.prepare("DELETE FROM task_identifier_aliases WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id),
    db.prepare(
      `DELETE FROM external_records WHERE
       (target_type = 'project' AND target_id = ?) OR
       (target_type = 'release' AND target_id IN (SELECT id FROM releases WHERE project_id = ?)) OR
       (target_type = 'task' AND target_id IN (SELECT id FROM tasks WHERE project_id = ?)) OR
       (target_type = 'saved_view' AND target_id IN (SELECT id FROM saved_views WHERE scope_project_id = ?))`,
    ).bind(current.id, current.id, current.id, current.id),
    db.prepare("DELETE FROM attachments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(current.id),
    ...(storedFileIds.length
      ? [db.prepare(
          `DELETE FROM stored_files WHERE id IN (${placeholders(storedFileIds)})
           AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.stored_file_id = stored_files.id)`,
        ).bind(...storedFileIds)]
      : []),
    db.prepare(
      `DELETE FROM entity_purge_jobs WHERE
       (entity_type = 'task' AND entity_id IN (
         SELECT id FROM tasks WHERE project_id = ?
       )) OR (entity_type = 'release' AND entity_id IN (
         SELECT id FROM releases WHERE project_id = ?
       )) OR (entity_type = 'saved_view' AND entity_id IN (
         SELECT id FROM saved_views WHERE scope_project_id = ?
       ))`,
    ).bind(current.id, current.id, current.id),
    db.prepare(
      `DELETE FROM access_grants WHERE
       (resource_type = 'task' AND resource_id IN (
         SELECT id FROM tasks WHERE project_id = ?
       )) OR (resource_type = 'saved_view' AND resource_id IN (
         SELECT id FROM saved_views WHERE scope_project_id = ?
       ))`,
    ).bind(current.id, current.id),
    db.prepare("DELETE FROM tasks WHERE project_id = ?").bind(current.id),
    db.prepare("DELETE FROM releases WHERE project_id = ?").bind(current.id),
    db.prepare("DELETE FROM saved_views WHERE scope_project_id = ?").bind(current.id),
    db.prepare(
      `DELETE FROM projects WHERE id = ? AND version = ?
       AND owner_user_id = ? AND deleted_at IS NOT NULL RETURNING id`,
    ).bind(current.id, current.version, actorUserId),
    // Project DELETE must run while grants still exist so the trigger captures
    // every collaborator that must remove the subtree.
    db.prepare("DELETE FROM access_grants WHERE resource_type = 'project' AND resource_id = ?").bind(current.id),
    purgeReceiptCompletionStatement(db, actorUserId, "project", current, completedAt),
  ];
  const results = await db.batch<DbRow>(statements);
  assertPhysicalDelete(results.at(-3), "Project");
  assertPurgeReceipt(results.at(-1), "Project");
}

async function claimPurge(
  actorUserId: string,
  type: DeletableEntityType,
  current: LifecycleRow,
  now: string,
) {
  const guard = purgeOwnerGuard(type);
  const claimed = await getD1().prepare(
    `INSERT INTO entity_purge_jobs
       (entity_type, entity_id, entity_public_id, actor_user_id,
        source_version, started_at, updated_at, attempt_count,
        completed_at, receipt_expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL
     WHERE EXISTS (
       SELECT 1 FROM ${tableForAll(type)} entity
       WHERE entity.id = ? AND entity.version = ? AND entity.deleted_at IS NOT NULL
         AND ${guard.sql}
     )
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET
       updated_at = excluded.updated_at,
       attempt_count = entity_purge_jobs.attempt_count + 1
     WHERE entity_purge_jobs.completed_at IS NULL
       AND entity_purge_jobs.entity_public_id = excluded.entity_public_id
       AND entity_purge_jobs.actor_user_id = excluded.actor_user_id
       AND entity_purge_jobs.source_version = excluded.source_version
     RETURNING entity_type`,
  ).bind(
    type,
    current.id,
    current.publicId,
    actorUserId,
    current.version,
    now,
    now,
    current.id,
    current.version,
    ...guard.parameters(actorUserId),
  ).first<{ entity_type: string }>();
  if (!claimed) {
    throw new ConflictError(`${entityLabel(type)} changed before permanent deletion`);
  }
}

function purgeOwnerGuard(type: DeletableEntityType) {
  if (type === "project") {
    return {
      sql: "entity.owner_user_id = ?",
      parameters: (userId: string) => [userId],
    };
  }
  if (type === "task" || type === "release") {
    return {
      sql: `EXISTS (SELECT 1 FROM projects owner_project
        WHERE owner_project.id = entity.project_id
          AND owner_project.owner_user_id = ?
          AND owner_project.deleted_at IS NULL)`,
      parameters: (userId: string) => [userId],
    };
  }
  return {
    sql: `((entity.scope_project_id IS NULL AND entity.owner_user_id = ?)
      OR EXISTS (SELECT 1 FROM projects owner_project
        WHERE owner_project.id = entity.scope_project_id
          AND owner_project.owner_user_id = ?
          AND owner_project.deleted_at IS NULL))`,
    parameters: (userId: string) => [userId, userId],
  };
}

async function hasPurgeJob(type: DeletableEntityType, entityId: string) {
  return Boolean(await getD1().prepare(
    `SELECT 1 AS claimed FROM entity_purge_jobs
     WHERE entity_type = ? AND entity_id = ? LIMIT 1`,
  ).bind(type, entityId).first<{ claimed: number }>());
}

async function loadCompletedPurgeReceipt(
  actorUserId: string,
  type: DeletableEntityType,
  reference: string,
  sourceVersion: number,
  now: Date,
) {
  return getD1().prepare(
    `SELECT entity_id FROM entity_purge_jobs
     WHERE entity_type = ? AND actor_user_id = ? AND source_version = ?
       AND completed_at IS NOT NULL AND receipt_expires_at > ?
       AND (entity_id = ? OR entity_public_id = ?)
     LIMIT 1`,
  ).bind(
    type,
    actorUserId,
    sourceVersion,
    now.toISOString(),
    reference,
    reference,
  ).first<{ entity_id: string }>();
}

function purgeReceiptCompletionStatement(
  db: D1Database,
  actorUserId: string,
  type: DeletableEntityType,
  current: LifecycleRow,
  completedAt: string,
) {
  const receiptExpiresAt = new Date(
    Date.parse(completedAt) + RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  return db.prepare(
    `UPDATE entity_purge_jobs
     SET completed_at = ?, receipt_expires_at = ?, updated_at = ?
     WHERE entity_type = ? AND entity_id = ? AND entity_public_id = ?
       AND actor_user_id = ? AND source_version = ? AND completed_at IS NULL
     RETURNING entity_id`,
  ).bind(
    completedAt,
    receiptExpiresAt,
    completedAt,
    type,
    current.id,
    current.publicId,
    actorUserId,
    current.version,
  );
}

function assertPhysicalDelete(
  result: D1Result<DbRow> | undefined,
  label: string,
) {
  if (!result || result.results.length !== 1) {
    throw new ConflictError(`${label} changed before permanent deletion`);
  }
}

function assertPurgeReceipt(
  result: D1Result<DbRow> | undefined,
  label: string,
) {
  if (!result || result.results.length !== 1) {
    throw new ConflictError(`${label} purge receipt could not be completed`);
  }
}

async function loadMaintenanceOwner(id: string): Promise<UserRecord> {
  const row = await getD1().prepare(
    `SELECT id, display_name, email, timezone, theme, sidebar_preference, version
     FROM users WHERE id = ?`,
  ).bind(id).first<DbRow>();
  if (!row) throw new NotFoundError("Deletion owner not found");
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    email: String(row.email),
    timezone: String(row.timezone),
    theme: String(row.theme ?? "system") as UserRecord["theme"],
    sidebarPreference: String(row.sidebar_preference ?? "expanded") as UserRecord["sidebarPreference"],
    version: Number(row.version ?? 1),
  };
}

function mapRecentlyDeleted(row: DbRow, currentUserId: string): RecentlyDeletedRecord {
  const accessRole = String(row.access_role) as AccessRole;
  return {
    type: String(row.entity_type) as DeletableEntityType,
    id: String(row.id),
    publicId: String(row.public_id),
    displayName: String(row.display_name),
    context: nullableString(row.context_name),
    deletedAt: String(row.deleted_at),
    deletedBy: {
      displayName: String(row.deleted_by_name),
      isCurrentUser: String(row.deleted_by_user_id) === currentUserId,
    },
    purgeAfter: String(row.purge_after),
    version: Number(row.version),
    accessRole,
    actions: {
      canRestore: canEditContent(accessRole) && row.purge_started_at == null &&
        Date.parse(String(row.purge_after)) > Date.now(),
      canPurge: accessRole === "owner",
    },
    purgeState: row.purge_started_at == null ? "ready" : "retry_required",
  };
}

function lifecycleResult(
  type: DeletableEntityType,
  row: LifecycleRow,
): EntityDeletionResult {
  return {
    type,
    id: row.id,
    publicId: row.publicId,
    version: row.version,
    deletedAt: row.deletedAt,
    purgeAfter: row.purgeAfter,
  };
}

function lifecycleRowFromMutation(row: DbRow, current?: LifecycleRow): LifecycleRow {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    version: Number(row.version),
    deletedAt: nullableString(row.deleted_at),
    deletedByUserId: nullableString(row.deleted_by_user_id),
    purgeAfter: nullableString(row.purge_after),
    accessRole: current?.accessRole ?? "owner",
    projectId: current?.projectId ?? null,
    projectDeletedAt: current?.projectDeletedAt ?? null,
    releaseStatus: current?.releaseStatus ?? null,
  };
}

function nullableReleaseStatus(value: unknown): LifecycleRow["releaseStatus"] {
  return value == null ? null : String(value) as LifecycleRow["releaseStatus"];
}

function tableFor(type: Exclude<DeletableEntityType, "task">) {
  if (type === "project") return "projects";
  if (type === "release") return "releases";
  return "saved_views";
}

function tableForAll(type: DeletableEntityType) {
  return type === "task" ? "tasks" : tableFor(type);
}

function entityLabel(type: DeletableEntityType) {
  if (type === "saved_view") return "Saved View";
  return type[0]!.toUpperCase() + type.slice(1);
}

function requireEditor(role: AccessRole) {
  if (!canEditContent(role)) throw new PermissionError("Editor access is required");
}

function assertExpectedVersion(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError("version must be a positive integer");
  }
}

function isIdempotentReplay(currentVersion: number, expectedVersion: number) {
  return expectedVersion === currentVersion || expectedVersion === currentVersion - 1;
}

function normalizeLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError("limit must be a positive integer");
  }
  return Math.min(value, MAX_PAGE_SIZE);
}

type DeletionCursor = {
  deletedAt: string;
  type: DeletableEntityType;
  id: string;
  filterType: DeletableEntityType | null;
  search: string | null;
};

function encodeCursor(cursor: DeletionCursor) {
  return btoa(JSON.stringify({ version: 1, ...cursor }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursor(value: string | null): DeletionCursor | null {
  if (!value) return null;
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ValidationError("Recently deleted cursor is invalid");
  }
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    ) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      typeof parsed.deletedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.deletedAt)) ||
      !isEntityType(parsed.type) ||
      typeof parsed.id !== "string" ||
      !parsed.id ||
      (parsed.filterType !== null && !isEntityType(parsed.filterType)) ||
      (parsed.search !== null && typeof parsed.search !== "string")
    ) {
      throw new Error("invalid");
    }
    return {
      deletedAt: parsed.deletedAt,
      type: parsed.type,
      id: parsed.id,
      filterType: parsed.filterType,
      search: parsed.search,
    };
  } catch {
    throw new ValidationError("Recently deleted cursor is invalid");
  }
}

function normalizeSearch(value: string | null | undefined) {
  if (value == null) return null;
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return null;
  if (normalized.length > 120) {
    throw new ValidationError("Recently deleted search is too long");
  }
  return normalized;
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function isEntityType(value: unknown): value is DeletableEntityType {
  return value === "task" || value === "project" || value === "release" ||
    value === "saved_view";
}

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
