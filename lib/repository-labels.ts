import { canEditContent } from "./access";
import { editableTaskWhere } from "./access-sql";
import {
  ConflictError,
  NotFoundError,
  optionalText,
  ValidationError,
} from "./domain";
import {
  activityBatchAssertion,
  activityEventStatement,
} from "./activity-write";
import {
  loadAccessibleProject,
  loadAccessibleTask,
  loadAccessibleTasks,
  requireContentEdit,
} from "./repository-access-loaders";
import {
  mapLabel,
  mapLabelGroup,
  mapTaskLabel,
  type DbRow,
} from "./repository-mappers";
import type {
  LabelGroupRecord,
  LabelRecord,
  UserRecord,
} from "./types";
import { getD1 } from "@/db";

const editableTaskPredicate = editableTaskWhere("tasks");

function sqlPlaceholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint|foreign key|unique/i.test(error.message);
}

export type LabelSettingsRecord = LabelRecord & { taskCount: number };
export type LabelGroupSettingsRecord = LabelGroupRecord & { taskCount: number; labelCount: number };

export async function listOwnedLabelGroups(
  currentUser: UserRecord,
): Promise<LabelGroupSettingsRecord[]> {
  const rows = await getD1().prepare(
    `SELECT g.*, COUNT(DISTINCT l.id) AS label_count,
       COUNT(DISTINCT tl.task_id) AS task_count
     FROM label_groups g
     LEFT JOIN labels l ON l.group_id = g.id
     LEFT JOIN task_labels tl ON tl.label_id = l.id
     WHERE g.owner_user_id = ?
     GROUP BY g.id
     ORDER BY g.archived_at IS NOT NULL, g.position, lower(g.name), g.id`,
  ).bind(currentUser.id).all<DbRow>();
  return rows.results.map((row) => ({
    ...mapLabelGroup(row),
    taskCount: Number(row.task_count ?? 0),
    labelCount: Number(row.label_count ?? 0),
  }));
}

