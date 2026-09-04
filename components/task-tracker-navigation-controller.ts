"use client";

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  navigationPath,
  navigationPathWithTemporaryFilter,
  parseNavigationPath,
  resolveNavigationHistoryState,
  resolveNavigationTarget,
  type Layout,
  type ResolvedNavigation,
} from "@/lib/navigation";
import {
  canonicalViewQuery,
  decodeTemporaryViewQuery,
  encodeTemporaryViewQuery,
} from "@/lib/task-filter";
import {
  ALL_ACCESSIBLE_WORKSPACE_SCOPE,
  resolveWorkspaceScopeMembership,
} from "@/lib/workspace-scope";
import {
  emptyViewQuery,
} from "@/lib/view-contract";
import type {
  AppSnapshot,
  TaskDetailRecord,
  ViewQuery,
} from "@/lib/types";
import {
  defaultLayoutForSurface,
} from "@/components/task-tracker-view";
import {
  fetchTaskSnapshot,
  navigationStateForWorkspaceScope,
  workspaceScopeFromHistory,
  workspaceScopeStorageKey,
} from "@/components/task-tracker-state";

type NavigationControllerOptions = {
  initialData: AppSnapshot;
  initialWorkspaceData: AppSnapshot | null;
  initialNavigation: ResolvedNavigation;
  data: AppSnapshot;
  dataRef: MutableRefObject<AppSnapshot>;
  setTaskDetail: Dispatch<SetStateAction<TaskDetailRecord | null>>;
  setForcedTaskDetailId: Dispatch<SetStateAction<string | null>>;
  setPeekTaskId: Dispatch<SetStateAction<string | null>>;
  closeSurfaceUi: () => void;
  closeLayoutUi: () => void;
  onError: (message: string) => void;
};

