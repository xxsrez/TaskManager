import { getD1 } from "@/db";
import { canEditContent } from "./access";
import {
  AgentApiError,
  catalogReference,
  encodeKeysetCursor,
  type AgentAttachmentListQuery,
  type AgentKeysetPosition,
  type AgentProjectListQuery,
  type AgentReleaseListQuery,
  type AgentSavedViewListQuery,
  type AgentTaskListQuery,
} from "./agent-api-contract";
import {
  createAttachment,
  deleteAttachment,
  getAttachmentContent,
  getTaskAttachment,
  listTaskAttachments,
  restoreAttachment,
  type AttachmentContentOptions,
  type CreateAttachmentInput,
} from "./attachments";
import { NotFoundError, PermissionError, ValidationError } from "./domain";
import {
  createSubtask,
  createTask,
  moveTask,
  setTaskLabel,
  setTaskParent,
  updateTask,
} from "./repository";
import {
  createTaskRelation,
  deleteTaskRelation,
  updateTaskRelation,
} from "./task-relations";
import {
  createComment,
  deleteComment,
  editComment,
  getCommentThread,
  listTaskComments,
  resolveCommentThread,
  setCommentReaction,
} from "./comments";
import type { AgentAuthorizationContext } from "./agent-api-context";
import type {
  AccessRole,
  AttachmentRecord,
  UserRecord,
  ViewFilterCondition,
} from "./types";
import { parseStoredViewDisplay, parseStoredViewQuery } from "./view-contract";
import { taskFilterSql } from "./task-filter";
import { listTaskActivity } from "./activity";

type DbRow = Record<string, unknown>;

const taskScopeCte = (detail: boolean) => `WITH scoped_tasks AS (
  SELECT
    ${detail ? "t.*" : `t.id, t.public_id, t.owner_user_id, t.identifier,
      t.title, t.description, t.status_id, t.priority, t.assignee_user_id, t.project_id,
      t.release_id, t.estimate, t.due_date, t.parent_task_id, t.rank,
      t.started_at, t.completed_at, t.canceled_at, t.archived_at,
      t.comment_count,
      t.version, t.created_at, t.updated_at,
      CASE WHEN length(t.description) > 0 THEN 1 ELSE 0 END AS has_description`},
    s.name AS status_name,
    s.category AS status_category,
    p.public_id AS project_public_id,
    p.name AS project_name,
    p.summary AS project_summary,
    p.status AS project_status,
    p.target_date AS project_target_date,
    r.public_id AS release_public_id,
    r.name AS release_name,
    r.status AS release_status,
    r.target_date AS release_target_date,
    r.released_at AS release_released_at,
    assignee.display_name AS assignee_display_name,
    CASE
      WHEN t.project_id IS NOT NULL AND p.owner_user_id = ? THEN 'owner'
      WHEN t.project_id IS NOT NULL THEN (
        SELECT CASE ag.permission
          WHEN 'full_access' THEN 'manager'
          WHEN 'manager' THEN 'manager'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM access_grants ag
        WHERE ag.resource_type = 'project' AND ag.resource_id = t.project_id
          AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
      )
      WHEN t.owner_user_id = ? THEN 'owner'
      ELSE (
        SELECT CASE ag.permission
          WHEN 'full_access' THEN 'editor'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM access_grants ag
        WHERE ag.resource_type = 'task' AND ag.resource_id = t.id
          AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
      )
    END AS access_role
  FROM tasks t
  JOIN workflow_statuses s ON s.id = t.status_id
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN releases r ON r.id = t.release_id
  LEFT JOIN users assignee ON assignee.id = t.assignee_user_id
), visible_tasks AS (
  SELECT * FROM scoped_tasks WHERE access_role IS NOT NULL
)`;

const taskProjection = `v.*,
  COALESCE((
    SELECT json_group_array(json_object('id', l.id, 'name', l.name))
    FROM task_labels tl JOIN labels l ON l.id = tl.label_id
    WHERE tl.task_id = v.id
  ), '[]') AS labels_json,
  (SELECT COUNT(*) FROM visible_tasks child WHERE child.parent_task_id = v.id)
    AS subtask_count,
  (SELECT COUNT(*)
   FROM task_relations tr
   JOIN visible_tasks other ON other.id = CASE
     WHEN tr.source_task_id = v.id THEN tr.target_task_id
     ELSE tr.source_task_id
   END
   WHERE tr.source_task_id = v.id OR tr.target_task_id = v.id)
    AS relation_count`;

const projectScopeCte = `WITH scoped_projects AS (
  SELECT p.*,
    CASE WHEN p.owner_user_id = ? THEN 'owner' ELSE (
      SELECT CASE ag.permission
        WHEN 'full_access' THEN 'manager'
        WHEN 'manager' THEN 'manager'
        WHEN 'editor' THEN 'editor'
        WHEN 'viewer' THEN 'viewer'
      END
      FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
        AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
    ) END AS access_role
  FROM projects p
), visible_projects AS (
  SELECT * FROM scoped_projects WHERE access_role IS NOT NULL
)`;

const releaseScopeCte = `WITH scoped_releases AS (
  SELECT r.*, p.public_id AS project_public_id, p.name AS project_name,
    CASE WHEN p.owner_user_id = ? THEN 'owner' ELSE (
      SELECT CASE ag.permission
        WHEN 'full_access' THEN 'manager'
        WHEN 'manager' THEN 'manager'
        WHEN 'editor' THEN 'editor'
        WHEN 'viewer' THEN 'viewer'
      END
      FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = r.project_id
        AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
    ) END AS access_role
  FROM releases r JOIN projects p ON p.id = r.project_id
), visible_releases AS (
  SELECT * FROM scoped_releases WHERE access_role IS NOT NULL
)`;

const savedViewScopeCte = `WITH scoped_views AS (
  SELECT v.*, p.public_id AS project_public_id, p.name AS project_name,
    CASE
      WHEN v.scope_project_id IS NOT NULL AND p.owner_user_id = ? THEN 'owner'
      WHEN v.scope_project_id IS NOT NULL THEN (
        SELECT CASE ag.permission
          WHEN 'full_access' THEN 'manager'
          WHEN 'manager' THEN 'manager'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM access_grants ag
        WHERE ag.resource_type = 'project' AND ag.resource_id = v.scope_project_id
          AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
      )
      WHEN v.owner_user_id = ? THEN 'owner'
      ELSE (
        SELECT CASE ag.permission
          WHEN 'full_access' THEN 'editor'
          WHEN 'editor' THEN 'editor'
          WHEN 'viewer' THEN 'viewer'
        END
        FROM access_grants ag
        WHERE ag.resource_type = 'saved_view' AND ag.resource_id = v.id
          AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
      )
    END AS access_role
  FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
), visible_views AS (
  SELECT * FROM scoped_views WHERE access_role IS NOT NULL
)`;

