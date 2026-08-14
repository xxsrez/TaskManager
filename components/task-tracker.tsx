"use client";

import {
  Archive,
  ArchiveRestore,
  ArrowDownWideNarrow,
  Boxes,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Columns3,
  Download,
  FolderKanban,
  GitBranch,
  Inbox,
  LayoutList,
  Link2,
  ListFilter,
  LogOut,
  Monitor,
  Moon,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rocket,
  Save,
  Search,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Tag,
  Upload,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  navigationHistoryState,
  navigationPath,
  parseNavigationPath,
  projectReleasesPath,
  resolveNavigationHistoryState,
  resolveNavigationTarget,
  taskPath,
  type Layout,
  type ResolvedNavigation,
} from "@/lib/navigation";
import type {
  AdminOverview,
  AppliedSystemBackup,
  AppSnapshot,
  Priority,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  StagedSystemBackup,
  TaskRecord,
  ViewDisplay,
  ViewQuery,
  WorkflowStatusRecord,
} from "@/lib/types";

type Dialog = "task" | "project" | "release" | "view" | "share" | "systemImport" | null;

const priorityMeta: Record<Priority, { label: string; glyph: string }> = {
  urgent: { label: "Urgent", glyph: "!!!" },
  high: { label: "High", glyph: "▥" },
  medium: { label: "Medium", glyph: "▤" },
  low: { label: "Low", glyph: "▂" },
  none: { label: "No priority", glyph: "—" },
};

export function resolveArchiveBulkAction(
  tasks: Array<Pick<TaskRecord, "archivedAt">>,
) {
  const shouldRestore =
    tasks.length > 0 && tasks.every((task) => task.archivedAt !== null);
  return shouldRestore
    ? ({ archived: false, label: "Restore" } as const)
    : ({ archived: true, label: "Archive" } as const);
}

const builtInViews = [
  { id: "all", label: "All tasks" },
  { id: "active", label: "Active" },
  { id: "backlog", label: "Backlog" },
  { id: "archived", label: "Archived" },
];

type BreadcrumbItem = {
  label: string;
  surface?: string;
  layout?: Layout;
};

