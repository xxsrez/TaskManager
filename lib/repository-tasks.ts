import {
  accessibleTaskWhere,
  editableTaskWhere,
  projectEffectiveRoleRankSql,
  taskEffectiveRoleRankSql,
} from "./access-sql";
import {
  assertReleaseProject,
  ConflictError,
  optionalDate,
  optionalEstimate,
  optionalText,
  priority,
  requireTitle,
  statusTimestamps,
  ValidationError,
} from "./domain";
import {
  activityBatchAssertion,
  activityEventStatement,
  changedFields,
  newActivityId,
} from "./activity-write";
import {
  assertReleasedCompositionChange,
  assertTaskAssigneeAccess,
  loadAccessibleProject,
  loadAccessibleRelease,
  loadAccessibleStoredRelease,
  loadAccessibleTask,
  loadAccessibleTasks,
  loadStatus,
  requestedAssigneeUserId,
  requireContentEdit,
} from "./repository-access-loaders";
import { validateActiveLabelIds } from "./repository-labels";
import {
  internalTaskParentId,
  internalTaskReleaseId,
  finiteNumber,
  type DbRow,
} from "./repository-mappers";
import {
  taskDescriptionAttachmentPredicate,
  validateTaskDescriptionAttachments,
} from "./task-description-attachments";
import { rankBetweenNeighbors, taskGroupValue } from "./task-groups";
import type {
  TaskRecord,
  ReleaseRecord,
  UserRecord,
} from "./types";
import { getD1 } from "@/db";
import {
  isConstraintError,
  moveBatchAssertion,
  touchProjectSyncMarker,
} from "./repository-write-helpers";

const editableTaskPredicate = editableTaskWhere("tasks");

