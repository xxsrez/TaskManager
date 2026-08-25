import { getD1 } from "@/db";
import {
  getWorkspaceTaskMetrics,
  getWorkspaceSyncProjection,
  resolveUiWorkspaceScope,
  type WorkspaceSyncProjection,
} from "./repository";
import type {
  UserRecord,
  WorkspaceSyncChanges,
  WorkspaceSyncResponse,
} from "./types";
import {
  decodeWorkspaceSyncCursor,
  encodeWorkspaceSyncCursor,
} from "./workspace-sync-cursor";

type ChangeRow = {
  sequence: number;
  entity_type: string;
  entity_id: string;
  operation: string;
};

const SYNC_PAGE_SIZE = 200;
const SYNC_RETENTION_DAYS = 30;
const SYNC_PRUNE_INTERVAL_HOURS = 24;

export async function getWorkspaceSync(
  user: UserRecord,
  cursorValue: string,
  workspaceScopeToken?: string | null,
): Promise<WorkspaceSyncResponse> {
  const db = getD1();
  const workspaceScope = workspaceScopeToken === undefined
    ? null
    : await resolveUiWorkspaceScope(user, workspaceScopeToken);
  await pruneWorkspaceSyncEvents(db);
  const state = await db
    .prepare(
      `SELECT last_sequence FROM workspace_sync_sequences
       WHERE audience_user_id = ?`,
    )
    .bind(user.id)
    .first<{ last_sequence: number }>();
  const lastSequence = Number(state?.last_sequence ?? 0);
  if (workspaceScope?.fallback) return resetResponse(lastSequence);
  const cursor = decodeWorkspaceSyncCursor(cursorValue);
  if (cursor === null || cursor > lastSequence) {
    return resetResponse(lastSequence);
  }

  const earliest = await db
    .prepare(
      `SELECT MIN(sequence) AS sequence FROM workspace_change_events
       WHERE audience_user_id = ?`,
    )
    .bind(user.id)
    .first<{ sequence: number | null }>();
  const earliestSequence = earliest?.sequence === null || earliest?.sequence === undefined
    ? null
    : Number(earliest.sequence);
  if (earliestSequence !== null && cursor < earliestSequence - 1) {
    return resetResponse(lastSequence);
  }

  const page = await db
    .prepare(
      `SELECT sequence, entity_type, entity_id, operation
       FROM workspace_change_events
       WHERE audience_user_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
    )
    .bind(user.id, cursor, SYNC_PAGE_SIZE + 1)
    .all<ChangeRow>();
  const rows = page.results.slice(0, SYNC_PAGE_SIZE);
  if (rows.length === 0 && cursor < lastSequence) {
    return resetResponse(lastSequence);
  }
  if (!hasContinuousSequence(rows, cursor)) {
    return resetResponse(lastSequence);
  }
  if (rows.some((row) => row.entity_type === "workspace" || row.operation === "reset")) {
    return resetResponse(lastSequence);
  }
  if (rows.some((row) => !isIncrementalEntity(row.entity_type))) {
    return resetResponse(lastSequence);
  }
  if (rows.length === 0) {
    return {
      cursor: cursorValue,
      resetRequired: false,
      hasMore: false,
      changes: emptyChanges(),
    };
  }

  const processedSequence = Number(rows.at(-1)!.sequence);
  const touched = coalesceTouchedEntities(rows);
  const invalidatedTaskIds = [
    ...touched.task_detail,
    ...touched.task_comments,
    ...touched.task_activity,
    ...touched.task_attachments,
  ];
  const [projection, workspaceMetrics] = await Promise.all([
    getWorkspaceSyncProjection(user, {
      taskIds: [...touched.task],
      projectIds: [...touched.project],
      releaseIds: [...touched.release],
      viewIds: [...touched.saved_view],
      labelGroupIds: [...touched.label_group],
      invalidatedTaskIds,
      ...(workspaceScope
        ? { workspaceOwnerUserId: workspaceScope.ownerUserId }
        : {}),
    }),
    workspaceScope
      ? getWorkspaceTaskMetrics(user, workspaceScope.ownerUserId)
      : Promise.resolve(undefined),
  ]);
  return {
    cursor: encodeWorkspaceSyncCursor(processedSequence),
    resetRequired: false,
    hasMore: page.results.length > SYNC_PAGE_SIZE,
    changes: buildChanges(projection, touched),
    ...(workspaceMetrics ? { workspaceMetrics } : {}),
  };
}

function hasContinuousSequence(rows: ChangeRow[], cursor: number): boolean {
  let expected = cursor + 1;
  for (const row of rows) {
    if (Number(row.sequence) !== expected) return false;
    expected += 1;
  }
  return true;
}

function resetResponse(sequence: number): WorkspaceSyncResponse {
  return {
    cursor: encodeWorkspaceSyncCursor(sequence),
    resetRequired: true,
    hasMore: false,
    changes: emptyChanges(),
  };
}

function emptyChanges(): WorkspaceSyncChanges {
  return {
    tasks: { upsert: [], remove: [] },
    projects: { upsert: [], remove: [] },
    releases: { upsert: [], remove: [] },
    views: { upsert: [], remove: [] },
    invalidations: {
      taskDetails: [],
      taskComments: [],
      taskActivities: [],
      taskAttachments: [],
    },
    labels: [],
    labelGroups: [],
    taskLabels: [],
    relations: [],
  };
}

type IncrementalEntity =
  | "task"
  | "project"
  | "release"
  | "saved_view"
  | "label_group"
  | "task_detail"
  | "task_comments"
  | "task_activity"
  | "task_attachments"
  | "task_external_source";

function isIncrementalEntity(value: string): value is IncrementalEntity {
  return value === "task" ||
    value === "project" ||
    value === "release" ||
    value === "saved_view" ||
    value === "label_group" ||
    value === "task_detail" ||
    value === "task_comments" ||
    value === "task_activity" ||
    value === "task_attachments" ||
    value === "task_external_source";
}

function coalesceTouchedEntities(rows: ChangeRow[]) {
  const touched = {
    task: new Set<string>(),
    project: new Set<string>(),
    release: new Set<string>(),
    saved_view: new Set<string>(),
    label_group: new Set<string>(),
    task_detail: new Set<string>(),
    task_comments: new Set<string>(),
    task_activity: new Set<string>(),
    task_attachments: new Set<string>(),
    task_external_source: new Set<string>(),
  };
  for (const row of rows) {
    if (isIncrementalEntity(row.entity_type)) {
      touched[row.entity_type].add(String(row.entity_id));
    }
  }
  return touched;
}

function buildChanges(
  projection: WorkspaceSyncProjection,
  touched: ReturnType<typeof coalesceTouchedEntities>,
): WorkspaceSyncChanges {
  const accessibleTaskIds = new Set(projection.accessibleTaskIds);
  return {
    tasks: collectionPatch(projection.tasks, touched.task),
    projects: collectionPatch(projection.projects, touched.project),
    releases: collectionPatch(projection.releases, touched.release),
    views: collectionPatch(projection.views, touched.saved_view),
    invalidations: {
      taskDetails: [...touched.task_detail].filter((id) => accessibleTaskIds.has(id)),
      taskComments: [...touched.task_comments].filter((id) => accessibleTaskIds.has(id)),
      taskActivities: [...touched.task_activity].filter((id) => accessibleTaskIds.has(id)),
      taskAttachments: [...touched.task_attachments].filter((id) =>
        accessibleTaskIds.has(id)
      ),
    },
    // Only labels assigned to invalidated Tasks are projected. The owner
    // catalog remains detail-on-demand and never expands compact sync pages.
    labels: projection.labels,
    labelGroups: projection.labelGroups,
    taskLabels: projection.taskLabels,
    labelContextTaskIds: projection.labelContextTaskIds,
    relations: [],
  };
}

async function pruneWorkspaceSyncEvents(db: D1Database): Promise<void> {
  const claim = await db
    .prepare(
      `INSERT INTO workspace_sync_maintenance (key, last_run_at)
       VALUES ('event-retention', CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET last_run_at = CURRENT_TIMESTAMP
       WHERE last_run_at < datetime('now', '-' || ? || ' hours')
       RETURNING last_run_at`,
    )
    .bind(SYNC_PRUNE_INTERVAL_HOURS)
    .first<{ last_run_at: string }>();
  if (!claim) return;
  await db
    .prepare(
      `DELETE FROM workspace_change_events
       WHERE created_at < datetime('now', '-' || ? || ' days')`,
    )
    .bind(SYNC_RETENTION_DAYS)
    .run();
}

function collectionPatch<T extends { id: string }>(items: T[], touched: Set<string>) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    upsert: [...touched].flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    }),
    remove: [...touched].filter((id) => !byId.has(id)),
  };
}