export async function createLabelGroup(currentUser: UserRecord, input: Record<string, unknown>) {
  const name = labelGroupName(input.name);
  const description = optionalText(input.description, 2_000);
  await assertUniqueActiveLabelGroupName(currentUser.id, name);
  const position = Object.hasOwn(input, "position")
    ? labelGroupPosition(input.position)
    : Number((await getD1().prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM label_groups WHERE owner_user_id = ?",
    ).bind(currentUser.id).first<{ position: number }>())?.position ?? 0);
  const now = new Date().toISOString();
  try {
    await getD1().prepare(
      `INSERT INTO label_groups
       (id, owner_user_id, name, description, position, archived_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(`label-group:${currentUser.id}:${crypto.randomUUID()}`, currentUser.id, name, description, position, now, now).run();
  } catch (error) {
    translateLabelGroupNameCollision(error);
  }
  return listOwnedLabelGroups(currentUser);
}

export async function updateLabelGroup(
  currentUser: UserRecord,
  groupId: string,
  input: Record<string, unknown>,
) {
  const current = await loadOwnedLabelGroup(currentUser.id, groupId);
  const version = expectedLabelVersion(input.version);
  if (current.version !== version) throw new ConflictError("Label Group was changed in another session");
  const action = input.action ?? "update";
  const now = new Date().toISOString();
  let result: D1Result<unknown>;
  if (action === "archive") {
    if (current.archivedAt) throw new ConflictError("Label Group is already archived");
    result = await getD1().prepare(
      `UPDATE label_groups SET archived_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
    ).bind(now, now, groupId, currentUser.id, version).run();
  } else if (action === "restore") {
    if (!current.archivedAt) throw new ConflictError("Label Group is not archived");
    await assertUniqueActiveLabelGroupName(currentUser.id, current.name, current.id);
    try {
      result = await getD1().prepare(
        `UPDATE label_groups SET archived_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NOT NULL`,
      ).bind(now, groupId, currentUser.id, version).run();
    } catch (error) {
      translateLabelGroupNameCollision(error);
    }
  } else if (action === "update") {
    if (current.archivedAt) throw new ValidationError("Restore an archived Label Group before editing it");
    const name = Object.hasOwn(input, "name") ? labelGroupName(input.name) : current.name;
    const description = Object.hasOwn(input, "description") ? optionalText(input.description, 2_000) : current.description;
    const position = Object.hasOwn(input, "position") ? labelGroupPosition(input.position) : current.position;
    if (name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
      await assertUniqueActiveLabelGroupName(currentUser.id, name, current.id);
    }
    try {
      result = await getD1().prepare(
        `UPDATE label_groups SET name = ?, description = ?, position = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
      ).bind(name, description, position, now, groupId, currentUser.id, version).run();
    } catch (error) {
      translateLabelGroupNameCollision(error);
    }
  } else {
    throw new ValidationError("Unsupported Label Group action");
  }
  if ((result!.meta.changes ?? 0) < 1) throw new ConflictError("Label Group was changed in another session");
  return listOwnedLabelGroups(currentUser);
}

export async function listOwnedLabels(
  currentUser: UserRecord,
): Promise<LabelSettingsRecord[]> {
  const rows = await getD1().prepare(
    `SELECT l.*, COUNT(tl.task_id) AS task_count
     FROM labels l
     LEFT JOIN task_labels tl ON tl.label_id = l.id
     WHERE l.owner_user_id = ?
     GROUP BY l.id
     ORDER BY l.archived_at IS NOT NULL, lower(l.name), l.id`,
  ).bind(currentUser.id).all<DbRow>();
  return rows.results.map((row) => ({
    ...mapLabel(row),
    taskCount: Number(row.task_count ?? 0),
  }));
}

export async function createLabel(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const name = labelName(input.name);
  const color = labelColor(input.color);
  const description = optionalText(input.description, 2_000);
  const group = input.groupId == null || input.groupId === ""
    ? null
    : await loadOwnedLabelGroup(currentUser.id, requiredLabelGroupId(input.groupId));
  if (group?.archivedAt) throw new ValidationError("Archived Label Groups cannot receive Labels");
  await assertUniqueActiveLabelName(currentUser.id, name);
  const now = new Date().toISOString();
  try {
    await getD1().prepare(
      `INSERT INTO labels
        (id, owner_user_id, group_id, name, color, description, archived_at,
         version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(
      `label:${currentUser.id}:${crypto.randomUUID()}`,
      currentUser.id,
      group?.id ?? null,
      name,
      color,
      description,
      now,
      now,
    ).run();
  } catch (error) {
    translateLabelNameCollision(error);
  }
  return listOwnedLabels(currentUser);
}

export async function updateLabel(
  currentUser: UserRecord,
  labelId: string,
  input: Record<string, unknown>,
) {
  const current = await loadOwnedLabel(currentUser.id, labelId);
  const version = expectedLabelVersion(input.version);
  if (current.version !== version) throw staleLabel();
  const action = input.action ?? "update";
  const now = new Date().toISOString();
  let result: D1Result<unknown>;
  if (action === "archive") {
    if (current.archivedAt) throw new ConflictError("Label is already archived");
    result = await getD1().prepare(
      `UPDATE labels SET archived_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
    ).bind(now, now, labelId, currentUser.id, version).run();
  } else if (action === "restore") {
    if (!current.archivedAt) throw new ConflictError("Label is not archived");
    await assertUniqueActiveLabelName(currentUser.id, current.name, current.id);
    try {
      result = await getD1().prepare(
        `UPDATE labels SET archived_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NOT NULL`,
      ).bind(now, labelId, currentUser.id, version).run();
    } catch (error) {
      translateLabelNameCollision(error);
    }
  } else if (action === "update") {
    if (current.archivedAt) {
      throw new ValidationError("Restore an archived Label before editing it");
    }
    const name = Object.hasOwn(input, "name") ? labelName(input.name) : current.name;
    const color = Object.hasOwn(input, "color") ? labelColor(input.color) : current.color;
    const description = Object.hasOwn(input, "description")
      ? optionalText(input.description, 2_000)
      : current.description;
    const nextGroup = !Object.hasOwn(input, "groupId")
      ? (current.groupId ? await loadOwnedLabelGroup(currentUser.id, current.groupId) : null)
      : input.groupId == null || input.groupId === ""
        ? null
        : await loadOwnedLabelGroup(currentUser.id, requiredLabelGroupId(input.groupId));
    if (nextGroup?.archivedAt) throw new ValidationError("Archived Label Groups cannot receive Labels");
    if (name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
      await assertUniqueActiveLabelName(currentUser.id, name, current.id);
    }
    try {
      if (nextGroup?.id !== current.groupId) {
        if (nextGroup) {
          const conflict = await getD1().prepare(
            `SELECT COUNT(DISTINCT moving.task_id) AS count
             FROM task_labels moving
             JOIN task_labels existing ON existing.task_id = moving.task_id
             JOIN labels existing_label ON existing_label.id = existing.label_id
             WHERE moving.label_id = ? AND existing_label.group_id = ? AND existing.label_id <> ?`,
          ).bind(labelId, nextGroup.id, labelId).first<{ count: number }>();
          const count = Number(conflict?.count ?? 0);
          if (count > 0) throw new ConflictError(`Moving this Label would create group conflicts on ${count} Task${count === 1 ? "" : "s"}`);
        }
        // label_group_label_move_sync is the single authority for rebuilding
        // the derived exclusivity guard. Keeping this as one UPDATE also makes
        // the version check, conflict trigger, and guard rewrite atomic.
        result = await getD1().prepare(
          `UPDATE labels SET group_id = ?, name = ?, color = ?, description = ?,
             version = version + 1, updated_at = ?
           WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
        ).bind(nextGroup?.id ?? null, name, color, description, now, labelId, currentUser.id, version).run();
      } else {
        result = await getD1().prepare(
          `UPDATE labels SET name = ?, color = ?, description = ?,
             version = version + 1, updated_at = ?
           WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
        ).bind(name, color, description, now, labelId, currentUser.id, version).run();
      }
    } catch (error) {
      translateLabelUpdateCollision(error);
    }
  } else {
    throw new ValidationError("Unsupported Label action");
  }
  if ((result!.meta.changes ?? 0) < 1) throw staleLabel();
  return listOwnedLabels(currentUser);
}

export async function getTaskLabelState(
  currentUser: UserRecord,
  taskId: string,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  const db = getD1();
  const [groups, labels, assignments] = await db.batch<DbRow>([
    db.prepare(
      `SELECT * FROM label_groups
       WHERE owner_user_id = ? AND (
         archived_at IS NULL OR EXISTS (
           SELECT 1 FROM task_label_group_values value
           WHERE value.task_id = ? AND value.group_id = label_groups.id
         )
       ) ORDER BY archived_at IS NOT NULL, position, lower(name), id`,
    ).bind(task.ownerUserId, task.id),
    db.prepare(
      `SELECT l.* FROM labels l
       WHERE l.owner_user_id = ? AND (
         l.archived_at IS NULL OR EXISTS (
           SELECT 1 FROM task_labels tl
           WHERE tl.task_id = ? AND tl.label_id = l.id
         )
       )
       ORDER BY l.archived_at IS NOT NULL, lower(l.name), l.id`,
    ).bind(task.ownerUserId, task.id),
    db.prepare(
      `SELECT task_id, label_id FROM task_labels WHERE task_id = ? ORDER BY label_id`,
    ).bind(task.id),
  ]);
  return {
    labelGroups: groups.results.map(mapLabelGroup),
    labels: labels.results.map(mapLabel),
    taskLabels: assignments.results.map(mapTaskLabel),
    taskIds: [task.id],
    canWrite: canEditContent(task.accessRole),
  };
}

export async function getProjectLabelCatalog(
  currentUser: UserRecord,
  projectId: string,
  includeArchived = false,
) {
  const project = await loadAccessibleProject(currentUser.id, projectId);
  requireContentEdit(project.accessRole);
  const [groups, rows] = await getD1().batch<DbRow>([
    getD1().prepare(
      `SELECT * FROM label_groups
       WHERE owner_user_id = ? AND (? = 1 OR archived_at IS NULL)
       ORDER BY archived_at IS NOT NULL, position, lower(name), id`,
    ).bind(project.ownerUserId, includeArchived ? 1 : 0),
    getD1().prepare(
      `SELECT * FROM labels
       WHERE owner_user_id = ? AND (? = 1 OR archived_at IS NULL)
       ORDER BY group_id IS NULL, lower(name), id`,
    ).bind(project.ownerUserId, includeArchived ? 1 : 0),
  ]);
  return { labelGroups: groups.results.map(mapLabelGroup), labels: rows.results.map(mapLabel) };
}

export async function setTaskLabel(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  requireContentEdit(task.accessRole);
  const labelId = requiredLabelId(input.labelId);
  const active = input.active;
  if (typeof active !== "boolean") {
    throw new ValidationError("Label assignment active must be boolean");
  }
  const label = await loadTaskOwnerLabel(task.ownerUserId, labelId, !active);
  if (active && label.groupId) {
    return setTaskLabelGroupValue(currentUser, task.id, {
      groupId: label.groupId,
      labelId: label.id,
    });
  }
  const db = getD1();
  const existing = await db.prepare(
    "SELECT 1 AS assigned FROM task_labels WHERE task_id = ? AND label_id = ?",
  ).bind(task.id, label.id).first<{ assigned: number }>();
  if (Boolean(existing) === active) {
    return getTaskLabelState(currentUser, task.id);
  }
  const now = new Date().toISOString();
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: "labels_changed",
    payload: {
      label: { id: label.id, name: label.name },
      active,
    },
    createdAt: now,
  });
  const mutation = active
    ? db.prepare(
      `INSERT OR IGNORE INTO task_labels (task_id, label_id)
       SELECT tasks.id, labels.id FROM tasks, labels
       WHERE tasks.id = ? AND labels.id = ?
         AND labels.owner_user_id = tasks.owner_user_id
         AND labels.archived_at IS NULL
         AND ${editableTaskPredicate}`,
    ).bind(
      task.id,
      label.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    )
    : db.prepare(
      `DELETE FROM task_labels
       WHERE task_id = ? AND label_id = ? AND EXISTS (
         SELECT 1 FROM tasks
         WHERE tasks.id = task_labels.task_id AND ${editableTaskPredicate}
       )`,
    ).bind(
      task.id,
      label.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    );
  try {
    await db.batch([
      mutation,
      activityBatchAssertion(
        db,
        `activity_assert_${crypto.randomUUID()}`,
        now,
      ),
      activity.statement,
      db.prepare(
        `UPDATE tasks SET updated_at = CASE
           WHEN updated_at >= ?
             THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
           ELSE ? END
         WHERE id = ?`,
      ).bind(now, now, task.id),
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError(label.groupId
        ? "Task Label Group value changed concurrently; use the explicit set-group-value command"
        : "Task access or Label state changed before the assignment committed");
    }
    throw error;
  }
  const state = await getTaskLabelState(currentUser, task.id);
  const applied = state.taskLabels.some((item) => item.labelId === label.id);
  if (applied !== active) {
    throw new ConflictError("Task access or Label state changed before the assignment committed");
  }
  return state;
}

export async function replaceTaskLabels(
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
  const currentRows = await getD1().prepare(
    `SELECT tl.label_id, l.name
     FROM task_labels tl JOIN labels l ON l.id = tl.label_id
     WHERE tl.task_id = ? ORDER BY tl.label_id`,
  ).bind(task.id).all<{ label_id: string; name: string }>();
  const currentIds = currentRows.results.map((row) => row.label_id).sort();
  const labelIds = await validateReplacementLabelIds(
    task.ownerUserId,
    input.labelIds,
    new Set(currentIds),
  );
  const nextIds = [...labelIds].sort();
  if (JSON.stringify(currentIds) === JSON.stringify(nextIds)) {
    return getTaskLabelState(currentUser, task.id);
  }

  const labels = labelIds.length
      ? await getD1().prepare(
        `SELECT id, name FROM labels
         WHERE owner_user_id = ?
           AND id IN (${sqlPlaceholders(labelIds)})
         ORDER BY id`,
      ).bind(task.ownerUserId, ...labelIds).all<{ id: string; name: string }>()
    : { results: [] as Array<{ id: string; name: string }> };
  const now = new Date().toISOString();
  const db = getD1();
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: "labels_changed",
    payload: {
      replace: true,
      before: currentRows.results.map((row) => ({ id: row.label_id, name: row.name })),
      after: labels.results.map((label) => ({ id: label.id, name: label.name })),
    },
    createdAt: now,
  });
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE tasks SET version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND ${editableTaskPredicate}`,
    ).bind(
      now,
      task.id,
      expectedVersion,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    ),
    activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
    db.prepare("DELETE FROM task_labels WHERE task_id = ?").bind(task.id),
  ];
  for (const labelId of labelIds) {
    statements.push(
      db.prepare(
        `INSERT INTO task_labels (task_id, label_id)
         SELECT task.id, label.id
         FROM tasks task JOIN labels label ON label.id = ?
         WHERE task.id = ? AND task.version = ?
           AND label.owner_user_id = task.owner_user_id
           AND (label.archived_at IS NULL OR ? = 1)`,
      ).bind(
        labelId,
        task.id,
        expectedVersion + 1,
        currentIds.includes(labelId) ? 1 : 0,
      ),
      activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
    );
  }
  statements.push(activity.statement);
  try {
    await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError(
        "Task access, version, or Label catalog changed before replacement",
      );
    }
    throw error;
  }
  const state = await getTaskLabelState(currentUser, task.id);
  const applied = state.taskLabels.map((item) => item.labelId).sort();
  if (JSON.stringify(applied) !== JSON.stringify(nextIds)) {
    throw new ConflictError(
      "Task access, version, or Label catalog changed before replacement",
    );
  }
  return state;
}

export async function bulkSetTaskLabel(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const taskIds = Array.isArray(input.ids)
    ? [...new Set(input.ids.map(String))]
    : [];
  if (taskIds.length === 0 || taskIds.length > 100) {
    throw new ValidationError("Select between 1 and 100 tasks");
  }
  const active = input.active;
  if (typeof active !== "boolean") {
    throw new ValidationError("Label assignment active must be boolean");
  }
  const tasks = await loadAccessibleTasks(currentUser.id, taskIds);
  tasks.forEach((task) => requireContentEdit(task.accessRole));
  const ownerIds = new Set(tasks.map((task) => task.ownerUserId));
  if (ownerIds.size !== 1) {
    throw new ValidationError("Bulk Label changes require Tasks from one owner catalog");
  }
  const label = await loadTaskOwnerLabel(
    tasks[0]!.ownerUserId,
    requiredLabelId(input.labelId),
    !active,
  );
  if (active && label.groupId) {
    return bulkSetTaskLabelGroupValue(currentUser, {
      ids: taskIds,
      groupId: label.groupId,
      labelId: label.id,
    });
  }
  const db = getD1();
  const placeholders = sqlPlaceholders(taskIds);
  const currentRows = await db.prepare(
    `SELECT task_id FROM task_labels
     WHERE task_id IN (${placeholders}) AND label_id = ?`,
  ).bind(...taskIds, label.id).all<{ task_id: string }>();
  const assigned = new Set(currentRows.results.map((row) => row.task_id));
  const changedTasks = tasks.filter((task) => assigned.has(task.id) !== active);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const task of changedTasks) {
    const activity = activityEventStatement(db, currentUser, {
      taskId: task.id,
      eventType: "labels_changed",
      payload: { label: { id: label.id, name: label.name }, active, bulk: true },
      createdAt: now,
    });
    statements.push(
      active
        ? db.prepare(
          `INSERT OR IGNORE INTO task_labels (task_id, label_id)
           SELECT tasks.id, ? FROM tasks
           WHERE tasks.id = ? AND ${editableTaskPredicate}`,
        ).bind(
          label.id,
          task.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
        )
        : db.prepare(
          `DELETE FROM task_labels
           WHERE task_id = ? AND label_id = ? AND EXISTS (
             SELECT 1 FROM tasks
             WHERE tasks.id = task_labels.task_id AND ${editableTaskPredicate}
           )`,
        ).bind(
          task.id,
          label.id,
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
        `UPDATE tasks SET updated_at = CASE
           WHEN updated_at >= ?
             THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
           ELSE ? END
         WHERE id = ?`,
      ).bind(now, now, task.id),
    );
  }
  if (statements.length) {
    try {
      await db.batch(statements);
    } catch (error) {
      if (isConstraintError(error)) {
        throw new ConflictError("Task access or Label state changed during the bulk action");
      }
      throw error;
    }
  }
  const rows = await db.prepare(
    `SELECT task_id, label_id FROM task_labels
     WHERE task_id IN (${placeholders}) ORDER BY task_id, label_id`,
  ).bind(...taskIds).all<DbRow>();
  const assignments = rows.results.map(mapTaskLabel);
  for (const task of tasks) {
    const applied = assignments.some((item) =>
      item.taskId === task.id && item.labelId === label.id);
    if (applied !== active) {
      throw new ConflictError("Task access or Label state changed during the bulk action");
    }
  }
  return { labels: [label], taskLabels: assignments, taskIds };
}