export async function listAgentTasks(
  currentUser: UserRecord,
  query: AgentTaskListQuery,
) {
  const project = query.projectRef
    ? await loadAccessibleProjectRow(currentUser.id, query.projectRef)
    : null;
  const release = query.releaseRef
    ? await loadAccessibleReleaseRow(currentUser.id, query.releaseRef)
    : null;
  if (project && release && String(release.project_id) !== String(project.id)) {
    throw new ValidationError("Release does not belong to the selected project");
  }

  const conditions: ViewFilterCondition[] = [
    { field: "archived", operator: "is", value: query.archived },
  ];
  if (project) conditions.push({ field: "project", operator: "is", value: String(project.id) });
  if (release) conditions.push({ field: "release", operator: "is", value: String(release.id) });
  if (query.statusCategories.length) {
    conditions.push({ field: "status_category", operator: "in", value: query.statusCategories });
  }
  if (query.priorities.length) {
    conditions.push({ field: "priority", operator: "in", value: query.priorities });
  }
  if (query.assignee === "me") {
    conditions.push({ field: "assignee", operator: "is", value: currentUser.id });
  } else if (query.assignee === "unassigned") {
    conditions.push({ field: "assignee", operator: "is_empty" });
  }
  const compiled = taskFilterSql({
    version: 1,
    op: "all",
    conditions,
    ...(query.search ? { search: query.search } : {}),
  }, { searchMode: "prefix" });
  const predicates = [compiled.sql];
  const parameters: unknown[] = [
    ...taskScopeParameters(currentUser.id),
    ...compiled.parameters,
  ];

  const direction = query.direction === "asc" ? "ASC" : "DESC";
  const order = taskOrderExpression(query.order);
  appendKeysetPredicate(predicates, parameters, order, direction, query.after);
  parameters.push(query.limit + 1);
  const rows = await getD1()
    .prepare(
      `${taskScopeCte(false)}
       SELECT ${taskProjection}, ${order} AS cursor_value
       FROM visible_tasks v
       WHERE ${predicates.join(" AND ")}
       ORDER BY ${order} ${direction}, v.public_id ${direction}
       LIMIT ?`,
    )
    .bind(...parameters)
    .all<DbRow>();

  const hasMore = rows.results.length > query.limit;
  const visible = rows.results.slice(0, query.limit);
  return {
    data: await Promise.all(visible.map((row) => mapTaskSummary(row, currentUser))),
    page: {
      hasMore,
      nextCursor: hasMore
        ? keysetCursor(visible.at(-1)!, query.fingerprint)
        : null,
    },
  };
}

export async function getAgentTaskDetail(
  currentUser: UserRecord,
  reference: string,
) {
  const row = await loadAccessibleTaskRow(currentUser.id, reference);
  const summary = await mapTaskSummary(row, currentUser);
  const [
    parent,
    subtasks,
    relations,
    provenance,
    availableStatuses,
    attachmentCount,
  ] = await Promise.all([
    loadParentTask(currentUser, nullableString(row.parent_task_id)),
    loadSubtasks(currentUser, String(row.id)),
    loadRelations(currentUser, String(row.id)),
    loadProvenanceSummary(String(row.id), String(row.owner_user_id)),
    loadStatusSummaries(String(row.owner_user_id)),
    loadNativeAttachmentCount(String(row.id)),
  ]);
  return {
    ...summary,
    contextHints: { ...summary.contextHints, attachmentCount },
    description: String(row.description ?? ""),
    estimate: nullableNumber(row.estimate),
    rank: Number(row.rank),
    access: {
      role: String(row.access_role),
      canEdit: canEditContent(String(row.access_role) as AccessRole),
    },
    lifecycle: {
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      startedAt: nullableString(row.started_at),
      completedAt: nullableString(row.completed_at),
      canceledAt: nullableString(row.canceled_at),
      archivedAt: nullableString(row.archived_at),
    },
    project: row.project_public_id
      ? {
          ref: String(row.project_public_id),
          name: String(row.project_name),
          summary: String(row.project_summary ?? ""),
          status: String(row.project_status),
          targetDate: nullableString(row.project_target_date),
        }
      : null,
    release: row.release_public_id
      ? {
          ref: String(row.release_public_id),
          name: String(row.release_name),
          status: String(row.release_status),
          targetDate: nullableString(row.release_target_date),
          releasedAt: nullableString(row.release_released_at),
        }
      : null,
    parent,
    subtasks,
    relations,
    provenance,
    availableStatuses,
  };
}

export async function getAgentTaskExternalContext(
  currentUser: UserRecord,
  reference: string,
  input: { limit: number; offset: number; fingerprint: string },
) {
  void input;
  const task = await loadAccessibleTaskRow(currentUser.id, reference);
  const row = await getD1()
    .prepare(
      `SELECT er.source, er.source_url, er.metadata_json,
              (SELECT COUNT(*) FROM comment_migration_outcomes outcome
               WHERE outcome.source_record_id = er.id AND outcome.outcome = 'migrated') AS comments_migrated,
              (SELECT COUNT(*) FROM comment_migration_outcomes outcome
               WHERE outcome.source_record_id = er.id AND outcome.outcome = 'exception') AS comment_exceptions
              ,(SELECT COUNT(*) FROM activity_migration_outcomes outcome
               WHERE outcome.source_record_id = er.id AND outcome.outcome = 'migrated') AS activity_migrated
              ,(SELECT COUNT(*) FROM activity_migration_outcomes outcome
               WHERE outcome.source_record_id = er.id AND outcome.outcome = 'exception') AS activity_exceptions
       FROM external_records er
       WHERE er.target_type = 'task' AND er.target_id = ? AND er.owner_user_id = ?
       ORDER BY er.imported_at DESC LIMIT 1`,
    )
    .bind(task.id, task.owner_user_id)
    .first<DbRow>();
  if (!row) throw new NotFoundError("External context not found");
  const metadata = safeJson<Record<string, unknown>>(row.metadata_json, {});
  return {
    data: {
      source: String(row.source),
      sourceUrl: nullableString(row.source_url),
      gitBranchName:
        typeof metadata.gitBranchName === "string"
          ? metadata.gitBranchName
          : null,
      attachments: externalAttachments(metadata.attachments),
      commentMigration: {
        migrated: Number(row.comments_migrated ?? 0),
        exceptions: Number(row.comment_exceptions ?? 0),
      },
      activityMigration: {
        migrated: Number(row.activity_migrated ?? 0),
        exceptions: Number(row.activity_exceptions ?? 0),
      },
    },
    page: {
      hasMore: false,
      nextCursor: null,
    },
  };
}

export async function listAgentProjects(
  currentUser: UserRecord,
  query: AgentProjectListQuery,
) {
  const predicates = [
    query.archived ? "p.archived_at IS NOT NULL" : "p.archived_at IS NULL",
  ];
  const parameters: unknown[] = [currentUser.id, currentUser.id];
  if (query.search) {
    predicates.push(
      `((lower(p.name) >= ? AND lower(p.name) < ?)
        OR (lower(p.summary) >= ? AND lower(p.summary) < ?))`,
    );
    const [start, end] = prefixRange(query.search);
    parameters.push(start, end, start, end);
  }
  appendKeysetPredicate(
    predicates,
    parameters,
    "p.updated_at",
    "DESC",
    query.after,
    "p.public_id",
  );
  parameters.push(query.limit + 1);
  const rows = await getD1()
    .prepare(
      `${projectScopeCte}
       SELECT p.*, p.updated_at AS cursor_value,
         ${taskCategoryCounts("p.id")},
         (SELECT COUNT(*) FROM releases r WHERE r.project_id = p.id)
           AS release_count
       FROM visible_projects p
       WHERE ${predicates.join(" AND ")}
       ORDER BY p.updated_at DESC, p.public_id DESC
       LIMIT ?`,
    )
    .bind(...parameters)
    .all<DbRow>();
  const hasMore = rows.results.length > query.limit;
  return {
    data: rows.results.slice(0, query.limit).map(mapProjectSummary),
    page: {
      hasMore,
      nextCursor: hasMore
        ? keysetCursor(rows.results[query.limit - 1]!, query.fingerprint)
        : null,
    },
  };
}

