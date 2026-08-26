import type {
  AppSnapshot,
  DeletableEntityType,
  DeletionPreview,
  RecentlyDeletedPage,
  WorkspaceSyncResponse,
} from "./types";

export type DeletionAction = "delete" | "restore_deleted" | "purge";

export type DeletionLifecycleResult = {
  type: DeletableEntityType;
  id: string;
  publicId: string;
  version: number;
  deletedAt: string | null;
  purgeAfter: string | null;
};

export type RecoverableDeletionResponse = { entity: DeletionLifecycleResult };
export type PermanentDeletionResponse = {
  type: DeletableEntityType;
  id: string;
  purged: true;
};

export const RECENTLY_DELETED_CHANGED_EVENT = "task-manager:recently-deleted-changed";

export class DeletionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function deletionErrorRequiresRefetch(error: unknown) {
  return error instanceof DeletionRequestError &&
    (error.status === 403 || error.status === 404 || error.status === 409);
}

export type DeletionConvergenceResult =
  | { ok: true }
  | { ok: false; message: string };

/** Retry only the authoritative read after a lifecycle mutation has committed. */
export async function convergeDeletionWorkspace(
  refresh?: () => Promise<unknown> | unknown,
): Promise<DeletionConvergenceResult> {
  if (!refresh) return { ok: true };
  try {
    await refresh();
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error && error.message
      ? ` ${error.message}`
      : "";
    return {
      ok: false,
      message: `The deletion action completed, but workspace data could not be refreshed.${detail}`,
    };
  }
}

export function deletionEntityPath(type: DeletableEntityType, id: string) {
  const collection = type === "saved_view" ? "views" : `${type}s`;
  return `/api/${collection}/${encodeURIComponent(id)}`;
}

export function deletionActionRequest(
  type: DeletableEntityType,
  id: string,
  action: DeletionAction,
  version: number,
  confirmation?: string,
) {
  const base = deletionEntityPath(type, id);
  return {
    path: action === "delete"
      ? base
      : `${base}/${action === "restore_deleted" ? "restore" : "purge"}`,
    init: {
      method: action === "delete" ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version,
        ...(action === "purge" ? { confirmation } : {}),
      }),
    } satisfies RequestInit,
  };
}

export async function performDeletionAction(
  type: DeletableEntityType,
  id: string,
  action: DeletionAction,
  version: number,
  options: { confirmation?: string; fetcher?: typeof fetch } = {},
): Promise<RecoverableDeletionResponse | PermanentDeletionResponse> {
  const { path, init } = deletionActionRequest(
    type,
    id,
    action,
    version,
    options.confirmation,
  );
  return readDeletionJson<RecoverableDeletionResponse | PermanentDeletionResponse>(
    await (options.fetcher ?? fetch)(path, init),
  );
}

/**
 * Immediate cache pruning for a successful recoverable delete. Restore and
 * purge deliberately use an authoritative bootstrap/sync refresh instead of
 * trying to reconstruct server projections in the browser.
 */
export function pruneDeletedEntityFromSnapshot(
  snapshot: AppSnapshot,
  type: DeletableEntityType,
  id: string,
): AppSnapshot {
  const removedTaskIds = new Set<string>();
  if (type === "task") removedTaskIds.add(id);
  if (type === "project") {
    snapshot.tasks.forEach((task) => {
      if (task.projectId === id) removedTaskIds.add(task.id);
    });
  }
  const tasks = snapshot.tasks
    .filter((task) => !removedTaskIds.has(task.id))
    .map((task) => type === "release" && task.releaseId === id
      ? { ...task, releaseId: null }
      : task);
  const projects = type === "project"
    ? snapshot.projects.filter((project) => project.id !== id)
    : snapshot.projects;
  const releases = snapshot.releases.filter((release) =>
    type === "release"
      ? release.id !== id
      : type !== "project" || release.projectId !== id
  );
  const views = snapshot.views.filter((view) =>
    type === "saved_view"
      ? view.id !== id
      : type !== "project" || view.scopeProjectId !== id
  );
  return {
    ...snapshot,
    tasks,
    projects,
    releases,
    views,
    taskLabels: snapshot.taskLabels.filter((assignment) =>
      !removedTaskIds.has(assignment.taskId)
    ),
    relations: snapshot.relations.filter((relation) =>
      !removedTaskIds.has(relation.sourceTaskId) &&
      !removedTaskIds.has(relation.targetTaskId)
    ),
    navigationCollections: snapshot.navigationCollections
      ? {
          projects: pruneNavigationCollection(
            snapshot.navigationCollections.projects,
            (project) => type !== "project" || project.id !== id,
          ),
          releases: pruneNavigationCollection(
            snapshot.navigationCollections.releases,
            (release) => type === "release"
              ? release.id !== id
              : type !== "project" || release.projectId !== id,
          ),
          views: pruneNavigationCollection(
            snapshot.navigationCollections.views,
            (view) => type === "saved_view"
              ? view.id !== id
              : type !== "project" || view.scopeProjectId !== id,
          ),
        }
      : undefined,
  };
}

function pruneNavigationCollection<T>(
  collection: { items: T[]; total: number; hasMore: boolean },
  retain: (item: T) => boolean,
) {
  const items = collection.items.filter(retain);
  return {
    ...collection,
    items,
    total: Math.max(0, collection.total - (collection.items.length - items.length)),
  };
}

export async function fetchRecentlyDeleted(
  input: {
    type?: DeletableEntityType;
    search?: string;
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  } = {},
) {
  const parameters = new URLSearchParams({ limit: String(input.limit ?? 30) });
  if (input.type) parameters.set("type", input.type);
  if (input.search?.trim()) parameters.set("search", input.search.trim());
  if (input.cursor) parameters.set("cursor", input.cursor);
  return readDeletionJson<RecentlyDeletedPage>(
    await (input.fetcher ?? fetch)(`/api/recently-deleted?${parameters}`, {
      cache: "no-store",
      signal: input.signal,
    }),
  );
}

export async function fetchDeletionPreview(
  type: DeletableEntityType,
  id: string,
  version: number,
  fetcher: typeof fetch = fetch,
) {
  const path = `/api/recently-deleted/${encodeURIComponent(type)}/${encodeURIComponent(id)}/preview?version=${encodeURIComponent(version)}`;
  return readDeletionJson<DeletionPreview>(
    await fetcher(path, { cache: "no-store" }),
  );
}

export function notifyRecentlyDeletedChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(RECENTLY_DELETED_CHANGED_EVENT));
}

export function workspaceSyncAffectsRecentlyDeleted(
  response: Pick<WorkspaceSyncResponse, "changes">,
) {
  const { changes } = response;
  return changes.tasks.upsert.length > 0 || changes.tasks.remove.length > 0 ||
    changes.projects.upsert.length > 0 || changes.projects.remove.length > 0 ||
    changes.releases.upsert.length > 0 || changes.releases.remove.length > 0 ||
    changes.views.upsert.length > 0 || changes.views.remove.length > 0;
}

async function readDeletionJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => null) as T | { error?: string } | null;
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value && value.error
      ? value.error
      : "Deletion request failed";
    throw new DeletionRequestError(message, response.status);
  }
  return value as T;
}