export async function setTaskLabelGroupValue(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  requireContentEdit(task.accessRole);
  const group = await loadOwnedLabelGroup(task.ownerUserId, requiredLabelGroupId(input.groupId));
  const requestedLabelId = input.labelId == null || input.labelId === ""
    ? null
    : requiredLabelId(input.labelId);
  if (requestedLabelId && group.archivedAt) {
    throw new ValidationError("Archived Label Groups cannot receive new values");
  }
  const label = requestedLabelId
    ? await loadTaskOwnerLabel(task.ownerUserId, requestedLabelId, false)
    : null;
  if (label && label.groupId !== group.id) {
    throw new ValidationError("Label does not belong to the selected Label Group");
  }
  const db = getD1();
  const current = await db.prepare(
    `SELECT value.label_id, l.name FROM task_label_group_values value
     JOIN labels l ON l.id = value.label_id
     WHERE value.task_id = ? AND value.group_id = ?`,
  ).bind(task.id, group.id).first<{ label_id: string; name: string }>();
  if ((current?.label_id ?? null) === requestedLabelId) {
    return getTaskLabelState(currentUser, task.id);
  }
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (current) {
    statements.push(
      db.prepare(
        `DELETE FROM task_labels WHERE task_id = ? AND label_id = ? AND EXISTS (
           SELECT 1 FROM tasks WHERE tasks.id = task_labels.task_id AND ${editableTaskPredicate}
         )`,
      ).bind(task.id, current.label_id, currentUser.id, currentUser.id, currentUser.id, currentUser.id),
      activityBatchAssertion(db, `label_group_clear_assert_${crypto.randomUUID()}`, now),
    );
  }
  if (label) {
    statements.push(
      db.prepare(
        `INSERT INTO task_labels (task_id, label_id)
         SELECT tasks.id, labels.id FROM tasks, labels
         JOIN label_groups g ON g.id = labels.group_id
         WHERE tasks.id = ? AND labels.id = ? AND labels.group_id = ?
           AND labels.owner_user_id = tasks.owner_user_id
           AND labels.archived_at IS NULL AND g.archived_at IS NULL
           AND ${editableTaskPredicate}`,
      ).bind(task.id, label.id, group.id, currentUser.id, currentUser.id, currentUser.id, currentUser.id),
      activityBatchAssertion(db, `label_group_set_assert_${crypto.randomUUID()}`, now),
    );
  }
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: "label_group_value_changed",
    payload: {
      group: { id: group.id, name: group.name },
      before: current ? { id: current.label_id, name: current.name } : null,
      after: label ? { id: label.id, name: label.name } : null,
    },
    createdAt: now,
  });
  statements.push(
    activity.statement,
    db.prepare(
      `UPDATE tasks SET updated_at = CASE WHEN updated_at >= ?
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') ELSE ? END
       WHERE id = ?`,
    ).bind(now, now, task.id),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("Task Label Group value changed concurrently; reload and retry");
    }
    throw error;
  }
  const state = await getTaskLabelState(currentUser, task.id);
  const applied = state.taskLabels.find((assignment) =>
    state.labels.find((candidate) => candidate.id === assignment.labelId)?.groupId === group.id)?.labelId ?? null;
  if (applied !== requestedLabelId) throw new ConflictError("Task Label Group value changed concurrently; reload and retry");
  return state;
}