export async function getAgentProjectDetail(
  currentUser: UserRecord,
  reference: string,
) {
  const project = await loadAccessibleProjectRow(currentUser.id, reference, true);
  const [releases, workflowStatuses, lead] = await Promise.all([
    getD1()
      .prepare(
        `SELECT r.* FROM releases r
       WHERE r.project_id = ?
       ORDER BY CASE r.status
         WHEN 'active' THEN 0 WHEN 'planned' THEN 1
         WHEN 'released' THEN 2 ELSE 3 END,
         COALESCE(r.target_date, '9999-12-31'), r.name`,
      )
      .bind(project.id)
      .all<DbRow>(),
    loadStatusSummaries(String(project.owner_user_id)),
    project.lead_user_id
      ? getD1().prepare(
        "SELECT display_name FROM users WHERE id = ?",
      ).bind(project.lead_user_id).first<{ display_name: string }>()
      : Promise.resolve(null),
  ]);
  return {
    ...mapProjectSummary(project),
    description: String(project.description ?? ""),
    startDate: nullableString(project.start_date),
    lead: project.lead_user_id && lead
      ? {
          displayName: String(lead.display_name),
          isCurrentUser: String(project.lead_user_id) === currentUser.id,
        }
      : null,
    releases: releases.results.map((row) => ({
      ref: String(row.public_id),
      name: String(row.name),
      status: String(row.status),
      targetDate: nullableString(row.target_date),
      releasedAt: nullableString(row.released_at),
      version: Number(row.version),
    })),
    workflowStatuses,
  };
}

export async function listAgentReleases(
  currentUser: UserRecord,
  query: AgentReleaseListQuery,
) {
  const project = query.projectRef
    ? await loadAccessibleProjectRow(currentUser.id, query.projectRef)
    : null;
  const predicates: string[] = [];
  const parameters: unknown[] = [currentUser.id, currentUser.id];
  if (project) {
    predicates.push("r.project_id = ?");
    parameters.push(project.id);
  }
  if (query.statuses.length) {
    predicates.push(`r.status IN (${placeholders(query.statuses.length)})`);
    parameters.push(...query.statuses);
  }
  if (query.search) {
    predicates.push("lower(r.name) >= ? AND lower(r.name) < ?");
    parameters.push(...prefixRange(query.search));
  }
  const releaseOrder = releaseOrderExpression();
  appendKeysetPredicate(
    predicates,
    parameters,
    releaseOrder,
    "ASC",
    query.after,
    "r.public_id",
  );
  parameters.push(query.limit + 1);
  const rows = await getD1()
    .prepare(
      `${releaseScopeCte}
       SELECT r.*, ${releaseOrder} AS cursor_value,
         ${taskCategoryCounts("r.project_id", "r.id")}
       FROM visible_releases r
       ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
       ORDER BY ${releaseOrder} ASC, r.public_id ASC
       LIMIT ?`,
    )
    .bind(...parameters)
    .all<DbRow>();
  const hasMore = rows.results.length > query.limit;
  return {
    data: rows.results.slice(0, query.limit).map(mapReleaseSummary),
    page: {
      hasMore,
      nextCursor: hasMore
        ? keysetCursor(rows.results[query.limit - 1]!, query.fingerprint)
        : null,
    },
  };
}

export async function getAgentReleaseDetail(
  currentUser: UserRecord,
  reference: string,
) {
  const release = await loadAccessibleReleaseRow(currentUser.id, reference, true);
  return {
    ...mapReleaseSummary(release),
    description: String(release.description ?? ""),
    releaseNotes: String(release.release_notes ?? ""),
    createdAt: String(release.created_at),
    workflowStatuses: await loadStatusSummaries(String(release.owner_user_id)),
  };
}

export async function listAgentSavedViews(
  currentUser: UserRecord,
  query: AgentSavedViewListQuery,
) {
  const project = query.projectRef
    ? await loadAccessibleProjectRow(currentUser.id, query.projectRef)
    : null;
  const predicates = [
    query.archived ? "v.archived_at IS NOT NULL" : "v.archived_at IS NULL",
  ];
  const parameters: unknown[] = [
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
  ];
  if (project) {
    predicates.push("v.scope_project_id = ?");
    parameters.push(project.id);
  }
  if (query.search) {
    predicates.push("lower(v.name) >= ? AND lower(v.name) < ?");
    parameters.push(...prefixRange(query.search));
  }
  const order = "lower(v.name)";
  appendKeysetPredicate(predicates, parameters, order, "ASC", query.after, "v.public_id");
  parameters.push(query.limit + 1);
  const rows = await getD1().prepare(
    `${savedViewScopeCte}
     SELECT v.*, ${order} AS cursor_value
     FROM visible_views v
     WHERE ${predicates.join(" AND ")}
     ORDER BY ${order} ASC, v.public_id ASC
     LIMIT ?`,
  ).bind(...parameters).all<DbRow>();
  const hasMore = rows.results.length > query.limit;
  const visible = rows.results.slice(0, query.limit);
  return {
    data: visible.map(mapSavedView),
    page: {
      hasMore,
      nextCursor: hasMore
        ? keysetCursor(visible.at(-1)!, query.fingerprint)
        : null,
    },
  };
}

export async function getAgentSavedViewDetail(
  currentUser: UserRecord,
  reference: string,
) {
  return mapSavedView(await loadAccessibleSavedViewRow(currentUser.id, reference));
}

