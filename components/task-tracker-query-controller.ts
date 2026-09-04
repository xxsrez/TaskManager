"use client";

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Layout,
} from "@/lib/navigation";
import {
  canonicalViewQuery,
  mergeViewQueries,
  taskMatchesViewQuery,
} from "@/lib/task-filter";
import {
  activeTaskQueryDependencies,
  authoritativeTaskQueryRefreshLimit,
  createTaskQueryRefreshCoordinator,
  mutationAffectsTaskQuery,
  reconcileTaskQueryMembership,
  taskMutationDependencies,
  taskQueryRequestToken,
  taskQueryResponseIsCurrent,
  type TaskQueryDependency,
  type TaskQueryRefreshCoordinator,
} from "@/lib/task-query-reconciliation";
import {
  mergeSearchTaskSummaries,
} from "@/lib/task-detail-reconciliation";
import {
  mergeTaskSummary,
} from "@/lib/workspace-sync-contract";
import type {
  AppSnapshot,
  TaskRecord,
  ViewDisplay,
  ViewQuery,
  WorkspaceSyncResponse,
} from "@/lib/types";
import type {
  WorkspaceSyncCheckpoint,
} from "@/components/workspace-sync-coordinator";
import {
  defaultViewDisplay,
} from "@/lib/view-contract";
import {
  fetchTaskSnapshot,
  mergeDeferredSnapshot,
  reconcileTaskSearch,
  runSingleFlight,
  taskMatchesSearch,
  type TaskSearchState,
  viewDisplayDependencies,
} from "@/components/task-tracker-state";
import {
  isCollectionSurface,
  sortTasks,
} from "@/components/task-tracker-view";

type TaskQueryContext = {
  surface: string;
  query: ViewQuery;
  scopeProjectId: string | null;
  referenceTime: number;
};

type TaskQueryControllerOptions = {
  initialTaskWindowTruncated: boolean;
  data: AppSnapshot;
  dataRef: MutableRefObject<AppSnapshot>;
  setData: Dispatch<SetStateAction<AppSnapshot>>;
  surface: string;
  layout: Layout;
  search: string;
  temporaryQuery: ViewQuery;
  displayOverrides: Partial<Record<string, ViewDisplay>>;
  workspaceScopeToken: string;
  workspaceScopeTokenRef: MutableRefObject<string>;
  onError: (message: string) => void;
};

function surfaceMatchesTask(
  task: TaskRecord,
  snapshot: AppSnapshot,
  surface: string,
) {
  if (surface === "mine") return task.assigneeUserId === snapshot.user.id;
  if (surface === "shared") return task.accessRole !== "owner";
  if (surface.startsWith("project:")) return task.projectId === surface.slice(8);
  if (surface.startsWith("release:")) return task.releaseId === surface.slice(8);
  const status = snapshot.statuses.find((item) => item.id === task.statusId);
  if (surface === "active") {
    return status?.category === "unstarted" || status?.category === "started";
  }
  if (surface === "backlog") return status?.category === "backlog";
  return true;
}

function archiveMatchesTask(task: TaskRecord, surface: string, query: ViewQuery) {
  const filtersArchived = canonicalViewQuery(query).conditions.some(
    (condition) => condition.field === "archived",
  );
  if (surface === "mine") return !task.archivedAt;
  if (surface === "archived") return Boolean(task.archivedAt);
  if (!filtersArchived) return !task.archivedAt;
  return true;
}

export function taskMatchesTaskQuery(
  task: TaskRecord,
  snapshot: AppSnapshot,
  context: TaskQueryContext,
) {
  if (!surfaceMatchesTask(task, snapshot, context.surface)) return false;
  if (!archiveMatchesTask(task, context.surface, context.query)) return false;
  if (context.scopeProjectId && task.projectId !== context.scopeProjectId) return false;
  return taskMatchesViewQuery(task, context.query, {
    statuses: snapshot.statuses,
    taskLabels: snapshot.taskLabels,
    relations: snapshot.relations,
    tasks: snapshot.tasks,
    referenceTime: new Date(context.referenceTime),
    timezone: snapshot.user.timezone,
  });
}

