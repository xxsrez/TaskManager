"use client";

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { GlobalSearchResult } from "@/lib/global-search";
import type { Layout, ResolvedNavigation } from "@/lib/navigation";
import {
  createUserPreferenceSaveQueue,
  type UserPreferenceChanges,
} from "@/lib/user-preference-save";
import { defaultViewDisplay, emptyViewQuery } from "@/lib/view-contract";
import type {
  AppSnapshot,
  ProjectRecord,
  SavedViewRecord,
  TaskDetailRecord,
  UserProfile,
  ViewDisplay,
  ViewQuery,
  WorkspaceCatalogKind,
} from "@/lib/types";
import {
  ProfileRequestError,
  fetchUserProfile,
  patchUserPreferences,
  type Dialog,
  type TaskCreateDefaults,
} from "@/components/task-tracker-state";
import { resolveGlobalSearchNavigation } from "@/components/task-tracker-view";

export function useTaskTrackerShellState(initialData: AppSnapshot) {
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [createDefaults, setCreateDefaults] = useState<TaskCreateDefaults>({});
  const [peekTaskId, setPeekTaskId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    initialData.user.sidebarPreference === "collapsed",
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [auxiliaryBackupBusy, setAuxiliaryBackupBusy] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"system" | "light" | "dark">(
    initialData.user.theme ?? "system",
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const mobileActionsRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const displayTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const mobileSidebarCloseRef = useRef<HTMLButtonElement>(null);
  const globalSearchReturnFocusRef = useRef<HTMLElement | null>(null);

  return {
    globalSearchOpen,
    setGlobalSearchOpen,
    dialog,
    setDialog,
    createDefaults,
    setCreateDefaults,
    peekTaskId,
    setPeekTaskId,
    sidebarCollapsed,
    setSidebarCollapsed,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    mobileActionsOpen,
    setMobileActionsOpen,
    filterOpen,
    setFilterOpen,
    displayOpen,
    setDisplayOpen,
    accountMenuOpen,
    setAccountMenuOpen,
    auxiliaryBackupBusy,
    setAuxiliaryBackupBusy,
    error,
    setError,
    theme,
    setTheme,
    searchRef,
    mobileSearchRef,
    accountMenuRef,
    mobileActionsRef,
    accountTriggerRef,
    filterTriggerRef,
    displayTriggerRef,
    mobileMenuRef,
    mobileSidebarCloseRef,
    globalSearchReturnFocusRef,
  };
}

type ShellState = ReturnType<typeof useTaskTrackerShellState>;

export function useTaskTrackerShellController({
  shell,
  data,
  dataRef,
  setData,
  surface,
  layout,
  activeTaskId,
  activeSavedView,
  currentDisplay,
  canCreateTask,
  setDisplayOverrides,
  setCollapsedGroups,
  setSearch,
  setTemporaryQuery,
  setTaskDetail,
  setForcedTaskDetailId,
  ensureCompleteCatalogs,
  applyNavigation,
}: {
  shell: ShellState;
  data: AppSnapshot;
  dataRef: MutableRefObject<AppSnapshot>;
  setData: Dispatch<SetStateAction<AppSnapshot>>;
  surface: string;
  layout: Layout;
  activeTaskId: string | null;
  activeSavedView?: SavedViewRecord;
  currentDisplay: ViewDisplay;
  canCreateTask: boolean;
  setDisplayOverrides: Dispatch<SetStateAction<Partial<Record<string, ViewDisplay>>>>;
  setCollapsedGroups: Dispatch<SetStateAction<Set<string>>>;
  setSearch: Dispatch<SetStateAction<string>>;
  setTemporaryQuery: Dispatch<SetStateAction<ViewQuery>>;
  setTaskDetail: Dispatch<SetStateAction<TaskDetailRecord | null>>;
  setForcedTaskDetailId: Dispatch<SetStateAction<string | null>>;
  ensureCompleteCatalogs: (
    kinds: readonly WorkspaceCatalogKind[],
    trackLoading?: boolean,
  ) => Promise<unknown>;
  applyNavigation: (
    next: ResolvedNavigation,
    historyMode?: "push" | "replace" | "none",
    preserveTemporaryFilter?: boolean,
    canonicalPath?: string,
  ) => void;
}) {
  const preferenceSaveQueueRef = useRef<ReturnType<typeof createUserPreferenceSaveQueue> | null>(null);
  const {
    accountMenuOpen,
    accountMenuRef,
    filterOpen,
    globalSearchReturnFocusRef,
    mobileActionsOpen,
    mobileActionsRef,
    mobileMenuRef,
    mobileSearchRef,
    mobileSidebarCloseRef,
    mobileSidebarOpen,
    setAccountMenuOpen,
    setAuxiliaryBackupBusy,
    setCreateDefaults,
    setDialog,
    setFilterOpen,
    setGlobalSearchOpen,
    setError,
    setMobileActionsOpen,
    setMobileSidebarOpen,
    setSidebarCollapsed,
    setTheme,
    theme,
  } = shell;

  useEffect(() => {
    dataRef.current = data;
  }, [data, dataRef]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(`tm-theme:${data.user.id}`, theme);
  }, [data.user.id, theme]);

  useEffect(() => {
    window.localStorage.setItem(
      `tm-sidebar:${data.user.id}`,
      shell.sidebarCollapsed ? "collapsed" : "expanded",
    );
  }, [data.user.id, shell.sidebarCollapsed]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [accountMenuOpen, accountMenuRef, setAccountMenuOpen]);

  useEffect(() => {
    if (!mobileActionsOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (!mobileActionsRef.current?.contains(event.target as Node)) setMobileActionsOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [mobileActionsOpen, mobileActionsRef, setMobileActionsOpen]);

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const timer = window.setTimeout(() => mobileSidebarCloseRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [mobileSidebarCloseRef, mobileSidebarOpen]);

  const currentUserProfile = useCallback((): UserProfile => {
    const current = dataRef.current;
    return current.userProfile ?? {
      user: {
        ...current.user,
        version: current.user.version ?? 1,
        theme: current.user.theme ?? "system",
        sidebarPreference: current.user.sidebarPreference ?? "expanded",
      },
      identities: [{ provider: "chatgpt", verifiedEmail: current.user.email }],
    };
  }, [dataRef]);

  const applyOptimisticPreferences = useCallback((changes: UserPreferenceChanges) => {
    if (changes.theme) setTheme(changes.theme);
    if (changes.sidebarPreference) setSidebarCollapsed(changes.sidebarPreference === "collapsed");
  }, [setSidebarCollapsed, setTheme]);

  const applyUserProfile = useCallback((
    profile: UserProfile,
    pendingPreferences: UserPreferenceChanges | null = null,
  ) => {
    dataRef.current = { ...dataRef.current, user: profile.user, userProfile: profile };
    setData((current) => ({ ...current, user: profile.user, userProfile: profile }));
    setTheme(pendingPreferences?.theme ?? profile.user.theme);
    setSidebarCollapsed(
      (pendingPreferences?.sidebarPreference ?? profile.user.sidebarPreference) === "collapsed",
    );
  }, [dataRef, setData, setSidebarCollapsed, setTheme]);

  useEffect(() => {
    const queue = createUserPreferenceSaveQueue({
      current: currentUserProfile,
      save: patchUserPreferences,
      refresh: fetchUserProfile,
      isConflict: (requestError) => requestError instanceof ProfileRequestError && requestError.status === 409,
      optimistic: applyOptimisticPreferences,
      apply: applyUserProfile,
      error: (requestError) => setError(
        requestError instanceof Error ? requestError.message : "Preference could not be saved",
      ),
    });
    preferenceSaveQueueRef.current = queue;
    return () => {
      if (preferenceSaveQueueRef.current === queue) preferenceSaveQueueRef.current = null;
    };
  }, [applyOptimisticPreferences, applyUserProfile, currentUserProfile, setError]);

  const openDialogWithCatalog = useCallback(async (
    nextDialog: Exclude<Dialog, null>,
    kinds: readonly WorkspaceCatalogKind[],
  ) => {
    setError("");
    try {
      await ensureCompleteCatalogs(kinds, true);
      setDialog(nextDialog);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
    }
  }, [ensureCompleteCatalogs, setDialog, setError]);

  function saveUserPreferences(changes: UserPreferenceChanges) {
    return preferenceSaveQueueRef.current?.enqueue(changes) ?? Promise.resolve();
  }

  async function openCreate(defaults: TaskCreateDefaults = {}) {
    if (!canCreateTask) return;
    setMobileSidebarOpen(false);
    setMobileActionsOpen(false);
    setCreateDefaults(defaults);
    await openDialogWithCatalog("task", ["projects", "releases"]);
  }

  async function toggleFilters(focusEditor = false) {
    if (filterOpen) {
      setFilterOpen(false);
      return;
    }
    setError("");
    try {
      await ensureCompleteCatalogs(["projects", "releases"], true);
      setFilterOpen(true);
      if (focusEditor) {
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".filter-popover input")?.focus();
        });
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
    }
  }

  function openGlobalSearch() {
    globalSearchReturnFocusRef.current = mobileSidebarOpen
      ? mobileMenuRef.current
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMobileSidebarOpen(false);
    setMobileActionsOpen(false);
    setAccountMenuOpen(false);
    setGlobalSearchOpen(true);
  }

  function closeGlobalSearch() {
    setGlobalSearchOpen(false);
    window.requestAnimationFrame(() => {
      const target = globalSearchReturnFocusRef.current;
      if (target?.isConnected) target.focus();
      else mobileMenuRef.current?.focus();
    });
  }

  function openGlobalSearchResult(result: GlobalSearchResult) {
    const next = resolveGlobalSearchNavigation(result, data, { surface, layout, taskId: activeTaskId });
    setGlobalSearchOpen(false);
    if (!next) {
      window.location.assign(result.href);
      return;
    }
    if (result.type === "task") {
      setTaskDetail((current) => current?.task.id === result.id ? current : null);
      if (!data.tasks.some((task) => task.id === result.id)) setForcedTaskDetailId(result.id);
    }
    applyNavigation(next, "push", false, result.href);
  }

  async function toggleMobileViewControls(focusMobileSearch = false) {
    setMobileSidebarOpen(false);
    if (mobileActionsOpen) {
      if (focusMobileSearch) mobileSearchRef.current?.focus();
      else setMobileActionsOpen(false);
      return;
    }
    setError("");
    try {
      await ensureCompleteCatalogs(["projects", "releases"], true);
      setMobileActionsOpen(true);
      if (focusMobileSearch) window.requestAnimationFrame(() => mobileSearchRef.current?.focus());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
    }
  }

  function focusLocalSearch() {
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    setMobileSidebarOpen(false);
    if (mobile) {
      void toggleMobileViewControls(true);
      return;
    }
    window.requestAnimationFrame(() => shell.searchRef.current?.focus());
  }

  function closeMobileSidebar() {
    setMobileSidebarOpen(false);
    window.setTimeout(() => mobileMenuRef.current?.focus(), 0);
  }

  function changeDisplay(changes: Partial<ViewDisplay>) {
    setDisplayOverrides((current) => ({
      ...current,
      [surface]: { ...currentDisplay, ...changes },
    }));
  }

  function changeGroupBy(nextGroupBy: ViewDisplay["groupBy"]) {
    changeDisplay({
      groupBy: nextGroupBy,
      labelGroupId: nextGroupBy === "label_group"
        ? currentDisplay.labelGroupId ?? (data.labelGroups ?? []).find((group) => !group.archivedAt)?.id ?? null
        : null,
    });
    setCollapsedGroups(new Set());
  }

  function clearTemporaryFilters() {
    setSearch("");
    setTemporaryQuery(emptyViewQuery());
  }

  function resetDisplayChanges() {
    setDisplayOverrides((current) => {
      const next = { ...current };
      delete next[surface];
      return next;
    });
    const baselineLayout = activeSavedView?.display.layout ?? defaultViewDisplay().layout;
    if (layout !== baselineLayout) applyNavigation({ surface, layout: baselineLayout, taskId: null });
  }

  async function downloadProjectBackup(project: ProjectRecord) {
    setAuxiliaryBackupBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/export`, {
        method: "POST",
        headers: { "x-task-manager-action": "project-backup" },
      });
      if (!response.ok) {
        const value = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(value?.error ?? "Could not export the project backup");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1]
        ?? `task-manager-project-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not export the project backup");
    } finally {
      setAuxiliaryBackupBusy(false);
    }
  }

  async function copyCurrentLink() {
    await navigator.clipboard.writeText(window.location.href);
  }

  return {
    applyUserProfile,
    saveUserPreferences,
    openDialogWithCatalog,
    openCreate,
    toggleFilters,
    openGlobalSearch,
    closeGlobalSearch,
    openGlobalSearchResult,
    toggleMobileViewControls,
    focusLocalSearch,
    closeMobileSidebar,
    changeGroupBy,
    changeDisplay,
    clearTemporaryFilters,
    resetDisplayChanges,
    downloadProjectBackup,
    copyCurrentLink,
  };
}