export async function getAgentWorkspace(
  context: AgentAuthorizationContext,
) {
  const user = context.user;
  const [taskCounts, projectCount, releaseCount, savedViewCount, statuses] = await Promise.all([
    getD1()
      .prepare(
        `${taskScopeCte(false)}
         SELECT COUNT(*) AS total,
           SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN archived_at IS NULL AND status_category = 'backlog' THEN 1 ELSE 0 END) AS backlog,
           SUM(CASE WHEN archived_at IS NULL AND status_category = 'unstarted' THEN 1 ELSE 0 END) AS unstarted,
           SUM(CASE WHEN archived_at IS NULL AND status_category = 'started' THEN 1 ELSE 0 END) AS started,
           SUM(CASE WHEN archived_at IS NULL AND status_category = 'completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN archived_at IS NULL AND status_category = 'canceled' THEN 1 ELSE 0 END) AS canceled
         FROM visible_tasks`,
      )
      .bind(...taskScopeParameters(user.id))
      .first<DbRow>(),
    getD1()
      .prepare(`${projectScopeCte} SELECT COUNT(*) AS count FROM visible_projects`)
      .bind(user.id, user.id)
      .first<{ count: number }>(),
    getD1()
      .prepare(`${releaseScopeCte} SELECT COUNT(*) AS count FROM visible_releases`)
      .bind(user.id, user.id)
      .first<{ count: number }>(),
    getD1()
      .prepare(`${savedViewScopeCte} SELECT COUNT(*) AS count FROM visible_views WHERE archived_at IS NULL`)
      .bind(user.id, user.id, user.id, user.id)
      .first<{ count: number }>(),
    getD1()
      .prepare(
        `SELECT DISTINCT s.* FROM workflow_statuses s
         WHERE s.archived_at IS NULL AND (s.owner_user_id = ?
            OR EXISTS (
              SELECT 1 FROM projects p
              WHERE p.owner_user_id = s.owner_user_id AND (
                p.owner_user_id = ? OR EXISTS (
                  SELECT 1 FROM access_grants ag
                  WHERE ag.resource_type = 'project'
                    AND ag.resource_id = p.id
                    AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                )
              )
            ))
            OR EXISTS (
              SELECT 1 FROM tasks t
              WHERE t.status_id = s.id AND t.project_id IS NULL AND (
                t.owner_user_id = ? OR EXISTS (
                  SELECT 1 FROM access_grants ag
                  WHERE ag.resource_type = 'task' AND ag.resource_id = t.id
                    AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                )
              )
            )
         ORDER BY s.owner_user_id = ? DESC, s.position, s.name`,
      )
      .bind(user.id, user.id, user.id, user.id, user.id, user.id)
      .all<DbRow>(),
  ]);

  return {
    user: { displayName: user.displayName, timezone: user.timezone },
    capabilities: {
      read: context.scopes.includes("api:read"),
      writeTasks: context.scopes.includes("api:write"),
    },
    counts: {
      projects: Number(projectCount?.count ?? 0),
      releases: Number(releaseCount?.count ?? 0),
      savedViews: Number(savedViewCount?.count ?? 0),
      tasks: {
        total: Number(taskCounts?.total ?? 0),
        active: Number(taskCounts?.active ?? 0),
        byCategory: {
          backlog: Number(taskCounts?.backlog ?? 0),
          unstarted: Number(taskCounts?.unstarted ?? 0),
          started: Number(taskCounts?.started ?? 0),
          completed: Number(taskCounts?.completed ?? 0),
          canceled: Number(taskCounts?.canceled ?? 0),
        },
      },
    },
    statuses: await Promise.all(statuses.results.map(mapStatusSummary)),
  };
}

export async function createAgentTask(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, [
    "title",
    "description",
    "statusRef",
    "priority",
    "projectRef",
    "releaseRef",
    "confirmReleasedComposition",
    "estimate",
    "dueDate",
  ]);
  if (!input.projectRef) throw new ValidationError("projectRef is required");
  const project = await loadAccessibleProjectRow(
    currentUser.id,
    String(input.projectRef),
  );
  const release = input.releaseRef
    ? await loadAccessibleReleaseRow(currentUser.id, String(input.releaseRef))
    : null;
  if (release && String(project.id) !== String(release.project_id)) {
    throw new ValidationError("Release does not belong to the selected project");
  }
  const ownerUserId = String(project.owner_user_id);
  const statusId = input.statusRef
    ? await resolveStatusReference(ownerUserId, String(input.statusRef))
    : undefined;
  const created = await createTask(currentUser, {
    ...input,
    projectId: project.id,
    releaseId: release?.id ?? null,
    ...(statusId ? { statusId } : {}),
  });
  return getAgentTaskDetail(currentUser, created.publicId);
}

export async function updateAgentTask(
  currentUser: UserRecord,
  reference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, [
    "version",
    "title",
    "description",
    "statusRef",
    "priority",
    "projectRef",
    "releaseRef",
    "confirmReleasedComposition",
    "estimate",
    "dueDate",
    "rank",
    "archived",
  ]);
  const task = await loadAccessibleTaskRow(currentUser.id, reference);
  const translated: Record<string, unknown> = { ...input };
  delete translated.statusRef;
  delete translated.projectRef;
  delete translated.releaseRef;
  if (Object.hasOwn(input, "statusRef")) {
    if (!input.statusRef) throw new ValidationError("statusRef cannot be empty");
    translated.statusId = await resolveStatusReference(
      String(task.owner_user_id),
      String(input.statusRef),
    );
  }
  if (Object.hasOwn(input, "projectRef")) {
    if (!input.projectRef) throw new ValidationError("projectRef cannot be cleared");
    translated.projectId = String(
      (await loadAccessibleProjectRow(
        currentUser.id,
        String(input.projectRef),
      )).id,
    );
  }
  if (Object.hasOwn(input, "releaseRef")) {
    translated.releaseId = input.releaseRef
      ? String(
          (await loadAccessibleReleaseRow(
            currentUser.id,
            String(input.releaseRef),
          )).id,
        )
      : null;
  }
  await updateTask(currentUser, String(task.id), translated);
  return getAgentTaskDetail(currentUser, String(task.public_id));
}

export async function moveAgentTask(
  currentUser: UserRecord,
  reference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, [
    "version",
    "targetProjectRef",
    "releaseRef",
    "confirmReleasedComposition",
    "assigneeEmail",
  ]);
  if (!input.targetProjectRef) {
    throw new ValidationError("targetProjectRef is required");
  }
  const task = await loadAccessibleTaskRow(currentUser.id, reference);
  const targetProject = await loadAccessibleProjectRow(
    currentUser.id,
    String(input.targetProjectRef),
  );
  const translated: Record<string, unknown> = {
    version: input.version,
    targetProjectId: String(targetProject.id),
  };
  if (Object.hasOwn(input, "releaseRef")) {
    translated.releaseId = input.releaseRef
      ? String(
          (await loadAccessibleReleaseRow(
            currentUser.id,
            String(input.releaseRef),
          )).id,
        )
      : null;
  }
  if (input.confirmReleasedComposition === true) {
    translated.confirmReleasedComposition = true;
  }
  if (Object.hasOwn(input, "assigneeEmail")) {
    if (input.assigneeEmail === null) {
      translated.assigneeUserId = null;
    } else if (typeof input.assigneeEmail === "string" && input.assigneeEmail) {
      const matches = await getD1()
        .prepare("SELECT id FROM users WHERE lower(email) = ? ORDER BY id LIMIT 2")
        .bind(input.assigneeEmail.trim().toLowerCase())
        .all<{ id: string }>();
      if (matches.results.length === 0) {
        throw new NotFoundError("Assignee not found");
      }
      if (matches.results.length > 1) {
        throw new ValidationError("More than one account uses that email");
      }
      translated.assigneeUserId = matches.results[0]!.id;
    } else {
      throw new ValidationError("assigneeEmail is invalid");
    }
  }
  await moveTask(currentUser, String(task.id), translated);
  return getAgentTaskDetail(currentUser, String(task.public_id));
}

export async function setAgentTaskParent(
  currentUser: UserRecord,
  reference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, ["version", "parentTaskRef"]);
  const task = await loadAccessibleTaskRow(currentUser.id, reference);
  const parentTaskId = input.parentTaskRef == null
    ? null
    : String(
        (await loadAccessibleTaskRow(
          currentUser.id,
          String(input.parentTaskRef),
        )).id,
      );
  await setTaskParent(currentUser, String(task.id), {
    version: input.version,
    parentTaskId,
  });
  return getAgentTaskDetail(currentUser, String(task.public_id));
}

