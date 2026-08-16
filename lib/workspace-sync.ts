import { getD1 } from "@/db";
import { getSnapshot } from "./repository";
import type {
  AppSnapshot,
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

export async function getWorkspaceSync(
  user: UserRecord,
  cursorValue: string,
): Promise<WorkspaceSyncResponse> {
  const db = getD1();
  const state = await db
    .prepare(
      `SELECT last_sequence FROM workspace_sync_sequences
       WHERE audience_user_id = ?`,
    )
    .bind(user.id)
    .first<{ last_sequence: number }>();
  const lastSequence = Number(state?.last_sequence ?? 0);
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
  const snapshot = await getSnapshot(user);
  const touched = coalesceTouchedEntities(rows);
  return {
    cursor: encodeWorkspaceSyncCursor(processedSequence),
    resetRequired: false,
    hasMore: page.results.length > SYNC_PAGE_SIZE,
    changes: buildChanges(snapshot, touched),
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
    labels: [],
    taskLabels: [],
    relations: [],
  };
}

function isIncrementalEntity(value: string): value is "task" | "project" | "release" | "saved_view" {
  return value === "task" || value === "project" || value === "release" || value === "saved_view";
}

function coalesceTouchedEntities(rows: ChangeRow[]) {
  const touched = {
    task: new Set<string>(),
    project: new Set<string>(),
    release: new Set<string>(),
    saved_view: new Set<string>(),
  };
  for (const row of rows) {
    if (isIncrementalEntity(row.entity_type)) {
      touched[row.entity_type].add(String(row.entity_id));
    }
  }
  return touched;
}

function buildChanges(
  snapshot: AppSnapshot,
  touched: ReturnType<typeof coalesceTouchedEntities>,
): WorkspaceSyncChanges {
  const tasks = collectionPatch(snapshot.tasks, touched.task);
  const projects = collectionPatch(snapshot.projects, touched.project);
  const releases = collectionPatch(snapshot.releases, touched.release);
  const views = collectionPatch(snapshot.views, touched.saved_view);
  const upsertedTaskIds = new Set(tasks.upsert.map((task) => task.id));
  const taskLabels = snapshot.taskLabels.filter((assignment) =>
    upsertedTaskIds.has(assignment.taskId),
  );
  const labelIds = new Set(taskLabels.map((assignment) => assignment.labelId));
  return {
    tasks,
    projects,
    releases,
    views,
    labels: snapshot.labels.filter((label) => labelIds.has(label.id)),
    taskLabels,
    relations: snapshot.relations.filter(
      (relation) =>
        upsertedTaskIds.has(relation.sourceTaskId) ||
        upsertedTaskIds.has(relation.targetTaskId),
    ),
  };
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
