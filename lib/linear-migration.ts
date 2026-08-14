import { getD1 } from "@/db";
import { ValidationError } from "./domain";
import {
  buildLinearImportPlan,
  type LinearImportPlan,
  type LinearUserMapping,
} from "./linear-import";
import { loadLinearSnapshotRows } from "./linear-oauth";
import type { LoadedLinearSnapshot } from "./linear-oauth";
import { linearApplyGuardBindings, linearApplyGuardSql } from "./linear-migration-sql";
import { assertLinearScopeIds, selectLinearScope, type LinearScope } from "./linear-scope";
import { ensureDatabase } from "./repository";
import type {
  AppliedLinearMigration,
  LinearMigrationPreview,
  UserRecord,
} from "./types";

type JsonObject = Record<string, unknown>;
type Scope = LinearScope;
type StagedRow = { type: string; ordinal: number; value: JsonObject };

export async function previewLinearMigration(
  currentUser: UserRecord,
  input: { sessionId: string; scope: unknown; userMapping: unknown },
): Promise<LinearMigrationPreview> {
  const userMapping = normalizeUserMapping(input.userMapping);
  const snapshot = await loadLinearSnapshotRows(currentUser, input.sessionId);
  const scoped = buildScopedLinearPayload(snapshot, input.scope);
  const scope = scoped.scope;
  const selection = scoped.selection;
  if (selection.issues.length === 0 && selection.projects.length === 0) {
    throw new ValidationError("The selected Linear scope contains no projects or issues");
  }
  await ensureDatabase();
  const db = getD1();
  const targetUsers = await db.prepare("SELECT id FROM users").all<{ id: string }>();
  const validTargetUsers = new Set(targetUsers.results.map((user) => user.id));
  for (const targetId of Object.values(userMapping)) {
    if (targetId !== null && !validTargetUsers.has(targetId)) throw new ValidationError("Linear user mapping targets an unknown Task Manager user");
  }

  const payload = scoped.payload;
  const plan = buildLinearImportPlan(currentUser.id, payload, userMapping);
  await reconcilePlanWithLiveState(db, currentUser, plan);
  await validateMappedUserAccess(db, currentUser.id, plan);
  const rows = await planRows(db, currentUser.id, plan);
  const sha256 = await checksumRows(rows);
  const existing = await countExistingTargets(db, plan);
  const selectedAssigneeIds = new Set(
    selection.issues
      .map((issue) => objectOrNull(issue.assignee)?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const unmappedUsers = snapshot.users
    .filter((user) => selectedAssigneeIds.has(String(user.id)))
    .filter((user) => !mappedTarget(String(user.id), snapshot.inventory.viewer.id, currentUser.id, userMapping))
    .map((user) => ({ id: String(user.id), name: String(user.name), email: String(user.email ?? "") }));
  const warnings = [...snapshot.inventory.warnings, ...selection.warnings];
  if (unmappedUsers.length) warnings.push(`${unmappedUsers.length} Linear assignee(s) will remain unassigned.`);
  const counts = {
    statuses: plan.statuses.length,
    labels: plan.labels.length,
    projects: plan.projects.length,
    releases: plan.releases.length,
    tasks: plan.tasks.length,
    taskLabels: plan.taskLabels.length,
    relations: plan.relations.length,
    views: plan.views.length,
    externalRecords: plan.externalRecords.length,
  };
  const preview: LinearMigrationPreview = {
    importId: input.sessionId,
    workspace: snapshot.inventory.organization.name,
    scope,
    sourceCounts: snapshot.inventory.counts,
    counts,
    changes: { create: rows.filter((row) => isEntityRow(row.type)).length - existing, update: existing },
    mappedUsers: new Set(Object.values(userMapping).filter(Boolean)).size +
      (selectedAssigneeIds.has(snapshot.inventory.viewer.id) ? 1 : 0),
    unmappedUsers,
    warnings,
    sha256,
  };
  const planTypes = [...new Set(rows.map((row) => row.type))];
  const transition = await db.prepare(`UPDATE user_import_sessions SET status = 'planning',
      scope_json = '{}', preview_json = '{}', payload_sha256 = NULL
      WHERE id = ? AND created_by_user_id = ? AND kind = 'linear'
      AND status IN ('snapshot', 'staged')`)
      .bind(input.sessionId, currentUser.id).run();
  if (transition.meta.changes !== 1) throw new ValidationError("Linear snapshot is no longer available for preview");
  try {
    await db.prepare(`DELETE FROM user_import_rows WHERE import_id = ? AND row_type NOT LIKE 'linear_%'`).bind(input.sessionId).run();
    for (let offset = 0; offset < rows.length; offset += 500) {
      const statements: D1PreparedStatement[] = [];
      const portion = rows.slice(offset, offset + 500);
      for (let rowOffset = 0; rowOffset < portion.length; rowOffset += 25) {
        const group = portion.slice(rowOffset, rowOffset + 25);
        statements.push(
          db.prepare(`INSERT INTO user_import_rows (import_id, row_type, ordinal, row_json) VALUES ${group.map(() => "(?, ?, ?, ?)").join(", ")}`)
            .bind(...group.flatMap((row) => [input.sessionId, row.type, row.ordinal, JSON.stringify(row.value)])),
        );
      }
      await db.batch(statements);
    }
    await db.prepare(`UPDATE user_import_sessions SET status = 'staged', scope_json = ?,
        preview_json = ?, payload_sha256 = ? WHERE id = ? AND created_by_user_id = ?
        AND kind = 'linear' AND status = 'planning'`)
        .bind(JSON.stringify({ scope, userMapping, planTypes }), JSON.stringify(preview), sha256, input.sessionId, currentUser.id).run();
  } catch (error) {
    await db.batch([
      db.prepare(`DELETE FROM user_import_rows WHERE import_id = ? AND row_type NOT LIKE 'linear_%'`).bind(input.sessionId),
      db.prepare(`UPDATE user_import_sessions SET status = 'snapshot', scope_json = '{}',
        preview_json = '{}', payload_sha256 = NULL WHERE id = ? AND created_by_user_id = ?
        AND kind = 'linear' AND status = 'planning'`).bind(input.sessionId, currentUser.id),
    ]);
    throw error;
  }
  return preview;
}

export function buildScopedLinearPayload(snapshot: LoadedLinearSnapshot, value: unknown) {
  const scope = normalizeScope(value);
  validateScopeIds(scope, snapshot.projects, snapshot.users);
  const selection = selectLinearSnapshot(snapshot, scope);
  return { scope, selection, payload: toLegacyLinearPayload(snapshot, selection) };
}

export async function applyLinearMigration(
  currentUser: UserRecord,
  input: { importId: string; sha256: string; confirmation: string },
): Promise<AppliedLinearMigration> {
  if (!input.importId.startsWith("linear-import:") || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new ValidationError("Invalid staged Linear migration reference");
  }
  if (input.confirmation !== "IMPORT") throw new ValidationError("Type IMPORT to confirm Linear migration");
  await ensureDatabase();
  const db = getD1();
  const session = await db.prepare(`SELECT preview_json FROM user_import_sessions
    WHERE id = ? AND created_by_user_id = ? AND kind = 'linear' AND status = 'staged'
      AND payload_sha256 = ? AND expires_at >= CURRENT_TIMESTAMP`)
    .bind(input.importId, currentUser.id, input.sha256)
    .first<{ preview_json: string }>();
  if (!session) throw new ValidationError("Staged Linear migration is missing or expired");
  const preview = JSON.parse(session.preview_json) as LinearMigrationPreview;
  const transition = await db.prepare(`UPDATE user_import_sessions SET status = 'applying'
    WHERE id = ? AND created_by_user_id = ? AND kind = 'linear' AND status = 'staged'
      AND payload_sha256 = ? AND expires_at >= CURRENT_TIMESTAMP`)
    .bind(input.importId, currentUser.id, input.sha256).run();
  if (transition.meta.changes !== 1) throw new ValidationError("Linear migration is already being applied");
  const statements: D1PreparedStatement[] = [
    linearApplyGuardStatement(db, input.importId, currentUser.id),
    db.prepare(`DELETE FROM task_labels WHERE task_id IN (
      SELECT json_extract(row_json, '$.id') FROM user_import_rows
      WHERE import_id = ? AND row_type = 'tasks'
    )`).bind(input.importId),
    db.prepare(`DELETE FROM task_relations WHERE
      source_task_id IN (SELECT json_extract(row_json, '$.id') FROM user_import_rows WHERE import_id = ? AND row_type = 'tasks')
      AND target_task_id IN (SELECT json_extract(row_json, '$.id') FROM user_import_rows WHERE import_id = ? AND row_type = 'tasks')`)
      .bind(input.importId, input.importId),
    insertIgnoreStatement(db, input.importId, "workflow_statuses",
      ["id", "owner_user_id", "name", "category", "color", "position", "is_default", "created_at", "updated_at"],
    ),
    insertIgnoreStatement(db, input.importId, "labels",
      ["id", "owner_user_id", "name", "color", "created_at"]),
    upsertStatement(db, input.importId, "projects",
      ["id", "public_id", "owner_user_id", "creator_user_id", "name", "summary", "description", "status", "lead_user_id", "start_date", "target_date", "icon", "color", "archived_at", "version", "created_at", "updated_at"],
      ["name", "summary", "description", "status", "lead_user_id", "start_date", "target_date", "icon", "color", "archived_at", "updated_at"]),
    upsertStatement(db, input.importId, "releases",
      ["id", "public_id", "project_id", "owner_user_id", "creator_user_id", "name", "description", "status", "target_date", "released_at", "release_notes", "version", "created_at", "updated_at"],
      ["project_id", "name", "description", "status", "target_date", "updated_at"]),
    upsertStatement(db, input.importId, "tasks",
      ["id", "public_id", "owner_user_id", "creator_user_id", "identifier", "sequence_number", "title", "description", "status_id", "priority", "assignee_user_id", "project_id", "release_id", "estimate", "due_date", "parent_task_id", "rank", "started_at", "completed_at", "canceled_at", "archived_at", "version", "created_at", "updated_at"],
      ["title", "description", "status_id", "priority", "assignee_user_id", "project_id", "release_id", "estimate", "due_date", "parent_task_id", "rank", "started_at", "completed_at", "canceled_at", "archived_at", "updated_at"]),
    upsertStatement(db, input.importId, "saved_views",
      ["id", "public_id", "owner_user_id", "name", "scope_project_id", "query_json", "display_json", "version", "created_at", "updated_at"],
      ["name", "scope_project_id", "query_json", "display_json", "updated_at"]),
    db.prepare(`INSERT OR IGNORE INTO task_labels (task_id, label_id)
      SELECT json_extract(row_json, '$.task_id'), json_extract(row_json, '$.label_id')
      FROM user_import_rows WHERE import_id = ? AND row_type = 'task_labels' ORDER BY ordinal`).bind(input.importId),
    db.prepare(`INSERT OR IGNORE INTO task_relations
      (source_task_id, target_task_id, type, creator_user_id, created_at)
      SELECT json_extract(row_json, '$.source_task_id'), json_extract(row_json, '$.target_task_id'),
        json_extract(row_json, '$.type'), json_extract(row_json, '$.creator_user_id'),
        json_extract(row_json, '$.created_at')
      FROM user_import_rows WHERE import_id = ? AND row_type = 'task_relations' ORDER BY ordinal`).bind(input.importId),
    upsertStatement(db, input.importId, "external_records",
      ["id", "owner_user_id", "target_type", "target_id", "source", "source_id", "source_url", "metadata_json", "imported_at"],
      ["target_type", "target_id", "source_id", "source_url", "metadata_json", "imported_at"]),
    db.prepare("UPDATE user_import_sessions SET status = 'applied', applied_at = CURRENT_TIMESTAMP, secret_json = '{}' WHERE id = ? AND status = 'applying'").bind(input.importId),
    db.prepare("DELETE FROM user_import_rows WHERE import_id = ?").bind(input.importId),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    await db.prepare("UPDATE user_import_sessions SET status = 'staged' WHERE id = ? AND status = 'applying'")
      .bind(input.importId).run();
    throw error;
  }
  await db.prepare("PRAGMA optimize").run();
  return { applied: true, counts: preview.counts, warnings: preview.warnings };
}

function selectLinearSnapshot(
  snapshot: Awaited<ReturnType<typeof loadLinearSnapshotRows>>,
  scope: Scope,
) {
  return selectLinearScope(snapshot, scope);
}

function toLegacyLinearPayload(
  snapshot: Awaited<ReturnType<typeof loadLinearSnapshotRows>>,
  selection: ReturnType<typeof selectLinearSnapshot>,
) {
  const selectedIdentifiers = new Set(selection.issues.map((issue) => String(issue.identifier)));
  const commentsByIssue: Record<string, JsonObject[]> = {};
  const issues = selection.issues.map((issue) => {
    const identifier = String(issue.identifier);
    commentsByIssue[identifier] = connectionNodes(issue.comments).map((comment) => ({
      ...comment,
      author: objectOrNull(comment.user),
    }));
    const outgoing = connectionNodes(issue.relations);
    const relatedTo = outgoing
      .filter((relation) => relation.type === "related")
      .map((relation) => relation.relatedIssue as JsonObject)
      .filter((target) => target && selectedIdentifiers.has(String(target.identifier)))
      .map((target) => ({ id: String(target.identifier), title: String(target.title ?? "") }));
    const blocks = outgoing
      .filter((relation) => relation.type === "blocks")
      .map((relation) => relation.relatedIssue as JsonObject)
      .filter((target) => target && selectedIdentifiers.has(String(target.identifier)))
      .map((target) => ({ id: String(target.identifier), title: String(target.title ?? "") }));
    const duplicate = outgoing.find((relation) => relation.type === "duplicate");
    const duplicateTarget = duplicate ? objectOrNull(duplicate.relatedIssue) : null;
    const project = objectOrNull(issue.project);
    const milestone = objectOrNull(issue.projectMilestone);
    const parent = objectOrNull(issue.parent);
    return {
      ...issue,
      id: identifier,
      sourceId: String(issue.id),
      status: String(objectOrNull(issue.state)?.name ?? ""),
      statusType: String(objectOrNull(issue.state)?.type ?? ""),
      priority: { value: Number(issue.priority ?? 0), name: String(issue.priorityLabel ?? "") },
      assigneeId: objectOrNull(issue.assignee)?.id ?? null,
      projectId: project?.id ?? null,
      projectMilestone: milestone ? { id: milestone.id, name: milestone.name } : null,
      parentId: parent && selectedIdentifiers.has(String(parent.identifier)) ? parent.identifier : null,
      labels: connectionNodes(issue.labels).map((label) => String(label.name)),
      attachments: connectionNodes(issue.attachments),
      stateHistory: connectionNodes(issue.stateHistory),
      gitBranchName: issue.branchName ?? null,
      relations: {
        blocks,
        blockedBy: [],
        relatedTo,
        duplicateOf: duplicateTarget && selectedIdentifiers.has(String(duplicateTarget.identifier))
          ? { id: duplicateTarget.identifier, title: duplicateTarget.title ?? "" }
          : null,
      },
    };
  });
  return {
    version: 1,
    source: {
      provider: "linear",
      workspace: snapshot.inventory.organization.name,
      organizationId: snapshot.inventory.organization.id,
      viewerId: snapshot.inventory.viewer.id,
      exportedAt: new Date().toISOString(),
    },
    statuses: selection.statuses,
    labels: selection.labels,
    projects: selection.projects.map((project) => ({
      ...project,
      summary: "",
      milestones: connectionNodes(project.projectMilestones),
    })),
    issues,
    views: selection.views.map((view) => linearView(view)),
    commentsByIssue,
  };
}

function linearView(view: JsonObject) {
  const projects = connectionNodes(view.projects);
  const preferences = objectOrNull(objectOrNull(view.userViewPreferences)?.preferences) ?? {};
  const layout = preferences.layout === "board" ? "board" : "list";
  const group = String(preferences.issueGrouping ?? "status").toLowerCase();
  return {
    sourceId: String(view.id), name: String(view.name), description: String(view.description ?? ""),
    url: null,
    sourceProjectId: projects.length === 1 ? String(projects[0].id) : null,
    query: {},
    display: {
      layout,
      groupBy: group === "priority" || group === "project" ? group : group === "none" ? "none" : "status",
      orderBy: mapViewOrder(preferences.viewOrdering),
      direction: preferences.viewOrderingDirection === "desc" ? "desc" : "asc",
      showEmptyGroups: layout === "board" ? preferences.showEmptyGroupsBoard === true : preferences.showEmptyGroupsList === true,
      visibleFields: [
        preferences.fieldPriority === true ? "priority" : null,
        preferences.fieldProject === true ? "project" : null,
        preferences.fieldMilestone === true ? "release" : null,
        preferences.fieldDueDate === true ? "dueDate" : null,
        preferences.fieldAssignee === true ? "assignee" : null,
      ].filter(Boolean),
    },
    rawFilterData: view.filterData,
    rawProjectFilterData: view.projectFilterData,
  };
}

async function reconcilePlanWithLiveState(db: D1Database, currentUser: UserRecord, plan: LinearImportPlan) {
  const [external, statuses, labels, tasks] = await Promise.all([
    db.prepare("SELECT id, target_type, target_id, source_id FROM external_records WHERE owner_user_id = ? AND source = 'linear'")
      .bind(currentUser.id).all<{ id: string; target_type: string; target_id: string; source_id: string }>(),
    db.prepare("SELECT id, name FROM workflow_statuses WHERE owner_user_id = ?").bind(currentUser.id).all<{ id: string; name: string }>(),
    db.prepare("SELECT id, name FROM labels WHERE owner_user_id = ?").bind(currentUser.id).all<{ id: string; name: string }>(),
    db.prepare("SELECT id, identifier, sequence_number FROM tasks WHERE owner_user_id = ?").bind(currentUser.id).all<{ id: string; identifier: string; sequence_number: number }>(),
  ]);
  const targetBySource = new Map(external.results.map((row) => [`${row.target_type}\u0000${row.source_id}`, row]));
  const idRemap = new Map<string, string>();
  const entities = [
    ...plan.projects.map((row) => ({ type: "project", row })),
    ...plan.releases.map((row) => ({ type: "release", row })),
    ...plan.tasks.map((row) => ({ type: "task", row })),
    ...plan.views.map((row) => ({ type: "saved_view", row })),
    ...plan.labels.map((row) => ({ type: "label", row })),
    ...plan.statuses.map((row) => ({ type: "workflow_status", row })),
  ];
  for (const entity of entities) {
    const existing = targetBySource.get(`${entity.type}\u0000${entity.row.sourceId}`);
    if (existing && existing.target_id !== entity.row.id) idRemap.set(entity.row.id, existing.target_id);
  }
  const statusByName = new Map(statuses.results.map((row) => [row.name.toLowerCase(), row.id]));
  for (const status of plan.statuses) {
    const existing = statusByName.get(status.name.toLowerCase());
    if (existing && existing !== status.id) idRemap.set(status.id, existing);
  }
  const labelByName = new Map(labels.results.map((row) => [row.name.toLowerCase(), row.id]));
  for (const label of plan.labels) {
    const existing = labelByName.get(label.name.toLowerCase());
    if (existing && existing !== label.id) idRemap.set(label.id, existing);
  }
  applyIdRemap(plan, idRemap);
  const taskById = new Map(tasks.results.map((task) => [task.id, task]));
  const taskByIdentifier = new Map(tasks.results.map((task) => [task.identifier, task]));
  let nextSequence = Math.max(0, ...tasks.results.map((task) => Number(task.sequence_number))) + 1;
  for (const task of plan.tasks) {
    const existing = taskById.get(task.id) ?? taskByIdentifier.get(task.identifier);
    if (existing && existing.id !== task.id) throw new ValidationError(`Task identifier ${task.identifier} already belongs to a different record`);
    if (existing) {
      task.identifier = existing.identifier;
      task.sequenceNumber = existing.sequence_number;
    } else {
      task.sequenceNumber = nextSequence++;
    }
  }
  for (const record of plan.externalRecords) {
    const existing = targetBySource.get(`${record.targetType}\u0000${record.sourceId}`);
    if (existing) record.id = existing.id;
  }
}

function applyIdRemap(plan: LinearImportPlan, remap: Map<string, string>) {
  const id = (value: string | null) => value === null ? null : remap.get(value) ?? value;
  for (const status of plan.statuses) status.id = id(status.id)!;
  for (const label of plan.labels) label.id = id(label.id)!;
  for (const project of plan.projects) project.id = id(project.id)!;
  for (const release of plan.releases) { release.id = id(release.id)!; release.projectId = id(release.projectId)!; }
  for (const task of plan.tasks) {
    task.id = id(task.id)!; task.statusId = id(task.statusId)!; task.projectId = id(task.projectId);
    task.releaseId = id(task.releaseId); task.parentTaskId = id(task.parentTaskId);
  }
  for (const assignment of plan.taskLabels) { assignment.taskId = id(assignment.taskId)!; assignment.labelId = id(assignment.labelId)!; }
  for (const relation of plan.relations) { relation.sourceTaskId = id(relation.sourceTaskId)!; relation.targetTaskId = id(relation.targetTaskId)!; }
  for (const view of plan.views) { view.id = id(view.id)!; view.scopeProjectId = id(view.scopeProjectId); }
  for (const view of plan.views) {
    if (typeof view.query.projectId === "string") view.query.projectId = id(view.query.projectId);
    if (typeof view.query.releaseId === "string") view.query.releaseId = id(view.query.releaseId);
  }
  for (const record of plan.externalRecords) record.targetId = id(record.targetId)!;
}

async function validateMappedUserAccess(db: D1Database, ownerUserId: string, plan: LinearImportPlan) {
  const nonOwnerAssignments = plan.tasks.filter((task) => task.assigneeUserId && task.assigneeUserId !== ownerUserId);
  const nonOwnerLeads = plan.projects.filter((project) => project.leadUserId && project.leadUserId !== ownerUserId);
  for (const task of nonOwnerAssignments) {
    if (!task.projectId) throw new ValidationError("A mapped assignee needs an existing direct task grant; import it unassigned first");
    const grant = await db.prepare("SELECT 1 FROM access_grants WHERE resource_type = 'project' AND resource_id = ? AND grantee_user_id = ? AND revoked_at IS NULL")
      .bind(task.projectId, task.assigneeUserId).first();
    if (!grant) throw new ValidationError("A mapped assignee must already have access to every target project");
  }
  for (const project of nonOwnerLeads) {
    const grant = await db.prepare("SELECT 1 FROM access_grants WHERE resource_type = 'project' AND resource_id = ? AND grantee_user_id = ? AND revoked_at IS NULL")
      .bind(project.id, project.leadUserId).first();
    if (!grant) project.leadUserId = null;
  }
}

async function planRows(db: D1Database, ownerUserId: string, plan: LinearImportPlan): Promise<StagedRow[]> {
  const existingPublicIds = await loadExistingPublicIds(db, plan);
  const rows: StagedRow[] = [];
  const push = (type: string, values: JsonObject[]) => values.forEach((value, ordinal) => rows.push({ type, ordinal, value }));
  push("workflow_statuses", plan.statuses.map((row) => ({
    id: row.id, owner_user_id: ownerUserId, name: row.name, category: row.category,
    color: row.color, position: row.position, is_default: row.isDefault,
    created_at: plan.exportedAt, updated_at: plan.exportedAt,
  })));
  push("labels", plan.labels.map((row) => ({ id: row.id, owner_user_id: ownerUserId, name: row.name, color: row.color, created_at: plan.exportedAt })));
  push("projects", plan.projects.map((row) => ({
    id: row.id, public_id: existingPublicIds.get(`project:${row.id}`) ?? crypto.randomUUID(),
    owner_user_id: ownerUserId, creator_user_id: ownerUserId, name: row.name,
    summary: row.summary, description: row.description, status: row.status,
    lead_user_id: row.leadUserId, start_date: row.startDate, target_date: row.targetDate,
    icon: row.icon, color: row.color, archived_at: row.archivedAt, version: 1,
    created_at: row.createdAt, updated_at: row.updatedAt,
  })));
  push("releases", plan.releases.map((row) => ({
    id: row.id, public_id: existingPublicIds.get(`release:${row.id}`) ?? crypto.randomUUID(),
    project_id: row.projectId, owner_user_id: ownerUserId, creator_user_id: ownerUserId,
    name: row.name, description: row.description, status: row.status, target_date: row.targetDate,
    released_at: null, release_notes: "", version: 1, created_at: row.createdAt, updated_at: row.updatedAt,
  })));
  push("tasks", plan.tasks.map((row) => ({
    id: row.id, public_id: existingPublicIds.get(`task:${row.id}`) ?? crypto.randomUUID(),
    owner_user_id: ownerUserId, creator_user_id: ownerUserId, identifier: row.identifier,
    sequence_number: row.sequenceNumber, title: row.title, description: row.description,
    status_id: row.statusId, priority: row.priority, assignee_user_id: row.assigneeUserId,
    project_id: row.projectId, release_id: row.releaseId, estimate: row.estimate,
    due_date: row.dueDate, parent_task_id: row.parentTaskId, rank: row.rank,
    started_at: row.startedAt, completed_at: row.completedAt, canceled_at: row.canceledAt,
    archived_at: row.archivedAt, version: 1, created_at: row.createdAt, updated_at: row.updatedAt,
  })));
  push("saved_views", plan.views.map((row) => ({
    id: row.id, public_id: existingPublicIds.get(`saved_view:${row.id}`) ?? crypto.randomUUID(),
    owner_user_id: ownerUserId, name: row.name, scope_project_id: row.scopeProjectId,
    query_json: JSON.stringify(row.query), display_json: JSON.stringify(row.display),
    version: 1, created_at: plan.exportedAt, updated_at: plan.exportedAt,
  })));
  push("task_labels", plan.taskLabels.map((row) => ({ task_id: row.taskId, label_id: row.labelId })));
  push("task_relations", plan.relations.map((row) => ({
    source_task_id: row.sourceTaskId, target_task_id: row.targetTaskId, type: row.type,
    creator_user_id: ownerUserId, created_at: plan.exportedAt,
  })));
  push("external_records", plan.externalRecords.map((row) => ({
    id: row.id, owner_user_id: ownerUserId, target_type: row.targetType, target_id: row.targetId,
    source: "linear", source_id: row.sourceId, source_url: row.sourceUrl,
    metadata_json: row.metadataJson, imported_at: plan.exportedAt,
  })));
  return rows;
}

async function loadExistingPublicIds(db: D1Database, plan: LinearImportPlan) {
  const result = new Map<string, string>();
  for (const [type, table, ids] of [
    ["project", "projects", plan.projects.map((row) => row.id)],
    ["release", "releases", plan.releases.map((row) => row.id)],
    ["task", "tasks", plan.tasks.map((row) => row.id)],
    ["saved_view", "saved_views", plan.views.map((row) => row.id)],
  ] as const) {
    if (!ids.length) continue;
    for (let offset = 0; offset < ids.length; offset += 90) {
      const group = ids.slice(offset, offset + 90);
      const rows = await db.prepare(`SELECT id, public_id FROM ${table} WHERE id IN (${group.map(() => "?").join(", ")})`)
        .bind(...group).all<{ id: string; public_id: string }>();
      rows.results.forEach((row) => result.set(`${type}:${row.id}`, row.public_id));
    }
  }
  return result;
}

async function countExistingTargets(db: D1Database, plan: LinearImportPlan) {
  let count = 0;
  for (const [table, ids] of [
    ["workflow_statuses", plan.statuses.map((row) => row.id)], ["labels", plan.labels.map((row) => row.id)],
    ["projects", plan.projects.map((row) => row.id)], ["releases", plan.releases.map((row) => row.id)],
    ["tasks", plan.tasks.map((row) => row.id)], ["saved_views", plan.views.map((row) => row.id)],
    ["external_records", plan.externalRecords.map((row) => row.id)],
  ] as const) {
    for (let offset = 0; offset < ids.length; offset += 90) {
      const group = ids.slice(offset, offset + 90);
      if (!group.length) continue;
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id IN (${group.map(() => "?").join(", ")})`)
        .bind(...group).first<{ count: number }>();
      count += Number(row?.count ?? 0);
    }
  }
  return count;
}

function upsertStatement(db: D1Database, importId: string, table: string, columns: string[], updates: string[]) {
  const extract = columns.map((column) => `json_extract(row_json, '$.${column}')`).join(", ");
  return db.prepare(`INSERT INTO ${table} (${columns.join(", ")})
    SELECT ${extract} FROM user_import_rows
    WHERE import_id = ? AND row_type = '${table}' AND 1 = 1
    ON CONFLICT(id) DO UPDATE SET ${updates.map((column) => `${column} = excluded.${column}`).join(", ")}`)
    .bind(importId);
}

function insertIgnoreStatement(db: D1Database, importId: string, table: string, columns: string[]) {
  const extract = columns.map((column) => `json_extract(row_json, '$.${column}')`).join(", ");
  return db.prepare(`INSERT INTO ${table} (${columns.join(", ")})
    SELECT ${extract} FROM user_import_rows
    WHERE import_id = ? AND row_type = '${table}' AND 1 = 1 ORDER BY ordinal
    ON CONFLICT(id) DO NOTHING`).bind(importId);
}

function linearApplyGuardStatement(db: D1Database, importId: string, ownerUserId: string) {
  return db.prepare(linearApplyGuardSql).bind(...linearApplyGuardBindings(importId, ownerUserId));
}

function normalizeScope(value: unknown): Scope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Linear scope is required");
  const row = value as JsonObject;
  if (row.mode !== "workspace" && row.mode !== "projects" && row.mode !== "assignees") throw new ValidationError("Unsupported Linear migration scope");
  const ids = Array.isArray(row.ids) ? [...new Set(row.ids.filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
  if (row.mode !== "workspace" && ids.length === 0) throw new ValidationError("Select at least one Linear project or assignee");
  if (ids.length > 100) throw new ValidationError("Select at most 100 Linear scope values");
  return { mode: row.mode, ids: row.mode === "workspace" ? [] : ids };
}

function normalizeUserMapping(value: unknown): LinearUserMapping {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Linear user mapping must be an object");
  const result: LinearUserMapping = {};
  for (const [source, target] of Object.entries(value as JsonObject)) {
    if (target !== null && typeof target !== "string") throw new ValidationError("Linear user mapping target must be a user ID or null");
    result[source] = target as string | null;
  }
  return result;
}

function validateScopeIds(scope: Scope, projects: JsonObject[], users: JsonObject[]) {
  assertLinearScopeIds(scope, projects, users);
}

function connectionNodes(value: unknown): JsonObject[] {
  const connection = objectOrNull(value);
  return Array.isArray(connection?.nodes) ? connection.nodes.filter((node): node is JsonObject => Boolean(objectOrNull(node))) : [];
}

function objectOrNull(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function mapViewOrder(value: unknown) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("priority")) return "priority";
  if (normalized.includes("created")) return "created";
  if (normalized.includes("updated")) return "updated";
  if (normalized.includes("due")) return "due";
  if (normalized.includes("title")) return "title";
  return "manual";
}

function mappedTarget(sourceId: string, viewerId: string, ownerId: string, mapping: LinearUserMapping) {
  if (Object.prototype.hasOwnProperty.call(mapping, sourceId)) return mapping[sourceId];
  return sourceId === viewerId ? ownerId : null;
}

function isEntityRow(type: string) {
  return type !== "task_labels" && type !== "task_relations";
}

async function checksumRows(rows: StagedRow[]) {
  const value = rows.map((row) => `${row.type}:${row.ordinal}:${JSON.stringify(row.value)}`).join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