export async function createAgentSubtask(
  currentUser: UserRecord,
  parentReference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, [
    "version",
    "title",
    "description",
    "statusRef",
    "priority",
    "releaseRef",
    "confirmReleasedComposition",
    "estimate",
    "dueDate",
  ]);
  const parent = await loadAccessibleTaskRow(currentUser.id, parentReference);
  const translated: Record<string, unknown> = { ...input };
  delete translated.statusRef;
  delete translated.releaseRef;
  if (input.statusRef) {
    translated.statusId = await resolveStatusReference(
      String(parent.owner_user_id),
      String(input.statusRef),
    );
  }
  if (Object.hasOwn(input, "releaseRef")) {
    translated.releaseId = input.releaseRef
      ? String(
          (await loadAccessibleReleaseRow(
            currentUser.id,
            String(input.releaseRef),
          )).id,
        )
      : null;
  }
  const created = await createSubtask(
    currentUser,
    String(parent.id),
    translated,
  );
  return getAgentTaskDetail(currentUser, created.publicId);
}

export async function listAgentLabels(
  currentUser: UserRecord,
  includeArchived = false,
) {
  const rows = await getD1().prepare(
    `SELECT DISTINCT l.* FROM labels l
     WHERE (? = 1 OR l.archived_at IS NULL) AND (
       l.owner_user_id = ? OR EXISTS (
         SELECT 1 FROM projects p
         WHERE p.owner_user_id = l.owner_user_id AND (
           p.owner_user_id = ? OR EXISTS (
             SELECT 1 FROM access_grants ag
             WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
               AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
           )
         )
       )
     )
     ORDER BY l.owner_user_id = ? DESC, l.archived_at IS NOT NULL,
       lower(l.name), l.id
     LIMIT 201`,
  ).bind(
    includeArchived ? 1 : 0,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
  ).all<DbRow>();
  const visible = rows.results.slice(0, 200);
  return {
    items: await Promise.all(visible.map(async (row) => ({
      ref: await catalogReference("label", String(row.id)),
      name: String(row.name),
      color: String(row.color),
      description: String(row.description ?? ""),
      archivedAt: nullableString(row.archived_at),
      version: Number(row.version ?? 1),
      owner: { isCurrentUser: String(row.owner_user_id) === currentUser.id },
    }))),
    page: { nextCursor: null, hasMore: rows.results.length > 200 },
  };
}

export async function setAgentTaskLabel(
  currentUser: UserRecord,
  taskReference: string,
  labelReference: string,
  active: boolean,
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const labelId = await resolveLabelReference(
    String(task.owner_user_id),
    labelReference,
    !active,
  );
  await setTaskLabel(currentUser, String(task.id), { labelId, active });
  return getAgentTaskDetail(currentUser, String(task.public_id));
}

export async function createAgentTaskRelation(
  currentUser: UserRecord,
  taskReference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, [
    "targetTaskRef",
    "type",
    "direction",
    "idempotencyKey",
    "taskVersion",
  ]);
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const target = await loadAccessibleTaskRow(
    currentUser.id,
    String(input.targetTaskRef ?? ""),
  );
  const relation = await createTaskRelation(currentUser, String(task.id), {
    targetTaskId: String(target.id),
    type: input.type,
    direction: input.direction,
    idempotencyKey: input.idempotencyKey,
    ...(Object.hasOwn(input, "taskVersion")
      ? { taskVersion: input.taskVersion }
      : {}),
  });
  return relationMutationResult(currentUser, String(task.public_id), relation.id);
}

export async function updateAgentTaskRelation(
  currentUser: UserRecord,
  taskReference: string,
  relationReference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, ["version", "type", "direction", "taskVersion"]);
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const relation = await updateTaskRelation(
    currentUser,
    String(task.id),
    relationReference,
    input,
  );
  return relationMutationResult(currentUser, String(task.public_id), relation.id);
}

export async function deleteAgentTaskRelation(
  currentUser: UserRecord,
  taskReference: string,
  relationReference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, ["version"]);
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const result = await deleteTaskRelation(
    currentUser,
    String(task.id),
    relationReference,
    input,
  );
  return {
    deleted: true,
    relationRef: result.relation.id,
    task: await getAgentTaskDetail(currentUser, String(task.public_id)),
  };
}

export async function listAgentTaskAttachments(
  currentUser: UserRecord,
  taskReference: string,
  input: AgentAttachmentListQuery,
  origin: string,
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const after = input.after
    ? {
        createdAt: String(input.after.values[0]),
        ref: input.after.id,
      }
    : null;
  const page = await listTaskAttachments(currentUser, String(task.id), {
    includeDeleted: input.includeDeleted,
    limit: input.limit,
    after,
  });
  const items = page.items.map((attachment) =>
    agentAttachment(attachment, String(task.public_id), origin),
  );
  return {
    data: items,
    page: {
      hasMore: page.hasMore,
      nextCursor: page.hasMore
        ? encodeKeysetCursor(
            {
              values: [page.items.at(-1)!.createdAt],
              id: page.items.at(-1)!.publicId,
            },
            input.fingerprint,
          )
        : null,
    },
    totalCount: page.totalCount,
  };
}

export async function getAgentTaskAttachment(
  currentUser: UserRecord,
  taskReference: string,
  attachmentReference: string,
  origin: string,
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const attachment = await getTaskAttachment(
    currentUser,
    String(task.id),
    attachmentReference,
  );
  return agentAttachment(attachment, String(task.public_id), origin);
}

export async function createAgentTaskAttachment(
  currentUser: UserRecord,
  taskReference: string,
  input: CreateAttachmentInput,
  origin: string,
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const attachment = await createAttachment(currentUser, String(task.id), input);
  return agentAttachment(attachment, String(task.public_id), origin);
}

export async function assertAgentTaskAttachmentWriteAccess(
  currentUser: UserRecord,
  taskReference: string,
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  if (!canEditContent(String(task.access_role) as AccessRole)) {
    throw new PermissionError("Editor access is required");
  }
}

export async function deleteAgentTaskAttachment(
  currentUser: UserRecord,
  taskReference: string,
  attachmentReference: string,
  expectedVersion: number,
  origin: string,
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const attachment = await deleteAttachment(
    currentUser,
    String(task.id),
    attachmentReference,
    expectedVersion,
  );
  return agentAttachment(attachment, String(task.public_id), origin);
}

export async function restoreAgentTaskAttachment(
  currentUser: UserRecord,
  taskReference: string,
  attachmentReference: string,
  expectedVersion: number,
  origin: string,
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const attachment = await restoreAttachment(
    currentUser,
    String(task.id),
    attachmentReference,
    expectedVersion,
  );
  return agentAttachment(attachment, String(task.public_id), origin);
}

export async function getAgentTaskAttachmentContent(
  currentUser: UserRecord,
  taskReference: string,
  attachmentReference: string,
  options: AttachmentContentOptions,
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  return getAttachmentContent(
    currentUser,
    String(task.id),
    attachmentReference,
    options,
  );
}

