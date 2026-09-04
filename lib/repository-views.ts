import {
  projectEffectiveRoleRankSql,
  savedViewEffectiveRoleRankSql,
  taskEffectiveRoleRankSql,
} from "./access-sql";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  requireTitle,
  ValidationError,
} from "./domain";
import {
  loadAccessibleProject,
  loadAccessibleRelease,
  loadAccessibleTask,
  loadAccessibleView,
  requireContentEdit,
} from "./repository-access-loaders";
import type { DbRow } from "./repository-mappers";
import {
  isConstraintError,
  moveBatchAssertion,
  touchProjectSyncMarker,
} from "./repository-write-helpers";
import { getSnapshot } from "./repository-workspace";
import { canonicalViewQuery } from "./task-filter";
import type {
  ProjectRecord,
  ReleaseRecord,
  UserRecord,
  ViewFilterCondition,
  ViewQuery,
} from "./types";
import { validateViewDisplay, validateViewQuery } from "./view-contract";
import { getD1 } from "@/db";

function sqlPlaceholders(values: readonly unknown[]): string {
  return values.length ? values.map(() => "?").join(", ") : "NULL";
}
export async function createSavedView(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const query = validateViewQuery(input.query);
  const display = validateViewDisplay(input.display);
  const project = input.scopeProjectId
    ? await loadAccessibleProject(currentUser.id, String(input.scopeProjectId))
    : null;
  if (project) requireContentEdit(project.accessRole);
  await validateSavedViewReferences(currentUser, query, display, project);
  const id = `view_${crypto.randomUUID()}`;
  await getD1()
    .prepare(
      `INSERT INTO saved_views
        (id, public_id, owner_user_id, name, scope_project_id, query_json, display_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      crypto.randomUUID(),
      project?.ownerUserId ?? currentUser.id,
      requireTitle(input.name),
      project?.id ?? null,
      JSON.stringify(query),
      JSON.stringify(display),
    )
    .run();
  return loadAccessibleView(currentUser.id, id);
}

export async function updateSavedView(
  currentUser: UserRecord,
  viewId: string,
  input: Record<string, unknown>,
) {
  const view = await loadAccessibleView(currentUser.id, viewId);
  requireContentEdit(view.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== view.version) {
    throw new ConflictError("Saved View version changed before the update");
  }

  const scopeChanged = Object.hasOwn(input, "scopeProjectId") &&
    (input.scopeProjectId ? String(input.scopeProjectId) : null) !== view.scopeProjectId;
  if (scopeChanged && view.accessRole !== "owner") {
    throw new PermissionError("Only the owner can move a Saved View between scopes");
  }
  const nextScopeProject = Object.hasOwn(input, "scopeProjectId")
    ? input.scopeProjectId
      ? await loadAccessibleProject(currentUser.id, String(input.scopeProjectId))
      : null
    : view.scopeProjectId
      ? await loadAccessibleProject(currentUser.id, view.scopeProjectId)
      : null;
  if (nextScopeProject) requireContentEdit(nextScopeProject.accessRole);

  const name = Object.hasOwn(input, "name") ? requireTitle(input.name) : view.name;
  const query = Object.hasOwn(input, "query")
    ? validateViewQuery(input.query)
    : view.query;
  const display = Object.hasOwn(input, "display")
    ? validateViewDisplay(input.display)
    : view.display;
  await validateSavedViewReferences(currentUser, query, display, nextScopeProject, {
    allowedMissingReleaseIds: scopeChanged
      ? new Set<string>()
      : new Set(filterReferenceValues(
          canonicalViewQuery(view.query).conditions,
          "release",
        )),
  });
  const archivedAt = Object.hasOwn(input, "archived")
    ? input.archived === true
      ? view.archivedAt ?? new Date().toISOString()
      : input.archived === false
        ? null
        : (() => { throw new ValidationError("Saved View archived must be boolean"); })()
    : view.archivedAt;
  const ownerUserId = nextScopeProject?.ownerUserId ??
    (scopeChanged && !nextScopeProject ? currentUser.id : view.ownerUserId);
  const now = new Date().toISOString();
  const db = getD1();
  const update = db.prepare(
    `UPDATE saved_views SET
       owner_user_id = ?, name = ?, scope_project_id = ?, query_json = ?,
       display_json = ?, archived_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM (SELECT ? AS id) mutation_actor
         LEFT JOIN projects p ON p.id = saved_views.scope_project_id
         WHERE (saved_views.scope_project_id IS NULL OR p.deleted_at IS NULL)
           AND ${savedViewEffectiveRoleRankSql(
             "saved_views",
             "p",
             "mutation_actor.id",
           )} >= 2
       )`,
  ).bind(
    ownerUserId,
    name,
    nextScopeProject?.id ?? null,
    JSON.stringify(query),
    JSON.stringify(display),
    archivedAt,
    now,
    view.id,
    expectedVersion,
    currentUser.id,
  );
  let result: D1Result<unknown>;
  if (scopeChanged && view.scopeProjectId) {
    const assertionId = `view_move_assert_${crypto.randomUUID()}`;
    try {
      [result] = await db.batch([
        update,
        moveBatchAssertion(db, assertionId, "saved-view"),
        touchProjectSyncMarker(db, view.scopeProjectId, now),
        moveBatchAssertion(db, `${assertionId}_source`, "source-project"),
      ]);
    } catch (error) {
      if (isConstraintError(error)) {
        throw new ConflictError(
          "Saved View access, scope, or version changed before the update committed",
        );
      }
      throw error;
    }
  } else {
    result = await update.run();
  }
  if ((result.meta.changes ?? 0) < 1) {
    throw new ConflictError("Saved View access, scope, or version changed before the update committed");
  }
  return loadAccessibleView(currentUser.id, view.id);
}

async function validateSavedViewReferences(
  currentUser: UserRecord,
  query: ViewQuery,
  display: import("./types").ViewDisplay,
  scopeProject: ProjectRecord | null,
  options: { allowedMissingReleaseIds?: ReadonlySet<string> } = {},
) {
  const canonical = canonicalViewQuery(query);
  const snapshot = await getSnapshot(currentUser);
  const projectIds = filterReferenceValues(canonical.conditions, "project");
  const releaseIds = filterReferenceValues(canonical.conditions, "release");
  const statusIds = filterReferenceValues(canonical.conditions, "status");
  const assigneeIds = filterReferenceValues(canonical.conditions, "assignee");
  const labelIds = filterReferenceValues(canonical.conditions, "label");
  const parentIds = filterReferenceValues(canonical.conditions, "parent");
  const groupRefs = labelGroupReferences(canonical.conditions, display.labelGroupId ?? null);

  if (scopeProject && projectIds.some((projectId) => projectId !== scopeProject.id)) {
    throw new ValidationError("A project-scoped Saved View cannot filter outside its Project");
  }
  let projects: ProjectRecord[];
  let releaseCandidates: Array<ReleaseRecord | null>;
  try {
    [projects, releaseCandidates] = await Promise.all([
      Promise.all(projectIds.map((id) => loadAccessibleProject(currentUser.id, id))),
      Promise.all(releaseIds.map(async (id) => {
        try {
          return await loadAccessibleRelease(currentUser.id, id);
        } catch (error) {
          if (error instanceof NotFoundError && options.allowedMissingReleaseIds?.has(id)) {
            return null;
          }
          throw error;
        }
      })),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new ValidationError("Saved View project or release filter is inaccessible");
    }
    throw error;
  }
  const releases = releaseCandidates.filter(
    (release): release is ReleaseRecord => release !== null,
  );
  if (scopeProject && releases.some((release) => release?.projectId !== scopeProject.id)) {
    throw new ValidationError("Saved View release must belong to its scoped Project");
  }
  if (projects.length === 1 && releases.some(
    (release) => release.projectId !== projects[0]!.id,
  )) {
    throw new ValidationError("Saved View release does not belong to its Project filter");
  }
  if (statusIds.some(
    (statusId) => !snapshot.statuses.some((status) => status.id === statusId),
  )) {
    throw new ValidationError("Saved View status filter is inaccessible");
  }
  if (assigneeIds.some(
    (userId) => !snapshot.users.some((user) => user.id === userId),
  )) {
    throw new ValidationError("Saved View assignee filter is inaccessible");
  }
  if (labelIds.some(
    (labelId) => !snapshot.labels.some((label) => label.id === labelId),
  )) {
    throw new ValidationError("Saved View label filter is inaccessible");
  }
  await validateAccessibleLabelGroupReferences(currentUser, groupRefs);
  for (const taskId of parentIds) {
    try {
      await loadAccessibleTask(currentUser.id, taskId);
    } catch {
      throw new ValidationError("Saved View parent filter is inaccessible");
    }
  }
}

export async function validateTaskFilterReferences(
  currentUser: UserRecord,
  query: ViewQuery,
  scopeProject: ProjectRecord | null,
  allowInertMissingReferences = false,
) {
  const conditions = canonicalViewQuery(query).conditions;
  const projectIds = filterReferenceValues(conditions, "project");
  const releaseIds = filterReferenceValues(conditions, "release");
  const statusIds = filterReferenceValues(conditions, "status");
  const assigneeIds = filterReferenceValues(conditions, "assignee");
  const labelIds = filterReferenceValues(conditions, "label");
  const parentIds = filterReferenceValues(conditions, "parent");
  const groupRefs = labelGroupReferences(conditions, null);

  if (scopeProject && projectIds.some((projectId) => projectId !== scopeProject.id)) {
    throw new ValidationError("A project-scoped Saved View cannot filter outside its Project");
  }

  // Runtime filters are logical references. A reference that was later
  // deleted or purged remains a valid, inert predicate instead of disclosing
  // whether that resource still exists. Creation/update validation stays
  // strict in validateSavedViewReferences.
  const [projectCandidates, releaseCandidates] = await Promise.all([
    Promise.all(projectIds.map((id) =>
      loadAccessibleProject(currentUser.id, id).catch(() => null)
    )),
    Promise.all(releaseIds.map((id) =>
      loadAccessibleRelease(currentUser.id, id).catch(() => null)
    )),
  ]);
  const projects = projectCandidates.filter(
    (project): project is ProjectRecord => project !== null,
  );
  const releases = releaseCandidates.filter(
    (release): release is ReleaseRecord => release !== null,
  );
  if (
    !allowInertMissingReferences &&
    (projects.length !== projectIds.length || releases.length !== releaseIds.length)
  ) {
    throw new ValidationError("Task filter reference is inaccessible");
  }
  if (scopeProject && releases.some((release) => release.projectId !== scopeProject.id)) {
    throw new ValidationError("Saved View release must belong to its scoped Project");
  }
  if (projects.length === 1 && releases.some(
    (release) => release.projectId !== projects[0]!.id,
  )) {
    throw new ValidationError("Saved View release does not belong to its Project filter");
  }

  const db = getD1();
  const checks: Array<{
    ids: string[];
    statement: D1PreparedStatement;
    message: string;
  }> = [];
  if (statusIds.length) {
    checks.push({
      ids: statusIds,
      message: "Saved View status filter is inaccessible",
      statement: db.prepare(
        `SELECT s.id FROM workflow_statuses s
         CROSS JOIN (SELECT ? AS id) filter_actor
         WHERE s.id IN (${filterPlaceholders(statusIds.length)})
           AND ${catalogOwnerAccessibleSql("s.owner_user_id", "filter_actor")}`,
      ).bind(currentUser.id, ...statusIds),
    });
  }
  if (assigneeIds.length) {
    checks.push({
      ids: assigneeIds,
      message: "Saved View assignee filter is inaccessible",
      statement: db.prepare(
        `SELECT u.id FROM users u
         CROSS JOIN (SELECT ? AS id) filter_actor
         WHERE u.id IN (${filterPlaceholders(assigneeIds.length)}) AND (
           u.id = filter_actor.id OR EXISTS (
             SELECT 1 FROM projects p
             WHERE p.deleted_at IS NULL
               AND ${projectEffectiveRoleRankSql("p", "filter_actor.id")} > 0
               AND ${projectEffectiveRoleRankSql("p", "u.id")} > 0
           ) OR EXISTS (
             SELECT 1 FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
             WHERE t.deleted_at IS NULL
               AND (t.project_id IS NULL OR p.deleted_at IS NULL)
               AND ${taskEffectiveRoleRankSql("t", "p", "filter_actor.id")} > 0
               AND ${taskEffectiveRoleRankSql("t", "p", "u.id")} > 0
           )
         )`,
      ).bind(currentUser.id, ...assigneeIds),
    });
  }
  if (labelIds.length) {
    checks.push({
      ids: labelIds,
      message: "Saved View label filter is inaccessible",
      statement: db.prepare(
        `SELECT l.id FROM labels l
         CROSS JOIN (SELECT ? AS id) filter_actor
         WHERE l.id IN (${filterPlaceholders(labelIds.length)})
           AND ${catalogOwnerAccessibleSql("l.owner_user_id", "filter_actor")}`,
      ).bind(currentUser.id, ...labelIds),
    });
  }
  if (checks.length) {
    const results = await db.batch<DbRow>(checks.map((check) => check.statement));
    results.forEach((result, index) => {
      const check = checks[index]!;
      if (new Set(result.results.map((row) => String(row.id))).size !== check.ids.length) {
        throw new ValidationError(check.message);
      }
    });
  }
  await validateAccessibleLabelGroupReferences(currentUser, groupRefs);
  for (const taskId of parentIds) {
    try {
      await loadAccessibleTask(currentUser.id, taskId);
    } catch {
      if (!allowInertMissingReferences) {
        throw new ValidationError("Saved View parent filter is inaccessible");
      }
    }
  }
}

function filterPlaceholders(length: number) {
  return Array.from({ length }, () => "?").join(", ");
}

function catalogOwnerAccessibleSql(
  ownerExpression: string,
  actorAlias: string,
): string {
  return `(${ownerExpression} = ${actorAlias}.id OR EXISTS (
    SELECT 1 FROM projects catalog_project
    WHERE catalog_project.owner_user_id = ${ownerExpression}
      AND catalog_project.deleted_at IS NULL
      AND ${projectEffectiveRoleRankSql(
        "catalog_project",
        `${actorAlias}.id`,
      )} > 0
  ) OR EXISTS (
    SELECT 1 FROM tasks catalog_task
    LEFT JOIN projects catalog_task_project
      ON catalog_task_project.id = catalog_task.project_id
    WHERE CASE WHEN catalog_task.project_id IS NOT NULL
        THEN catalog_task_project.owner_user_id
        ELSE catalog_task.owner_user_id END = ${ownerExpression}
      AND catalog_task.deleted_at IS NULL
      AND (catalog_task.project_id IS NULL
        OR catalog_task_project.deleted_at IS NULL)
      AND ${taskEffectiveRoleRankSql(
        "catalog_task",
        "catalog_task_project",
        `${actorAlias}.id`,
      )} > 0
  ))`;
}

function filterReferenceValues(
  conditions: ViewFilterCondition[],
  field: ViewFilterCondition["field"],
) {
  return [...new Set(conditions
    .filter((condition) => condition.field === field && condition.operator !== "is_empty")
    .flatMap((condition) => Array.isArray(condition.value)
      ? condition.value
      : typeof condition.value === "string"
        ? [condition.value]
        : []))];
}

function labelGroupReferences(
  conditions: ViewFilterCondition[],
  displayGroupId: string | null,
) {
  const refs = conditions
    .filter((condition) => condition.field === "label_group")
    .map((condition) => condition.value as import("./types").ViewFilterLabelGroupValue);
  const groupIds = [...new Set([
    ...refs.map((value) => value.groupId),
    ...(displayGroupId ? [displayGroupId] : []),
  ])];
  const labelIds = [...new Set(refs.flatMap((value) => value.labelIds ?? []))];
  return { groupIds, labelIds };
}

async function validateAccessibleLabelGroupReferences(
  currentUser: UserRecord,
  refs: { groupIds: string[]; labelIds: string[] },
) {
  if (!refs.groupIds.length && !refs.labelIds.length) return;
  const db = getD1();
  if (refs.groupIds.length) {
    const rows = await db.prepare(
      `SELECT g.id FROM label_groups g
       CROSS JOIN (SELECT ? AS id) filter_actor
       WHERE g.id IN (${sqlPlaceholders(refs.groupIds)})
         AND ${catalogOwnerAccessibleSql("g.owner_user_id", "filter_actor")}`,
    ).bind(currentUser.id, ...refs.groupIds).all<DbRow>();
    if (new Set(rows.results.map((row) => String(row.id))).size !== refs.groupIds.length) {
      throw new ValidationError("Saved View Label Group is inaccessible");
    }
  }
  if (refs.labelIds.length) {
    const rows = await db.prepare(
      `SELECT l.id FROM labels l
       CROSS JOIN (SELECT ? AS id) filter_actor
       WHERE l.id IN (${sqlPlaceholders(refs.labelIds)})
         AND l.group_id IN (${sqlPlaceholders(refs.groupIds)})
         AND ${catalogOwnerAccessibleSql("l.owner_user_id", "filter_actor")}`,
    ).bind(currentUser.id, ...refs.labelIds, ...refs.groupIds).all<DbRow>();
    if (new Set(rows.results.map((row) => String(row.id))).size !== refs.labelIds.length) {
      throw new ValidationError("Saved View Label Group value is inaccessible");
    }
  }
}