export function TaskTracker({
  initialData,
  initialNavigation,
  signOutPath,
}: {
  initialData: AppSnapshot;
  initialNavigation: ResolvedNavigation;
  signOutPath: string;
}) {
  const [data, setData] = useState(initialData);
  const [surface, setSurface] = useState(initialNavigation.surface);
  const [layout, setLayout] = useState<Layout>(initialNavigation.layout);
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "all">("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(
    initialNavigation.taskId,
  );
  const [peekTaskId, setPeekTaskId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [highlighted, setHighlighted] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [systemBackupBusy, setSystemBackupBusy] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [viewReferenceTime] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const mobileActionsRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const taskReturnPath = useRef(
    navigationPath({ ...initialNavigation, taskId: null }, initialData),
  );

  const statusMap = useMemo(
    () => new Map(data.statuses.map((status) => [status.id, status])),
    [data.statuses],
  );
  const projectMap = useMemo(
    () => new Map(data.projects.map((project) => [project.id, project])),
    [data.projects],
  );
  const releaseMap = useMemo(
    () => new Map(data.releases.map((release) => [release.id, release])),
    [data.releases],
  );

  useEffect(() => {
    const saved = window.localStorage.getItem("tm-theme");
    if (saved === "light" || saved === "dark" || saved === "system") {
      // Local storage is the external source for this device preference.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTheme(saved);
    }
    const sidebar = window.localStorage.getItem("tm-sidebar");
    setSidebarCollapsed(sidebar === "collapsed");
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("tm-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(
      "tm-sidebar",
      sidebarCollapsed ? "collapsed" : "expanded",
    );
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!mobileActionsOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (!mobileActionsRef.current?.contains(event.target as Node)) {
        setMobileActionsOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [mobileActionsOpen]);

  useEffect(() => {
    window.history.replaceState(
      navigationHistoryState(initialNavigation),
      "",
      window.location.href,
    );
  }, [initialNavigation]);

  const activeSavedView = surface.startsWith("view:")
    ? data.views.find((view) => view.id === surface.slice(5))
    : undefined;

  const visibleTasks = useMemo(() => {
    let tasks = data.tasks;
    const query: ViewQuery = activeSavedView?.query ?? {};
    if (surface === "shared") {
      tasks = tasks.filter((task) => task.ownerUserId !== data.user.id);
    } else if (surface.startsWith("project:")) {
      tasks = tasks.filter((task) => task.projectId === surface.slice(8));
    } else if (surface.startsWith("release:")) {
      tasks = tasks.filter((task) => task.releaseId === surface.slice(8));
    } else if (surface === "active") {
      tasks = tasks.filter((task) => {
        const category = statusMap.get(task.statusId)?.category;
        return category === "unstarted" || category === "started";
      });
    } else if (surface === "backlog") {
      tasks = tasks.filter(
        (task) => statusMap.get(task.statusId)?.category === "backlog",
      );
    }

    const showArchived = surface === "archived" || query.archived === true;
    tasks = tasks.filter((task) => (showArchived ? task.archivedAt : !task.archivedAt));
    if (query.projectId !== undefined) {
      tasks = tasks.filter((task) => task.projectId === query.projectId);
    }
    if (activeSavedView?.scopeProjectId) {
      tasks = tasks.filter(
        (task) => task.projectId === activeSavedView.scopeProjectId,
      );
    }
    if (query.releaseId !== undefined) {
      tasks = tasks.filter((task) => task.releaseId === query.releaseId);
    }
    if (query.statusIds?.length) {
      tasks = tasks.filter((task) => query.statusIds?.includes(task.statusId));
    }
    if (query.priorities?.length) {
      tasks = tasks.filter((task) => query.priorities?.includes(task.priority));
    }
    if (query.updatedWithinHours && query.updatedWithinHours > 0) {
      const cutoff = viewReferenceTime - query.updatedWithinHours * 60 * 60 * 1000;
      tasks = tasks.filter((task) => new Date(task.updatedAt).getTime() >= cutoff);
    }
    if (statusFilter !== "all") tasks = tasks.filter((task) => task.statusId === statusFilter);
    if (priorityFilter !== "all") tasks = tasks.filter((task) => task.priority === priorityFilter);
    const needle = (search || query.search || "").trim().toLowerCase();
    if (needle) {
      tasks = tasks.filter(
        (task) =>
          task.identifier.toLowerCase() === needle ||
          task.identifier.toLowerCase().includes(needle) ||
          task.title.toLowerCase().includes(needle) ||
          task.description.toLowerCase().includes(needle),
      );
    }
    return sortTasks(tasks, activeSavedView?.display);
  }, [
    activeSavedView,
    data.tasks,
    data.user.id,
    priorityFilter,
    search,
    statusFilter,
    statusMap,
    surface,
    viewReferenceTime,
  ]);

  const breadcrumbs = surfaceBreadcrumbs(surface, data, activeSavedView);
  const visibleStatuses = statusGroupsForTasks(visibleTasks, data.statuses).filter(
    (status) => activeSavedView?.display.showEmptyGroups !== false || visibleTasks.some((task) => task.statusId === status.id),
  );
  const activeTask = data.tasks.find((task) => task.id === activeTaskId) ?? null;
  const peekTask = data.tasks.find((task) => task.id === peekTaskId) ?? null;
  const selectedTasks = [...selected]
    .map((id) => data.tasks.find((task) => task.id === id))
    .filter(Boolean) as TaskRecord[];
  const archiveAction = resolveArchiveBulkAction(selectedTasks);
  const projectReleaseSurfaceId = surface.startsWith("project-releases:")
    ? surface.slice("project-releases:".length)
    : null;
  const contextProject = surface.startsWith("project:")
    ? surface.slice(8)
    : projectReleaseSurfaceId;
  const contextRelease = surface.startsWith("release:") ? surface.slice(8) : null;
  const scopedReleases = projectReleaseSurfaceId
    ? data.releases.filter((release) => release.projectId === projectReleaseSurfaceId)
    : data.releases;
  const surfaceCount = surface === "views"
    ? builtInViews.length + data.views.length
    : surface === "admin" && data.admin
      ? data.admin.registeredUserCount
    : projectReleaseSurfaceId
      ? scopedReleases.length
      : visibleTasks.length;
  const contextProjectRecord = contextProject
    ? data.projects.find((project) => project.id === contextProject)
    : undefined;
  const sidebarCompact = sidebarCollapsed && !mobileSidebarOpen;
  const hasViewChanges = Boolean(
    search || priorityFilter !== "all" || statusFilter !== "all",
  );

  async function mutate(path: string, method: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = (await response.json()) as AppSnapshot | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Request failed");
      }
      setData(value);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function downloadSystemBackup() {
    setSystemBackupBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/export", {
        method: "POST",
        headers: { "x-task-manager-action": "system-backup" },
      });
      if (!response.ok) {
        const value = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(value?.error ?? "Could not export the system backup");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1]
        ?? `task-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not export the system backup");
      return false;
    } finally {
      setSystemBackupBusy(false);
    }
  }

  function applyNavigation(
    next: ResolvedNavigation,
    historyMode: "push" | "replace" | "none" = "push",
  ) {
    setSurface(next.surface);
    setLayout(next.layout);
    setActiveTaskId(next.taskId);
    if (!next.taskId) taskReturnPath.current = navigationPath(next, data);
    if (historyMode === "push") {
      window.history.pushState(
        navigationHistoryState(next),
        "",
        navigationPath(next, data),
      );
    } else if (historyMode === "replace") {
      window.history.replaceState(
        navigationHistoryState(next),
        "",
        navigationPath(next, data),
      );
    }
  }

  function navigateSurface(nextSurface: string, nextLayout?: Layout) {
    setMobileSidebarOpen(false);
    setMobileActionsOpen(false);
    applyNavigation({
      surface: nextSurface,
      layout: nextLayout ?? defaultLayoutForSurface(nextSurface, data),
      taskId: null,
    });
  }

  function changeLayout(nextLayout: Layout) {
    setMobileActionsOpen(false);
    applyNavigation({ surface, layout: nextLayout, taskId: null });
  }

  function openTask(taskId: string) {
    if (!activeTaskId) {
      taskReturnPath.current = navigationPath(
        { surface, layout, taskId: null },
        data,
      );
    }
    applyNavigation({ surface, layout, taskId });
  }

  function closeTask() {
    setActiveTaskId(null);
    const target = parseNavigationPath(taskReturnPath.current);
    const next = target ? resolveNavigationTarget(target, data) : null;
    window.history.replaceState(
      next ? navigationHistoryState(next) : null,
      "",
      taskReturnPath.current,
    );
  }

  async function copyCurrentLink() {
    await navigator.clipboard.writeText(window.location.href);
  }

  function openCreate(statusId?: string) {
    setMobileSidebarOpen(false);
    setMobileActionsOpen(false);
    setDialog("task");
    if (statusId) window.sessionStorage.setItem("tm-create-status", statusId);
    else window.sessionStorage.removeItem("tm-create-status");
  }

  function focusSearch() {
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    setMobileSidebarOpen(false);
    if (mobile) setMobileActionsOpen(true);
    window.requestAnimationFrame(() => {
      const target = mobile ? mobileSearchRef.current : searchRef.current;
      target?.focus();
    });
  }

  function toggleSelection(id: string, additive = true) {
    setSelected((current) => {
      const next = additive ? new Set(current) : new Set<string>();
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      const target = parseNavigationPath(window.location.pathname);
      const resolved =
        resolveNavigationHistoryState(
          event.state,
          window.location.pathname,
          data,
        ) ?? (target ? resolveNavigationTarget(target, data) : null);
      if (resolved) {
        setSurface(resolved.surface);
        setLayout(resolved.layout);
        setActiveTaskId(resolved.taskId);
        if (!resolved.taskId) {
          taskReturnPath.current = navigationPath(resolved, data);
        }
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [data]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      if (event.key === "Escape") {
        if (mobileActionsOpen) setMobileActionsOpen(false);
        else if (mobileSidebarOpen) setMobileSidebarOpen(false);
        else if (accountMenuOpen) {
          setAccountMenuOpen(false);
          accountTriggerRef.current?.focus();
        }
        else if (dialog && !systemBackupBusy) setDialog(null);
        else if (activeTaskId) {
          setActiveTaskId(null);
          const target = parseNavigationPath(taskReturnPath.current);
          const next = target ? resolveNavigationTarget(target, data) : null;
          window.history.replaceState(
            next ? navigationHistoryState(next) : null,
            "",
            taskReturnPath.current,
          );
        }
        else if (peekTaskId) setPeekTaskId(null);
        else if (selected.size) setSelected(new Set());
        return;
      }
      if (typing) return;
      if (surface === "admin") return;
      if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        openCreate();
      } else if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFilterOpen((value) => !value);
      } else if (event.key.toLowerCase() === "b" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        const nextLayout = layout === "list" ? "board" : "list";
        const next: ResolvedNavigation = { surface, layout: nextLayout, taskId: null };
        setLayout(nextLayout);
        setActiveTaskId(null);
        taskReturnPath.current = navigationPath(next, data);
        window.history.pushState(
          navigationHistoryState(next),
          "",
          navigationPath(next, data),
        );
      } else if (["j", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        setHighlighted((value) => Math.min(value + 1, visibleTasks.length - 1));
      } else if (["k", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        setHighlighted((value) => Math.max(0, value - 1));
      } else if (event.key.toLowerCase() === "x" && visibleTasks[highlighted]) {
        event.preventDefault();
        toggleSelection(visibleTasks[highlighted].id);
      } else if (event.key === " " && visibleTasks[highlighted]) {
        event.preventDefault();
        setPeekTaskId(visibleTasks[highlighted].id);
      } else if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSelected(new Set(visibleTasks.map((task) => task.id)));
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [accountMenuOpen, activeTaskId, data, dialog, highlighted, layout, mobileActionsOpen, mobileSidebarOpen, peekTaskId, selected.size, surface, systemBackupBusy, visibleTasks]);

  useEffect(() => {
    // Navigation changes deliberately reset ephemeral list state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlighted(0);
    setSelected(new Set());
  }, [surface, search, priorityFilter, statusFilter]);

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${mobileSidebarOpen ? "mobile-sidebar-open" : ""}`}>
      {mobileSidebarOpen && (
        <button
          className="mobile-sidebar-backdrop"
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <aside className="sidebar" id="workspace-sidebar">
        <div className="sidebar-head">
          <a
            className="workspace-switcher"
            href={navigationPath({ surface: "all", layout: "list", taskId: null }, data)}
            title="Go to workspace"
            onClick={(event) => handleLocalLink(event, () => navigateSurface("all", "list"))}
          >
            <span className="product-mark">T</span>
            {!sidebarCompact && <span className="workspace-name">Task Manager</span>}
          </a>
          {!sidebarCompact && (
            <button className="icon-button" onClick={() => openCreate()} title="Create task (C)">
              <Plus size={15} />
            </button>
          )}
          <button
            className="icon-button mobile-sidebar-close"
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileSidebarOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
        {!sidebarCompact && (
          <button className="sidebar-search" onClick={focusSearch}>
            <Search size={14} /><span>Search</span><kbd>/</kbd>
          </button>
        )}
        <nav className="nav-scroll" aria-label="Workspace">
          <NavItem compact={sidebarCompact} icon={<Inbox size={15} />} label="My tasks" active={builtInViews.some((view) => view.id === surface)} href="/issues" onNavigate={() => navigateSurface("all", "list")} />
          <NavItem compact={sidebarCompact} icon={<UsersRound size={15} />} label="Shared with me" active={surface === "shared"} href="/shared" onNavigate={() => navigateSurface("shared", "list")} />
          {!sidebarCompact && (
            <>
              <SidebarSection title="Views" action={() => setDialog("view")}>
                <NavItem compact={false} icon={<Boxes size={13} />} label="All views" active={surface === "views"} href="/views" onNavigate={() => navigateSurface("views", "list")} />
                {builtInViews.map((view) => (
                  <NavItem key={view.id} compact={false} icon={<Circle size={9} />} label={view.label} active={surface === view.id} href={navigationPath({ surface: view.id, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(view.id, "list")} count={taskCountForView(view.id, data, statusMap)} />
                ))}
                {data.views.map((view) => (
                  <NavItem key={view.id} compact={false} icon={<Zap size={13} />} label={view.name} active={surface === `view:${view.id}`} href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)} onNavigate={() => navigateSurface(`view:${view.id}`, view.display.layout)} />
                ))}
              </SidebarSection>
              <SidebarSection title="Projects" action={() => setDialog("project")}>
                <NavItem compact={false} icon={<Boxes size={13} />} label="All projects" active={surface === "projects"} href="/projects" onNavigate={() => navigateSurface("projects", "list")} />
                {data.projects.map((project) => (
                  <NavItem key={project.id} compact={false} icon={<span className="project-dot" style={{ background: project.color }} />} label={project.name} active={surface === `project:${project.id}`} href={navigationPath({ surface: `project:${project.id}`, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(`project:${project.id}`, "list")} />
                ))}
              </SidebarSection>
              <SidebarSection title="Releases" action={() => setDialog("release")}>
                <NavItem compact={false} icon={<Rocket size={13} />} label="All releases" active={surface === "releases"} href="/releases" onNavigate={() => navigateSurface("releases", "list")} />
                {data.releases.slice(0, 6).map((release) => (
                  <NavItem key={release.id} compact={false} icon={<CircleDot size={12} />} label={release.name} active={surface === `release:${release.id}`} href={navigationPath({ surface: `release:${release.id}`, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(`release:${release.id}`, "list")} />
                ))}
              </SidebarSection>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="account-control" ref={accountMenuRef}>
            {accountMenuOpen && (
              <div className="account-menu" role="menu" aria-label="Account menu">
                <div className="account-menu-user">
                  <span className="avatar">{initials(data.user.displayName)}</span>
                  <span>
                    <b>{data.user.displayName}</b>
                    <small>{data.user.email}</small>
                  </span>
                </div>
                <p className="account-provider">Signed in with ChatGPT</p>
                <div className="account-menu-separator" role="separator" />
                <a
                  className="account-menu-item"
                  href={navigationPath({ surface: "all", layout: "list", taskId: null }, data)}
                  role="menuitem"
                  onClick={(event) => handleLocalLink(event, () => {
                    navigateSurface("all", "list");
                    setAccountMenuOpen(false);
                  })}
                >
                  <Inbox size={14} />
                  <span>My tasks</span>
                </a>
                {data.admin && (
                  <a
                    className="account-menu-item"
                    href={navigationPath({ surface: "admin", layout: "list", taskId: null }, data)}
                    role="menuitem"
                    onClick={(event) => handleLocalLink(event, () => {
                      navigateSurface("admin", "list");
                      setAccountMenuOpen(false);
                    })}
                  >
                    <ShieldCheck size={14} />
                    <span>Administration</span>
                  </a>
                )}
                <div className="account-menu-separator" role="separator" />
                <div className="account-theme" role="group" aria-label="Appearance">
                  <span>Appearance</span>
                  <div>
                    <button role="menuitemradio" aria-checked={theme === "system"} className={theme === "system" ? "active" : ""} onClick={() => setTheme("system")} title="Use system theme"><Monitor size={13} /></button>
                    <button role="menuitemradio" aria-checked={theme === "light"} className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")} title="Use light theme"><Sun size={13} /></button>
                    <button role="menuitemradio" aria-checked={theme === "dark"} className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")} title="Use dark theme"><Moon size={13} /></button>
                  </div>
                </div>
              </div>
            )}
            <div className="profile-row">
              <button
                className="profile-trigger"
                ref={accountTriggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
                title={sidebarCompact ? "Open account menu" : undefined}
                onClick={() => setAccountMenuOpen((value) => !value)}
              >
                <span className="avatar small">{initials(data.user.displayName)}</span>
                {!sidebarCompact && <span className="profile-label"><b>{data.user.displayName}</b><small>{data.user.email}</small></span>}
                {!sidebarCompact && <ChevronDown size={13} className={`profile-chevron ${accountMenuOpen ? "open" : ""}`} />}
              </button>
              <a className="profile-logout" href={signOutPath} title="Sign out" aria-label="Sign out">
                <LogOut size={14} />
              </a>
            </div>
          </div>
        </div>
      </aside>

      <section className="main-surface">
        <header className="surface-header">
          <div className="title-row">
            <div className="title-cluster">
              <button
                className="icon-button desktop-sidebar-toggle"
                type="button"
                aria-controls="workspace-sidebar"
                aria-expanded={!sidebarCollapsed}
                aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
                onClick={() => setSidebarCollapsed((value) => !value)}
                title="Toggle navigation"
              >
                {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>
              <button
                className="icon-button mobile-menu"
                type="button"
                aria-controls="workspace-sidebar"
                aria-expanded={mobileSidebarOpen}
                aria-label={mobileSidebarOpen ? "Close navigation" : "Open navigation"}
                onClick={() => {
                  setMobileSidebarOpen((value) => !value);
                  setMobileActionsOpen(false);
                }}
                title="Toggle navigation"
              >
                {mobileSidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
              </button>
              <nav className="breadcrumbs" aria-label="Breadcrumb">
                {breadcrumbs.map((item, index) => {
                  const current = index === breadcrumbs.length - 1;
                  const targetSurface = item.surface;
                  return (
                    <div className="breadcrumb-step" key={`${item.label}:${index}`}>
                      {index > 0 && <ChevronRight size={12} className="breadcrumb-chevron" aria-hidden="true" />}
                      {current || !targetSurface ? (
                        <h1 className="breadcrumb-current">{item.label}</h1>
                      ) : (
                        <a
                          className="breadcrumb-link"
                          href={navigationPath({ surface: targetSurface, layout: item.layout ?? "list", taskId: null }, data)}
                          onClick={(event) => handleLocalLink(event, () => navigateSurface(targetSurface, item.layout))}
                        >
                          {item.label}
                        </a>
                      )}
                    </div>
                  );
                })}
              </nav>
              <span className="count-pill">{surfaceCount}</span>
            </div>
            <div className="title-actions">
              {surface === "admin" && data.admin && <button className="button ghost" disabled={systemBackupBusy} onClick={() => void downloadSystemBackup()}><Download size={14} />{systemBackupBusy ? "Exporting…" : "Export"}</button>}
              {surface === "admin" && data.admin && <button className="button ghost danger" disabled={systemBackupBusy} onClick={() => setDialog("systemImport")}><Upload size={14} />Import</button>}
              {surface.startsWith("project:") && contextProjectRecord && <a className="button ghost" href={projectReleasesPath(contextProjectRecord.publicId)} onClick={(event) => handleLocalLink(event, () => navigateSurface(`project-releases:${contextProjectRecord.id}`, "list"))}><Rocket size={14} />Releases</a>}
              {shareTarget(surface, activeTask, data) && <button className="button ghost" onClick={() => setDialog("share")}><Share2 size={14} />Share</button>}
              <button className="icon-button" title="Copy direct link" onClick={() => void copyCurrentLink()}><Link2 size={16} /></button>
            </div>
          </div>
          {!isCollectionSurface(surface) && (
            <div className="toolbar-row">
              <div className="toolbar-left">
                <div className="desktop-view-controls">
                  <div className="search-control">
                    <Search size={13} />
                    <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks…" aria-label="Search tasks" />
                    {search && <button onClick={() => setSearch("")}><X size={12} /></button>}
                  </div>
                  <div className="popover-anchor">
                    <button className={`button ghost ${filterOpen ? "active" : ""}`} onClick={() => setFilterOpen((value) => !value)}><ListFilter size={14} />Filter{(priorityFilter !== "all" || statusFilter !== "all") && <span className="filter-count">{Number(priorityFilter !== "all") + Number(statusFilter !== "all")}</span>}</button>
                    {filterOpen && <FilterPopover statuses={data.statuses} priority={priorityFilter} status={statusFilter} onPriority={setPriorityFilter} onStatus={setStatusFilter} onClose={() => setFilterOpen(false)} />}
                  </div>
                  <div className="segmented" aria-label="Layout">
                    <button className={layout === "list" ? "active" : ""} onClick={() => changeLayout("list")} title="List"><LayoutList size={14} /></button>
                    <button className={layout === "board" ? "active" : ""} onClick={() => changeLayout("board")} title="Board"><Columns3 size={14} /></button>
                  </div>
                  <div className="popover-anchor display-anchor">
                    <button className={`button ghost ${displayOpen ? "active" : ""}`} onClick={() => setDisplayOpen((value) => !value)}><SlidersHorizontal size={14} />Display</button>
                    {displayOpen && <DisplayPopover layout={layout} groupBy={activeSavedView?.display.groupBy ?? "status"} orderBy={activeSavedView?.display.orderBy ?? "manual"} onLayout={changeLayout} onClose={() => setDisplayOpen(false)} />}
                  </div>
                  {hasViewChanges && <button className="button ghost save-view" onClick={() => setDialog("view")}><Save size={13} />Save view</button>}
                </div>
                <div className="mobile-view-controls-anchor" ref={mobileActionsRef}>
                  <button
                    className={`icon-button mobile-view-controls-trigger ${mobileActionsOpen ? "active" : ""}`}
                    type="button"
                    aria-controls="mobile-view-controls"
                    aria-expanded={mobileActionsOpen}
                    aria-haspopup="dialog"
                    aria-label="Open view controls"
                    onClick={() => {
                      setMobileActionsOpen((value) => !value);
                      setMobileSidebarOpen(false);
                    }}
                  >
                    <SlidersHorizontal size={17} />
                    {(priorityFilter !== "all" || statusFilter !== "all") && <span className="filter-count">{Number(priorityFilter !== "all") + Number(statusFilter !== "all")}</span>}
                  </button>
                  <div
                    className="mobile-view-controls"
                    id="mobile-view-controls"
                    role="dialog"
                    aria-modal="false"
                    aria-label="View controls"
                    hidden={!mobileActionsOpen}
                  >
                    <header>
                      <b>View controls</b>
                      <button type="button" className="icon-button" aria-label="Close view controls" onClick={() => setMobileActionsOpen(false)}><X size={15} /></button>
                    </header>
                    <label className="mobile-search-control">
                      <Search size={15} />
                      <input ref={mobileSearchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks…" aria-label="Search tasks on mobile" />
                      {search && <button type="button" aria-label="Clear search" onClick={() => setSearch("")}><X size={13} /></button>}
                    </label>
                    <section className="mobile-control-section">
                      <h3>Filter</h3>
                      <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Any status</option>{data.statuses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                      <label><span>Priority</span><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as Priority | "all")}><option value="all">Any priority</option>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></label>
                    </section>
                    <section className="mobile-control-section">
                      <h3>Display</h3>
                      <div className="segmented wide" aria-label="Mobile layout">
                        <button className={layout === "list" ? "active" : ""} onClick={() => changeLayout("list")}><LayoutList size={14} />List</button>
                        <button className={layout === "board" ? "active" : ""} onClick={() => changeLayout("board")}><Columns3 size={14} />Board</button>
                      </div>
                      <div className="mobile-display-summary"><span>Group by</span><b>{displayLabel(activeSavedView?.display.groupBy ?? "status")}</b></div>
                      <div className="mobile-display-summary"><span>Order</span><b>{displayLabel(activeSavedView?.display.orderBy ?? "manual")}</b></div>
                    </section>
                    <div className="mobile-controls-footer">
                      <button className="button ghost" type="button" onClick={() => { setPriorityFilter("all"); setStatusFilter("all"); }}>Clear filters</button>
                      {hasViewChanges && <button className="button secondary" type="button" onClick={() => { setMobileActionsOpen(false); setDialog("view"); }}><Save size={14} />Save view</button>}
                    </div>
                  </div>
                </div>
              </div>
              <button className="button primary" onClick={() => openCreate()}><Plus size={14} />New task</button>
            </div>
          )}
        </header>

        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")}><X size={14} /></button></div>}
        {busy && <div className="progress-line" aria-label="Saving" />}

        {surface === "admin" && data.admin ? (
          <AdminSurface overview={data.admin} timeZone={data.user.timezone} />
        ) : surface === "views" ? (
          <ViewsSurface data={data} statusMap={statusMap} onOpen={(nextSurface, nextLayout) => navigateSurface(nextSurface, nextLayout)} />
        ) : surface === "projects" ? (
          <ProjectsSurface projects={data.projects} tasks={data.tasks} statuses={data.statuses} onOpen={(id) => navigateSurface(`project:${id}`, "list")} onCreate={() => setDialog("project")} />
        ) : surface === "releases" || projectReleaseSurfaceId ? (
          <ReleasesSurface releases={scopedReleases} projects={projectMap} tasks={data.tasks} statuses={data.statuses} onOpen={(id) => navigateSurface(`release:${id}`, "list")} onCreate={() => setDialog("release")} />
        ) : layout === "board" ? (
          <TaskBoard tasks={visibleTasks} statuses={visibleStatuses} projects={projectMap} releases={releaseMap} selected={selected} onSelect={toggleSelection} onOpen={openTask} onCreate={openCreate} onMove={async (task, statusId, rank) => mutate(`/api/tasks/${task.id}`, "PATCH", { version: task.version, statusId, rank })} />
        ) : (
          <TaskList tasks={visibleTasks} statuses={visibleStatuses} groupBy={activeSavedView?.display.groupBy ?? "status"} projects={projectMap} releases={releaseMap} selected={selected} highlighted={highlighted} collapsed={collapsedGroups} onToggleGroup={(id) => setCollapsedGroups((current) => toggleSet(current, id))} onSelect={toggleSelection} onHighlight={setHighlighted} onOpen={openTask} onPeek={setPeekTaskId} onCreate={openCreate} />
        )}
      </section>

      {selected.size > 0 && (
        <BulkBar count={selected.size} statuses={statusGroupsForTasks(selectedTasks, data.statuses)} archiveAction={archiveAction} onStatus={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], field: "statusId", value }).then((ok) => ok && setSelected(new Set()))} onPriority={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], field: "priority", value }).then((ok) => ok && setSelected(new Set()))} onArchive={() => mutate("/api/tasks/bulk", "POST", { ids: [...selected], field: "archived", value: archiveAction.archived }).then((ok) => ok && setSelected(new Set()))} onClose={() => setSelected(new Set())} />
      )}

      {activeTask && <TaskDetails key={activeTask.id} task={activeTask} data={data} onClose={closeTask} onOpenTask={openTask} onSave={async (changes) => mutate(`/api/tasks/${activeTask.id}`, "PATCH", { version: activeTask.version, ...changes })} onShare={() => setDialog("share")} busy={busy} />}
      {peekTask && <Peek task={peekTask} status={statusMap.get(peekTask.statusId)} project={peekTask.projectId ? projectMap.get(peekTask.projectId) : undefined} onClose={() => setPeekTaskId(null)} onOpen={() => { openTask(peekTask.id); setPeekTaskId(null); }} />}
      {dialog === "task" && <TaskComposer data={data} contextProject={contextProject} contextRelease={contextRelease} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/tasks", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "project" && <EntityDialog title="Create project" icon={<FolderKanban size={17} />} fields={[{ name: "name", label: "Project name", required: true }, { name: "summary", label: "Short summary" }, { name: "targetDate", label: "Target date", type: "date" }]} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/projects", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "release" && <ReleaseDialog projects={data.projects} initialProjectId={contextProject} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/releases", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "view" && <ViewDialog search={search} status={statusFilter} priority={priorityFilter} layout={layout} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/views", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "share" && <ShareDialog target={shareTarget(surface, activeTask, data)} collaborators={data.collaborators} onClose={() => setDialog(null)} onShare={(input) => mutate("/api/shares", "POST", input)} onRevoke={(grantId) => mutate("/api/shares", "DELETE", { grantId })} busy={busy} />}
      {dialog === "systemImport" && <SystemImportDialog onClose={() => setDialog(null)} onDownloadCurrent={downloadSystemBackup} onBusyChange={setSystemBackupBusy} onApplied={() => window.location.assign("/admin")} />}
    </main>
  );
}

function NavItem({ compact, icon, label, active, href, onNavigate, count }: { compact: boolean; icon: React.ReactNode; label: string; active: boolean; href: string; onNavigate: () => void; count?: number }) {
  return <a className={`nav-item ${active ? "active" : ""}`} href={href} aria-current={active ? "page" : undefined} onClick={(event) => handleLocalLink(event, onNavigate)} title={compact ? label : undefined}><span className="nav-icon">{icon}</span>{!compact && <><span>{label}</span>{count !== undefined && <small className="nav-count">{count}</small>}</>}</a>;
}

function SidebarSection({ title, action, children }: { title: string; action: () => void; children: React.ReactNode }) {
  return <section className="sidebar-section"><div className="section-label"><span>{title}</span><button onClick={action} title={`Add ${title.toLowerCase()}`}><Plus size={12} /></button></div>{children}</section>;
}

function TaskList({ tasks, statuses, groupBy, projects, releases, selected, highlighted, collapsed, onToggleGroup, onSelect, onHighlight, onOpen, onPeek, onCreate }: { tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; groupBy: ViewDisplay["groupBy"]; projects: Map<string, ProjectRecord>; releases: Map<string, ReleaseRecord>; selected: Set<string>; highlighted: number; collapsed: Set<string>; onToggleGroup: (id: string) => void; onSelect: (id: string) => void; onHighlight: (index: number) => void; onOpen: (id: string) => void; onPeek: (id: string) => void; onCreate: (statusId?: string) => void }) {
  if (!tasks.length) return <EmptyState onCreate={() => onCreate()} />;
  if (groupBy === "none") {
    const statusMap = new Map(statuses.map((status) => [status.id, status]));
    return <div className="task-list ungrouped">{tasks.map((task, index) => { const status = statusMap.get(task.statusId); return status ? <TaskRow key={task.id} task={task} status={status} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} selected={selected.has(task.id)} highlighted={highlighted === index} onSelect={() => onSelect(task.id)} onHighlight={() => onHighlight(index)} onOpen={() => onOpen(task.id)} onPeek={() => onPeek(task.id)} /> : null; })}</div>;
  }
  let flatIndex = -1;
  return <div className="task-list">{statuses.map((status) => {
    const groupTasks = tasks.filter((task) => task.statusId === status.id);
    if (!groupTasks.length) return null;
    const isCollapsed = collapsed.has(status.id);
    return <section className="task-group" key={status.id}><div className="group-header"><button className="group-title" onClick={() => onToggleGroup(status.id)}><ChevronDown size={13} className={isCollapsed ? "rotated" : ""} /><StatusIcon status={status} /><span>{status.name}</span><small>{groupTasks.length}</small></button><button className="icon-button quiet" onClick={() => onCreate(status.id)} title={`Add to ${status.name}`}><Plus size={13} /></button></div>{!isCollapsed && groupTasks.map((task) => { flatIndex += 1; const index = flatIndex; return <TaskRow key={task.id} task={task} status={status} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} selected={selected.has(task.id)} highlighted={highlighted === index} onSelect={() => onSelect(task.id)} onHighlight={() => onHighlight(index)} onOpen={() => onOpen(task.id)} onPeek={() => onPeek(task.id)} />; })}</section>;
  })}</div>;
}

function TaskRow({ task, status, project, release, selected, highlighted, onSelect, onHighlight, onOpen, onPeek }: { task: TaskRecord; status: WorkflowStatusRecord; project?: ProjectRecord; release?: ReleaseRecord; selected: boolean; highlighted: boolean; onSelect: () => void; onHighlight: () => void; onOpen: () => void; onPeek: () => void }) {
  return <div className={`task-row ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""}`} onMouseEnter={onHighlight} onDoubleClick={onPeek}><button className={`row-check ${selected ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); onSelect(); }} aria-label={selected ? "Deselect task" : "Select task"}>{selected ? <Check size={12} /> : <span />}</button><span className={`priority priority-${task.priority}`} title={priorityMeta[task.priority].label}>{priorityMeta[task.priority].glyph}</span><a className="task-identity" href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)}>{task.identifier}</a><a className="task-title" href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)} title={task.title}>{task.title}</a><div className="row-metadata">{project && <span className="metadata-chip"><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}{release && <span className="metadata-chip"><Rocket size={12} />{release.name}</span>}{task.dueDate && <span className={`metadata-chip ${isOverdue(task.dueDate, status.category) ? "overdue" : ""}`}><CalendarDays size={12} />{shortDate(task.dueDate)}</span>}<span className="avatar" title="Assignee">{initials("Me")}</span><button className="row-more" title="More"><MoreHorizontal size={14} /></button></div></div>;
}

function TaskBoard({ tasks, statuses, projects, releases, selected, onSelect, onOpen, onCreate, onMove }: { tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; projects: Map<string, ProjectRecord>; releases: Map<string, ReleaseRecord>; selected: Set<string>; onSelect: (id: string) => void; onOpen: (id: string) => void; onCreate: (statusId?: string) => void; onMove: (task: TaskRecord, statusId: string, rank: number) => Promise<unknown> }) {
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="board">
      {statuses.map((status) => {
        const cards = tasks.filter((task) => task.statusId === status.id);
        return (
          <section
            key={status.id}
            className={`board-column ${over === status.id ? "drag-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(status.id);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData("text/task-id");
              const task = tasks.find((item) => item.id === id);
              setOver(null);
              if (task && task.statusId !== status.id) {
                const lastRank = cards.at(-1)?.rank ?? 0;
                void onMove(task, status.id, lastRank + 1000);
              }
            }}
          >
            <div className="column-header">
              <div>
                <StatusIcon status={status} />
                <span>{status.name}</span>
                <small>{cards.length}</small>
              </div>
              <button className="icon-button quiet" onClick={() => onCreate(status.id)}>
                <Plus size={13} />
              </button>
            </div>
            <div className="column-cards">
              {cards.map((task) => (
                <div
                  key={task.id}
                  role="button"
                  tabIndex={0}
                  className={`task-card ${selected.has(task.id) ? "selected" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/task-id", task.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onOpen(task.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpen(task.id);
                    }
                  }}
                >
                  <button
                    className={`card-check ${selected.has(task.id) ? "checked" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(task.id);
                    }}
                    aria-label={selected.has(task.id) ? "Deselect task" : "Select task"}
                  >
                    {selected.has(task.id) ? <Check size={11} /> : <span />}
                  </button>
                  <a href={taskPath(task.publicId)} onClick={(event) => { event.stopPropagation(); handleLocalLink(event, () => onOpen(task.id)); }}>
                  <h3>{task.title}</h3>
                  <div className="card-meta">
                    <span>{task.identifier}</span>
                    <span className={`priority priority-${task.priority}`}>
                      {priorityMeta[task.priority].glyph}
                    </span>
                    {task.projectId && projects.get(task.projectId) && (
                      <span className="metadata-chip">
                        <span className="project-dot" style={{ background: projects.get(task.projectId)?.color }} />
                        {projects.get(task.projectId)?.name}
                      </span>
                    )}
                    {task.releaseId && releases.get(task.releaseId) && <Rocket size={12} />}
                  </div>
                  </a>
                </div>
              ))}
            </div>
            <button className="add-card" onClick={() => onCreate(status.id)}>
              <Plus size={13} />Add task
            </button>
          </section>
        );
      })}
    </div>
  );
}