export function pruneTaskSearchAfterDeletion(
  current: TaskSearchState | null,
  type: "task" | "project" | "release" | "saved_view",
  id: string,
) {
  if (!current) return current;
  const tasks = current.tasks
    .filter((task) => type === "task" ? task.id !== id : type !== "project" || task.projectId !== id)
    .map((task) => type === "release" && task.releaseId === id ? { ...task, releaseId: null } : task)
    .map((task) => type === "task" && task.parentTaskId === id ? { ...task, parentTaskId: null } : task);
  const taskIds = new Set(tasks.map((task) => task.id));
  return {
    ...current,
    tasks,
    taskIds: current.taskIds.filter((taskId) => taskIds.has(taskId)),
  };
}

export function useTaskTrackerQueryController({
  initialTaskWindowTruncated,
  data,
  dataRef,
  setData,
  surface,
  layout,
  search,
  temporaryQuery,
  displayOverrides,
  workspaceScopeToken,
  workspaceScopeTokenRef,
  onError,
}: TaskQueryControllerOptions) {
  const [taskSearch, setTaskSearch] = useState<TaskSearchState | null>(null);
  const taskSearchRef = useRef<TaskSearchState | null>(null);
  const taskQueryKeyRef = useRef("");
  const taskQueryGenerationRef = useRef(0);
  const [taskQueryPaging, setTaskQueryPaging] = useState(false);
  const [taskWindowLoading, setTaskWindowLoading] = useState(initialTaskWindowTruncated);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [pullRefreshError, setPullRefreshError] = useState("");
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const pullRefreshFlight = useRef<Promise<AppSnapshot> | null>(null);
  const refreshCoordinatorRef = useRef<TaskQueryRefreshCoordinator | null>(null);
  const [viewReferenceTime] = useState(() => Date.now());

  useEffect(() => {
    const coordinator = createTaskQueryRefreshCoordinator(
      (refresh) => {
        taskQueryGenerationRef.current += 1;
        return window.setTimeout(refresh, 120);
      },
      (handle) => window.clearTimeout(handle),
      () => setRefreshEpoch((current) => current + 1),
    );
    refreshCoordinatorRef.current = coordinator;
    return () => {
      coordinator.cancel();
      refreshCoordinatorRef.current = null;
    };
  }, []);

  const activeSavedView = surface.startsWith("view:")
    ? data.views.find((view) => view.id === surface.slice(5) && !view.archivedAt)
    : undefined;
  const savedDisplay = useMemo(
    () => activeSavedView?.display ?? defaultViewDisplay(),
    [activeSavedView],
  );
  const currentDisplay = useMemo(() => ({
    ...savedDisplay,
    ...displayOverrides[surface],
    layout,
  }), [displayOverrides, layout, savedDisplay, surface]);
  const currentGroupBy = currentDisplay.groupBy;
  const currentDisplayDependencies = viewDisplayDependencies(currentDisplay);
  const canonicalTemporaryQuery = useMemo(
    () => canonicalViewQuery(temporaryQuery),
    [temporaryQuery],
  );
  const temporaryViewQuery = useMemo(() => ({
    ...canonicalTemporaryQuery,
    ...(search.trim() ? { search } : {}),
  }), [canonicalTemporaryQuery, search]);
  const currentViewQuery = useMemo(
    () => mergeViewQueries(activeSavedView?.query, temporaryViewQuery),
    [activeSavedView, temporaryViewQuery],
  );
  const taskQueryDisplay = useMemo(() => ({
    ...defaultViewDisplay(),
    orderBy: currentDisplay.orderBy,
    direction: currentDisplay.direction,
  }), [currentDisplay.direction, currentDisplay.orderBy]);
  const taskQueryKey = JSON.stringify({
    query: currentViewQuery,
    surface,
    scopeProjectId: activeSavedView?.scopeProjectId ?? null,
    display: taskQueryDisplay,
    workspaceScope: workspaceScopeToken || null,
  });
  const activeDependencySet = useMemo(
    () => activeTaskQueryDependencies({
      query: currentViewQuery,
      surface,
      scopeProjectId: activeSavedView?.scopeProjectId ?? null,
      display: currentDisplay,
    }),
    [activeSavedView?.scopeProjectId, currentDisplay, currentViewQuery, surface],
  );
  const queryContext = useMemo<TaskQueryContext>(() => ({
    surface,
    query: currentViewQuery,
    scopeProjectId: activeSavedView?.scopeProjectId ?? null,
    referenceTime: viewReferenceTime,
  }), [activeSavedView?.scopeProjectId, currentViewQuery, surface, viewReferenceTime]);
  const searchNeedle = (currentViewQuery.search ?? "").trim().toLowerCase();

  const captureSyncCheckpoint = useCallback((): WorkspaceSyncCheckpoint => ({
    taskIds: new Set(dataRef.current.tasks.map((task) => task.id)),
    projectIds: new Set(dataRef.current.projects.map((project) => project.id)),
    releaseIds: new Set(dataRef.current.releases.map((release) => release.id)),
    viewIds: new Set(dataRef.current.views.map((view) => view.id)),
  }), [dataRef]);

  const invalidateQuery = useCallback(() => {
    taskQueryGenerationRef.current += 1;
    setRefreshEpoch((current) => current + 1);
  }, []);

  const reconcileIncrementalTasks = useCallback((changes: WorkspaceSyncResponse["changes"]) => {
    if (!changes.tasks.upsert.length && !changes.tasks.remove.length) return;
    setTaskSearch((current) => reconcileTaskSearch(current, changes));
    invalidateQuery();
  }, [invalidateQuery]);

  const completeTaskWindow = useCallback(() => {
    setTaskWindowLoading(false);
  }, []);

  const refreshTaskList = useCallback(() => runSingleFlight(pullRefreshFlight, async () => {
    setPullRefreshing(true);
    setPullRefreshError("");
    const checkpoint = captureSyncCheckpoint();
    try {
      const incoming = await fetchTaskSnapshot(fetch, workspaceScopeTokenRef.current);
      setData((current) => mergeDeferredSnapshot(current, incoming, {
        taskIdsAtRequest: checkpoint.taskIds,
        projectIdsAtRequest: checkpoint.projectIds,
        releaseIdsAtRequest: checkpoint.releaseIds,
        viewIdsAtRequest: checkpoint.viewIds,
      }));
      setTaskWindowLoading(false);
      invalidateQuery();
      return incoming;
    } catch (requestError) {
      setPullRefreshError(
        requestError instanceof Error ? requestError.message : "Refresh failed",
      );
      throw requestError;
    } finally {
      setPullRefreshing(false);
    }
  }), [captureSyncCheckpoint, invalidateQuery, setData, workspaceScopeTokenRef]);

  useEffect(() => {
    taskSearchRef.current = taskSearch;
  }, [taskSearch]);

  useEffect(() => {
    taskQueryKeyRef.current = taskQueryKey;
  }, [taskQueryKey]);

  useEffect(() => {
    if (!taskWindowLoading) return;
    const controller = new AbortController();
    let idleId: number | null = null;
    let timerId: number | null = null;
    const idleWindow = window as unknown as {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const loadRemainingTasks = () => {
      const checkpoint = captureSyncCheckpoint();
      const parameters = new URLSearchParams();
      if (workspaceScopeToken) parameters.set("workspace_scope", workspaceScopeToken);
      const bootstrapPath = parameters.size ? `/api/bootstrap?${parameters}` : "/api/bootstrap";
      void fetch(bootstrapPath, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          const value = (await response.json()) as AppSnapshot | { error: string };
          if (!response.ok || "error" in value) {
            throw new Error("error" in value ? value.error : "Task loading failed");
          }
          setData((current) => mergeDeferredSnapshot(current, value, {
            taskIdsAtRequest: checkpoint.taskIds,
            projectIdsAtRequest: checkpoint.projectIds,
            releaseIdsAtRequest: checkpoint.releaseIds,
            viewIdsAtRequest: checkpoint.viewIds,
          }));
          setTaskWindowLoading(false);
        })
        .catch((requestError: unknown) => {
          if (requestError instanceof DOMException && requestError.name === "AbortError") return;
          setTaskWindowLoading(false);
          onError(requestError instanceof Error
            ? requestError.message
            : "Could not load remaining tasks");
        });
    };
    if (idleWindow.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(loadRemainingTasks, { timeout: 800 });
    } else {
      timerId = window.setTimeout(loadRemainingTasks, 0);
    }
    return () => {
      controller.abort();
      if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [captureSyncCheckpoint, onError, setData, taskWindowLoading, workspaceScopeToken]);

  useEffect(() => {
    if (isCollectionSurface(surface)) return;
    const generation = taskQueryGenerationRef.current + 1;
    taskQueryGenerationRef.current = generation;
    const token = taskQueryRequestToken(taskQueryKey, generation);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const loaded = taskSearchRef.current?.query === taskQueryKey
        ? taskSearchRef.current.taskIds.length
        : 0;
      const request = JSON.parse(taskQueryKey) as Record<string, unknown>;
      void fetch("/api/tasks/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          limit: authoritativeTaskQueryRefreshLimit(loaded),
        }),
        signal: controller.signal,
      })
        .then(async (response) => {
          const value = (await response.json()) as
            | { taskIds: string[]; tasks: TaskRecord[]; page: TaskSearchState["page"] }
            | { error: string };
          if (!response.ok || "error" in value) {
            throw new Error("error" in value ? value.error : "Task search failed");
          }
          if (
            controller.signal.aborted ||
            !taskQueryResponseIsCurrent(
              token,
              taskQueryKeyRef.current,
              taskQueryGenerationRef.current,
            )
          ) return;
          setTaskSearch({
            query: taskQueryKey,
            taskIds: value.taskIds,
            tasks: value.tasks,
            status: "ready",
            page: value.page,
          });
        })
        .catch((requestError: unknown) => {
          if (requestError instanceof DOMException && requestError.name === "AbortError") return;
          if (!taskQueryResponseIsCurrent(
            token,
            taskQueryKeyRef.current,
            taskQueryGenerationRef.current,
          )) return;
          setTaskSearch((current) =>
            current?.query === taskQueryKey && current.status === "ready"
              ? current
              : {
                  query: taskQueryKey,
                  taskIds: [],
                  tasks: [],
                  status: "error",
                  page: null,
                });
          onError(requestError instanceof Error ? requestError.message : "Task search failed");
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [onError, refreshEpoch, surface, taskQueryKey]);

  const loadMoreFilteredTasks = useCallback(async () => {
    const next = taskSearch?.query === taskQueryKey ? taskSearch.page?.next : null;
    if (!next || taskQueryPaging) return;
    const token = taskQueryRequestToken(taskQueryKey, taskQueryGenerationRef.current);
    const expectedCursor = JSON.stringify(next);
    setTaskQueryPaging(true);
    onError("");
    try {
      const request = JSON.parse(taskQueryKey) as Record<string, unknown>;
      const response = await fetch("/api/tasks/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, after: next, limit: 500 }),
      });
      const value = await response.json() as
        | { taskIds: string[]; tasks: TaskRecord[]; page: TaskSearchState["page"] }
        | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Could not load more tasks");
      }
      if (!taskQueryResponseIsCurrent(
        token,
        taskQueryKeyRef.current,
        taskQueryGenerationRef.current,
      )) return;
      setTaskSearch((current) => {
        if (
          !current ||
          current.query !== taskQueryKey ||
          JSON.stringify(current.page?.next ?? null) !== expectedCursor ||
          !taskQueryResponseIsCurrent(
            token,
            taskQueryKeyRef.current,
            taskQueryGenerationRef.current,
          )
        ) return current;
        return {
          ...current,
          taskIds: [...new Set([...current.taskIds, ...value.taskIds])],
          tasks: mergeSearchTaskSummaries(current.tasks, value.tasks),
          page: value.page,
        };
      });
    } catch (requestError) {
      if (!taskQueryResponseIsCurrent(
        token,
        taskQueryKeyRef.current,
        taskQueryGenerationRef.current,
      )) return;
      onError(requestError instanceof Error ? requestError.message : "Could not load more tasks");
    } finally {
      setTaskQueryPaging(false);
    }
  }, [onError, taskQueryKey, taskQueryPaging, taskSearch]);

  const taskPool = useMemo(
    () => taskSearch?.query === taskQueryKey
      ? mergeSearchTaskSummaries(data.tasks, taskSearch.tasks)
      : data.tasks,
    [data.tasks, taskQueryKey, taskSearch],
  );
  const visibleTasks = useMemo(() => {
    const authoritativeIds = taskSearch?.query === taskQueryKey && taskSearch.status === "ready"
      ? new Set(taskSearch.taskIds)
      : null;
    if (authoritativeIds) {
      return sortTasks(taskPool.filter((task) => authoritativeIds.has(task.id)), currentDisplay);
    }
    let tasks = taskPool.filter((task) => taskMatchesTaskQuery(task, data, queryContext));
    if (searchNeedle) {
      tasks = tasks.filter((task) => taskMatchesSearch(task, searchNeedle, null));
    }
    return sortTasks(tasks, currentDisplay);
  }, [currentDisplay, data, queryContext, searchNeedle, taskPool, taskQueryKey, taskSearch]);
  const taskSearchStatus: "loading" | "error" | null = visibleTasks.length === 0
    ? taskSearch?.query !== taskQueryKey
      ? "loading"
      : taskSearch.status === "error"
        ? "error"
        : null
    : null;

  const reconcileSuccessfulTaskMutation = useCallback((
    affectedTasks: readonly TaskRecord[],
    before: AppSnapshot,
    after: AppSnapshot,
    additionalDependencies: Iterable<TaskQueryDependency> = [],
    allowLocalMembership = true,
  ) => {
    if (isCollectionSurface(surface) || !affectedTasks.length) return;
    const beforeTasks = new Map(before.tasks.map((task) => [task.id, task]));
    const dependencies = new Set<TaskQueryDependency>(additionalDependencies);
    for (const task of affectedTasks) {
      for (const dependency of taskMutationDependencies(beforeTasks.get(task.id), task)) {
        dependencies.add(dependency);
      }
    }
    if (!mutationAffectsTaskQuery(activeDependencySet, dependencies)) return;
    const localSemanticsComplete = allowLocalMembership &&
      !canonicalViewQuery(currentViewQuery).conditions.some(
        (condition) => condition.field === "label_group",
      );
    if (localSemanticsComplete) {
      setTaskSearch((current) => {
        if (!current || current.query !== taskQueryKey || current.status !== "ready") {
          return current;
        }
        const merged = affectedTasks.map((task) =>
          mergeTaskSummary(current.tasks.find((candidate) => candidate.id === task.id), task));
        return reconcileTaskQueryMembership(
          current,
          merged,
          (task) => taskMatchesTaskQuery(task, after, queryContext),
        );
      });
    }
    refreshCoordinatorRef.current?.request(activeDependencySet, dependencies);
  }, [
    activeDependencySet,
    currentViewQuery,
    queryContext,
    surface,
    taskQueryKey,
  ]);

  return {
    activeSavedView,
    currentDisplay,
    currentGroupBy,
    currentDisplayDependencies,
    canonicalTemporaryQuery,
    temporaryViewQuery,
    currentViewQuery,
    searchNeedle,
    taskQueryKey,
    taskSearch,
    setTaskSearch,
    taskQueryPaging,
    taskWindowLoading,
    pullRefreshing,
    pullRefreshError,
    taskPool,
    visibleTasks,
    taskSearchStatus,
    captureSyncCheckpoint,
    reconcileIncrementalTasks,
    completeTaskWindow,
    invalidateQuery,
    refreshTaskList,
    loadMoreFilteredTasks,
    reconcileSuccessfulTaskMutation,
  };
}