export function useTaskTrackerNavigationController({
  initialData,
  initialWorkspaceData,
  initialNavigation,
  data,
  dataRef,
  setTaskDetail,
  setForcedTaskDetailId,
  setPeekTaskId,
  closeSurfaceUi,
  closeLayoutUi,
  onError,
}: NavigationControllerOptions) {
  const initialWorkspaceProjection = initialWorkspaceData ?? initialData;
  const initialWorkspaceFocusToken = initialWorkspaceData?.workspaceScope?.selectedToken ??
    initialData.workspaceScope?.options.find((option) => option.current)?.token ??
    ALL_ACCESSIBLE_WORKSPACE_SCOPE;
  const [workspaceData, setWorkspaceData] = useState(initialWorkspaceProjection);
  const workspaceDataRef = useRef(initialWorkspaceProjection);
  const [workspaceFocusToken, setWorkspaceFocusToken] = useState(initialWorkspaceFocusToken);
  const workspaceFocusTokenRef = useRef(initialWorkspaceFocusToken);
  const workspaceSyncRefreshReadyRef = useRef(false);
  const [workspaceScopeLoading, setWorkspaceScopeLoading] = useState(false);
  const [surface, setSurface] = useState(initialNavigation.surface);
  const [layout, setLayout] = useState<Layout>(initialNavigation.layout);
  const [search, setSearch] = useState("");
  const [temporaryQuery, setTemporaryQuery] = useState<ViewQuery>(() => emptyViewQuery());
  const [activeTaskId, setActiveTaskId] = useState<string | null>(initialNavigation.taskId);
  const temporaryQueryUrlReady = useRef(false);
  const taskReturnPath = useRef(
    navigationPath({ ...initialNavigation, taskId: null }, initialData),
  );

  async function loadWorkspaceScopeSnapshot(
    requestedToken: string,
    historyMode: "push" | "replace" | "none" = "push",
    goToWorkspace = true,
  ) {
    const scope = workspaceDataRef.current.workspaceScope ?? dataRef.current.workspaceScope;
    if (!scope) return false;
    const currentToken = scope.options.find((option) => option.current)?.token ??
      scope.selectedToken;
    const membership = resolveWorkspaceScopeMembership(
      requestedToken,
      scope.options,
      currentToken,
    );
    setWorkspaceScopeLoading(true);
    onError("");
    try {
      const incoming = await fetchTaskSnapshot(fetch, membership.token);
      const selectedToken = incoming.workspaceScope?.selectedToken ?? currentToken;
      workspaceFocusTokenRef.current = selectedToken;
      setWorkspaceFocusToken(selectedToken);
      workspaceDataRef.current = incoming;
      setWorkspaceData(incoming);
      window.localStorage.setItem(workspaceScopeStorageKey(incoming.user.id), selectedToken);
      const next: ResolvedNavigation = {
        surface: "workspace",
        layout: "list",
        taskId: null,
      };
      if (goToWorkspace) {
        setSurface(next.surface);
        setLayout(next.layout);
        setActiveTaskId(null);
        taskReturnPath.current = "/workspace";
      }
      if (historyMode !== "none") {
        window.history[historyMode === "push" ? "pushState" : "replaceState"](
          navigationStateForWorkspaceScope(next, selectedToken),
          "",
          goToWorkspace ? "/workspace" : window.location.href,
        );
      }
      return true;
    } catch (requestError) {
      onError(requestError instanceof Error
        ? requestError.message
        : "Workspace focus could not be loaded");
      return false;
    } finally {
      setWorkspaceScopeLoading(false);
    }
  }

  function applyNavigation(
    next: ResolvedNavigation,
    historyMode: "push" | "replace" | "none" = "push",
    preserveTemporaryFilter = false,
    canonicalPath?: string,
  ) {
    const nextPath = canonicalPath ?? (
      preserveTemporaryFilter
        ? navigationPathWithTemporaryFilter(
            navigationPath(next, data),
            window.location.href,
          )
        : navigationPath(next, data)
    );
    if (next.taskId && !activeTaskId) {
      taskReturnPath.current = navigationPathWithTemporaryFilter(
        navigationPath({ surface, layout, taskId: null }, data),
        window.location.href,
      );
    }
    setSurface(next.surface);
    setLayout(next.layout);
    setActiveTaskId(next.taskId);
    if (!next.taskId) taskReturnPath.current = nextPath;
    if (historyMode === "push") {
      window.history.pushState(
        navigationStateForWorkspaceScope(next, workspaceFocusTokenRef.current),
        "",
        nextPath,
      );
    } else if (historyMode === "replace") {
      window.history.replaceState(
        navigationStateForWorkspaceScope(next, workspaceFocusTokenRef.current),
        "",
        nextPath,
      );
    }
  }

  function navigateSurface(nextSurface: string, nextLayout?: Layout) {
    closeSurfaceUi();
    setSearch("");
    setTemporaryQuery(emptyViewQuery());
    if (nextSurface === "admin") {
      window.location.assign("/admin");
      return;
    }
    if (nextSurface === "workspace" && surface !== "workspace") {
      const scope = workspaceDataRef.current.workspaceScope ?? dataRef.current.workspaceScope;
      const currentToken = scope?.options.find((option) => option.current)?.token;
      const persisted = window.localStorage.getItem(workspaceScopeStorageKey(data.user.id));
      const requested = scope && currentToken
        ? resolveWorkspaceScopeMembership(
            persisted ?? workspaceFocusTokenRef.current,
            scope.options,
            currentToken,
          ).token
        : ALL_ACCESSIBLE_WORKSPACE_SCOPE;
      void loadWorkspaceScopeSnapshot(requested);
      return;
    }
    applyNavigation({
      surface: nextSurface,
      layout: nextLayout ?? defaultLayoutForSurface(nextSurface, data),
      taskId: null,
    });
  }

  function changeLayout(nextLayout: Layout) {
    closeLayoutUi();
    applyNavigation(
      { surface, layout: nextLayout, taskId: null },
      "push",
      true,
    );
  }

  function openTask(taskId: string) {
    applyNavigation({ surface, layout, taskId }, "push", true);
  }

  function closeTask() {
    setActiveTaskId(null);
    setPeekTaskId(null);
    const target = parseNavigationPath(taskReturnPath.current);
    const next = target ? resolveNavigationTarget(target, data) : null;
    window.history.replaceState(
      next ? navigationStateForWorkspaceScope(next, workspaceFocusTokenRef.current) : null,
      "",
      taskReturnPath.current,
    );
  }

  function returnToWorkspaceAfterRemoval() {
    setSurface("workspace");
    setLayout("list");
    setActiveTaskId(null);
    setTaskDetail(null);
    setForcedTaskDetailId(null);
    taskReturnPath.current = navigationPath(
      { surface: "workspace", layout: "list", taskId: null },
      dataRef.current,
    );
    window.history.replaceState(
      navigationStateForWorkspaceScope(
        { surface: "workspace", layout: "list", taskId: null },
        workspaceFocusTokenRef.current,
      ),
      "",
      taskReturnPath.current,
    );
  }

  useEffect(() => {
    workspaceDataRef.current = workspaceData;
  }, [workspaceData]);

  useEffect(() => {
    workspaceFocusTokenRef.current = workspaceFocusToken;
  }, [workspaceFocusToken]);

  useEffect(() => {
    if (initialNavigation.surface !== "workspace" || !initialWorkspaceProjection.workspaceScope) {
      return;
    }
    const persisted = window.localStorage.getItem(workspaceScopeStorageKey(initialData.user.id));
    const membership = resolveWorkspaceScopeMembership(
      persisted,
      initialWorkspaceProjection.workspaceScope.options,
      initialWorkspaceProjection.workspaceScope.options.find((option) => option.current)?.token ??
        initialWorkspaceProjection.workspaceScope.selectedToken,
    );
    if (!persisted || membership.fallback || membership.token === workspaceFocusTokenRef.current) {
      return;
    }
    void loadWorkspaceScopeSnapshot(membership.token, "replace", false);
    // Initial hydration intentionally uses the server-projected option set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (surface !== "workspace") return;
    if (!workspaceSyncRefreshReadyRef.current) {
      workspaceSyncRefreshReadyRef.current = true;
      return;
    }
    if (workspaceFocusTokenRef.current === ALL_ACCESSIBLE_WORKSPACE_SCOPE) {
      workspaceDataRef.current = data;
      setWorkspaceData(data);
      return;
    }
    void loadWorkspaceScopeSnapshot(workspaceFocusTokenRef.current, "none", false);
    // A global sync/mutation changes the ACL-complete source; refresh the local focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.syncCursor, surface]);

  useEffect(() => {
    window.history.replaceState(
      navigationStateForWorkspaceScope(initialNavigation, workspaceFocusTokenRef.current),
      "",
      window.location.href,
    );
  }, [initialNavigation]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const decoded = decodeTemporaryViewQuery(
        new URL(window.location.href).searchParams.get("filter"),
      );
      const { search: urlSearch, ...filterOnly } = decoded;
      setTemporaryQuery(filterOnly);
      setSearch(urlSearch ?? "");
      temporaryQueryUrlReady.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!temporaryQueryUrlReady.current) return;
    const encoded = encodeTemporaryViewQuery({
      ...canonicalViewQuery(temporaryQuery),
      ...(search.trim() ? { search } : {}),
    });
    const url = new URL(window.location.href);
    if (encoded) url.searchParams.set("filter", encoded);
    else url.searchParams.delete("filter");
    window.history.replaceState(window.history.state, "", url);
  }, [search, temporaryQuery]);

  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      void (async () => {
        const currentData = dataRef.current;
        const target = parseNavigationPath(window.location.pathname);
        const resolved = resolveNavigationHistoryState(
          event.state,
          window.location.pathname,
          currentData,
        ) ?? (target ? resolveNavigationTarget(target, currentData) : null);
        if (!resolved) return;
        const historyScope = resolved.surface === "workspace"
          ? workspaceScopeFromHistory(event.state)
          : null;
        if (historyScope && historyScope !== workspaceFocusTokenRef.current) {
          await loadWorkspaceScopeSnapshot(historyScope, "none", false);
        }
        setSurface(resolved.surface);
        setLayout(resolved.layout);
        setActiveTaskId(resolved.taskId);
        if (!resolved.taskId) taskReturnPath.current = navigationPath(resolved, currentData);
      })();
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
    // The handler intentionally resolves the latest loader inputs through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return {
    workspaceData,
    setWorkspaceData,
    workspaceDataRef,
    workspaceFocusToken,
    setWorkspaceFocusToken,
    workspaceFocusTokenRef,
    workspaceScopeLoading,
    surface,
    setSurface,
    layout,
    setLayout,
    search,
    setSearch,
    temporaryQuery,
    setTemporaryQuery,
    activeTaskId,
    setActiveTaskId,
    taskReturnPath,
    loadWorkspaceScopeSnapshot,
    applyNavigation,
    navigateSurface,
    changeLayout,
    openTask,
    closeTask,
    returnToWorkspaceAfterRemoval,
  };
}