function StatusIcon({ status }: { status: WorkflowStatusRecord }) {
  return <span className={`status-icon status-${status.category}`} style={{ "--status-color": status.color } as React.CSSProperties}>{status.category === "completed" && <Check size={9} />}</span>;
}

function TaskComposer({ data, contextProject, contextRelease, onClose, onSubmit, busy }: { data: AppSnapshot; contextProject: string | null; contextRelease: string | null; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const [projectId, setProjectId] = useState(contextProject ?? (contextRelease ? data.releases.find((release) => release.id === contextRelease)?.projectId ?? "" : ""));
  const ownerId = data.projects.find((project) => project.id === projectId)?.ownerUserId ?? data.user.id;
  const statuses = data.statuses.filter((status) => status.ownerUserId === ownerId);
  const storedStatus = typeof window !== "undefined" ? window.sessionStorage.getItem("tm-create-status") : null;
  const [statusId, setStatusId] = useState(storedStatus && statuses.some((status) => status.id === storedStatus) ? storedStatus : statuses.find((status) => status.isDefault)?.id ?? statuses[0]?.id ?? "");
  const [releaseId, setReleaseId] = useState(contextRelease ?? "");
  const [priority, setPriority] = useState<Priority>("none");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const submit = (event?: FormEvent) => { event?.preventDefault(); if (title.trim()) void onSubmit({ title, description, projectId: projectId || null, releaseId: releaseId || null, statusId, priority }); };
  return <Modal onClose={onClose} className="composer-modal"><form onSubmit={submit}><div className="modal-title-row"><span className="muted">New task</span><button type="button" className="icon-button" onClick={onClose}><X size={15} /></button></div><input className="composer-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" autoFocus /><textarea className="composer-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add description…" rows={4} onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit(); }} /><div className="property-bar"><PropertySelect icon={<CircleDot size={13} />} value={statusId} onChange={setStatusId}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</PropertySelect><PropertySelect icon={<ArrowDownWideNarrow size={13} />} value={priority} onChange={(value) => setPriority(value as Priority)}>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</PropertySelect><PropertySelect icon={<FolderKanban size={13} />} value={projectId} onChange={(value) => { setProjectId(value); setReleaseId(""); const nextOwner = data.projects.find((project) => project.id === value)?.ownerUserId ?? data.user.id; setStatusId(data.statuses.find((status) => status.ownerUserId === nextOwner && status.isDefault)?.id ?? data.statuses.find((status) => status.ownerUserId === nextOwner)?.id ?? ""); }}><option value="">No project</option>{data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</PropertySelect><PropertySelect icon={<Rocket size={13} />} value={releaseId} onChange={setReleaseId} disabled={!projectId}><option value="">No release</option>{data.releases.filter((release) => release.projectId === projectId).map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</PropertySelect></div><div className="modal-footer"><span className="shortcut-hint"><kbd>⌘</kbd><kbd>Enter</kbd> to create</span><button className="button primary" disabled={busy || !title.trim()}>{busy ? "Creating…" : "Create task"}</button></div></form></Modal>;
}

function TaskDetails({ task, data, onClose, onOpenTask, onSave, onShare, busy }: { task: TaskRecord; data: AppSnapshot; onClose: () => void; onOpenTask: (id: string) => void; onSave: (input: Record<string, unknown>) => Promise<unknown>; onShare: () => void; busy: boolean }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [estimate, setEstimate] = useState(task.estimate?.toString() ?? "");
  const statuses = data.statuses.filter((status) => status.ownerUserId === task.ownerUserId);
  const projects = data.projects.filter((project) => project.ownerUserId === task.ownerUserId);
  const taskMap = new Map(data.tasks.map((item) => [item.id, item]));
  const labels = data.taskLabels
    .filter((assignment) => assignment.taskId === task.id)
    .map((assignment) => data.labels.find((label) => label.id === assignment.labelId))
    .filter((label) => label !== undefined);
  const parent = task.parentTaskId ? taskMap.get(task.parentTaskId) : undefined;
  const subtasks = data.tasks.filter((item) => item.parentTaskId === task.id);
  const relations: Array<{ relation: AppSnapshot["relations"][number]; direction: "in" | "out"; target: TaskRecord | undefined }> = [];
  for (const relation of data.relations) {
    if (relation.sourceTaskId === task.id) {
      relations.push({ relation, direction: "out", target: taskMap.get(relation.targetTaskId) });
    } else if (relation.targetTaskId === task.id) {
      relations.push({ relation, direction: "in", target: taskMap.get(relation.sourceTaskId) });
    }
  }
  const source = data.externalSources.find(
    (entry) => entry.targetType === "task" && entry.targetId === task.id,
  );
  return <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="details-panel"><header><div className="details-crumb"><span>{task.identifier}</span><button title="Copy link" onClick={() => void navigator.clipboard.writeText(window.location.href)}><Link2 size={13} /></button></div><div><button className="button ghost" onClick={onShare}><Share2 size={13} />Share</button><button className="icon-button" onClick={onClose}><X size={16} /></button></div></header><div className="details-body"><input className="details-title" value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => title.trim() && title !== task.title && void onSave({ title })} /><textarea className="details-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add description…" rows={8} /><button className="button secondary save-description" disabled={busy || description === task.description} onClick={() => void onSave({ description })}>{busy ? "Saving…" : "Save description"}</button><div className="properties-grid"><PropertyRow label="Status" icon={<CircleDot size={14} />}><select value={task.statusId} onChange={(event) => void onSave({ statusId: event.target.value })}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></PropertyRow><PropertyRow label="Priority" icon={<ArrowDownWideNarrow size={14} />}><select value={task.priority} onChange={(event) => void onSave({ priority: event.target.value })}>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></PropertyRow><PropertyRow label="Project" icon={<FolderKanban size={14} />}><select value={task.projectId ?? ""} onChange={(event) => void onSave({ projectId: event.target.value || null })}><option value="">No project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></PropertyRow><PropertyRow label="Release" icon={<Rocket size={14} />}><select value={task.releaseId ?? ""} onChange={(event) => void onSave({ releaseId: event.target.value || null })} disabled={!task.projectId}><option value="">No release</option>{data.releases.filter((release) => release.projectId === task.projectId).map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</select></PropertyRow><PropertyRow label="Due date" icon={<CalendarDays size={14} />}><input type="date" value={task.dueDate ?? ""} onChange={(event) => void onSave({ dueDate: event.target.value || null })} /></PropertyRow><PropertyRow label="Estimate" icon={<Zap size={14} />}><input type="number" min="0" max="100" value={estimate} placeholder="No estimate" onChange={(event) => setEstimate(event.target.value)} onBlur={() => { const value = estimate === "" ? null : Number(estimate); if (value !== task.estimate) void onSave({ estimate: value }); }} /></PropertyRow></div>{labels.length > 0 && <DetailsSection title="Labels" icon={<Tag size={14} />}><div className="details-labels">{labels.map((label) => <span key={label.id} style={{ "--label-color": label.color } as React.CSSProperties}>{label.name}</span>)}</div></DetailsSection>}{(parent || subtasks.length > 0) && <DetailsSection title="Hierarchy" icon={<Boxes size={14} />}><div className="details-links">{parent && <TaskReference label="Parent" task={parent} onOpen={onOpenTask} />}{subtasks.map((subtask) => <TaskReference key={subtask.id} label="Subtask" task={subtask} onOpen={onOpenTask} />)}</div></DetailsSection>}{relations.length > 0 && <DetailsSection title="Relations" icon={<Link2 size={14} />}><div className="details-links">{relations.map(({ relation, direction, target }) => target && <TaskReference key={`${relation.sourceTaskId}:${relation.targetTaskId}:${relation.type}:${direction}`} label={relationLabel(relation.type, direction)} task={target} onOpen={onOpenTask} />)}</div></DetailsSection>}{source && <DetailsSection title="Imported from Linear" icon={<Link2 size={14} />}><div className="source-metadata">{source.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noreferrer">Open {source.sourceId} in Linear</a>}{source.gitBranchName && <span><GitBranch size={13} /><code>{source.gitBranchName}</code></span>}<span><MessageSquare size={13} />{source.commentEntries} archived comments</span><span><Boxes size={13} />{source.stateHistoryEntries} status-history entries</span>{source.attachments.map((attachment) => <a key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer"><Paperclip size={13} />{attachment.title}</a>)}</div></DetailsSection>}{source && source.comments.length > 0 && <DetailsSection title="Imported comments" icon={<MessageSquare size={14} />}><div className="comment-archive">{source.comments.map((comment) => <article key={comment.id}><header><b>{comment.authorName}</b><time dateTime={comment.createdAt}>{longDateTime(comment.createdAt)}</time>{comment.parentId && <small>Reply</small>}</header>{comment.quotedText && <blockquote>{comment.quotedText}</blockquote>}<p>{comment.body}</p></article>)}</div></DetailsSection>}<div className="timestamps"><span>Created {longDate(task.createdAt)}</span><span>Updated {longDate(task.updatedAt)}</span>{task.completedAt && <span>Completed {longDate(task.completedAt)}</span>}</div><button className="button danger ghost archive-action" onClick={() => { void onSave({ archived: !task.archivedAt }); onClose(); }}><Archive size={14} />{task.archivedAt ? "Restore task" : "Archive task"}</button></div></aside></div>;
}

function DetailsSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <section className="details-section"><h2>{icon}{title}</h2>{children}</section>; }
function TaskReference({ label, task, onOpen }: { label: string; task: TaskRecord; onOpen: (id: string) => void }) { return <a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, () => onOpen(task.id))}><small>{label}</small><span>{task.identifier}</span><b>{task.title}</b></a>; }

function PropertyRow({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) { return <label className="property-row"><span>{icon}{label}</span>{children}</label>; }
function PropertySelect({ icon, value, onChange, children, disabled }: { icon: React.ReactNode; value: string; onChange: (value: string) => void; children: React.ReactNode; disabled?: boolean }) { return <label className="property-select">{icon}<select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>{children}</select><ChevronDown size={11} /></label>; }

function FilterPopover({ statuses, priority, status, onPriority, onStatus, onClose }: { statuses: WorkflowStatusRecord[]; priority: Priority | "all"; status: string; onPriority: (value: Priority | "all") => void; onStatus: (value: string) => void; onClose: () => void }) { return <Popover title="Filter" onClose={onClose}><label className="popover-field"><span>Status</span><select value={status} onChange={(event) => onStatus(event.target.value)}><option value="all">Any status</option>{statuses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="popover-field"><span>Priority</span><select value={priority} onChange={(event) => onPriority(event.target.value as Priority | "all")}><option value="all">Any priority</option>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></label><button className="button ghost popover-clear" onClick={() => { onPriority("all"); onStatus("all"); }}>Clear filters</button></Popover>; }
function DisplayPopover({ layout, groupBy, orderBy, onLayout, onClose }: { layout: Layout; groupBy: ViewDisplay["groupBy"]; orderBy: ViewDisplay["orderBy"]; onLayout: (value: Layout) => void; onClose: () => void }) { return <Popover title="Display" onClose={onClose}><div className="display-option"><span>Layout</span><div className="segmented wide"><button className={layout === "list" ? "active" : ""} onClick={() => onLayout("list")}><LayoutList size={13} />List</button><button className={layout === "board" ? "active" : ""} onClick={() => onLayout("board")}><Columns3 size={13} />Board</button></div></div><div className="display-static"><span>Group by</span><b>{displayLabel(groupBy)}</b></div><div className="display-static"><span>Order</span><b>{displayLabel(orderBy)}</b></div></Popover>; }
function Popover({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="popover"><header><b>{title}</b><button onClick={onClose}><X size={13} /></button></header>{children}</div>; }

function EntityDialog({ title, icon, fields, onClose, onSubmit, busy }: { title: string; icon: React.ReactNode; fields: Array<{ name: string; label: string; type?: string; required?: boolean }>; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; busy: boolean }) { return <Modal onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void onSubmit(Object.fromEntries(new FormData(event.currentTarget))); }}><DialogHeader title={title} icon={icon} onClose={onClose} /><div className="form-stack">{fields.map((field) => <label key={field.name}><span>{field.label}</span><input name={field.name} type={field.type ?? "text"} required={field.required} autoFocus={field === fields[0]} /></label>)}</div><DialogFooter busy={busy} label="Create" /></form></Modal>; }
function ReleaseDialog({ projects, initialProjectId, onClose, onSubmit, busy }: { projects: ProjectRecord[]; initialProjectId: string | null; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; busy: boolean }) { return <Modal onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void onSubmit(Object.fromEntries(new FormData(event.currentTarget))); }}><DialogHeader title="Create release" icon={<Rocket size={17} />} onClose={onClose} /><div className="form-stack"><label><span>Release name</span><input name="name" required autoFocus placeholder="v1.0" /></label><label><span>Project</span><select name="projectId" required defaultValue={initialProjectId ?? ""}><option value="" disabled>Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label><span>Target date</span><input name="targetDate" type="date" /></label></div>{!projects.length && <p className="inline-note">Create a project before adding a release.</p>}<DialogFooter busy={busy} label="Create release" disabled={!projects.length} /></form></Modal>; }
function ViewDialog({ search, status, priority, layout, onClose, onSubmit, busy }: { search: string; status: string; priority: Priority | "all"; layout: Layout; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; busy: boolean }) { const query: ViewQuery = { ...(search && { search }), ...(status !== "all" && { statusIds: [status] }), ...(priority !== "all" && { priorities: [priority] }) }; const display: ViewDisplay = { layout, groupBy: "status", orderBy: "manual", direction: "asc", showEmptyGroups: true, visibleFields: ["priority", "project", "release", "dueDate", "assignee"] }; return <Modal onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void onSubmit({ name: values.name, query, display }); }}><DialogHeader title="Save as view" icon={<Zap size={17} />} onClose={onClose} /><div className="form-stack"><label><span>View name</span><input name="name" required autoFocus placeholder="e.g. Upcoming launch" /></label></div><div className="view-summary"><span>{layout === "list" ? "List" : "Board"}</span><span>{Object.keys(query).length || "No"} active filters</span></div><DialogFooter busy={busy} label="Save view" /></form></Modal>; }