export async function bulkSetTaskLabelGroupValue(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const taskIds = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : [];
  if (!taskIds.length || taskIds.length > 100) throw new ValidationError("Select between 1 and 100 tasks");
  const tasks = await loadAccessibleTasks(currentUser.id, taskIds);
  tasks.forEach((task) => requireContentEdit(task.accessRole));
  const ownerIds = new Set(tasks.map((task) => task.ownerUserId));
  if (ownerIds.size !== 1) throw new ValidationError("Bulk Label Group changes require Tasks from one owner catalog");
  const group = await loadOwnedLabelGroup(tasks[0]!.ownerUserId, requiredLabelGroupId(input.groupId));
  const requestedLabelId = input.labelId == null || input.labelId === "" ? null : requiredLabelId(input.labelId);
  if (requestedLabelId && group.archivedAt) throw new ValidationError("Archived Label Groups cannot receive new values");
  const label = requestedLabelId ? await loadTaskOwnerLabel(tasks[0]!.ownerUserId, requestedLabelId, false) : null;
  if (label && label.groupId !== group.id) throw new ValidationError("Label does not belong to the selected Label Group");
  const db = getD1();
  const placeholders = sqlPlaceholders(taskIds);
  const currentRows = await db.prepare(
    `SELECT value.task_id, value.label_id, l.name FROM task_label_group_values value
     JOIN labels l ON l.id = value.label_id
     WHERE value.task_id IN (${placeholders}) AND value.group_id = ?`,
  ).bind(...taskIds, group.id).all<{ task_id: string; label_id: string; name: string }>();
  const currentByTask = new Map(currentRows.results.map((row) => [row.task_id, row]));
  const changed = tasks.filter((task) => (currentByTask.get(task.id)?.label_id ?? null) !== requestedLabelId);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const task of changed) {
    const current = currentByTask.get(task.id);
    if (current) statements.push(
      db.prepare(
        `DELETE FROM task_labels WHERE task_id = ? AND label_id = ? AND EXISTS (
           SELECT 1 FROM tasks WHERE tasks.id = task_labels.task_id AND ${editableTaskPredicate}
         )`,
      ).bind(task.id, current.label_id, currentUser.id, currentUser.id, currentUser.id, currentUser.id),
      activityBatchAssertion(db, `bulk_group_clear_assert_${crypto.randomUUID()}`, now),
    );
    if (label) statements.push(
      db.prepare(
        `INSERT INTO task_labels (task_id, label_id)
         SELECT tasks.id, ? FROM tasks WHERE tasks.id = ? AND ${editableTaskPredicate}`,
      ).bind(label.id, task.id, currentUser.id, currentUser.id, currentUser.id, currentUser.id),
      activityBatchAssertion(db, `bulk_group_set_assert_${crypto.randomUUID()}`, now),
    );
    statements.push(activityEventStatement(db, currentUser, {
      taskId: task.id,
      eventType: "label_group_value_changed",
      payload: {
        group: { id: group.id, name: group.name },
        before: current ? { id: current.label_id, name: current.name } : null,
        after: label ? { id: label.id, name: label.name } : null,
        bulk: true,
      },
      createdAt: now,
    }).statement,
    db.prepare(
      `UPDATE tasks SET updated_at = CASE WHEN updated_at >= ?
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') ELSE ? END
       WHERE id = ?`,
    ).bind(now, now, task.id));
  }
  try {
    if (statements.length) await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) throw new ConflictError("Bulk Label Group change conflicted; no Task was changed");
    throw error;
  }
  const rows = await db.prepare(
    `SELECT task_id, label_id FROM task_labels WHERE task_id IN (${placeholders}) ORDER BY task_id, label_id`,
  ).bind(...taskIds).all<DbRow>();
  const labelRows = await db.prepare(
    `SELECT * FROM labels WHERE id IN (SELECT label_id FROM task_labels WHERE task_id IN (${placeholders}))`,
  ).bind(...taskIds).all<DbRow>();
  return { labelGroups: [group], labels: labelRows.results.map(mapLabel), taskLabels: rows.results.map(mapTaskLabel), taskIds };
}