export async function listAgentTaskComments(
  currentUser: UserRecord,
  taskReference: string,
  input: { limit?: number; cursor?: string | null } = {},
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const page = await listTaskComments(currentUser, String(task.id), input);
  return {
    data: page.threads.map((thread) => ({
      root: agentComment(thread.root, currentUser.id),
      replies: thread.replies.map((reply) => agentComment(reply, currentUser.id)),
    })),
    page: { hasMore: page.hasMore, nextCursor: page.nextCursor },
    totalCount: page.totalCount,
  };
}

export async function listAgentTaskActivity(
  currentUser: UserRecord,
  taskReference: string,
  input: { limit?: number; cursor?: string | null } = {},
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const page = await listTaskActivity(currentUser, String(task.id), input);
  return {
    data: page.events.map((event) => ({
      ref: event.id,
      eventType: event.eventType,
      actor: {
        displayName: event.actor.displayName,
        kind: event.actor.kind,
        isCurrentUser: event.actor.id === currentUser.id,
      },
      payload: privacyMinimizedActivityPayload(event.payload),
      source: event.source,
      historical: event.historical ? {
        sourceEventId: event.historical.sourceEventId,
        sourceIndex: event.historical.sourceIndex,
      } : null,
      createdAt: event.createdAt,
      schemaVersion: event.schemaVersion,
    })),
    page: { hasMore: page.hasMore, nextCursor: page.nextCursor },
    totalCount: page.totalCount,
  };
}

function privacyMinimizedActivityPayload(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitize(value) as Record<string, unknown>;

  function sanitize(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sanitize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .filter(([key]) => !/(^id$|Id$|_id$|^ref$)/.test(key))
        .map(([key, nested]) => [key, sanitize(nested)]),
    );
  }
}

export async function getAgentTaskThread(
  currentUser: UserRecord,
  taskReference: string,
  commentReference: string,
) {
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const thread = await getCommentThread(
    currentUser,
    String(task.id),
    commentReference,
  );
  return {
    root: agentComment(thread.root, currentUser.id),
    replies: thread.replies.map((reply) => agentComment(reply, currentUser.id)),
  };
}

export async function createAgentTaskComment(
  currentUser: UserRecord,
  taskReference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, ["body", "idempotencyKey", "parentCommentRef"]);
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  const created = await createComment(currentUser, String(task.id), {
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    ...(input.parentCommentRef
      ? { parentCommentId: String(input.parentCommentRef) }
      : {}),
  });
  return agentComment(created, currentUser.id);
}

export async function editAgentTaskComment(
  currentUser: UserRecord,
  taskReference: string,
  commentReference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, ["version", "body"]);
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  return agentComment(
    await editComment(currentUser, String(task.id), commentReference, input),
    currentUser.id,
  );
}

export async function deleteAgentTaskComment(
  currentUser: UserRecord,
  taskReference: string,
  commentReference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, ["version"]);
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  return agentComment(
    await deleteComment(currentUser, String(task.id), commentReference, input),
    currentUser.id,
  );
}

export async function setAgentCommentReaction(
  currentUser: UserRecord,
  taskReference: string,
  commentReference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, ["emoji", "active"]);
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  return setCommentReaction(
    currentUser,
    String(task.id),
    commentReference,
    input,
  );
}

export async function resolveAgentTaskThread(
  currentUser: UserRecord,
  taskReference: string,
  commentReference: string,
  input: Record<string, unknown>,
) {
  assertOnlyKeys(input, ["version", "resolved", "resolutionCommentRef"]);
  const task = await loadAccessibleTaskRow(currentUser.id, taskReference);
  return agentComment(
    await resolveCommentThread(currentUser, String(task.id), commentReference, {
      version: input.version,
      resolved: input.resolved,
      resolutionCommentId: input.resolutionCommentRef ?? null,
    }),
    currentUser.id,
  );
}

async function loadAccessibleTaskRow(userId: string, reference: string) {
  const rows = await getD1()
    .prepare(
      `${taskScopeCte(true)}
       SELECT ${taskProjection}
       FROM visible_tasks v
       WHERE v.public_id = ? OR upper(v.identifier) = upper(?)
          OR EXISTS (
            SELECT 1 FROM task_identifier_aliases alias
            WHERE alias.task_id = v.id
              AND upper(alias.identifier) = upper(?)
          )
       ORDER BY v.public_id LIMIT 3`,
    )
    .bind(...taskScopeParameters(userId), reference, reference, reference)
    .all<DbRow>();
  if (rows.results.length === 0) throw new NotFoundError("Task not found");
  if (rows.results.length > 1) {
    throw new AgentApiError(
      "ambiguous_reference",
      "The task identifier is ambiguous; use a canonical ref",
      409,
      {
        candidates: rows.results.map((row) => ({
          ref: String(row.public_id),
          identifier: String(row.identifier),
          title: String(row.title),
        })),
      },
    );
  }
  return rows.results[0]!;
}

async function loadAccessibleProjectRow(
  userId: string,
  reference: string,
  withCounts = false,
) {
  const row = await getD1()
    .prepare(
      `${projectScopeCte}
       SELECT p.*${withCounts ? `, ${taskCategoryCounts("p.id")},
         (SELECT COUNT(*) FROM releases r WHERE r.project_id = p.id) AS release_count` : ""}
       FROM visible_projects p WHERE p.public_id = ? LIMIT 1`,
    )
    .bind(userId, userId, reference)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Project not found");
  return row;
}

async function loadAccessibleReleaseRow(
  userId: string,
  reference: string,
  withCounts = false,
) {
  const row = await getD1()
    .prepare(
      `${releaseScopeCte}
       SELECT r.*${withCounts ? `, ${taskCategoryCounts("r.project_id", "r.id")}` : ""}
       FROM visible_releases r WHERE r.public_id = ? LIMIT 1`,
    )
    .bind(userId, userId, reference)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Release not found");
  return row;
}

async function loadAccessibleSavedViewRow(userId: string, reference: string) {
  const row = await getD1().prepare(
    `${savedViewScopeCte}
     SELECT v.* FROM visible_views v WHERE v.public_id = ? LIMIT 1`,
  ).bind(userId, userId, userId, userId, reference).first<DbRow>();
  if (!row) throw new NotFoundError("Saved View not found");
  return row;
}

async function loadParentTask(currentUser: UserRecord, id: string | null) {
  if (!id) return null;
  const row = await getD1()
    .prepare(
      `${taskScopeCte(false)}
       SELECT v.* FROM visible_tasks v WHERE v.id = ? LIMIT 1`,
    )
    .bind(...taskScopeParameters(currentUser.id), id)
    .first<DbRow>();
  return row ? mapCompactTaskLink(row) : null;
}

async function loadSubtasks(currentUser: UserRecord, taskId: string) {
  const rows = await getD1()
    .prepare(
      `${taskScopeCte(false)}
       SELECT v.* FROM visible_tasks v
       WHERE v.parent_task_id = ?
       ORDER BY v.rank, v.created_at LIMIT 200`,
    )
    .bind(...taskScopeParameters(currentUser.id), taskId)
    .all<DbRow>();
  return Promise.all(rows.results.map(mapCompactTaskLink));
}