function ShareDialog({ target, collaborators, onClose, onShare, onRevoke, busy }: { target: { resourceType: "project" | "task" | "saved_view"; resourceId: string; label: string } | null; collaborators: AppSnapshot["collaborators"]; onClose: () => void; onShare: (input: Record<string, unknown>) => Promise<boolean>; onRevoke: (grantId: string) => Promise<boolean>; busy: boolean }) { if (!target) return null; const grants = collaborators.filter((grant) => grant.resourceType === target.resourceType && grant.resourceId === target.resourceId); return <Modal onClose={onClose}><form onSubmit={async (event) => { event.preventDefault(); const email = String(new FormData(event.currentTarget).get("email") ?? ""); const ok = await onShare({ ...target, email }); if (ok) event.currentTarget.reset(); }}><DialogHeader title={`Share ${target.label}`} icon={<Share2 size={17} />} onClose={onClose} /><p className="dialog-copy">People you add get full access. They must have signed in once with their verified email.</p><div className="share-input"><input name="email" type="email" required placeholder="name@example.com" autoFocus /><button className="button primary" disabled={busy}>{busy ? "Adding…" : "Add"}</button></div><div className="access-list"><div className="access-row"><span className="avatar">{initials("You")}</span><span><b>You</b><small>Owner</small></span><em>Full access</em></div>{grants.map((grant) => <div className="access-row" key={grant.grantId}><span className="avatar">{initials(grant.displayName)}</span><span><b>{grant.displayName}</b><small>{grant.email}</small></span><button type="button" onClick={() => void onRevoke(grant.grantId)}>Remove</button></div>)}</div></form></Modal>; }