export async function validateActiveLabelIds(ownerUserId: string, value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("Label IDs must be an array");
  const ids = [...new Set(value.map(requiredLabelId))];
  if (ids.length > 50) throw new ValidationError("A Task can have at most 50 Labels");
  if (!ids.length) return ids;
  const rows = await getD1().prepare(
    `SELECT l.id, l.group_id FROM labels l
     LEFT JOIN label_groups g ON g.id = l.group_id
     WHERE l.owner_user_id = ? AND l.archived_at IS NULL
       AND (l.group_id IS NULL OR g.archived_at IS NULL)
       AND l.id IN (${sqlPlaceholders(ids)})`,
  ).bind(ownerUserId, ...ids).all<{ id: string; group_id: string | null }>();
  if (rows.results.length !== ids.length) {
    throw new ValidationError("Every Label must be active in the Task owner catalog");
  }
  const grouped = rows.results.map((row) => row.group_id).filter((id): id is string => Boolean(id));
  if (new Set(grouped).size !== grouped.length) {
    throw new ValidationError("A Task can have at most one Label from each Label Group");
  }
  return ids;
}

async function validateReplacementLabelIds(
  ownerUserId: string,
  value: unknown,
  currentlyAssigned: ReadonlySet<string>,
) {
  if (!Array.isArray(value)) throw new ValidationError("Label IDs must be an array");
  const ids = [...new Set(value.map(requiredLabelId))];
  if (ids.length > 50) throw new ValidationError("A Task can have at most 50 Labels");
  if (!ids.length) return ids;
  const rows = await getD1().prepare(
    `SELECT id, archived_at FROM labels
     WHERE owner_user_id = ? AND id IN (${sqlPlaceholders(ids)})`,
  ).bind(ownerUserId, ...ids).all<{ id: string; archived_at: string | null }>();
  if (rows.results.length !== ids.length) {
    throw new ValidationError("Every Label must belong to the Task owner catalog");
  }
  if (rows.results.some((row) => row.archived_at && !currentlyAssigned.has(row.id))) {
    throw new ValidationError("Archived Labels cannot be newly assigned");
  }
  return ids;
}

