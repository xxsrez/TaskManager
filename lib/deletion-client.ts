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

export type ReleaseDeletionPreview = {
  type: "release";
  id: string;
  publicId: string;
  displayName: string;
  context: string | null;
  version: number;
  status: "planned" | "active" | "released" | "canceled";
  taskMemberships: number;
  requiresReleasedCompositionConfirmation: boolean;
};

export type ProjectDeletionPreview = {
  type: "project";
  id: string;
  publicId: string;
  displayName: string;
  context: string | null;
  version: number;
  impact: {
    tasks: number;
    releases: number;
    savedViews: number;
    comments: number;
    attachments: number;
  };
  activeNavigation?: {
    releases: number;
    savedViews: number;
  };
};

export type ProjectActiveNavigationCounts = NonNullable<
  ProjectDeletionPreview["activeNavigation"]
>;

export function projectDeletionImpactLines(
  preview: Pick<ProjectDeletionPreview, "impact">,
) {
  const { impact } = preview;
  return [
    `${impact.tasks.toLocaleString()} Task${impact.tasks === 1 ? "" : "s"} will be hidden by the Project shadow.`,
    `${impact.releases.toLocaleString()} Release${impact.releases === 1 ? "" : "s"} will be hidden.`,
    `${impact.savedViews.toLocaleString()} project-scoped Saved View${impact.savedViews === 1 ? "" : "s"} will be hidden.`,
    `${impact.comments.toLocaleString()} comment${impact.comments === 1 ? "" : "s"} and ${impact.attachments.toLocaleString()} Attachment${impact.attachments === 1 ? "" : "s"} stay stored for restore.`,
  ];
}

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
  input: Record<string, unknown> = {},
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
        ...input,
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
  options: {
    confirmation?: string;
    input?: Record<string, unknown>;
    fetcher?: typeof fetch;
  } = {},
): Promise<RecoverableDeletionResponse | PermanentDeletionResponse> {
  const { path, init } = deletionActionRequest(
    type,
    id,
    action,
    version,
    options.confirmation,
    options.input,
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
  projectActiveNavigation?: ProjectActiveNavigationCounts,
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
    .map((task) => {
      const withoutDeletedParent = task.parentTaskId && removedTaskIds.has(task.parentTaskId)
        ? { ...task, parentTaskId: null }
        : task;
      return type === "release" && withoutDeletedParent.releaseId === id
        ? { ...withoutDeletedParent, releaseId: null }
        : withoutDeletedParent;
    });
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
    navigationCollections: snapshot.navigationCollections && (
      type !== "project" || projectActiveNavigation
    )
      ? {
          projects: pruneNavigationCollection(
            snapshot.navigationCollections.projects,
            (project) => type !== "project" || project.id !== id,
            type === "project" ? 1 : 0,
          ),
          releases: pruneNavigationCollection(
            snapshot.navigationCollections.releases,
            (release) => type === "release"
              ? release.id !== id
              : type !== "project" || release.projectId !== id,
            type === "release"
              ? 1
              : type === "project"
                ? projectActiveNavigation?.releases ?? 0
                : 0,
          ),
          views: pruneNavigationCollection(
            snapshot.navigationCollections.views,
            (view) => type === "saved_view"
              ? view.id !== id
              : type !== "project" || view.scopeProjectId !== id,
            type === "saved_view"
              ? 1
              : type === "project"
                ? projectActiveNavigation?.savedViews ?? 0
                : 0,
          ),
        }
      : undefined,
  };
}

function pruneNavigationCollection<T>(
  collection: { items: T[]; total: number; hasMore: boolean },
  retain: (item: T) => boolean,
  removedTotal: number,
) {
  const items = collection.items.filter(retain);
  const total = Math.max(items.length, collection.total - removedTotal);
  return {
    ...collection,
    items,
    total,
    hasMore: total > items.length,
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

export async function fetchReleaseDeletionPreview(
  id: string,
  version: number,
  fetcher: typeof fetch = fetch,
) {
  const path = `/api/releases/${encodeURIComponent(id)}/deletion-preview?version=${encodeURIComponent(version)}`;
  return readDeletionJson<ReleaseDeletionPreview>(
    await fetcher(path, { cache: "no-store" }),
  );
}

export async function fetchProjectDeletionPreview(
  id: string,
  version: number,
  fetcher: typeof fetch = fetch,
) {
  const path = `/api/projects/${encodeURIComponent(id)}/deletion-preview?version=${encodeURIComponent(version)}`;
  return readDeletionJson<ProjectDeletionPreview>(
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