function SystemImportDialog({
  onClose,
  onDownloadCurrent,
  onBusyChange,
  onApplied,
}: {
  onClose: () => void;
  onDownloadCurrent: () => Promise<boolean>;
  onBusyChange: (busy: boolean) => void;
  onApplied: (result: AppliedSystemBackup) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [staged, setStaged] = useState<StagedSystemBackup | null>(null);
  const [rollbackDownloaded, setRollbackDownloaded] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloadingCurrent, setDownloadingCurrent] = useState(false);
  const [error, setError] = useState("");

  function setImportBusy(value: boolean) {
    setBusy(value);
    onBusyChange(value);
  }

  async function validateFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setImportBusy(true);
    setError("");
    try {
      if (file.size > 10_000_000) throw new Error("Backup file is larger than 10 MB");
      const response = await fetch("/api/admin/import/validate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-task-manager-action": "system-backup",
        },
        body: await file.text(),
      });
      const value = await response.json().catch(() => null) as StagedSystemBackup | { error?: string } | null;
      if (!response.ok || !value || "error" in value || !("importId" in value)) {
        throw new Error(value && "error" in value ? value.error ?? "Backup validation failed" : "Backup validation failed");
      }
      setStaged(value);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Backup validation failed");
    } finally {
      setImportBusy(false);
    }
  }

  async function applyImport() {
    if (!staged || confirmation !== "RESTORE" || !rollbackDownloaded) return;
    setImportBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-task-manager-action": "system-backup",
        },
        body: JSON.stringify({
          importId: staged.importId,
          sha256: staged.sha256,
          confirmation,
        }),
      });
      const value = await response.json().catch(() => null) as AppliedSystemBackup | { error?: string } | null;
      if (!response.ok || !value || "error" in value || !("applied" in value)) {
        throw new Error(value && "error" in value ? value.error ?? "System restore failed" : "System restore failed");
      }
      onApplied(value);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "System restore failed");
      setImportBusy(false);
    }
  }

  return (
    <Modal onClose={() => !busy && !downloadingCurrent && onClose()} className="system-import-modal">
      <DialogHeader title="Import system backup" icon={<Upload size={17} />} onClose={() => !busy && !downloadingCurrent && onClose()} />
      {!staged ? (
        <form onSubmit={validateFile}>
          <div className="system-import-body">
            <p>This replaces every user, identity, task, project, release, saved view, label, relation and access grant in this Site.</p>
            <label className="system-import-file">
              <span>Backup file</span>
              <input
                type="file"
                accept="application/json,.json"
                required
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setError("");
                }}
              />
              <small>Task Manager system backup, up to 10 MB.</small>
            </label>
            {error && <p className="system-import-error" role="alert">{error}</p>}
          </div>
          <div className="dialog-footer">
            <span>The live database is unchanged during validation</span>
            <button className="button primary" disabled={!file || busy}>{busy ? "Validating…" : "Validate backup"}</button>
          </div>
        </form>
      ) : (
        <div>
          <div className="system-import-body">
            <div className="system-import-valid"><Check size={15} /><span><b>Backup validated</b><small>Exported {longDateTime(staged.exportedAt)} · schema {staged.schemaVersion}</small></span></div>
            <dl className="system-import-counts">
              <div><dt>Users</dt><dd>{staged.counts.users}</dd></div>
              <div><dt>Tasks</dt><dd>{staged.counts.tasks}</dd></div>
              <div><dt>Projects</dt><dd>{staged.counts.projects}</dd></div>
              <div><dt>Releases</dt><dd>{staged.counts.releases}</dd></div>
              <div><dt>Saved views</dt><dd>{staged.counts.saved_views}</dd></div>
              <div><dt>Access grants</dt><dd>{staged.counts.access_grants}</dd></div>
            </dl>
            <div className="system-import-warning">
              <b>This operation cannot be undone in the app.</b>
              <span>Download the current state first. The replacement is atomic: either every table changes, or none do.</span>
            </div>
            <button
              className="button secondary system-import-download"
              type="button"
              disabled={busy || downloadingCurrent || rollbackDownloaded}
              onClick={() => {
                setDownloadingCurrent(true);
                setError("");
                void onDownloadCurrent().then((ok) => {
                  if (ok) setRollbackDownloaded(true);
                  else setError("Current backup download failed");
                  setDownloadingCurrent(false);
                });
              }}
            >
              {rollbackDownloaded ? <Check size={14} /> : <Download size={14} />}
              {rollbackDownloaded ? "Current backup downloaded" : downloadingCurrent ? "Downloading…" : "Download current backup"}
            </button>
            <label className="system-import-confirmation">
              <span>Type <b>RESTORE</b> to replace the live state</span>
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            {error && <p className="system-import-error" role="alert">{error}</p>}
          </div>
          <div className="dialog-footer">
            <button className="button ghost" type="button" disabled={busy} onClick={() => setStaged(null)}>Choose another file</button>
            <button className="button primary system-import-apply" type="button" disabled={busy || !rollbackDownloaded || confirmation !== "RESTORE"} onClick={() => void applyImport()}>{busy ? "Replacing…" : "Replace system state"}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function DialogHeader({ title, icon, onClose }: { title: string; icon: React.ReactNode; onClose: () => void }) { return <div className="dialog-header"><div>{icon}<h2>{title}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={15} /></button></div>; }
function DialogFooter({ busy, label, disabled }: { busy: boolean; label: string; disabled?: boolean }) { return <div className="dialog-footer"><span>Press Esc to close</span><button className="button primary" disabled={busy || disabled}>{busy ? "Saving…" : label}</button></div>; }
function Modal({ onClose, children, className = "" }: { onClose: () => void; children: React.ReactNode; className?: string }) { return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className={`modal ${className}`} role="dialog" aria-modal="true">{children}</div></div>; }

function ViewsSurface({ data, statusMap, onOpen }: { data: AppSnapshot; statusMap: Map<string, WorkflowStatusRecord>; onOpen: (surface: string, layout: Layout) => void }) { return <div className="entity-grid">{builtInViews.map((view) => <a className="entity-card" key={view.id} href={navigationPath({ surface: view.id, layout: "list", taskId: null }, data)} onClick={(event) => handleLocalLink(event, () => onOpen(view.id, "list"))}><div className="entity-icon"><Inbox size={18} /></div><div className="entity-card-copy"><div><h2>{view.label}</h2><span className="status-badge">Built-in</span></div><p>Workspace issue view</p><div className="progress-meta"><span>{taskCountForView(view.id, data, statusMap)} issues</span><span>List or board</span></div></div></a>)}{data.views.map((view) => <a className="entity-card" key={view.id} href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)} onClick={(event) => handleLocalLink(event, () => onOpen(`view:${view.id}`, view.display.layout))}><div className="entity-icon"><Zap size={18} /></div><div className="entity-card-copy"><div><h2>{view.name}</h2><span className="status-badge">Saved</span></div><p>{view.scopeProjectId ? "Project-scoped query" : "Workspace query"}</p><div className="progress-meta"><span>{view.display.layout}</span><span>Grouped by {view.display.groupBy}</span></div></div></a>)}</div>; }
function ProjectsSurface({ projects, tasks, statuses, onOpen, onCreate }: { projects: ProjectRecord[]; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; onOpen: (id: string) => void; onCreate: () => void }) { if (!projects.length) return <EmptyState entity="project" onCreate={onCreate} />; return <div className="entity-grid">{projects.map((project) => { const scoped = tasks.filter((task) => task.projectId === project.id && !task.archivedAt); const progress = completion(scoped, statuses); return <a className="entity-card" key={project.id} href={`/projects/${encodeURIComponent(project.publicId)}`} onClick={(event) => handleLocalLink(event, () => onOpen(project.id))}><div className="entity-icon" style={{ background: `${project.color}20`, color: project.color }}><FolderKanban size={18} /></div><div className="entity-card-copy"><div><h2>{project.name}</h2><span className="status-badge">{project.status}</span></div><p>{project.summary || "No summary yet"}</p><div className="progress-meta"><span>{scoped.length} tasks</span>{project.targetDate && <span>Target {shortDate(project.targetDate)}</span>}</div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><small>{progress}% complete</small></div></a>; })}</div>; }
function ReleasesSurface({ releases, projects, tasks, statuses, onOpen, onCreate }: { releases: ReleaseRecord[]; projects: Map<string, ProjectRecord>; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; onOpen: (id: string) => void; onCreate: () => void }) { if (!releases.length) return <EmptyState entity="release" onCreate={onCreate} />; return <div className="release-list">{releases.map((release) => { const scoped = tasks.filter((task) => task.releaseId === release.id && !task.archivedAt); const progress = completion(scoped, statuses); const project = projects.get(release.projectId); return <a className="release-row" key={release.id} href={project ? `/projects/${encodeURIComponent(project.publicId)}/releases/${encodeURIComponent(release.publicId)}` : "/releases"} onClick={(event) => handleLocalLink(event, () => onOpen(release.id))}><span className="release-icon"><Rocket size={16} /></span><span className="release-main"><b>{release.name}</b><small>{project?.name}</small></span><span className={`status-badge release-${release.status}`}>{release.status}</span><span className="release-progress"><i><em style={{ width: `${progress}%` }} /></i><small>{progress}%</small></span><span className="release-date">{release.targetDate ? shortDate(release.targetDate) : "No date"}</span></a>; })}</div>; }
function AdminSurface({ overview, timeZone }: { overview: AdminOverview; timeZone: string }) {
  return (
    <div className="admin-surface">
      <section className="admin-metrics" aria-label="System overview">
        <AdminMetric label="Registered users" value={overview.registeredUserCount} note="All accounts" icon={<UsersRound size={16} />} />
        <AdminMetric label="Active users" value={overview.activeUserCount} note="Last 7 days" icon={<Zap size={16} />} />
        <AdminMetric label="Tasks" value={overview.taskCount} note={`${overview.projectCount} projects`} icon={<Inbox size={16} />} />
        <AdminMetric label="Saved views" value={overview.viewCount} note={`${overview.releaseCount} releases`} icon={<Boxes size={16} />} />
      </section>
      <section className="admin-panel">
        <header>
          <div>
            <h2>Users</h2>
            <p>Last active reflects the latest authenticated request. Content activity is the latest owned record change. Times are shown in {timeZone}.</p>
          </div>
          <span className="status-badge">Live totals</span>
        </header>
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Registered</th>
                <th>Last active</th>
                <th>Content activity</th>
                <th>Tasks</th>
                <th>Projects</th>
                <th>Releases</th>
                <th>Views</th>
              </tr>
            </thead>
            <tbody>
              {overview.users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <span className="admin-user">
                      <span className="avatar">{initials(user.displayName)}</span>
                      <span><b>{user.displayName}</b><small>{user.email}</small></span>
                      {user.isAdmin && <span className="status-badge admin-badge">Admin</span>}
                    </span>
                  </td>
                  <td><time dateTime={user.registeredAt}>{zonedDateTime(user.registeredAt, timeZone)}</time></td>
                  <td><time dateTime={user.lastSeenAt}>{zonedDateTime(user.lastSeenAt, timeZone)}</time></td>
                  <td>{user.lastContentActivityAt ? <time dateTime={user.lastContentActivityAt}>{zonedDateTime(user.lastContentActivityAt, timeZone)}</time> : <span className="muted-value">—</span>}</td>
                  <td><span className="admin-task-count"><b>{user.taskCount}</b><small>{user.recentTaskCount} changed in 7d</small></span></td>
                  <td>{user.projectCount}</td>
                  <td>{user.releaseCount}</td>
                  <td>{user.viewCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
function AdminMetric({ label, value, note, icon }: { label: string; value: number; note: string; icon: React.ReactNode }) { return <article className="admin-metric"><span className="admin-metric-icon">{icon}</span><div><span>{label}</span><b>{value}</b><small>{note}</small></div></article>; }
function EmptyState({ entity = "task", onCreate }: { entity?: "task" | "project" | "release"; onCreate: () => void }) { const labels = { task: ["No tasks here", "Create the first task and give this view a starting point."], project: ["No projects yet", "Create a project to group work around an outcome."], release: ["No releases yet", "Create a release to plan what ships together."] }; return <div className="empty-state"><div className="empty-illustration"><span /><span /><span /></div><h2>{labels[entity][0]}</h2><p>{labels[entity][1]}</p><button className="button primary" onClick={onCreate}><Plus size={14} />Create {entity}</button></div>; }
function Peek({ task, status, project, onClose, onOpen }: { task: TaskRecord; status?: WorkflowStatusRecord; project?: ProjectRecord; onClose: () => void; onOpen: () => void }) { return <div className="peek"><header><span>{task.identifier}</span><div><a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)}>Open</a><button onClick={onClose}><X size={13} /></button></div></header><h2>{task.title}</h2><p>{task.description || "No description"}</p><footer>{status && <span><StatusIcon status={status} />{status.name}</span>}{project && <span><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}</footer></div>; }
function BulkBar({ count, statuses, archiveAction, onStatus, onPriority, onArchive, onClose }: { count: number; statuses: WorkflowStatusRecord[]; archiveAction: ReturnType<typeof resolveArchiveBulkAction>; onStatus: (value: string) => void; onPriority: (value: Priority) => void; onArchive: () => void; onClose: () => void }) { return <div className="bulk-bar"><b>{count} selected</b><select defaultValue="" onChange={(event) => event.target.value && onStatus(event.target.value)}><option value="" disabled>Status…</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select><select defaultValue="" onChange={(event) => event.target.value && onPriority(event.target.value as Priority)}><option value="" disabled>Priority…</option>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select><button onClick={onArchive}>{archiveAction.archived ? <Archive size={14} /> : <ArchiveRestore size={14} />}{archiveAction.label}</button><button onClick={onClose}><X size={14} /></button></div>; }

function handleLocalLink(event: ReactMouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  navigate();
}

function defaultLayoutForSurface(surface: string, data: AppSnapshot): Layout {
  if (!surface.startsWith("view:")) return "list";
  return data.views.find((view) => view.id === surface.slice(5))?.display.layout ?? "list";
}

function surfaceBreadcrumbs(
  surface: string,
  data: AppSnapshot,
  view?: SavedViewRecord,
): BreadcrumbItem[] {
  const workspace: BreadcrumbItem = {
    label: "Workspace",
    surface: "all",
    layout: "list",
  };
  const current = (label: string): BreadcrumbItem => ({ label });
  const ancestor = (label: string, ancestorSurface: string, layout: Layout = "list"): BreadcrumbItem => ({
    label,
    surface: ancestorSurface,
    layout,
  });

  if (surface === "admin") return [workspace, current("Administration")];
  if (surface === "views") return [workspace, current("Views")];
  if (surface === "projects") return [workspace, current("Projects")];
  if (surface === "releases") return [workspace, current("Releases")];
  if (surface === "shared") return [workspace, current("Shared with me")];

  if (surface.startsWith("view:")) {
    return [
      workspace,
      ancestor("Views", "views"),
      current(view?.name ?? "Saved view"),
    ];
  }

  if (surface.startsWith("project-releases:")) {
    const project = data.projects.find(
      (item) => item.id === surface.slice("project-releases:".length),
    );
    if (!project) return [workspace, ancestor("Projects", "projects"), current("Releases")];
    return [
      workspace,
      ancestor("Projects", "projects"),
      ancestor(project.name, `project:${project.id}`),
      current("Releases"),
    ];
  }

  if (surface.startsWith("project:")) {
    const project = data.projects.find((item) => item.id === surface.slice(8));
    return [
      workspace,
      ancestor("Projects", "projects"),
      current(project?.name ?? "Project"),
    ];
  }

  if (surface.startsWith("release:")) {
    const release = data.releases.find((item) => item.id === surface.slice(8));
    const project = release
      ? data.projects.find((item) => item.id === release.projectId)
      : undefined;
    if (!release || !project) {
      return [workspace, ancestor("Releases", "releases"), current(release?.name ?? "Release")];
    }
    return [
      workspace,
      ancestor("Projects", "projects"),
      ancestor(project.name, `project:${project.id}`),
      ancestor("Releases", `project-releases:${project.id}`),
      current(release.name),
    ];
  }

  const builtIn = builtInViews.find((item) => item.id === surface);
  return [workspace, current(builtIn?.label ?? "My tasks")];
}
function isCollectionSurface(surface: string) { return surface === "admin" || surface === "views" || surface === "projects" || surface === "releases" || surface.startsWith("project-releases:"); }
function shareTarget(surface: string, activeTask: TaskRecord | null, data: AppSnapshot) { if (activeTask) { if (activeTask.projectId) { const project = data.projects.find((item) => item.id === activeTask.projectId); return project ? { resourceType: "project" as const, resourceId: project.id, label: project.name } : null; } return { resourceType: "task" as const, resourceId: activeTask.id, label: activeTask.identifier }; } if (surface.startsWith("project:")) { const project = data.projects.find((item) => item.id === surface.slice(8)); return project ? { resourceType: "project" as const, resourceId: project.id, label: project.name } : null; } if (surface.startsWith("view:")) { const view = data.views.find((item) => item.id === surface.slice(5)); return view ? { resourceType: "saved_view" as const, resourceId: view.id, label: view.name } : null; } return null; }
function statusGroupsForTasks(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const owners = new Set(tasks.map((task) => task.ownerUserId)); return statuses.filter((status) => owners.has(status.ownerUserId) || tasks.length === 0).sort((a, b) => a.position - b.position); }
function sortTasks(tasks: TaskRecord[], display?: ViewDisplay) {
  const orderBy = display?.orderBy ?? "manual";
  const direction = display?.direction === "desc" ? -1 : 1;
  const priorityOrder: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  return [...tasks].sort((a, b) => {
    let comparison = 0;
    if (orderBy === "priority") comparison = priorityOrder[a.priority] - priorityOrder[b.priority];
    else if (orderBy === "created") comparison = a.createdAt.localeCompare(b.createdAt);
    else if (orderBy === "updated") comparison = a.updatedAt.localeCompare(b.updatedAt);
    else if (orderBy === "due") comparison = (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31");
    else if (orderBy === "title") comparison = a.title.localeCompare(b.title);
    else comparison = a.rank - b.rank;
    return comparison * direction || a.rank - b.rank;
  });
}
function relationLabel(type: "blocks" | "related" | "duplicate_of", direction: "in" | "out") { if (type === "blocks") return direction === "out" ? "Blocks" : "Blocked by"; if (type === "duplicate_of") return direction === "out" ? "Duplicate of" : "Duplicated by"; return "Related"; }
function displayLabel(value: string) { return value === "none" ? "No grouping" : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`; }
function taskCountForView(id: string, data: AppSnapshot, statusMap: Map<string, WorkflowStatusRecord>) { if (id === "archived") return data.tasks.filter((task) => task.archivedAt).length; if (id === "backlog") return data.tasks.filter((task) => !task.archivedAt && statusMap.get(task.statusId)?.category === "backlog").length; if (id === "active") return data.tasks.filter((task) => !task.archivedAt && ["unstarted", "started"].includes(statusMap.get(task.statusId)?.category ?? "")).length; return data.tasks.filter((task) => !task.archivedAt).length; }
function completion(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const statusMap = new Map(statuses.map((status) => [status.id, status])); const eligible = tasks.filter((task) => statusMap.get(task.statusId)?.category !== "canceled"); if (!eligible.length) return 0; return Math.round((eligible.filter((task) => statusMap.get(task.statusId)?.category === "completed").length / eligible.length) * 100); }
function toggleSet(current: Set<string>, value: string) { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }
function initials(value: string) { return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function shortDate(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`)); }
function longDate(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function longDateTime(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function zonedDateTime(value: string, timeZone: string) { try { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(value)); } catch { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(value)); } }
function isOverdue(value: string, category: string) { return new Date(`${value}T23:59:59`) < new Date() && category !== "completed" && category !== "canceled"; }