async function loadOwnedLabel(ownerUserId: string, labelId: string) {
  const row = await getD1().prepare(
    "SELECT * FROM labels WHERE id = ? AND owner_user_id = ?",
  ).bind(labelId, ownerUserId).first<DbRow>();
  if (!row) throw new NotFoundError("Label not found");
  return mapLabel(row);
}

async function loadOwnedLabelGroup(ownerUserId: string, groupId: string) {
  const row = await getD1().prepare(
    "SELECT * FROM label_groups WHERE id = ? AND owner_user_id = ?",
  ).bind(groupId, ownerUserId).first<DbRow>();
  if (!row) throw new NotFoundError("Label Group not found");
  return mapLabelGroup(row);
}

async function loadTaskOwnerLabel(
  ownerUserId: string,
  labelId: string,
  allowArchived: boolean,
) {
  const label = await loadOwnedLabel(ownerUserId, labelId);
  if (!allowArchived && label.archivedAt) {
    throw new ValidationError("Archived Labels cannot be assigned");
  }
  if (!allowArchived && label.groupId) {
    const group = await loadOwnedLabelGroup(ownerUserId, label.groupId);
    if (group.archivedAt) throw new ValidationError("Labels in archived Label Groups cannot be assigned");
  }
  return label;
}

async function assertUniqueActiveLabelGroupName(ownerUserId: string, name: string, exceptId?: string) {
  const row = await getD1().prepare(
    `SELECT id FROM label_groups
     WHERE owner_user_id = ? AND archived_at IS NULL AND lower(name) = lower(?)
       AND (? IS NULL OR id <> ?) LIMIT 1`,
  ).bind(ownerUserId, name, exceptId ?? null, exceptId ?? null).first();
  if (row) throw new ValidationError("An active Label Group with this name already exists");
}

