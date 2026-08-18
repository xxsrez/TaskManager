import type { UserRecord, ViewDisplay, ViewQuery } from "./types";
import { optionalDate, ValidationError } from "./domain";

type JsonObject = Record<string, unknown>;

export const maxLinearImportBytes = 10_000_000;

export function decodeLinearImportPayload(bytes: Uint8Array): {
  tooLarge: boolean;
  payload: unknown;
} {
  if (bytes.byteLength > maxLinearImportBytes) {
    return { tooLarge: true, payload: null };
  }
  try {
    return {
      tooLarge: false,
      payload: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    };
  } catch {
    return { tooLarge: false, payload: null };
  }
}

export type LinearImportReport = {
  statuses: number;
  labels: number;
  projects: number;
  releases: number;
  tasks: number;
  taskLabels: number;
  relations: number;
  views: number;
  externalRecords: number;
};

type PlannedStatus = {
  id: string;
  sourceId: string;
  sourceName: string;
  name: string;
  category: string;
  color: string;
  position: number;
  isDefault: number;
};

type PlannedProject = {
  id: string;
  sourceId: string;
  name: string;
  summary: string;
  description: string;
  status: string;
  leadUserId: string | null;
  startDate: string | null;
  targetDate: string | null;
  icon: string;
  color: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type PlannedRelease = {
  id: string;
  sourceId: string;
  projectId: string;
  name: string;
  description: string;
  status: "active";
  targetDate: string | null;
  createdAt: string;
  updatedAt: string;
};

type PlannedTask = {
  id: string;
  sourceId: string;
  identifier: string;
  sequenceNumber: number;
  title: string;
  description: string;
  statusId: string;
  priority: "urgent" | "high" | "medium" | "low" | "none";
  assigneeUserId: string | null;
  projectId: string | null;
  releaseId: string | null;
  estimate: number | null;
  dueDate: string | null;
  parentTaskId: string | null;
  rank: number;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type PlannedLabel = {
  id: string;
  sourceId: string;
  name: string;
  color: string;
};

type PlannedRelation = {
  sourceTaskId: string;
  targetTaskId: string;
  type: "blocks" | "related" | "duplicate_of";
};

type PlannedView = {
  id: string;
  sourceId: string;
  name: string;
  scopeProjectId: string | null;
  query: ViewQuery;
  display: ViewDisplay;
};

type PlannedExternalRecord = {
  id: string;
  targetType: "task" | "project" | "release" | "saved_view" | "label" | "workflow_status";
  targetId: string;
  sourceId: string;
  sourceUrl: string | null;
  metadataJson: string;
};

export type LinearImportPlan = {
  exportedAt: string;
  statuses: PlannedStatus[];
  labels: PlannedLabel[];
  projects: PlannedProject[];
  releases: PlannedRelease[];
  tasks: PlannedTask[];
  taskLabels: Array<{ taskId: string; labelId: string }>;
  relations: PlannedRelation[];
  views: PlannedView[];
  externalRecords: PlannedExternalRecord[];
};

const STATUS_PRESENTATION: Record<
  string,
  { category: string; color: string; position: number; isDefault?: boolean }
> = {
  Backlog: { category: "backlog", color: "#6b7280", position: 0 },
  Todo: {
    category: "unstarted",
    color: "#94a3b8",
    position: 1,
    isDefault: true,
  },
  "In Progress": { category: "started", color: "#f59e0b", position: 2 },
  "In Review": { category: "started", color: "#5e6ad2", position: 3 },
  Done: { category: "completed", color: "#22c55e", position: 4 },
  Canceled: { category: "canceled", color: "#ef4444", position: 5 },
  Duplicate: { category: "canceled", color: "#9ca3af", position: 6 },
};

const BASE_STATUS_NAMES = new Set([
  "Backlog",
  "Todo",
  "In Progress",
  "Done",
  "Canceled",
]);

export function buildLinearImportPlan(
  ownerUserId: string,
  value: unknown,
): LinearImportPlan {
  const payload = object(value, "Linear import payload");
  if (payload.version !== 1) {
    throw new ValidationError("Unsupported Linear import payload version");
  }
  const source = object(payload.source, "Linear import source");
  if (source.provider !== "linear") {
    throw new ValidationError("Import source must be Linear");
  }
  const exportedAt = isoInstant(source.exportedAt, "exportedAt");
  const sourceStatuses = array(payload.statuses, "statuses");
  const sourceLabels = array(payload.labels, "labels");
  const sourceProjects = array(payload.projects, "projects");
  const sourceIssues = array(payload.issues, "issues");
  const sourceViews = array(payload.views, "views");
  const commentsByIssue = object(
    payload.commentsByIssue ?? {},
    "commentsByIssue",
  );
  const externalRecords: PlannedExternalRecord[] = [];

  const statuses = sourceStatuses.map((entry, index) => {
    const row = object(entry, `statuses[${index}]`);
    const sourceId = requiredString(row.id, `statuses[${index}].id`);
    const sourceName = requiredString(row.name, `statuses[${index}].name`);
    const name = sourceName;
    const presentation = STATUS_PRESENTATION[sourceName] ?? {
      category: statusCategory(row.type),
      color: "#6b7280",
      position: 100 + index,
    };
    const status = {
      id: statusTargetId(ownerUserId, sourceName, presentation.category),
      sourceId,
      sourceName,
      name,
      category: presentation.category,
      color: presentation.color,
      position: presentation.position,
      isDefault: presentation.isDefault ? 1 : 0,
    };
    externalRecords.push(
      externalRecord(
        ownerUserId,
        "workflow_status",
        status.id,
        sourceId,
        row,
      ),
    );
    return status;
  });
  const statusByName = new Map(statuses.map((status) => [status.sourceName, status]));

  const labels = sourceLabels.map((entry, index) => {
    const row = object(entry, `labels[${index}]`);
    const sourceId = requiredString(row.id, `labels[${index}].id`);
    return {
      id: targetId(ownerUserId, "label", sourceId),
      sourceId,
      name: requiredString(row.name, `labels[${index}].name`),
      color: optionalString(row.color) ?? "#6b7280",
    };
  });
  const labelByName = new Map(labels.map((label) => [label.name, label]));

  const projectBySourceId = new Map<string, PlannedProject>();
  const releases: PlannedRelease[] = [];
  const releaseBySourceId = new Map<string, PlannedRelease>();
  const projects = sourceProjects.map((entry, index) => {
    const row = object(entry, `projects[${index}]`);
    const sourceId = requiredString(row.id, `projects[${index}].id`);
    const status = object(row.status, `projects[${index}].status`);
    const project: PlannedProject = {
      id: targetId(ownerUserId, "project", sourceId),
      sourceId,
      name: requiredString(row.name, `projects[${index}].name`),
      summary: optionalString(row.summary) ?? "",
      description: optionalString(row.description) ?? "",
      status: projectStatus(status.type),
      leadUserId: row.lead ? ownerUserId : null,
      startDate: optionalDate(row.startDate),
      targetDate: optionalDate(row.targetDate),
      icon: optionalString(row.icon) ?? "cube",
      color: optionalString(row.color) ?? "#8b7cf6",
      archivedAt: optionalInstant(row.archivedAt),
      createdAt: isoInstant(row.createdAt, `projects[${index}].createdAt`),
      updatedAt: isoInstant(row.updatedAt, `projects[${index}].updatedAt`),
    };
    projectBySourceId.set(sourceId, project);
    externalRecords.push(
      externalRecord(ownerUserId, "project", project.id, sourceId, row),
    );

    for (const [milestoneIndex, milestoneValue] of array(
      row.milestones ?? [],
      `projects[${index}].milestones`,
    ).entries()) {
      const milestone = object(
        milestoneValue,
        `projects[${index}].milestones[${milestoneIndex}]`,
      );
      const milestoneSourceId = requiredString(
        milestone.id,
        `projects[${index}].milestones[${milestoneIndex}].id`,
      );
      if (releaseBySourceId.has(milestoneSourceId)) {
        throw new ValidationError(
          `Duplicate Linear milestone ${milestoneSourceId}`,
        );
      }
      const release: PlannedRelease = {
        id: targetId(ownerUserId, "release", milestoneSourceId),
        sourceId: milestoneSourceId,
        projectId: project.id,
        name: requiredString(
          milestone.name,
          `projects[${index}].milestones[${milestoneIndex}].name`,
        ),
        description: optionalString(milestone.description) ?? "",
        status: "active",
        targetDate: optionalDate(milestone.targetDate),
        createdAt: exportedAt,
        updatedAt: exportedAt,
      };
      releases.push(release);
      releaseBySourceId.set(milestoneSourceId, release);
      externalRecords.push(
        externalRecord(
          ownerUserId,
          "release",
          release.id,
          milestoneSourceId,
          {
            ...milestone,
            sourceProjectId: sourceId,
          },
        ),
      );
    }
    return project;
  });

  const taskBySourceId = new Map<string, PlannedTask>();
  const taskLabels: Array<{ taskId: string; labelId: string }> = [];
  const tasks = sourceIssues.map((entry, index) => {
    const row = object(entry, `issues[${index}]`);
    const sourceId = requiredString(row.id, `issues[${index}].id`);
    const sequenceNumber = linearSequence(sourceId);
    const statusName = requiredString(row.status, `issues[${index}].status`);
    const status = statusByName.get(statusName);
    if (!status) {
      throw new ValidationError(
        `Linear issue ${sourceId} references unknown status ${statusName}`,
      );
    }
    const sourceProjectId = optionalString(row.projectId);
    const projectId = sourceProjectId
      ? projectBySourceId.get(sourceProjectId)?.id
      : null;
    if (sourceProjectId && !projectId) {
      throw new ValidationError(
        `Linear issue ${sourceId} references missing project ${sourceProjectId}`,
      );
    }
    const milestone = row.projectMilestone
      ? object(row.projectMilestone, `issues[${index}].projectMilestone`)
      : null;
    const sourceReleaseId = milestone ? optionalString(milestone.id) : null;
    const releaseId = sourceReleaseId
      ? releaseBySourceId.get(sourceReleaseId)?.id
      : null;
    if (sourceReleaseId && !releaseId) {
      throw new ValidationError(
        `Linear issue ${sourceId} references missing milestone ${sourceReleaseId}`,
      );
    }
    if (
      releaseId &&
      releaseBySourceId.get(sourceReleaseId ?? "")?.projectId !== projectId
    ) {
      throw new ValidationError(
        `Linear issue ${sourceId} has an incompatible project milestone`,
      );
    }
    const task: PlannedTask = {
      id: targetId(ownerUserId, "task", sourceId),
      sourceId,
      identifier: sourceId,
      sequenceNumber,
      title: requiredString(row.title, `issues[${index}].title`),
      description: optionalString(row.description) ?? "",
      statusId: status.id,
      priority: linearPriority(row.priority),
      assigneeUserId: row.assigneeId ? ownerUserId : null,
      projectId: projectId ?? null,
      releaseId: releaseId ?? null,
      estimate: optionalInteger(row.estimate),
      dueDate: optionalDate(row.dueDate),
      parentTaskId: null,
      rank: (sourceIssues.length + 1 - sequenceNumber) * 1000,
      startedAt: optionalInstant(row.startedAt),
      completedAt: optionalInstant(row.completedAt),
      canceledAt: optionalInstant(row.canceledAt),
      archivedAt: optionalInstant(row.archivedAt),
      createdAt: isoInstant(row.createdAt, `issues[${index}].createdAt`),
      updatedAt: isoInstant(row.updatedAt, `issues[${index}].updatedAt`),
    };
    validateTerminalTimestamps(task, status.category);
    if (taskBySourceId.has(sourceId)) {
      throw new ValidationError(`Duplicate Linear issue ${sourceId}`);
    }
    taskBySourceId.set(sourceId, task);
    const comments = commentsByIssue[sourceId];
    externalRecords.push(
      externalRecord(ownerUserId, "task", task.id, sourceId, {
        ...row,
        comments:
          comments === undefined
            ? []
            : array(comments, `commentsByIssue.${sourceId}`),
      }),
    );
    for (const labelName of stringArray(row.labels)) {
      const label = labelByName.get(labelName);
      if (!label) {
        throw new ValidationError(
          `Linear issue ${sourceId} references unknown label ${labelName}`,
        );
      }
      taskLabels.push({ taskId: task.id, labelId: label.id });
    }
    return task;
  });

  for (const [index, entry] of sourceIssues.entries()) {
    const row = object(entry, `issues[${index}]`);
    const task = taskBySourceId.get(requiredString(row.id, "issue id"));
    const parentSourceId = optionalString(row.parentId);
    if (!task || !parentSourceId) continue;
    const parent = taskBySourceId.get(parentSourceId);
    if (!parent) {
      throw new ValidationError(
        `Linear issue ${task.sourceId} references missing parent ${parentSourceId}`,
      );
    }
    task.parentTaskId = parent.id;
  }
  validateParentGraph(tasks);

  const relations = buildRelations(sourceIssues, taskBySourceId);

  const views = sourceViews.map((entry, index) => {
    const row = object(entry, `views[${index}]`);
    const sourceId = requiredString(row.sourceId, `views[${index}].sourceId`);
    const sourceProjectId = optionalString(row.sourceProjectId);
    const sourceReleaseId = optionalString(row.sourceMilestoneId);
    const projectId = sourceProjectId
      ? projectBySourceId.get(sourceProjectId)?.id
      : null;
    const releaseId = sourceReleaseId
      ? releaseBySourceId.get(sourceReleaseId)?.id
      : null;
    if (sourceProjectId && !projectId) {
      throw new ValidationError(
        `Linear view ${sourceId} references missing project`,
      );
    }
    if (sourceReleaseId && !releaseId) {
      throw new ValidationError(
        `Linear view ${sourceId} references missing milestone`,
      );
    }
    const query = {
      ...object(row.query ?? {}, `views[${index}].query`),
      ...(projectId ? { projectId } : {}),
      ...(releaseId ? { releaseId } : {}),
    } as ViewQuery;
    const display = viewDisplay(row.display);
    const view: PlannedView = {
      id: targetId(ownerUserId, "view", sourceId),
      sourceId,
      name: requiredString(row.name, `views[${index}].name`),
      scopeProjectId: projectId ?? null,
      query,
      display,
    };
    externalRecords.push(
      externalRecord(ownerUserId, "saved_view", view.id, sourceId, row),
    );
    return view;
  });

  for (const label of labels) {
    const sourceLabel = sourceLabels
      .map((entry) => object(entry, "label"))
      .find((entry) => entry.id === label.sourceId);
    if (sourceLabel) {
      externalRecords.push(
        externalRecord(
          ownerUserId,
          "label",
          label.id,
          label.sourceId,
          sourceLabel,
        ),
      );
    }
  }

  return {
    exportedAt,
    statuses,
    labels,
    projects,
    releases,
    tasks,
    taskLabels,
    relations,
    views,
    externalRecords,
  };
}

export async function importLinearWorkspace(
  currentUser: UserRecord,
  payload: unknown,
): Promise<LinearImportReport> {
  const { getD1 } = await import("@/db");
  const plan = buildLinearImportPlan(currentUser.id, payload);
  const db = getD1();

  if (plan.statuses.some((status) => status.isDefault === 1)) {
    await db.prepare(
      `UPDATE workflow_statuses
       SET is_default = 0, version = version + 1, updated_at = ?
       WHERE owner_user_id = ? AND is_default = 1`,
    ).bind(plan.exportedAt, currentUser.id).run();
  }

  await runBatches(
    plan.statuses.map((status) =>
      db
        .prepare(
          `INSERT INTO workflow_statuses
            (id, owner_user_id, name, category, color, position, is_default,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             color = excluded.color,
             position = excluded.position,
             is_default = excluded.is_default,
             archived_at = NULL,
             version = workflow_statuses.version + 1,
             updated_at = excluded.updated_at`,
        )
        .bind(
          status.id,
          currentUser.id,
          status.name,
          status.category,
          status.color,
          status.position,
          status.isDefault,
          plan.exportedAt,
          plan.exportedAt,
        ),
    ),
  );

  await runBatches(
    plan.labels.map((label) =>
      db
        .prepare(
          `INSERT INTO labels (id, owner_user_id, name, color, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, color = excluded.color`,
        )
        .bind(
          label.id,
          currentUser.id,
          label.name,
          label.color,
          plan.exportedAt,
        ),
    ),
  );

  await runBatches(
    plan.projects.map((project) =>
      db
        .prepare(
          `INSERT INTO projects
            (id, public_id, owner_user_id, creator_user_id, name, summary, description,
             status, lead_user_id, start_date, target_date, icon, color,
             archived_at, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             summary = excluded.summary,
             description = excluded.description,
             status = excluded.status,
             lead_user_id = excluded.lead_user_id,
             start_date = excluded.start_date,
             target_date = excluded.target_date,
             icon = excluded.icon,
             color = excluded.color,
             archived_at = excluded.archived_at,
             updated_at = excluded.updated_at`,
        )
        .bind(
          project.id,
          crypto.randomUUID(),
          currentUser.id,
          currentUser.id,
          project.name,
          project.summary,
          project.description,
          project.status,
          project.leadUserId,
          project.startDate,
          project.targetDate,
          project.icon,
          project.color,
          project.archivedAt,
          project.createdAt,
          project.updatedAt,
        ),
    ),
  );

  await runBatches(
    plan.releases.map((release) =>
      db
        .prepare(
          `INSERT INTO releases
            (id, public_id, project_id, owner_user_id, creator_user_id, name, description,
             status, target_date, released_at, release_notes, version,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             name = excluded.name,
             description = excluded.description,
             status = excluded.status,
             target_date = excluded.target_date,
             updated_at = excluded.updated_at`,
        )
        .bind(
          release.id,
          crypto.randomUUID(),
          release.projectId,
          currentUser.id,
          currentUser.id,
          release.name,
          release.description,
          release.status,
          release.targetDate,
          release.createdAt,
          release.updatedAt,
        ),
    ),
  );

  await runBatches(
    plan.tasks.map((task) =>
      db
        .prepare(
          `INSERT INTO tasks
            (id, public_id, owner_user_id, creator_user_id, identifier, sequence_number,
             title, description, status_id, priority, assignee_user_id,
             project_id, release_id, estimate, due_date, parent_task_id, rank,
             started_at, completed_at, canceled_at, archived_at, version,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             identifier = excluded.identifier,
             sequence_number = excluded.sequence_number,
             title = excluded.title,
             description = excluded.description,
             status_id = excluded.status_id,
             priority = excluded.priority,
             assignee_user_id = excluded.assignee_user_id,
             project_id = excluded.project_id,
             release_id = excluded.release_id,
             estimate = excluded.estimate,
             due_date = excluded.due_date,
             parent_task_id = excluded.parent_task_id,
             rank = excluded.rank,
             started_at = excluded.started_at,
             completed_at = excluded.completed_at,
             canceled_at = excluded.canceled_at,
             archived_at = excluded.archived_at,
             updated_at = excluded.updated_at`,
        )
        .bind(
          task.id,
          crypto.randomUUID(),
          currentUser.id,
          currentUser.id,
          task.identifier,
          task.sequenceNumber,
          task.title,
          task.description,
          task.statusId,
          task.priority,
          task.assigneeUserId,
          task.projectId,
          task.releaseId,
          task.estimate,
          task.dueDate,
          task.parentTaskId,
          task.rank,
          task.startedAt,
          task.completedAt,
          task.canceledAt,
          task.archivedAt,
          task.createdAt,
          task.updatedAt,
        ),
    ),
  );

  await runBatches(
    plan.taskLabels.map((assignment) =>
      db
        .prepare(
          `INSERT INTO task_labels (task_id, label_id)
           VALUES (?, ?)
           ON CONFLICT(task_id, label_id) DO NOTHING`,
        )
        .bind(assignment.taskId, assignment.labelId),
    ),
  );

  await runBatches(
    plan.relations.map((relation) =>
      db
        .prepare(
          `INSERT INTO task_relations
            (source_task_id, target_task_id, type, creator_user_id, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(source_task_id, target_task_id, type) DO NOTHING`,
        )
        .bind(
          relation.sourceTaskId,
          relation.targetTaskId,
          relation.type,
          currentUser.id,
          plan.exportedAt,
        ),
    ),
  );

  await runBatches(
    plan.views.map((view) =>
      db
        .prepare(
          `INSERT INTO saved_views
            (id, public_id, owner_user_id, name, scope_project_id, query_json,
             display_json, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             scope_project_id = excluded.scope_project_id,
             query_json = excluded.query_json,
             display_json = excluded.display_json,
             updated_at = excluded.updated_at`,
        )
        .bind(
          view.id,
          crypto.randomUUID(),
          currentUser.id,
          view.name,
          view.scopeProjectId,
          JSON.stringify(view.query),
          JSON.stringify(view.display),
          plan.exportedAt,
          plan.exportedAt,
        ),
    ),
  );

  await runBatches(
    plan.externalRecords.map((record) =>
      db
        .prepare(
          `INSERT INTO external_records
            (id, owner_user_id, target_type, target_id, source, source_id,
             source_url, metadata_json, imported_at)
           VALUES (?, ?, ?, ?, 'linear', ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             target_type = excluded.target_type,
             target_id = excluded.target_id,
             source_url = excluded.source_url,
             metadata_json = excluded.metadata_json,
             imported_at = excluded.imported_at`,
        )
        .bind(
          record.id,
          currentUser.id,
          record.targetType,
          record.targetId,
          record.sourceId,
          record.sourceUrl,
          record.metadataJson,
          plan.exportedAt,
        ),
    ),
  );

  await db.prepare("PRAGMA optimize").run();
  return {
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
}

function buildRelations(
  sourceIssues: unknown[],
  taskBySourceId: Map<string, PlannedTask>,
) {
  const result: PlannedRelation[] = [];
  const seen = new Set<string>();
  const add = (
    sourceId: string,
    targetSourceId: string,
    type: PlannedRelation["type"],
  ) => {
    const sourceTask = taskBySourceId.get(sourceId);
    const targetTask = taskBySourceId.get(targetSourceId);
    if (!sourceTask || !targetTask) {
      throw new ValidationError(
        `Linear relation ${sourceId} -> ${targetSourceId} references a missing issue`,
      );
    }
    if (sourceTask.id === targetTask.id) {
      throw new ValidationError(`Linear issue ${sourceId} relates to itself`);
    }
    let sourceTaskId = sourceTask.id;
    let targetTaskId = targetTask.id;
    if (type === "related" && sourceTaskId > targetTaskId) {
      [sourceTaskId, targetTaskId] = [targetTaskId, sourceTaskId];
    }
    const key = `${type}:${sourceTaskId}:${targetTaskId}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ sourceTaskId, targetTaskId, type });
  };

  for (const [index, value] of sourceIssues.entries()) {
    const issue = object(value, `issues[${index}]`);
    const sourceId = requiredString(issue.id, `issues[${index}].id`);
    const relations = object(
      issue.relations ?? {},
      `issues[${index}].relations`,
    );
    for (const blocked of array(relations.blocks ?? [], "relations.blocks")) {
      add(
        sourceId,
        requiredString(object(blocked, "blocked issue").id, "blocked issue id"),
        "blocks",
      );
    }
    for (const related of array(
      relations.relatedTo ?? [],
      "relations.relatedTo",
    )) {
      add(
        sourceId,
        requiredString(object(related, "related issue").id, "related issue id"),
        "related",
      );
    }
    if (relations.duplicateOf) {
      add(
        sourceId,
        requiredString(
          object(relations.duplicateOf, "duplicate issue").id,
          "duplicate issue id",
        ),
        "duplicate_of",
      );
    }
  }
  return result;
}

function validateParentGraph(tasks: PlannedTask[]) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    const visited = new Set<string>([task.id]);
    let parentId = task.parentTaskId;
    while (parentId) {
      if (visited.has(parentId)) {
        throw new ValidationError(
          `Linear parent hierarchy contains a cycle at ${task.sourceId}`,
        );
      }
      visited.add(parentId);
      parentId = taskById.get(parentId)?.parentTaskId ?? null;
    }
  }
}

function validateTerminalTimestamps(task: PlannedTask, category: string) {
  if ((category === "completed") !== Boolean(task.completedAt)) {
    throw new ValidationError(
      `Linear issue ${task.sourceId} has inconsistent completedAt metadata`,
    );
  }
  if ((category === "canceled") !== Boolean(task.canceledAt)) {
    throw new ValidationError(
      `Linear issue ${task.sourceId} has inconsistent canceledAt metadata`,
    );
  }
}

function statusTargetId(
  ownerUserId: string,
  name: string,
  category: string,
) {
  if (name.toLocaleLowerCase() === "duplicate") {
    return `status:${ownerUserId}:duplicate`;
  }
  return BASE_STATUS_NAMES.has(name)
    ? `status:${ownerUserId}:${category}`
    : targetId(ownerUserId, "status", slug(name));
}

function targetId(ownerUserId: string, kind: string, sourceId: string) {
  return `linear:${kind}:${ownerUserId}:${sourceId}`;
}

function externalRecord(
  ownerUserId: string,
  targetType: PlannedExternalRecord["targetType"],
  targetRecordId: string,
  sourceId: string,
  raw: JsonObject,
): PlannedExternalRecord {
  return {
    id: targetId(ownerUserId, `external-${targetType}`, sourceId),
    targetType,
    targetId: targetRecordId,
    sourceId,
    sourceUrl: optionalString(raw.url),
    metadataJson: JSON.stringify(raw),
  };
}

async function runBatches(statements: D1PreparedStatement[]) {
  const { getD1 } = await import("@/db");
  for (let offset = 0; offset < statements.length; offset += 50) {
    await getD1().batch(statements.slice(offset, offset + 50));
  }
}

function statusCategory(value: unknown) {
  const type = optionalString(value);
  if (type === "duplicate") return "canceled";
  if (
    type === "backlog" ||
    type === "unstarted" ||
    type === "started" ||
    type === "completed" ||
    type === "canceled"
  ) {
    return type;
  }
  throw new ValidationError(`Unsupported Linear status category ${type}`);
}

function projectStatus(value: unknown) {
  const type = optionalString(value);
  if (type === "started") return "active";
  if (type === "completed") return "completed";
  if (type === "canceled") return "canceled";
  if (type === "paused") return "paused";
  return "planned";
}

function linearPriority(value: unknown): PlannedTask["priority"] {
  const priority = object(value ?? {}, "priority");
  if (priority.value === 1) return "urgent";
  if (priority.value === 2) return "high";
  if (priority.value === 3) return "medium";
  if (priority.value === 4) return "low";
  return "none";
}

function viewDisplay(value: unknown): ViewDisplay {
  const display = object(value ?? {}, "view display");
  const layout = display.layout === "board" ? "board" : "list";
  const groupBy =
    display.groupBy === "status" ||
    display.groupBy === "priority" ||
    display.groupBy === "assignee" ||
    display.groupBy === "project" ||
    display.groupBy === "release" ||
    display.groupBy === "none"
      ? display.groupBy
      : "status";
  const orderBy =
    display.orderBy === "manual" ||
    display.orderBy === "priority" ||
    display.orderBy === "created" ||
    display.orderBy === "updated" ||
    display.orderBy === "due" ||
    display.orderBy === "title"
      ? display.orderBy
      : "manual";
  return {
    layout,
    groupBy,
    orderBy,
    direction: display.direction === "desc" ? "desc" : "asc",
    showEmptyGroups: display.showEmptyGroups === true,
    visibleFields: stringArray(display.visibleFields).filter(
      (field): field is ViewDisplay["visibleFields"][number] =>
        field === "priority" ||
        field === "project" ||
        field === "release" ||
        field === "dueDate" ||
        field === "assignee",
    ),
  };
}

function linearSequence(identifier: string) {
  const match = identifier.match(/^[A-Z][A-Z0-9]*-(\d+)$/);
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(
      `Linear issue identifier ${identifier} has no numeric sequence`,
    );
  }
  return value;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must be an array`);
  }
  return value;
}

function requiredString(value: unknown, label: string) {
  const result = optionalString(value);
  if (!result) throw new ValidationError(`${label} is required`);
  return result;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isoInstant(value: unknown, label: string) {
  const result = optionalInstant(value);
  if (!result) throw new ValidationError(`${label} must be an ISO instant`);
  return result;
}

function optionalInstant(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ValidationError("Linear timestamp must be an ISO instant");
  }
  return value;
}

function optionalInteger(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new ValidationError("Linear estimate must be an integer");
  }
  return number;
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