async function loadRelations(currentUser: UserRecord, taskId: string) {
  const rows = await getD1()
    .prepare(
      `${taskScopeCte(false)}
       SELECT other.*, tr.id AS relation_id, tr.type AS relation_type,
         tr.version AS relation_version, tr.created_at AS relation_created_at,
         tr.updated_at AS relation_updated_at,
         source_status.category AS relation_source_status_category,
         CASE WHEN tr.source_task_id = ? THEN 'outgoing' ELSE 'incoming' END
           AS relation_direction
       FROM task_relations tr
       JOIN tasks source_task ON source_task.id = tr.source_task_id
       JOIN workflow_statuses source_status ON source_status.id = source_task.status_id
       JOIN visible_tasks other ON other.id = CASE
         WHEN tr.source_task_id = ? THEN tr.target_task_id
         ELSE tr.source_task_id END
       WHERE tr.source_task_id = ? OR tr.target_task_id = ?
       ORDER BY tr.type, other.identifier LIMIT 200`,
    )
    .bind(
      ...taskScopeParameters(currentUser.id),
      taskId,
      taskId,
      taskId,
      taskId,
    )
    .all<DbRow>();
  return Promise.all(
    rows.results.map(async (row) => ({
      ref: String(row.relation_id),
      type: String(row.relation_type),
      direction: String(row.relation_direction),
      presentation: relationPresentation(
        String(row.relation_type),
        String(row.relation_direction),
        String(row.relation_source_status_category),
      ),
      version: Number(row.relation_version),
      createdAt: String(row.relation_created_at),
      updatedAt: String(row.relation_updated_at),
      task: await mapCompactTaskLink(row),
    })),
  );
}

async function relationMutationResult(
  currentUser: UserRecord,
  taskReference: string,
  relationReference: string,
) {
  const task = await getAgentTaskDetail(currentUser, taskReference);
  const relation = task.relations.find(
    (item) => item.ref === relationReference,
  );
  if (!relation) throw new NotFoundError("Relation not found");
  return { relation, task };
}

function relationPresentation(
  type: string,
  direction: string,
  sourceStatusCategory: string,
) {
  if (type === "related") return "related";
  if (type === "duplicate_of") {
    return direction === "outgoing" ? "duplicate_of" : "duplicates";
  }
  if (
    type === "blocks" &&
    (sourceStatusCategory === "completed" || sourceStatusCategory === "canceled")
  ) {
    return "related";
  }
  return direction === "outgoing" ? "blocks" : "blocked_by";
}

async function loadProvenanceSummary(taskId: string, ownerUserId: string) {
  const row = await getD1()
    .prepare(
      `SELECT source, source_url,
         COALESCE(json_array_length(metadata_json, '$.comments'), 0)
           AS comment_count,
         COALESCE(json_array_length(metadata_json, '$.attachments'), 0)
           AS attachment_count,
         (SELECT COUNT(*) FROM activity_migration_outcomes outcome
          WHERE outcome.source_record_id = external_records.id
            AND outcome.outcome = 'migrated') AS activity_count
       FROM external_records
       WHERE target_type = 'task' AND target_id = ? AND owner_user_id = ?
       ORDER BY imported_at DESC LIMIT 1`,
    )
    .bind(taskId, ownerUserId)
    .first<DbRow>();
  if (!row) return null;
  const commentCount = Number(row.comment_count ?? 0);
  const attachmentCount = Number(row.attachment_count ?? 0);
  const activityCount = Number(row.activity_count ?? 0);
  return {
    source: String(row.source),
    sourceUrl: nullableString(row.source_url),
    commentCount,
    attachmentCount,
    activityCount,
    hasExternalContext: commentCount > 0 || attachmentCount > 0 || activityCount > 0,
  };
}