function labelGroupName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError("Label Group name is required");
  const name = value.trim();
  if (name.length > 80) throw new ValidationError("Label Group name is too long");
  return name;
}

function labelGroupPosition(value: unknown) {
  const position = Number(value);
  if (!Number.isInteger(position) || position < 0 || position > 100_000) {
    throw new ValidationError("Label Group position is invalid");
  }
  return position;
}

function requiredLabelGroupId(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw new ValidationError("Label Group ID is required");
  }
  return value.trim();
}

function translateLabelGroupNameCollision(error: unknown): never {
  if (error instanceof ValidationError) throw error;
  if (error instanceof Error && /idx_label_groups_owner_name_active/i.test(error.message)) {
    throw new ValidationError("An active Label Group with this name already exists");
  }
  throw error;
}

async function assertUniqueActiveLabelName(
  ownerUserId: string,
  name: string,
  exceptId?: string,
) {
  const row = await getD1().prepare(
    `SELECT id FROM labels
     WHERE owner_user_id = ? AND archived_at IS NULL AND lower(name) = lower(?)
       AND (? IS NULL OR id <> ?)
     LIMIT 1`,
  ).bind(ownerUserId, name, exceptId ?? null, exceptId ?? null).first();
  if (row) throw new ValidationError("An active Label with this name already exists");
}