export async function createTask(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const db = getD1();
  const title = requireTitle(input.title);
  const description = optionalText(input.description);
  await validateTaskDescriptionAttachments(null, description);
  if (!input.projectId) throw new ValidationError("Project is required");
  const project = await loadAccessibleProject(
    currentUser.id,
    String(input.projectId),
  );
  requireContentEdit(project.accessRole);
  if (project.status === "canceled") {
    throw new ValidationError("Tasks cannot be created in a canceled project");
  }
  const ownerUserId = project.ownerUserId;
  const status = await loadStatus(
    ownerUserId,
    input.statusId ? String(input.statusId) : null,
  );
  const release = input.releaseId
    ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
    : null;
  if (release) requireContentEdit(release.accessRole);
  assertReleaseProject(project.id, release?.projectId ?? null);
  assertReleasedCompositionChange(null, release, input);
  const assigneeUserId = Object.hasOwn(input, "assigneeUserId")
    ? requestedAssigneeUserId(input.assigneeUserId)
    : currentUser.id;
  await assertTaskAssigneeAccess(
    assigneeUserId,
    ownerUserId,
    project.id,
    null,
  );
  const labelIds = await validateActiveLabelIds(ownerUserId, input.labelIds);

  const sequenceRow = await db
    .prepare(
      `UPDATE projects SET
         task_sequence = MAX(
           task_sequence + 1,
           (SELECT COALESCE(MAX(sequence_number), 0) + 1
            FROM tasks WHERE project_id = projects.id)
         ),
         code_locked_at = COALESCE(code_locked_at, ?)
       WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM (SELECT ? AS id) mutation_actor
           WHERE ${projectEffectiveRoleRankSql(
             "projects",
             "mutation_actor.id",
           )} >= 2
         )
       RETURNING task_sequence AS last_value, task_code`,
    )
    .bind(new Date().toISOString(), project.id, currentUser.id)
    .first<{ last_value: number; task_code: string }>();
  const rankRow = await db
    .prepare(
      "SELECT COALESCE(MAX(rank), 0) + 1000 AS next FROM tasks WHERE owner_user_id = ? AND status_id = ?",
    )
    .bind(ownerUserId, status.id)
    .first<{ next: number }>();
  if (!sequenceRow) throw new Error("Task sequence allocation failed");
  const sequence = sequenceRow.last_value;
  const now = new Date().toISOString();
  const timestamps = statusTimestamps(
    status.category,
    { startedAt: null, completedAt: null, canceledAt: null },
    now,
  );
  const taskId = `task_${crypto.randomUUID()}`;
  const publicId = crypto.randomUUID();
  const activity = activityEventStatement(db, currentUser, {
    taskId,
    eventType: "task_created",
    payload: {
      identifier: `${sequenceRow.task_code}-${sequence}`,
      project: { id: project.id, name: project.name },
      status: { id: status.id, name: status.name },
    },
    createdAt: now,
  });

  await db.batch([
    db.prepare(
      `INSERT INTO tasks (
        id, public_id, owner_user_id, creator_user_id, identifier, sequence_number,
        title, description, status_id, priority, assignee_user_id,
        project_id, release_id, estimate, due_date, rank,
        started_at, completed_at, canceled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      taskId,
      publicId,
      ownerUserId,
      currentUser.id,
      `${sequenceRow.task_code}-${sequence}`,
      sequence,
      title,
      description,
      status.id,
      input.priority ? priority(input.priority) : "none",
      assigneeUserId,
      project.id,
      release?.id ?? null,
      optionalEstimate(input.estimate),
      optionalDate(input.dueDate),
      rankRow?.next ?? 1000,
      timestamps.startedAt,
      timestamps.completedAt,
      timestamps.canceledAt,
      now,
      now,
    ),
    ...labelIds.map((labelId) => db.prepare(
      `INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`,
    ).bind(taskId, labelId)),
    activity.statement,
  ]);
  return { id: taskId, publicId };
}

export async function createSubtask(
  currentUser: UserRecord,
  parentTaskId: string,
  input: Record<string, unknown>,
): Promise<TaskRecord> {
  const parent = await loadAccessibleTask(currentUser.id, parentTaskId);
  requireContentEdit(parent.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== parent.version) {
    throw new ConflictError("Parent Task was changed in another session");
  }
  if (parent.archivedAt) {
    throw new ValidationError("Subtasks cannot be added to an archived Task");
  }

  const project = await loadAccessibleProject(currentUser.id, parent.projectId);
  requireContentEdit(project.accessRole);
  if (project.archivedAt || project.status === "canceled") {
    throw new ValidationError("Subtasks require an active Project");
  }
  const title = requireTitle(input.title);
  const description = optionalText(input.description);
  await validateTaskDescriptionAttachments(null, description);
  const status = await loadStatus(
    parent.ownerUserId,
    input.statusId ? String(input.statusId) : null,
  );
  const release = input.releaseId
    ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
    : null;
  if (release) requireContentEdit(release.accessRole);
  assertReleaseProject(project.id, release?.projectId ?? null);
  assertReleasedCompositionChange(null, release, input);
  const assigneeUserId = Object.hasOwn(input, "assigneeUserId")
    ? requestedAssigneeUserId(input.assigneeUserId)
    : currentUser.id;
  await assertTaskAssigneeAccess(
    assigneeUserId,
    parent.ownerUserId,
    project.id,
    null,
  );
  const labelIds = await validateActiveLabelIds(parent.ownerUserId, input.labelIds);
  const rankRow = await getD1()
    .prepare(
      "SELECT COALESCE(MAX(rank), 0) + 1000 AS next FROM tasks WHERE owner_user_id = ? AND status_id = ?",
    )
    .bind(parent.ownerUserId, status.id)
    .first<{ next: number }>();
  const now = new Date().toISOString();
  const timestamps = statusTimestamps(
    status.category,
    { startedAt: null, completedAt: null, canceledAt: null },
    now,
  );
  const taskId = `task_${crypto.randomUUID()}`;
  const publicId = crypto.randomUUID();
  const assertionId = `subtask_assert_${crypto.randomUUID()}`;
  const db = getD1();
  const activity = activityEventStatement(db, currentUser, {
    taskId,
    eventType: "task_created",
    payload: {
      parentTaskId: parent.id,
      project: { id: project.id, name: project.name },
      status: { id: status.id, name: status.name },
    },
    createdAt: now,
  });

  try {
    const results = await db.batch([
      db.prepare(
        `UPDATE projects SET
           task_sequence = MAX(
             task_sequence + 1,
             (SELECT COALESCE(MAX(sequence_number), 0) + 1
              FROM tasks WHERE project_id = projects.id)
           ),
           code_locked_at = COALESCE(code_locked_at, ?),
           version = version + 1,
           updated_at = ?
         WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL
           AND status <> 'canceled'
           AND EXISTS (
             SELECT 1 FROM tasks parent
             WHERE parent.id = ? AND parent.project_id = projects.id
               AND parent.version = ? AND parent.archived_at IS NULL
               AND parent.deleted_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM (SELECT ? AS id) mutation_actor
             WHERE ${projectEffectiveRoleRankSql(
               "projects",
               "mutation_actor.id",
             )} >= 2
           )`,
      ).bind(
        now,
        now,
        project.id,
        parent.id,
        expectedVersion,
        currentUser.id,
      ),
      moveBatchAssertion(db, assertionId, "allocator"),
      db.prepare(
        `INSERT INTO tasks (
           id, public_id, owner_user_id, creator_user_id, identifier,
           sequence_number, title, description, status_id, priority,
           assignee_user_id, project_id, release_id, estimate, due_date,
           parent_task_id, rank, started_at, completed_at, canceled_at,
           created_at, updated_at
         )
         SELECT ?, ?, p.owner_user_id, ?, p.task_code || '-' || p.task_sequence,
           p.task_sequence, ?, ?, ?, ?, ?, p.id, ?, ?, ?, parent.id, ?, ?, ?, ?, ?, ?
         FROM projects p JOIN tasks parent ON parent.project_id = p.id
         WHERE p.id = ? AND parent.id = ? AND parent.version = ?
           AND parent.archived_at IS NULL AND p.archived_at IS NULL
           AND parent.deleted_at IS NULL AND p.deleted_at IS NULL
           AND p.status <> 'canceled'
           AND EXISTS (
             SELECT 1 FROM (SELECT ? AS id) mutation_actor
             WHERE ${projectEffectiveRoleRankSql("p", "mutation_actor.id")} >= 2
           )`,
      ).bind(
        taskId,
        publicId,
        currentUser.id,
        title,
        description,
        status.id,
        input.priority ? priority(input.priority) : "none",
        assigneeUserId,
        release?.id ?? null,
        optionalEstimate(input.estimate),
        optionalDate(input.dueDate),
        rankRow?.next ?? 1000,
        timestamps.startedAt,
        timestamps.completedAt,
        timestamps.canceledAt,
        now,
        now,
        project.id,
        parent.id,
        expectedVersion,
        currentUser.id,
      ),
      moveBatchAssertion(db, `${assertionId}_task`, "task"),
      db.prepare(
        `UPDATE tasks SET version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND project_id = ?
           AND ${editableTaskPredicate}`,
      ).bind(
        now,
        parent.id,
        expectedVersion,
        project.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
      ),
      moveBatchAssertion(db, `${assertionId}_parent`, "parent"),
      ...labelIds.map((labelId) => db.prepare(
        `INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`,
      ).bind(taskId, labelId)),
      activity.statement,
    ]);
    if (
      (results[0]?.meta.changes ?? 0) < 1 ||
      (results[2]?.meta.changes ?? 0) < 1 ||
      (results[4]?.meta.changes ?? 0) < 1
    ) {
      throw new ConflictError("Subtask could not be created atomically");
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    if (isConstraintError(error)) {
      throw new ConflictError(
        "Parent Task, Project access, or Project sequence changed before the subtask committed",
      );
    }
    throw error;
  }

  return loadAccessibleTask(currentUser.id, taskId);
}

export async function setTaskParent(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
): Promise<TaskRecord> {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  requireContentEdit(task.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== task.version) {
    throw new ConflictError("Task was changed in another session");
  }
  const parentTaskId = input.parentTaskId == null
    ? null
    : String(input.parentTaskId);
  if (parentTaskId === task.id) {
    throw new ValidationError("A Task cannot be its own parent");
  }
  const storedParentTaskId = internalTaskParentId(task);
  if (parentTaskId === storedParentTaskId) return task;

  if (parentTaskId) {
    const parent = await loadAccessibleTask(currentUser.id, parentTaskId);
    requireContentEdit(parent.accessRole);
    if (parent.projectId !== task.projectId) {
      throw new ValidationError("Parent and subtask must belong to the same Project");
    }
    if (parent.archivedAt) {
      throw new ValidationError("An archived Task cannot become a new parent");
    }
    const cycle = await getD1().prepare(
      `WITH RECURSIVE ancestors(id, parent_task_id) AS (
         SELECT id, parent_task_id FROM tasks WHERE id = ?
         UNION ALL
         SELECT parent.id, parent.parent_task_id
         FROM tasks parent JOIN ancestors child ON parent.id = child.parent_task_id
       )
       SELECT 1 AS found FROM ancestors WHERE id = ? LIMIT 1`,
    ).bind(parentTaskId, task.id).first<{ found: number }>();
    if (cycle) throw new ValidationError("Task hierarchy cannot contain a cycle");
  }

  const now = new Date().toISOString();
  const oldParentTaskId = storedParentTaskId;
  const db = getD1();
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: "hierarchy_changed",
    payload: {
      changes: {
        // Keep a deleted parent opaque in ordinary child Activity while the
        // guarded mutation still compares the stored internal edge below.
        parentTaskId: { before: task.parentTaskId, after: parentTaskId },
      },
    },
    createdAt: now,
  });
  const parentGuard = parentTaskId
    ? `EXISTS (
         SELECT 1 FROM tasks parent
         WHERE parent.id = ? AND parent.id <> tasks.id
           AND parent.project_id = tasks.project_id
           AND parent.archived_at IS NULL
       ) AND NOT EXISTS (
         WITH RECURSIVE ancestors(id, parent_task_id) AS (
           SELECT id, parent_task_id FROM tasks WHERE id = ?
           UNION ALL
           SELECT parent.id, parent.parent_task_id
           FROM tasks parent JOIN ancestors child
             ON parent.id = child.parent_task_id
         )
         SELECT 1 FROM ancestors WHERE id = tasks.id
       )`
    : "1 = 1";
  const parentBindings = parentTaskId ? [parentTaskId, parentTaskId] : [];
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
      `UPDATE tasks SET parent_task_id = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND project_id IS NOT NULL
         AND ${parentGuard} AND ${editableTaskPredicate}`,
    ).bind(
      parentTaskId,
      now,
      task.id,
      expectedVersion,
      ...parentBindings,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    ),
    activityBatchAssertion(
      db,
      `activity_assert_${crypto.randomUUID()}`,
      now,
    ),
    activity.statement,
    db.prepare(
      `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
       SELECT ?, 'task_detail'
       WHERE ? IS NOT NULL AND EXISTS (
         SELECT 1 FROM tasks child
         WHERE child.id = ? AND child.version = ? AND child.parent_task_id IS ?
       )`,
    ).bind(
      oldParentTaskId,
      oldParentTaskId,
      task.id,
      expectedVersion + 1,
      parentTaskId,
    ),
    db.prepare(
      `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
       SELECT ?, 'task_detail'
       WHERE ? IS NOT NULL AND ? IS NOT ? AND EXISTS (
         SELECT 1 FROM tasks child
         WHERE child.id = ? AND child.version = ? AND child.parent_task_id IS ?
       )`,
    ).bind(
      parentTaskId,
      parentTaskId,
      parentTaskId,
      oldParentTaskId,
      task.id,
      expectedVersion + 1,
      parentTaskId,
      ),
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError(
        "Task hierarchy, Project access, or Task version changed before the update committed",
      );
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new ConflictError(
      "Task hierarchy, Project access, or Task version changed before the update committed",
    );
  }
  return loadAccessibleTask(currentUser.id, task.id, true);
}

export async function updateTask(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  requireContentEdit(task.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== task.version) {
    throw new ConflictError("Task was changed in another session");
  }

  let projectId = task.projectId;
  if (Object.hasOwn(input, "projectId")) {
    if (!input.projectId) throw new ValidationError("Project cannot be cleared");
    const targetProject = await loadAccessibleProject(
      currentUser.id,
      String(input.projectId),
    );
    requireContentEdit(targetProject.accessRole);
    if (targetProject.id !== task.projectId) {
      throw new ValidationError("Use the explicit Task move command to change Project");
    }
    projectId = targetProject.id;
  }

  const storedReleaseId = internalTaskReleaseId(task);
  let releaseId = storedReleaseId;
  let selectedRelease: ReleaseRecord | null = null;
  if (Object.hasOwn(input, "releaseId")) {
    selectedRelease = input.releaseId
      ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
      : null;
    if (selectedRelease) requireContentEdit(selectedRelease.accessRole);
    assertReleaseProject(projectId, selectedRelease?.projectId ?? null);
    const currentRelease = storedReleaseId
      ? await loadAccessibleStoredRelease(currentUser.id, storedReleaseId)
      : null;
    assertReleasedCompositionChange(currentRelease, selectedRelease, input);
    releaseId = selectedRelease?.id ?? null;
  }

  const assigneeUserId = Object.hasOwn(input, "assigneeUserId")
    ? requestedAssigneeUserId(input.assigneeUserId)
    : task.assigneeUserId;
  await assertTaskAssigneeAccess(
    assigneeUserId,
    task.ownerUserId,
    projectId,
    task.id,
  );

  const status = Object.hasOwn(input, "statusId")
    ? await loadStatus(task.ownerUserId, String(input.statusId))
    : await loadStatus(task.ownerUserId, task.statusId, { allowArchived: true });
  const previousStatus = status.id === task.statusId
    ? status
    : await loadStatus(task.ownerUserId, task.statusId, { allowArchived: true });
  const now = new Date().toISOString();
  const timestamps = statusTimestamps(status.category, task, now);
  const title = Object.hasOwn(input, "title")
    ? requireTitle(input.title)
    : task.title;
  const descriptionChanged = Object.hasOwn(input, "description");
  const description = descriptionChanged
    ? optionalText(input.description)
    : task.description ?? "";
  const descriptionRefs = descriptionChanged
    ? await validateTaskDescriptionAttachments(task.id, description)
    : [];
  const descriptionPredicate = taskDescriptionAttachmentPredicate(descriptionRefs);
  const nextPriority = Object.hasOwn(input, "priority")
    ? priority(input.priority)
    : task.priority;
  const dueDate = Object.hasOwn(input, "dueDate")
    ? optionalDate(input.dueDate)
    : task.dueDate;
  const estimate = Object.hasOwn(input, "estimate")
    ? optionalEstimate(input.estimate)
    : task.estimate;
  const archivedAt = Object.hasOwn(input, "archived")
    ? input.archived
      ? now
      : null
    : task.archivedAt;
  const rank = Object.hasOwn(input, "rank")
    ? finiteNumber(input.rank, "Rank")
    : task.rank;

  const changes = changedFields([
    ["title", task.title, title],
    ["description", task.description ?? "", description],
    ["status", { id: task.statusId, name: previousStatus.name }, { id: status.id, name: status.name }],
    ["priority", task.priority, nextPriority],
    ["assigneeUserId", task.assigneeUserId, assigneeUserId],
    ["projectId", task.projectId, projectId],
    ["releaseId", storedReleaseId, releaseId],
    ["estimate", task.estimate, estimate],
    ["dueDate", task.dueDate, dueDate],
    ["rank", task.rank, rank],
    ["archivedAt", task.archivedAt, archivedAt],
  ]);
  if (
    storedReleaseId !== task.releaseId &&
    Object.hasOwn(changes, "releaseId")
  ) {
    // The recoverably deleted Release stays opaque in ordinary Task Activity.
    changes.releaseId = { before: task.releaseId, after: releaseId };
  }
  if (Object.keys(changes).length === 0) return task;
  if (Object.hasOwn(changes, "description")) {
    changes.description = {
      before: task.description ? "Set" : "Empty",
      after: description ? "Set" : "Empty",
    };
  }
  const eventType = Object.hasOwn(changes, "archivedAt")
    ? archivedAt ? "task_archived" : "task_restored"
    : Object.keys(changes).length === 1 && Object.hasOwn(changes, "status")
      ? "status_changed"
      : "task_updated";
  const db = getD1();
  const activity = activityEventStatement(db, currentUser, {
    taskId,
    eventType,
    payload: { changes },
    createdAt: now,
  });

  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
      `UPDATE tasks SET
        title = ?, description = ?, status_id = ?, priority = ?,
        assignee_user_id = ?, project_id = ?, release_id = ?, estimate = ?, due_date = ?, rank = ?,
        started_at = ?, completed_at = ?, canceled_at = ?, archived_at = ?,
        version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?${descriptionPredicate.sql}
         AND ${editableTaskPredicate}
       AND (
         ? = 1 OR release_id IS ? OR NOT EXISTS (
           SELECT 1 FROM releases locked_release
           WHERE locked_release.id IN (tasks.release_id, ?)
             AND locked_release.deleted_at IS NULL
             AND locked_release.status = 'released'
         )
       )`,
      ).bind(
      title,
      description,
      status.id,
      nextPriority,
      assigneeUserId,
      projectId,
      releaseId,
      estimate,
      dueDate,
      rank,
      timestamps.startedAt,
      timestamps.completedAt,
      timestamps.canceledAt,
      archivedAt,
      now,
      taskId,
      expectedVersion,
      ...descriptionPredicate.bindings,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      input.confirmReleasedComposition === true ? 1 : 0,
      releaseId,
      releaseId,
      ),
      activityBatchAssertion(
        db,
        `activity_assert_${crypto.randomUUID()}`,
        now,
      ),
      activity.statement,
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("Task was changed in another session");
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new ConflictError("Task was changed in another session");
  }
  return loadAccessibleTask(currentUser.id, taskId, true);
}

export async function reorderTask(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  requireContentEdit(task.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== task.version) {
    throw new ConflictError("Task was changed in another session");
  }
  const groupBy = reorderGroupBy(input.groupBy);
  if (!Object.hasOwn(input, "expectedGroupValue") || !Object.hasOwn(input, "targetGroupValue")) {
    throw new ValidationError("Expected and target Task groups are required");
  }
  const expectedGroupValue = reorderGroupValue(groupBy, input.expectedGroupValue);
  const targetGroupValue = reorderGroupValue(groupBy, input.targetGroupValue);
  if (taskGroupValue(task, groupBy) !== expectedGroupValue) {
    throw new ConflictError("Task no longer belongs to the expected group");
  }
  if (groupBy === "project" && targetGroupValue !== task.projectId) {
    throw new ValidationError("Use the explicit Task move command to change Project");
  }

  let statusId = task.statusId;
  let nextPriority = task.priority;
  let assigneeUserId = task.assigneeUserId;
  const storedReleaseId = internalTaskReleaseId(task);
  let releaseId = storedReleaseId;
  let selectedRelease: ReleaseRecord | null = null;
  if (groupBy === "status") {
    statusId = targetGroupValue!;
    await loadStatus(task.ownerUserId, statusId);
  } else if (groupBy === "priority") {
    nextPriority = priority(targetGroupValue);
  } else if (groupBy === "assignee") {
    assigneeUserId = targetGroupValue;
    await assertTaskAssigneeAccess(assigneeUserId, task.ownerUserId, task.projectId, task.id);
  } else if (groupBy === "release") {
    if (targetGroupValue !== task.releaseId) {
      const currentRelease = storedReleaseId
        ? await loadAccessibleStoredRelease(currentUser.id, storedReleaseId)
        : null;
      selectedRelease = targetGroupValue
        ? await loadAccessibleRelease(currentUser.id, targetGroupValue)
        : null;
      if (selectedRelease) requireContentEdit(selectedRelease.accessRole);
      assertReleaseProject(task.projectId, selectedRelease?.projectId ?? null);
      assertReleasedCompositionChange(currentRelease, selectedRelease, input);
      releaseId = selectedRelease?.id ?? null;
    }
  }

  const previousTaskId = optionalTaskNeighbor(input.previousTaskId);
  const nextTaskId = optionalTaskNeighbor(input.nextTaskId);
  if (previousTaskId === task.id || nextTaskId === task.id || previousTaskId === nextTaskId && previousTaskId !== null) {
    throw new ValidationError("Task reorder neighbors are invalid");
  }
  const previousTask = previousTaskId
    ? await loadAccessibleTask(currentUser.id, previousTaskId)
    : null;
  const nextTask = nextTaskId
    ? await loadAccessibleTask(currentUser.id, nextTaskId)
    : null;
  for (const neighbor of [previousTask, nextTask]) {
    if (neighbor && taskGroupValue(neighbor, groupBy) !== targetGroupValue) {
      throw new ConflictError("Task reorder neighbor changed groups");
    }
  }

  const db = getD1();
  let previousRank = previousTask?.rank ?? null;
  let nextRank = nextTask?.rank ?? null;
  if (!previousTask && !nextTask) {
    const targetGroup = taskGroupSql("candidate", groupBy, targetGroupValue);
    const row = await db.prepare(
      `SELECT MAX(candidate.rank) AS last_rank FROM tasks candidate
       WHERE candidate.id <> ? AND ${targetGroup.sql}
         AND ${accessibleTaskWhere("candidate")}`,
    ).bind(
      task.id,
      ...targetGroup.bindings,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    ).first<{ last_rank: number | null }>();
    previousRank = row?.last_rank === null || row?.last_rank === undefined
      ? null
      : Number(row.last_rank);
    nextRank = null;
  }
  let rank: number;
  try {
    rank = rankBetweenNeighbors(previousRank, nextRank);
  } catch (error) {
    throw new ConflictError(error instanceof Error ? error.message : "Task rank could not be allocated");
  }

  const expectedGroup = taskGroupSql("tasks", groupBy, expectedGroupValue);
  const targetRankGroup = taskGroupSql("ranked", groupBy, targetGroupValue);
  const neighborGuards: string[] = [];
  const neighborBindings: unknown[] = [];
  for (const [alias, neighbor] of [["previous_neighbor", previousTask], ["next_neighbor", nextTask]] as const) {
    if (!neighbor) continue;
    const neighborGroup = taskGroupSql(alias, groupBy, targetGroupValue);
    neighborGuards.push(
      `EXISTS (SELECT 1 FROM tasks ${alias}
       WHERE ${alias}.id = ? AND ${alias}.rank = ? AND ${neighborGroup.sql}
         AND ${accessibleTaskWhere(alias)})`,
    );
    neighborBindings.push(
      neighbor.id,
      neighbor.rank,
      ...neighborGroup.bindings,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    );
  }
  const now = new Date().toISOString();
  const targetStatus = await loadStatus(task.ownerUserId, statusId, { allowArchived: true });
  const timestamps = statusTimestamps(targetStatus.category, task, now);
  const changes = changedFields([
    ["status", task.statusId, statusId],
    ["priority", task.priority, nextPriority],
    ["assigneeUserId", task.assigneeUserId, assigneeUserId],
    ["releaseId", storedReleaseId, releaseId],
    ["rank", task.rank, rank],
  ]);
  if (
    storedReleaseId !== task.releaseId &&
    Object.hasOwn(changes, "releaseId")
  ) {
    // A hidden Release may protect composition without becoming visible again.
    changes.releaseId = { before: task.releaseId, after: releaseId };
  }
  if (!Object.keys(changes).length) return task;
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: statusId !== task.statusId ? "status_changed" : "task_updated",
    payload: { changes, reorder: true },
    createdAt: now,
  });
  const guardSql = neighborGuards.length ? ` AND ${neighborGuards.join(" AND ")}` : "";
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `UPDATE tasks SET status_id = ?, priority = ?, assignee_user_id = ?,
           release_id = ?, rank = ?, started_at = ?, completed_at = ?, canceled_at = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND ${expectedGroup.sql}
           AND ${editableTaskPredicate}${guardSql}
           AND NOT EXISTS (
             SELECT 1 FROM tasks ranked
             WHERE ranked.id <> tasks.id AND ranked.rank = ?
               AND ${targetRankGroup.sql}
               AND ${accessibleTaskWhere("ranked")}
           )
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM users assignee
             LEFT JOIN projects assignment_project
               ON assignment_project.id = tasks.project_id
             WHERE assignee.id = ?
               AND ${taskEffectiveRoleRankSql(
                 "tasks",
                 "assignment_project",
                 "assignee.id",
               )} > 0
           ))
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM releases selected_release
             WHERE selected_release.id = ?
               AND selected_release.project_id = tasks.project_id
               AND selected_release.deleted_at IS NULL
           ))
           AND (? = 1 OR release_id IS ? OR NOT EXISTS (
             SELECT 1 FROM releases locked_release
             WHERE locked_release.id IN (tasks.release_id, ?)
               AND locked_release.deleted_at IS NULL
               AND locked_release.status = 'released'
           ))`,
      ).bind(
        statusId,
        nextPriority,
        assigneeUserId,
        releaseId,
        rank,
        timestamps.startedAt,
        timestamps.completedAt,
        timestamps.canceledAt,
        now,
        task.id,
        expectedVersion,
        ...expectedGroup.bindings,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        ...neighborBindings,
        rank,
        ...targetRankGroup.bindings,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        assigneeUserId,
        assigneeUserId,
        selectedRelease?.id ?? null,
        selectedRelease?.id ?? null,
        input.confirmReleasedComposition === true ? 1 : 0,
        releaseId,
        releaseId,
      ),
      activityBatchAssertion(db, `reorder_assert_${crypto.randomUUID()}`, now),
      activity.statement,
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("Task order changed concurrently; reload and retry");
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new ConflictError("Task order changed concurrently; reload and retry");
  }
  return loadAccessibleTask(currentUser.id, task.id, true);
}

function reorderGroupBy(value: unknown): "none" | "status" | "priority" | "assignee" | "project" | "release" {
  if (value === "none" || value === "status" || value === "priority" || value === "assignee" || value === "project" || value === "release") return value;
  throw new ValidationError("Task reorder group is invalid");
}

function reorderGroupValue(
  groupBy: "none" | "status" | "priority" | "assignee" | "project" | "release",
  value: unknown,
): string | null {
  if (groupBy === "none") {
    if (value !== null) throw new ValidationError("Ungrouped Task reorder value must be null");
    return null;
  }
  if ((groupBy === "assignee" || groupBy === "release") && value === null) return null;
  if (typeof value !== "string" || !value || value.length > 240) {
    throw new ValidationError("Task reorder group value is invalid");
  }
  return value;
}

function optionalTaskNeighbor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value || value.length > 240) {
    throw new ValidationError("Task reorder neighbor is invalid");
  }
  return value;
}

function taskGroupSql(
  alias: string,
  groupBy: "none" | "status" | "priority" | "assignee" | "project" | "release",
  value: string | null,
): { sql: string; bindings: unknown[] } {
  if (groupBy === "none") return { sql: "1 = 1", bindings: [] };
  if (groupBy === "release") {
    const activeRelease = `${alias}_active_release`;
    return value === null
      ? {
          sql: `(${alias}.release_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM releases ${activeRelease}
            WHERE ${activeRelease}.id = ${alias}.release_id
              AND ${activeRelease}.deleted_at IS NULL
          ))`,
          bindings: [],
        }
      : {
          sql: `(${alias}.release_id = ? AND EXISTS (
            SELECT 1 FROM releases ${activeRelease}
            WHERE ${activeRelease}.id = ${alias}.release_id
              AND ${activeRelease}.deleted_at IS NULL
          ))`,
          bindings: [value],
        };
  }
  const column = {
    status: "status_id",
    priority: "priority",
    assignee: "assignee_user_id",
    project: "project_id",
  }[groupBy];
  return value === null
    ? { sql: `${alias}.${column} IS NULL`, bindings: [] }
    : { sql: `${alias}.${column} = ?`, bindings: [value] };
}

export async function moveTask(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  requireContentEdit(task.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== task.version) {
    throw new ConflictError("Task was changed in another session");
  }
  if (!input.targetProjectId) {
    throw new ValidationError("Target Project is required");
  }

  const sourceProject = await loadAccessibleProject(currentUser.id, task.projectId);
  requireContentEdit(sourceProject.accessRole);
  const targetProject = await loadAccessibleProject(
    currentUser.id,
    String(input.targetProjectId),
  );
  requireContentEdit(targetProject.accessRole);
  if (targetProject.id === sourceProject.id) return task;
  if (targetProject.archivedAt) {
    throw new ValidationError("Tasks cannot be moved to an archived Project");
  }
  if (targetProject.status === "canceled") {
    throw new ValidationError("Tasks cannot be moved to a canceled Project");
  }

  const storedReleaseId = internalTaskReleaseId(task);
  const currentRelease = storedReleaseId
    ? await loadAccessibleStoredRelease(currentUser.id, storedReleaseId)
    : null;
  let releaseId: string | null;
  let selectedRelease: ReleaseRecord | null = null;
  if (Object.hasOwn(input, "releaseId")) {
    selectedRelease = input.releaseId
      ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
      : null;
    if (selectedRelease) requireContentEdit(selectedRelease.accessRole);
    assertReleaseProject(targetProject.id, selectedRelease?.projectId ?? null);
    releaseId = selectedRelease?.id ?? null;
  } else if (storedReleaseId) {
    throw new ValidationError(
      "Choose a Release in the target Project or explicitly clear the current Release",
    );
  } else {
    releaseId = null;
  }
  assertReleasedCompositionChange(currentRelease, selectedRelease, input);

  const assigneeUserId = Object.hasOwn(input, "assigneeUserId")
    ? requestedAssigneeUserId(input.assigneeUserId)
    : task.assigneeUserId;
  try {
    await assertTaskAssigneeAccess(
      assigneeUserId,
      task.ownerUserId,
      targetProject.id,
      task.id,
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(
        "Choose an assignee with access to the target Project or explicitly clear the assignee",
      );
    }
    throw error;
  }

  const hierarchy = await getD1()
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM tasks child WHERE child.parent_task_id = ?) AS has_children`,
    )
    .bind(task.id)
    .first<{ has_children: number }>();
  if (internalTaskParentId(task) || Number(hierarchy?.has_children ?? 0) === 1) {
    throw new ValidationError(
      "Detach or reparent this Task hierarchy before moving it to another Project",
    );
  }
  const relation = await getD1()
    .prepare(
      `SELECT 1 AS related FROM task_relations
       WHERE type = 'duplicate_of'
         AND (source_task_id = ? OR target_task_id = ?) LIMIT 1`,
    )
    .bind(task.id, task.id)
    .first<{ related: number }>();
  if (relation) {
    throw new ValidationError(
      "Unlink the duplicate relation before moving this Task to another Project",
    );
  }

  const now = new Date().toISOString();
  const db = getD1();
  const guardSql = `
    SELECT 1
    FROM tasks moving
    JOIN projects source ON source.id = moving.project_id
    JOIN projects target ON target.id = ?
    CROSS JOIN (SELECT ? AS id) mutation_actor
    WHERE moving.id = ? AND moving.version = ? AND moving.project_id = ?
      AND moving.deleted_at IS NULL
      AND source.deleted_at IS NULL AND target.deleted_at IS NULL
      AND target.archived_at IS NULL AND target.status <> 'canceled'
      AND ${taskEffectiveRoleRankSql(
        "moving",
        "source",
        "mutation_actor.id",
      )} >= 2
      AND ${projectEffectiveRoleRankSql("target", "mutation_actor.id")} >= 2
      AND moving.parent_task_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM tasks child WHERE child.parent_task_id = moving.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_relations relation
        WHERE relation.type = 'duplicate_of'
          AND (relation.source_task_id = moving.id
            OR relation.target_task_id = moving.id)
      )
      AND (
        ? IS NULL OR EXISTS (
          SELECT 1 FROM releases selected_release
          WHERE selected_release.id = ?
            AND selected_release.project_id = target.id
            AND selected_release.deleted_at IS NULL
        )
      )
      AND (
        ? IS NULL OR EXISTS (
          SELECT 1 FROM users assignee
          WHERE assignee.id = ? AND (
            ${projectEffectiveRoleRankSql("target", "assignee.id")} > 0
            OR EXISTS (
              SELECT 1 FROM team_grants explicit_task_grant
              JOIN teams explicit_task_team
                ON explicit_task_team.id = explicit_task_grant.team_id
                AND explicit_task_team.archived_at IS NULL
              JOIN team_memberships explicit_task_member
                ON explicit_task_member.team_id = explicit_task_team.id
                AND explicit_task_member.user_id = assignee.id
                AND explicit_task_member.status = 'active'
                AND explicit_task_member.deactivated_at IS NULL
              WHERE explicit_task_grant.resource_type = 'task'
                AND explicit_task_grant.resource_id = moving.id
                AND explicit_task_grant.revoked_at IS NULL
            )
          )
        )
      )
      AND (
        ? = 1 OR NOT EXISTS (
          SELECT 1 FROM releases locked_release
          WHERE locked_release.id IN (moving.release_id, ?)
            AND locked_release.deleted_at IS NULL
            AND locked_release.status = 'released'
        )
      )`;
  const guardBindings = [
    targetProject.id,
    currentUser.id,
    task.id,
    expectedVersion,
    sourceProject.id,
    releaseId,
    releaseId,
    assigneeUserId,
    assigneeUserId,
    input.confirmReleasedComposition === true ? 1 : 0,
    releaseId,
  ];
  const assertionId = `move_assert_${crypto.randomUUID()}`;
  const aliasId = `alias_${crypto.randomUUID()}`;
  const activityId = newActivityId();
  const activityInsert = db.prepare(
    `INSERT INTO activity_events
      (id, task_id, schema_version, event_type, actor_kind, actor_user_id,
       actor_name, payload_json, source, created_at)
     SELECT ?, moved.id, 1, 'task_moved', 'user', ?, ?,
       json_object('changes', json_object(
         'project', json_object(
           'before', json_object('id', ?, 'name', ?),
           'after', json_object('id', ?, 'name', ?)
         ),
         'identifier', json_object('before', ?, 'after', moved.identifier),
         'releaseId', json_object('before', ?, 'after', moved.release_id),
         'assigneeUserId', json_object('before', ?, 'after', moved.assignee_user_id)
       )),
       'native', ?
     FROM tasks moved WHERE moved.id = ? AND moved.version = ?`,
  ).bind(
    activityId,
    currentUser.id,
    currentUser.displayName,
    sourceProject.id,
    sourceProject.name,
    targetProject.id,
    targetProject.name,
    task.identifier,
    task.releaseId,
    task.assigneeUserId,
    now,
    task.id,
    expectedVersion + 1,
  );

  try {
    const results = await db.batch([
      db
        .prepare(
          `WITH move_guard AS (${guardSql})
           UPDATE projects SET
             task_sequence = MAX(
               task_sequence + 1,
               (SELECT COALESCE(MAX(sequence_number), 0) + 1
                FROM tasks WHERE project_id = projects.id)
             ),
             code_locked_at = COALESCE(code_locked_at, ?),
             version = version + 1,
             updated_at = ?
           WHERE id = ? AND EXISTS (SELECT 1 FROM move_guard)`,
        )
        .bind(...guardBindings, now, now, targetProject.id),
      moveBatchAssertion(db, assertionId, "allocator"),
      db
        .prepare(
          `WITH move_guard AS (${guardSql})
           UPDATE tasks SET
             project_id = ?,
             sequence_number = (
               SELECT task_sequence FROM projects WHERE id = ?
             ),
             identifier = (
               SELECT task_code || '-' || task_sequence
               FROM projects WHERE id = ?
             ),
             release_id = ?,
             assignee_user_id = ?,
             version = version + 1,
             updated_at = ?
           WHERE id = ? AND version = ?
             AND EXISTS (SELECT 1 FROM move_guard)`,
        )
        .bind(
          ...guardBindings,
          targetProject.id,
          targetProject.id,
          targetProject.id,
          releaseId,
          assigneeUserId,
          now,
          task.id,
          expectedVersion,
        ),
      moveBatchAssertion(db, `${assertionId}_task`, "task"),
      touchProjectSyncMarker(db, sourceProject.id, now),
      moveBatchAssertion(db, `${assertionId}_source`, "source-project"),
      db
        .prepare(
          `INSERT OR IGNORE INTO task_identifier_aliases
             (id, task_id, identifier, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(aliasId, task.id, task.identifier, now),
      activityInsert,
      invalidateTaskRelationDetails(db, task.id),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) < 1 ||
      (results[2]?.meta.changes ?? 0) < 1
    ) {
      throw new ConflictError("Task move could not be committed atomically");
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    if (isConstraintError(error)) {
      throw new ConflictError(
        "Task, Project access, or target sequence changed before the move committed",
      );
    }
    throw error;
  }

  return loadAccessibleTask(currentUser.id, task.id);
}

function invalidateTaskRelationDetails(db: D1Database, taskId: string) {
  return db.prepare(
    `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
     SELECT affected.task_id, 'task_detail'
     FROM (
       SELECT ? AS task_id
       UNION
       SELECT CASE
         WHEN relation.source_task_id = ? THEN relation.target_task_id
         ELSE relation.source_task_id
       END AS task_id
       FROM task_relations relation
       WHERE relation.source_task_id = ? OR relation.target_task_id = ?
     ) affected`,
  ).bind(taskId, taskId, taskId, taskId);
}

export async function bulkMoveTasks(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : [];
  if (ids.length === 0 || ids.length > 100) {
    throw new ValidationError("Select between 1 and 100 tasks");
  }
  if (!input.targetProjectId) {
    throw new ValidationError("Target Project is required");
  }
  const tasks = await loadAccessibleTasks(currentUser.id, ids);
  tasks.forEach((task) => requireContentEdit(task.accessRole));
  const versionInput = input.versions;
  if (!versionInput || typeof versionInput !== "object" || Array.isArray(versionInput)) {
    throw new ValidationError("Expected task versions are required");
  }
  const versions = versionInput as Record<string, unknown>;
  const expectedVersions = new Map<string, number>();
  tasks.forEach((task, index) => {
    const address = ids[index]!;
    const expected = Number(versions[address] ?? versions[task.id] ?? versions[task.publicId]);
    if (!Number.isInteger(expected) || expected !== task.version) {
      throw new ConflictError("One or more tasks changed in another session");
    }
    expectedVersions.set(task.id, expected);
  });

  const targetProject = await loadAccessibleProject(
    currentUser.id,
    String(input.targetProjectId),
  );
  requireContentEdit(targetProject.accessRole);
  if (targetProject.archivedAt || targetProject.status === "canceled") {
    throw new ValidationError("Tasks cannot be moved to this Project");
  }
  const movingTasks = tasks.filter((task) => task.projectId !== targetProject.id);
  if (!movingTasks.length) return tasks;
  if (movingTasks.some((task) => task.archivedAt)) {
    throw new ValidationError("Restore archived Tasks before moving them");
  }
  for (const sourceProjectId of new Set(movingTasks.map((task) => task.projectId))) {
    if (!sourceProjectId) throw new ValidationError("Every moved Task must have a Project");
    const sourceProject = await loadAccessibleProject(currentUser.id, sourceProjectId);
    requireContentEdit(sourceProject.accessRole);
  }

  const db = getD1();
  const placeholders = movingTasks.map(() => "?").join(", ");
  const hierarchy = await db.prepare(
    `SELECT id FROM tasks
     WHERE id IN (${placeholders}) AND (
       parent_task_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM tasks child WHERE child.parent_task_id = tasks.id
       )
     ) LIMIT 1`,
  ).bind(...movingTasks.map((task) => task.id)).first<DbRow>();
  if (hierarchy) {
    throw new ValidationError("Detach or reparent selected Task hierarchies before moving them");
  }
  const relation = await db.prepare(
    `SELECT 1 AS related FROM task_relations
     WHERE type = 'duplicate_of'
       AND (source_task_id IN (${placeholders})
         OR target_task_id IN (${placeholders}))
       AND NOT (
         source_task_id IN (${placeholders})
         AND target_task_id IN (${placeholders})
       )
     LIMIT 1`,
  ).bind(
    ...movingTasks.map((task) => task.id),
    ...movingTasks.map((task) => task.id),
    ...movingTasks.map((task) => task.id),
    ...movingTasks.map((task) => task.id),
  ).first<{ related: number }>();
  if (relation) {
    throw new ValidationError(
      "Move both duplicate relation endpoints together or unlink the relation first",
    );
  }

  const clearRelease = input.clearRelease === true;
  if (movingTasks.some((task) => internalTaskReleaseId(task)) && !clearRelease) {
    throw new ValidationError("Confirm clearing incompatible Releases before moving Tasks");
  }
  const currentReleases = await Promise.all(
    [...new Set(movingTasks.map(internalTaskReleaseId).filter((id): id is string => Boolean(id)))]
      .map((releaseId) => loadAccessibleStoredRelease(currentUser.id, releaseId)),
  );
  if (
    currentReleases.some((release) => release.status === "released") &&
    input.confirmReleasedComposition !== true
  ) {
    throw new ValidationError("Confirm changing the composition of a released Release");
  }

  const clearAssignee = input.clearAssignee === true;
  const nextAssignees = new Map<string, string | null>();
  for (const task of movingTasks) {
    let nextAssignee = task.assigneeUserId;
    try {
      await assertTaskAssigneeAccess(
        nextAssignee,
        task.ownerUserId,
        targetProject.id,
        task.id,
      );
    } catch (error) {
      if (!(error instanceof ValidationError) || !clearAssignee) throw new ValidationError(
        "Confirm clearing assignees without access to the target Project",
      );
      nextAssignee = null;
    }
    nextAssignees.set(task.id, nextAssignee);
  }

  const allocation = await db.prepare(
    `SELECT MAX(
       p.task_sequence,
       COALESCE((SELECT MAX(t.sequence_number) FROM tasks t WHERE t.project_id = p.id), 0)
     ) AS base_sequence
     FROM projects p WHERE p.id = ?`,
  ).bind(targetProject.id).first<{ base_sequence: number }>();
  const allocationBase = Number(allocation?.base_sequence ?? targetProject.taskSequence);
  const nextSequence = allocationBase + movingTasks.length;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const mutationIndexes: number[] = [];
  statements.push(
    db.prepare(
      `UPDATE projects SET task_sequence = ?, code_locked_at = COALESCE(code_locked_at, ?),
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND task_sequence = ?
         AND archived_at IS NULL AND deleted_at IS NULL
         AND status <> 'canceled' AND EXISTS (
           SELECT 1 FROM (SELECT ? AS id) mutation_actor
           WHERE ${projectEffectiveRoleRankSql(
             "projects",
             "mutation_actor.id",
           )} >= 2
         )`,
    ).bind(
      nextSequence,
      now,
      now,
      targetProject.id,
      targetProject.version,
      targetProject.taskSequence,
      currentUser.id,
    ),
    moveBatchAssertion(db, `bulk_move_allocator_${crypto.randomUUID()}`, "allocator"),
  );

  movingTasks.forEach((task, index) => {
    const sequenceNumber = allocationBase + index + 1;
    const identifier = `${targetProject.taskCode}-${sequenceNumber}`;
    const assigneeUserId = nextAssignees.get(task.id) ?? null;
    const expectedVersion = expectedVersions.get(task.id)!;
    mutationIndexes.push(statements.length);
    const activity = activityEventStatement(db, currentUser, {
      taskId: task.id,
      eventType: "task_moved",
      payload: {
        changes: {
          project: { before: { id: task.projectId }, after: { id: targetProject.id, name: targetProject.name } },
          identifier: { before: task.identifier, after: identifier },
          releaseId: { before: task.releaseId, after: null },
          assigneeUserId: { before: task.assigneeUserId, after: assigneeUserId },
        },
        bulk: true,
      },
      createdAt: now,
    });
    statements.push(
      db.prepare(
        `UPDATE tasks SET project_id = ?, sequence_number = ?, identifier = ?,
           release_id = NULL, assignee_user_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND project_id = ? AND archived_at IS NULL
           AND parent_task_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM tasks child WHERE child.parent_task_id = tasks.id)
           AND NOT EXISTS (
             SELECT 1 FROM task_relations relation
             WHERE relation.type = 'duplicate_of'
               AND (relation.source_task_id = tasks.id
                 OR relation.target_task_id = tasks.id)
               AND NOT (
                 relation.source_task_id IN (${placeholders})
                 AND relation.target_task_id IN (${placeholders})
               )
           )
           AND ${editableTaskPredicate}
           AND EXISTS (
             SELECT 1 FROM projects target
             CROSS JOIN (SELECT ? AS id) mutation_actor
             WHERE target.id = ? AND target.archived_at IS NULL
               AND target.deleted_at IS NULL AND target.status <> 'canceled'
               AND ${projectEffectiveRoleRankSql(
                 "target",
                 "mutation_actor.id",
               )} >= 2
           )
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM users assignee WHERE assignee.id = ? AND EXISTS (
               SELECT 1 FROM projects target
               WHERE target.id = ? AND (
                 ${projectEffectiveRoleRankSql("target", "assignee.id")} > 0
                 OR EXISTS (
                   SELECT 1 FROM team_grants explicit_task_grant
                   JOIN teams explicit_task_team
                     ON explicit_task_team.id = explicit_task_grant.team_id
                     AND explicit_task_team.archived_at IS NULL
                   JOIN team_memberships explicit_task_member
                     ON explicit_task_member.team_id = explicit_task_team.id
                     AND explicit_task_member.user_id = assignee.id
                     AND explicit_task_member.status = 'active'
                     AND explicit_task_member.deactivated_at IS NULL
                   WHERE explicit_task_grant.resource_type = 'task'
                     AND explicit_task_grant.resource_id = tasks.id
                     AND explicit_task_grant.revoked_at IS NULL
                 )
               )
             )
           ))
           AND (? = 1 OR NOT EXISTS (
             SELECT 1 FROM releases current_release
             WHERE current_release.id = tasks.release_id
               AND current_release.deleted_at IS NULL
               AND current_release.status = 'released'
           ))`,
      ).bind(
        targetProject.id,
        sequenceNumber,
        identifier,
        assigneeUserId,
        now,
        task.id,
        expectedVersion,
        task.projectId,
        ...movingTasks.map((movingTask) => movingTask.id),
        ...movingTasks.map((movingTask) => movingTask.id),
        currentUser.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        targetProject.id,
        assigneeUserId,
        assigneeUserId,
        targetProject.id,
        input.confirmReleasedComposition === true ? 1 : 0,
      ),
      moveBatchAssertion(db, `bulk_move_task_${crypto.randomUUID()}`, "task"),
      db.prepare(
        `INSERT OR IGNORE INTO task_identifier_aliases
           (id, task_id, identifier, created_at) VALUES (?, ?, ?, ?)`,
      ).bind(`alias_${crypto.randomUUID()}`, task.id, task.identifier, now),
      activity.statement,
      invalidateTaskRelationDetails(db, task.id),
    );
  });
  for (const sourceProjectId of new Set(
    movingTasks.map((task) => task.projectId),
  )) {
    statements.push(
      touchProjectSyncMarker(db, sourceProjectId, now),
      moveBatchAssertion(
        db,
        `bulk_move_source_${crypto.randomUUID()}`,
        "source-project",
      ),
    );
  }

  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("Bulk Project move changed concurrently and was rolled back");
    }
    throw error;
  }
  if (
    (results[0]?.meta.changes ?? 0) < 1 ||
    mutationIndexes.some((index) => (results[index]?.meta.changes ?? 0) < 1)
  ) {
    throw new ConflictError("Bulk Project move changed concurrently and was rolled back");
  }
  return loadAccessibleTasks(currentUser.id, ids);
}

export async function bulkUpdateTasks(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : [];
  if (ids.length === 0 || ids.length > 100) {
    throw new ValidationError("Select between 1 and 100 tasks");
  }
  const field = input.field;
  if (
    field !== "statusId" &&
    field !== "priority" &&
    field !== "archived" &&
    field !== "assigneeUserId" &&
    field !== "releaseId"
  ) {
    throw new ValidationError("Unsupported bulk action");
  }
  const tasks = await loadAccessibleTasks(currentUser.id, ids);
  tasks.forEach((task) => requireContentEdit(task.accessRole));
  const versionInput = input.versions;
  if (!versionInput || typeof versionInput !== "object" || Array.isArray(versionInput)) {
    throw new ValidationError("Expected task versions are required");
  }
  const versions = versionInput as Record<string, unknown>;
  const expectedVersions = new Map<string, number>();
  tasks.forEach((task, index) => {
    const address = ids[index]!;
    const expected = Number(
      versions[address] ?? versions[task.id] ?? versions[task.publicId],
    );
    if (!Number.isInteger(expected) || expected !== task.version) {
      throw new ConflictError("One or more tasks changed in another session");
    }
    expectedVersions.set(task.id, expected);
  });
  const now = new Date().toISOString();
  const db = getD1();
  const nextPriority = field === "priority" ? priority(input.value) : null;
  const nextAssigneeUserId = field === "assigneeUserId"
    ? requestedAssigneeUserId(input.value)
    : null;
  const nextRelease = field === "releaseId" && input.value !== null
    ? await loadAccessibleRelease(currentUser.id, String(input.value))
    : null;
  if (nextRelease) requireContentEdit(nextRelease.accessRole);
  if (
    field === "releaseId" &&
    nextRelease &&
    tasks.some((task) => task.projectId !== nextRelease.projectId)
  ) {
    throw new ValidationError("Selected Release is not compatible with every Task Project");
  }
  if (field === "releaseId") {
    const currentReleases = new Map(
      (await Promise.all(
        [...new Set(tasks.map(internalTaskReleaseId).filter((id): id is string => Boolean(id)))]
          .map((releaseId) => loadAccessibleStoredRelease(currentUser.id, releaseId)),
      )).map((release) => [release.id, release] as const),
    );
    for (const task of tasks) {
      const storedReleaseId = internalTaskReleaseId(task);
      const currentRelease = storedReleaseId
        ? currentReleases.get(storedReleaseId) ?? null
        : null;
      assertReleasedCompositionChange(currentRelease, nextRelease, input);
    }
  }
  if (field === "assigneeUserId") {
    for (const task of tasks) {
      await assertTaskAssigneeAccess(
        nextAssigneeUserId,
        task.ownerUserId,
        task.projectId,
        task.id,
      );
    }
  }
  const targetStatus = field === "statusId"
    ? await loadStatus(tasks[0]!.ownerUserId, String(input.value))
    : null;
  if (targetStatus && tasks.some((task) => task.ownerUserId !== targetStatus.ownerUserId)) {
    throw new ValidationError("Bulk status changes require tasks from one workflow owner");
  }
  const statements: D1PreparedStatement[] = [];
  const primaryIndexes: number[] = [];
  for (const task of tasks) {
    let update: D1PreparedStatement;
    let eventType: string;
    let changes: Record<string, unknown>;
    if (field === "priority") {
      if (task.priority === nextPriority) continue;
      update = db
        .prepare(
            `UPDATE tasks SET priority = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND ${editableTaskPredicate}`,
        )
        .bind(
          nextPriority,
          now,
          task.id,
          expectedVersions.get(task.id),
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
        );
      eventType = "task_updated";
      changes = { priority: { before: task.priority, after: nextPriority } };
    } else if (field === "archived") {
      const desiredArchived = Boolean(input.value);
      if (Boolean(task.archivedAt) === desiredArchived) continue;
      const nextArchivedAt = desiredArchived ? now : null;
      update = db
        .prepare(
          `UPDATE tasks SET archived_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND ${editableTaskPredicate}`,
        )
        .bind(
          nextArchivedAt,
          now,
          task.id,
          expectedVersions.get(task.id),
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
        );
      eventType = desiredArchived ? "task_archived" : "task_restored";
      changes = { archivedAt: { before: task.archivedAt, after: nextArchivedAt } };
    } else if (field === "statusId") {
      if (task.statusId === targetStatus!.id) continue;
      const timestamps = statusTimestamps(targetStatus!.category, task, now);
      update = db
        .prepare(
          `UPDATE tasks SET status_id = ?, started_at = ?, completed_at = ?,
            canceled_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND ${editableTaskPredicate}`,
        )
        .bind(
          targetStatus!.id,
          timestamps.startedAt,
          timestamps.completedAt,
          timestamps.canceledAt,
          now,
          task.id,
          expectedVersions.get(task.id),
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
        );
      eventType = "status_changed";
      changes = {
        status: {
          before: { id: task.statusId },
          after: { id: targetStatus!.id, name: targetStatus!.name },
        },
      };
    } else if (field === "assigneeUserId") {
      if (task.assigneeUserId === nextAssigneeUserId) continue;
      update = db
        .prepare(
          `UPDATE tasks SET assignee_user_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND ${editableTaskPredicate}
             AND (
               ? IS NULL OR EXISTS (
                 SELECT 1 FROM users assignee
                 LEFT JOIN projects assignment_project
                   ON assignment_project.id = tasks.project_id
                 WHERE assignee.id = ?
                   AND ${taskEffectiveRoleRankSql(
                     "tasks",
                     "assignment_project",
                     "assignee.id",
                   )} > 0
               )
             )`,
        )
        .bind(
          nextAssigneeUserId,
          now,
          task.id,
          expectedVersions.get(task.id),
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
          nextAssigneeUserId,
          nextAssigneeUserId,
        );
      eventType = "task_updated";
      changes = {
        assigneeUserId: {
          before: task.assigneeUserId,
          after: nextAssigneeUserId,
        },
      };
    } else {
      if (internalTaskReleaseId(task) === nextRelease?.id) continue;
      update = db
        .prepare(
          `UPDATE tasks SET release_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND ${editableTaskPredicate}
             AND (? IS NULL OR EXISTS (
               SELECT 1 FROM releases selected_release
               WHERE selected_release.id = ?
                 AND selected_release.project_id = tasks.project_id
                 AND selected_release.deleted_at IS NULL
             ))
             AND (? = 1 OR NOT EXISTS (
               SELECT 1 FROM releases locked_release
               WHERE locked_release.id IN (tasks.release_id, ?)
                 AND locked_release.deleted_at IS NULL
                 AND locked_release.status = 'released'
             ))`,
        )
        .bind(
          nextRelease?.id ?? null,
          now,
          task.id,
          expectedVersions.get(task.id),
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
          nextRelease?.id ?? null,
          nextRelease?.id ?? null,
          input.confirmReleasedComposition === true ? 1 : 0,
          nextRelease?.id ?? null,
        );
      eventType = "task_updated";
      changes = {
        releaseId: {
          before: task.releaseId,
          after: nextRelease?.id ?? null,
        },
      };
    }
    primaryIndexes.push(statements.length);
    const activity = activityEventStatement(db, currentUser, {
      taskId: task.id,
      eventType,
      payload: { changes, bulk: true },
      createdAt: now,
    });
    statements.push(
      update,
      activityBatchAssertion(
        db,
        `activity_assert_${crypto.randomUUID()}`,
        now,
      ),
      activity.statement,
    );
  }
  if (!statements.length) return loadAccessibleTasks(currentUser.id, ids, true);
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("One or more tasks changed in another session");
    }
    throw error;
  }
  if (primaryIndexes.some((index) => (results[index]?.meta.changes ?? 0) < 1)) {
    throw new ConflictError("One or more tasks changed in another session");
  }
  return loadAccessibleTasks(currentUser.id, ids, true);
}