async function loadNativeAttachmentCount(taskId: string) {
  const row = await getD1()
    .prepare(
      `SELECT COUNT(*) AS count FROM attachments
       WHERE task_id = ? AND state <> 'deleted'`,
    )
    .bind(taskId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function resolveStatusReference(ownerUserId: string, reference: string) {
  const rows = await getD1()
    .prepare(
      `SELECT id FROM workflow_statuses
       WHERE owner_user_id = ? AND archived_at IS NULL ORDER BY position, id`,
    )
    .bind(ownerUserId)
    .all<{ id: string }>();
  for (const row of rows.results) {
    if ((await catalogReference("status", row.id)) === reference) return row.id;
  }
  throw new ValidationError("Status is not available for this task");
}

async function resolveLabelReference(
  ownerUserId: string,
  reference: string,
  allowArchived: boolean,
) {
  const rows = await getD1().prepare(
    `SELECT id FROM labels
     WHERE owner_user_id = ?${allowArchived ? "" : " AND archived_at IS NULL"}
     ORDER BY id`,
  ).bind(ownerUserId).all<{ id: string }>();
  for (const row of rows.results) {
    if ((await catalogReference("label", row.id)) === reference) return row.id;
  }
  throw new ValidationError("Label is not available for this Task");
}

async function mapTaskSummary(row: DbRow, currentUser: UserRecord) {
  const labels = safeJson<Array<{ id: string; name: string }>>(
    row.labels_json,
    [],
  );
  return {
    ref: String(row.public_id),
    identifier: String(row.identifier),
    title: String(row.title),
    status: {
      ref: await catalogReference("status", String(row.status_id)),
      name: String(row.status_name),
      category: String(row.status_category),
    },
    priority: String(row.priority),
    project: row.project_public_id
      ? { ref: String(row.project_public_id), name: String(row.project_name) }
      : null,
    release: row.release_public_id
      ? { ref: String(row.release_public_id), name: String(row.release_name) }
      : null,
    assignee: row.assignee_user_id
      ? {
          displayName: String(row.assignee_display_name),
          isCurrentUser: String(row.assignee_user_id) === currentUser.id,
        }
      : null,
    labels: await Promise.all(
      labels.map(async (label) => ({
        ref: await catalogReference("label", String(label.id)),
        name: String(label.name),
      })),
    ),
    dueDate: nullableString(row.due_date),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    contextHints: {
      hasDescription: Boolean(row.has_description ?? String(row.description ?? "")),
      subtaskCount: Number(row.subtask_count ?? 0),
      relationCount: Number(row.relation_count ?? 0),
      commentCount: Number(row.comment_count ?? 0),
    },
  };
}

function agentAttachment(
  attachment: AttachmentRecord,
  taskReference: string,
  origin: string,
) {
  const task = encodeURIComponent(taskReference);
  const ref = encodeURIComponent(attachment.publicId);
  const base = new URL(`/api/agent/v1/tasks/${task}/attachments/${ref}`, origin);
  return {
    ref: attachment.publicId,
    filename: attachment.displayName,
    mediaType: attachment.mediaType,
    byteSize: attachment.byteSize,
    checksumSha256: attachment.checksumSha256,
    kind: attachment.kind,
    state: attachment.state,
    imageWidth: attachment.imageWidth,
    imageHeight: attachment.imageHeight,
    variants: attachment.variants,
    failureCode: attachment.failureCode,
    version: attachment.version,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
    deletedAt: attachment.deletedAt,
    links: {
      metadata: base.toString(),
      original:
        attachment.state === "ready"
          ? `${base.toString()}/content?variant=original`
          : null,
      thumbnail:
        attachment.state === "ready" && attachment.kind === "image"
          ? `${base.toString()}/content?variant=thumbnail`
          : null,
    },
  };
}

function agentComment(comment: import("./types").CommentRecord, currentUserId: string) {
  return {
    ref: comment.id,
    parentCommentRef: comment.parentCommentId,
    author: {
      displayName: comment.author.displayName,
      kind: comment.author.kind,
      isCurrentUser: comment.author.id !== null && comment.author.id === currentUserId,
    },
    body: comment.body,
    source: comment.source,
    historical: comment.historical,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    deletedAt: comment.deletedAt,
    resolvedAt: comment.resolvedAt,
    resolutionCommentRef: comment.resolutionCommentId,
    version: comment.version,
    reactions: comment.reactions,
    permissions: comment.permissions,
  };
}

async function mapCompactTaskLink(row: DbRow) {
  return {
    ref: String(row.public_id),
    identifier: String(row.identifier),
    title: String(row.title),
    status: {
      ref: await catalogReference("status", String(row.status_id)),
      name: String(row.status_name),
      category: String(row.status_category),
    },
  };
}

function mapProjectSummary(row: DbRow) {
  const counts = categoryCounts(row);
  const denominator = counts.total - counts.canceled;
  return {
    ref: String(row.public_id),
    name: String(row.name),
    taskCode: String(row.task_code),
    taskSequence: Number(row.task_sequence),
    codeLocked: row.code_locked_at != null,
    summary: String(row.summary ?? ""),
    status: String(row.status),
    icon: String(row.icon ?? "cube"),
    color: String(row.color ?? "#8b7cf6"),
    archivedAt: nullableString(row.archived_at),
    startDate: nullableString(row.start_date),
    targetDate: nullableString(row.target_date),
    taskCounts: counts,
    progress: denominator > 0 ? counts.completed / denominator : 0,
    releaseCount: Number(row.release_count ?? 0),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

function mapReleaseSummary(row: DbRow) {
  const counts = categoryCounts(row);
  const denominator = counts.total - counts.canceled;
  return {
    ref: String(row.public_id),
    project: {
      ref: String(row.project_public_id),
      name: String(row.project_name),
    },
    name: String(row.name),
    status: String(row.status),
    targetDate: nullableString(row.target_date),
    releasedAt: nullableString(row.released_at),
    taskCounts: counts,
    progress: denominator > 0 ? counts.completed / denominator : 0,
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

function mapSavedView(row: DbRow) {
  const accessRole = String(row.access_role) as AccessRole;
  return {
    ref: String(row.public_id),
    name: String(row.name),
    scope: row.scope_project_id
      ? {
          type: "project" as const,
          project: {
            ref: String(row.project_public_id),
            name: String(row.project_name),
          },
        }
      : { type: "global" as const, project: null },
    query: parseStoredViewQuery(row.query_json),
    display: parseStoredViewDisplay(row.display_json),
    archivedAt: nullableString(row.archived_at),
    access: {
      role: accessRole,
      canEdit: canEditContent(accessRole),
    },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

async function mapStatusSummary(row: DbRow) {
  return {
    ref: await catalogReference("status", String(row.id)),
    name: String(row.name),
    category: String(row.category),
    color: String(row.color),
    position: Number(row.position),
    isDefault: Boolean(row.is_default),
  };
}

async function loadStatusSummaries(ownerUserId: string) {
  const rows = await getD1()
    .prepare(
      `SELECT * FROM workflow_statuses
       WHERE owner_user_id = ? AND archived_at IS NULL ORDER BY position, name`,
    )
    .bind(ownerUserId)
    .all<DbRow>();
  return Promise.all(rows.results.map(mapStatusSummary));
}

function taskCategoryCounts(projectExpression: string, releaseExpression?: string) {
  const releasePredicate = releaseExpression
    ? ` AND t.release_id = ${releaseExpression}`
    : "";
  const base = `t.project_id = ${projectExpression}${releasePredicate} AND t.archived_at IS NULL`;
  return `(SELECT COUNT(*) FROM tasks t WHERE ${base}) AS task_total,
    (SELECT COUNT(*) FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE ${base} AND s.category = 'backlog') AS task_backlog,
    (SELECT COUNT(*) FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE ${base} AND s.category = 'unstarted') AS task_unstarted,
    (SELECT COUNT(*) FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE ${base} AND s.category = 'started') AS task_started,
    (SELECT COUNT(*) FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE ${base} AND s.category = 'completed') AS task_completed,
    (SELECT COUNT(*) FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE ${base} AND s.category = 'canceled') AS task_canceled`;
}

function categoryCounts(row: DbRow) {
  return {
    total: Number(row.task_total ?? 0),
    backlog: Number(row.task_backlog ?? 0),
    unstarted: Number(row.task_unstarted ?? 0),
    started: Number(row.task_started ?? 0),
    completed: Number(row.task_completed ?? 0),
    canceled: Number(row.task_canceled ?? 0),
  };
}

function taskScopeParameters(userId: string) {
  return [userId, userId, userId, userId];
}

function taskOrderExpression(order: AgentTaskListQuery["order"]) {
  if (order === "manual") return "v.rank";
  if (order === "created") return "v.created_at";
  if (order === "priority") {
    return `CASE v.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
      WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
  }
  if (order === "due") return "COALESCE(v.due_date, '9999-12-31')";
  if (order === "title") return "lower(v.title)";
  return "v.updated_at";
}

function releaseOrderExpression() {
  return `printf('%01d|%s', CASE r.status
    WHEN 'active' THEN 0 WHEN 'planned' THEN 1
    WHEN 'released' THEN 2 ELSE 3 END,
    COALESCE(r.target_date, '9999-12-31'))`;
}

function appendKeysetPredicate(
  predicates: string[],
  parameters: unknown[],
  valueExpression: string,
  direction: "ASC" | "DESC",
  after: AgentKeysetPosition | null,
  idExpression = "v.public_id",
) {
  if (!after) return;
  if (after.values.length !== 1) {
    throw new AgentApiError("invalid_argument", "Cursor is invalid", 400);
  }
  const comparison = direction === "ASC" ? ">" : "<";
  predicates.push(
    `(${valueExpression} ${comparison} ? OR
      (${valueExpression} = ? AND ${idExpression} ${comparison} ?))`,
  );
  parameters.push(after.values[0], after.values[0], after.id);
}

function keysetCursor(row: DbRow, fingerprint: string) {
  const value = row.cursor_value;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new AgentApiError("internal_error", "Pagination key is invalid", 500);
  }
  return encodeKeysetCursor(
    { values: [value], id: String(row.public_id) },
    fingerprint,
  );
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function prefixRange(value: string): [string, string] {
  const start = value.toLocaleLowerCase("en-US");
  return [start, `${start}\uffff`];
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function externalAttachments(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.title !== "string" || typeof item.url !== "string") {
      return [];
    }
    return [{
      title: item.title,
      subtitle: typeof item.subtitle === "string" ? item.subtitle : null,
      url: item.url,
    }];
  });
}

function assertOnlyKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new ValidationError(`Unknown task field: ${key}`);
    }
  }
}