function labelName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("Label name is required");
  }
  const name = value.trim();
  if (name.length > 80) throw new ValidationError("Label name is too long");
  return name;
}

function labelColor(value: unknown) {
  const color = value === undefined ? "#6b7280" : String(value).trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new ValidationError("Label color must be a six-digit hex color");
  }
  return color.toLowerCase();
}

function requiredLabelId(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new ValidationError("Label ID is required");
  }
  return value.trim();
}

function expectedLabelVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("Current Label version is required");
  }
  return version;
}

function staleLabel() {
  return new ConflictError("Label was changed in another session");
}

function translateLabelNameCollision(error: unknown): never {
  if (error instanceof ValidationError) throw error;
  if (error instanceof Error && /idx_labels_owner_name_active/i.test(error.message)) {
    throw new ValidationError("An active Label with this name already exists");
  }
  throw error;
}

function translateLabelUpdateCollision(error: unknown): never {
  if (error instanceof ConflictError) throw error;
  if (error instanceof Error && (
    /at most one Label from each Label Group/i.test(error.message) ||
    /task_label_group_values\.task_id.*task_label_group_values\.group_id/i.test(error.message)
  )) {
    throw new ConflictError("Moving this Label would create a Label Group conflict");
  }
  translateLabelNameCollision(error);
}
