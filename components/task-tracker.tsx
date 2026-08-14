"use client";

import {
  Archive,
  ArrowDownWideNarrow,
  Boxes,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  Circle,
  CircleDot,
  Columns3,
  FolderKanban,
  Inbox,
  LayoutList,
  Link2,
  ListFilter,
  LogOut,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rocket,
  Save,
  Search,
  Share2,
  SlidersHorizontal,
  Sun,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppSnapshot,
  Priority,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  TaskRecord,
  ViewDisplay,
  ViewQuery,
  WorkflowStatusRecord,
} from "@/lib/types";

type Layout = "list" | "board";
type Dialog = "task" | "project" | "release" | "view" | "share" | null;

const priorityMeta: Record<Priority, { label: string; glyph: string }> = {
  urgent: { label: "Urgent", glyph: "!!!" },
  high: { label: "High", glyph: "▥" },
  medium: { label: "Medium", glyph: "▤" },
  low: { label: "Low", glyph: "▂" },
  none: { label: "No priority", glyph: "—" },
};

const builtInViews = [
  { id: "all", label: "All tasks" },
  { id: "active", label: "Active" },
  { id: "backlog", label: "Backlog" },
  { id: "archived", label: "Archived" },
];

export function TaskTracker({
  initialData,
  signOutPath,
}: {
  initialData: AppSnapshot;
  signOutPath: string;
}) {
  const [data, setData] = useState(initialData);
  const [surface, setSurface] = useState("all");
  const [layout, setLayout] = useState<Layout>("list");
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "all">("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [peekTaskId, setPeekTaskId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [highlighted, setHighlighted] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const searchRef = useRef<HTMLInputElement>(null);

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
    if (query.releaseId !== undefined) {
      tasks = tasks.filter((task) => task.releaseId === query.releaseId);
    }
    if (query.statusIds?.length) {
      tasks = tasks.filter((task) => query.statusIds?.includes(task.statusId));
    }
    if (query.priorities?.length) {
      tasks = tasks.filter((task) => query.priorities?.includes(task.priority));
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
    return [...tasks].sort((a, b) => a.rank - b.rank);
  }, [
    activeSavedView,
    data.tasks,
    data.user.id,
    priorityFilter,
    search,
    statusFilter,
    statusMap,
    surface,
  ]);

  const title = surfaceTitle(surface, data, activeSavedView);
  const activeTask = data.tasks.find((task) => task.id === activeTaskId) ?? null;
  const peekTask = data.tasks.find((task) => task.id === peekTaskId) ?? null;
  const contextProject = surface.startsWith("project:") ? surface.slice(8) : null;
  const contextRelease = surface.startsWith("release:") ? surface.slice(8) : null;

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

  function openCreate(statusId?: string) {
    setDialog("task");
    if (statusId) window.sessionStorage.setItem("tm-create-status", statusId);
    else window.sessionStorage.removeItem("tm-create-status");
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
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      if (event.key === "Escape") {
        if (dialog) setDialog(null);
        else if (activeTaskId) setActiveTaskId(null);
        else if (peekTaskId) setPeekTaskId(null);
        else if (selected.size) setSelected(new Set());
        return;
      }
      if (typing) return;
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
        setSidebarCollapsed((value) => !value);
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
  }, [activeTaskId, dialog, highlighted, peekTaskId, selected.size, visibleTasks]);

  useEffect(() => {
    // Navigation changes deliberately reset ephemeral list state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlighted(0);
    setSelected(new Set());
  }, [surface, search, priorityFilter, statusFilter]);

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <button className="workspace-switcher" title="Workspace">
            <span className="product-mark">T</span>
            {!sidebarCollapsed && <span className="workspace-name">Task Manager</span>}
            {!sidebarCollapsed && <ChevronDown size={13} />}
          </button>
          {!sidebarCollapsed && (
            <button className="icon-button" onClick={() => openCreate()} title="Create task (C)">
              <Plus size={15} />
            </button>
          )}
        </div>
        {!sidebarCollapsed && (
          <button className="sidebar-search" onClick={() => searchRef.current?.focus()}>
            <Search size={14} /><span>Search</span><kbd>/</kbd>
          </button>
        )}
        <nav className="nav-scroll" aria-label="Workspace">
          <NavItem compact={sidebarCollapsed} icon={<Inbox size={15} />} label="My tasks" active={builtInViews.some((view) => view.id === surface)} onClick={() => setSurface("all")} />
          <NavItem compact={sidebarCollapsed} icon={<UsersRound size={15} />} label="Shared with me" active={surface === "shared"} onClick={() => setSurface("shared")} />

          {!sidebarCollapsed && (
            <>
              <SidebarSection title="Views" action={() => setDialog("view")}>
                {builtInViews.map((view) => (
                  <NavItem key={view.id} compact={false} icon={<Circle size={9} />} label={view.label} active={surface === view.id} onClick={() => setSurface(view.id)} count={taskCountForView(view.id, data, statusMap)} />
                ))}
                {data.views.map((view) => (
                  <NavItem key={view.id} compact={false} icon={<Zap size={13} />} label={view.name} active={surface === `view:${view.id}`} onClick={() => { setSurface(`view:${view.id}`); setLayout(view.display.layout); }} />
                ))}
              </SidebarSection>
              <SidebarSection title="Projects" action={() => setDialog("project")}>
                <NavItem compact={false} icon={<Boxes size={13} />} label="All projects" active={surface === "projects"} onClick={() => setSurface("projects")} />
                {data.projects.map((project) => (
                  <NavItem key={project.id} compact={false} icon={<span className="project-dot" style={{ background: project.color }} />} label={project.name} active={surface === `project:${project.id}`} onClick={() => setSurface(`project:${project.id}`)} />
                ))}
              </SidebarSection>
              <SidebarSection title="Releases" action={() => setDialog("release")}>
                <NavItem compact={false} icon={<Rocket size={13} />} label="All releases" active={surface === "releases"} onClick={() => setSurface("releases")} />
                {data.releases.slice(0, 6).map((release) => (
                  <NavItem key={release.id} compact={false} icon={<CircleDot size={12} />} label={release.name} active={surface === `release:${release.id}`} onClick={() => setSurface(`release:${release.id}`)} />
                ))}
              </SidebarSection>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <button className="nav-item" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle theme">
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            {!sidebarCollapsed && <span>{theme === "dark" ? "Light theme" : "Dark theme"}</span>}
          </button>
          <a className="nav-item" href={signOutPath} title="Sign out">
            <span className="avatar small">{initials(data.user.displayName)}</span>
            {!sidebarCollapsed && <span className="profile-label"><b>{data.user.displayName}</b><small>{data.user.email}</small></span>}
            {!sidebarCollapsed && <LogOut size={13} className="nav-trailing" />}
          </a>
        </div>
      </aside>

      <section className="main-surface">
        <header className="surface-header">
          <div className="title-row">
            <div className="title-cluster">
              <button className="icon-button mobile-menu" onClick={() => setSidebarCollapsed((value) => !value)} title="Toggle sidebar">
                {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>
              <span className="breadcrumb">Workspace</span><ChevronLeft size={12} className="breadcrumb-chevron" />
              <h1>{title}</h1>
              <span className="count-pill">{visibleTasks.length}</span>
            </div>
            <div className="title-actions">
              {shareTarget(surface, activeTask, data) && <button className="button ghost" onClick={() => setDialog("share")}><Share2 size={14} />Share</button>}
              <button className="icon-button" title="More actions"><MoreHorizontal size={16} /></button>
            </div>
          </div>
          {!isCollectionSurface(surface) && (
            <div className="toolbar-row">
              <div className="toolbar-left">
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
                  <button className={layout === "list" ? "active" : ""} onClick={() => setLayout("list")} title="List"><LayoutList size={14} /></button>
                  <button className={layout === "board" ? "active" : ""} onClick={() => setLayout("board")} title="Board"><Columns3 size={14} /></button>
                </div>
                <div className="popover-anchor display-anchor">
                  <button className={`button ghost ${displayOpen ? "active" : ""}`} onClick={() => setDisplayOpen((value) => !value)}><SlidersHorizontal size={14} />Display</button>
                  {displayOpen && <DisplayPopover layout={layout} onLayout={setLayout} onClose={() => setDisplayOpen(false)} />}
                </div>
                {(search || priorityFilter !== "all" || statusFilter !== "all") && <button className="button ghost save-view" onClick={() => setDialog("view")}><Save size={13} />Save view</button>}
              </div>
              <button className="button primary" onClick={() => openCreate()}><Plus size={14} />New task</button>
            </div>
          )}
        </header>

        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")}><X size={14} /></button></div>}
        {busy && <div className="progress-line" aria-label="Saving" />}

        {surface === "projects" ? (
          <ProjectsSurface projects={data.projects} tasks={data.tasks} statuses={data.statuses} onOpen={(id) => setSurface(`project:${id}`)} onCreate={() => setDialog("project")} />
        ) : surface === "releases" ? (
          <ReleasesSurface releases={data.releases} projects={projectMap} tasks={data.tasks} statuses={data.statuses} onOpen={(id) => setSurface(`release:${id}`)} onCreate={() => setDialog("release")} />
        ) : layout === "board" ? (
          <TaskBoard tasks={visibleTasks} statuses={statusGroupsForTasks(visibleTasks, data.statuses)} projects={projectMap} releases={releaseMap} selected={selected} onSelect={toggleSelection} onOpen={setActiveTaskId} onCreate={openCreate} onMove={async (task, statusId, rank) => mutate(`/api/tasks/${task.id}`, "PATCH", { version: task.version, statusId, rank })} />
        ) : (
          <TaskList tasks={visibleTasks} statuses={statusGroupsForTasks(visibleTasks, data.statuses)} projects={projectMap} releases={releaseMap} selected={selected} highlighted={highlighted} collapsed={collapsedGroups} onToggleGroup={(id) => setCollapsedGroups((current) => toggleSet(current, id))} onSelect={toggleSelection} onHighlight={setHighlighted} onOpen={setActiveTaskId} onPeek={setPeekTaskId} onCreate={openCreate} />
        )}
      </section>

      {selected.size > 0 && (
        <BulkBar count={selected.size} statuses={statusGroupsForTasks([...selected].map((id) => data.tasks.find((task) => task.id === id)).filter(Boolean) as TaskRecord[], data.statuses)} onStatus={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], field: "statusId", value }).then((ok) => ok && setSelected(new Set()))} onPriority={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], field: "priority", value }).then((ok) => ok && setSelected(new Set()))} onArchive={() => mutate("/api/tasks/bulk", "POST", { ids: [...selected], field: "archived", value: true }).then((ok) => ok && setSelected(new Set()))} onClose={() => setSelected(new Set())} />
      )}

      {activeTask && <TaskDetails task={activeTask} data={data} onClose={() => setActiveTaskId(null)} onSave={async (changes) => mutate(`/api/tasks/${activeTask.id}`, "PATCH", { version: activeTask.version, ...changes })} onShare={() => setDialog("share")} busy={busy} />}
      {peekTask && <Peek task={peekTask} status={statusMap.get(peekTask.statusId)} project={peekTask.projectId ? projectMap.get(peekTask.projectId) : undefined} onClose={() => setPeekTaskId(null)} onOpen={() => { setActiveTaskId(peekTask.id); setPeekTaskId(null); }} />}
      {dialog === "task" && <TaskComposer data={data} contextProject={contextProject} contextRelease={contextRelease} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/tasks", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "project" && <EntityDialog title="Create project" icon={<FolderKanban size={17} />} fields={[{ name: "name", label: "Project name", required: true }, { name: "summary", label: "Short summary" }, { name: "targetDate", label: "Target date", type: "date" }]} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/projects", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "release" && <ReleaseDialog projects={data.projects} initialProjectId={contextProject} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/releases", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "view" && <ViewDialog search={search} status={statusFilter} priority={priorityFilter} layout={layout} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/views", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "share" && <ShareDialog target={shareTarget(surface, activeTask, data)} collaborators={data.collaborators} onClose={() => setDialog(null)} onShare={(input) => mutate("/api/shares", "POST", input)} onRevoke={(grantId) => mutate("/api/shares", "DELETE", { grantId })} busy={busy} />}
    </main>
  );
}

function NavItem({ compact, icon, label, active, onClick, count }: { compact: boolean; icon: React.ReactNode; label: string; active: boolean; onClick: () => void; count?: number }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick} title={compact ? label : undefined}><span className="nav-icon">{icon}</span>{!compact && <><span>{label}</span>{count !== undefined && <small className="nav-count">{count}</small>}</>}</button>;
}

function SidebarSection({ title, action, children }: { title: string; action: () => void; children: React.ReactNode }) {
  return <section className="sidebar-section"><div className="section-label"><span>{title}</span><button onClick={action} title={`Add ${title.toLowerCase()}`}><Plus size={12} /></button></div>{children}</section>;
}

function TaskList({ tasks, statuses, projects, releases, selected, highlighted, collapsed, onToggleGroup, onSelect, onHighlight, onOpen, onPeek, onCreate }: { tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; projects: Map<string, ProjectRecord>; releases: Map<string, ReleaseRecord>; selected: Set<string>; highlighted: number; collapsed: Set<string>; onToggleGroup: (id: string) => void; onSelect: (id: string) => void; onHighlight: (index: number) => void; onOpen: (id: string) => void; onPeek: (id: string) => void; onCreate: (statusId?: string) => void }) {
  if (!tasks.length) return <EmptyState onCreate={() => onCreate()} />;
  let flatIndex = -1;
  return <div className="task-list">{statuses.map((status) => {
    const groupTasks = tasks.filter((task) => task.statusId === status.id);
    if (!groupTasks.length) return null;
    const isCollapsed = collapsed.has(status.id);
    return <section className="task-group" key={status.id}><div className="group-header"><button className="group-title" onClick={() => onToggleGroup(status.id)}><ChevronDown size={13} className={isCollapsed ? "rotated" : ""} /><StatusIcon status={status} /><span>{status.name}</span><small>{groupTasks.length}</small></button><button className="icon-button quiet" onClick={() => onCreate(status.id)} title={`Add to ${status.name}`}><Plus size={13} /></button></div>{!isCollapsed && groupTasks.map((task) => { flatIndex += 1; const index = flatIndex; return <TaskRow key={task.id} task={task} status={status} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} selected={selected.has(task.id)} highlighted={highlighted === index} onSelect={() => onSelect(task.id)} onHighlight={() => onHighlight(index)} onOpen={() => onOpen(task.id)} onPeek={() => onPeek(task.id)} />; })}</section>;
  })}</div>;
}

function TaskRow({ task, status, project, release, selected, highlighted, onSelect, onHighlight, onOpen, onPeek }: { task: TaskRecord; status: WorkflowStatusRecord; project?: ProjectRecord; release?: ReleaseRecord; selected: boolean; highlighted: boolean; onSelect: () => void; onHighlight: () => void; onOpen: () => void; onPeek: () => void }) {
  return <div className={`task-row ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""}`} onMouseEnter={onHighlight} onDoubleClick={onPeek}><button className={`row-check ${selected ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); onSelect(); }} aria-label={selected ? "Deselect task" : "Select task"}>{selected ? <Check size={12} /> : <span />}</button><span className={`priority priority-${task.priority}`} title={priorityMeta[task.priority].label}>{priorityMeta[task.priority].glyph}</span><button className="task-identity" onClick={onOpen}>{task.identifier}</button><button className="task-title" onClick={onOpen} title={task.title}>{task.title}</button><div className="row-metadata">{project && <span className="metadata-chip"><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}{release && <span className="metadata-chip"><Rocket size={12} />{release.name}</span>}{task.dueDate && <span className={`metadata-chip ${isOverdue(task.dueDate, status.category) ? "overdue" : ""}`}><CalendarDays size={12} />{shortDate(task.dueDate)}</span>}<span className="avatar" title="Assignee">{initials("Me")}</span><button className="row-more" title="More"><MoreHorizontal size={14} /></button></div></div>;
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

function TaskDetails({ task, data, onClose, onSave, onShare, busy }: { task: TaskRecord; data: AppSnapshot; onClose: () => void; onSave: (input: Record<string, unknown>) => Promise<unknown>; onShare: () => void; busy: boolean }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const statuses = data.statuses.filter((status) => status.ownerUserId === task.ownerUserId);
  const projects = data.projects.filter((project) => project.ownerUserId === task.ownerUserId);
  return <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="details-panel"><header><div className="details-crumb"><span>{task.identifier}</span><button title="Copy link" onClick={() => void navigator.clipboard.writeText(window.location.href)}><Link2 size={13} /></button></div><div><button className="button ghost" onClick={onShare}><Share2 size={13} />Share</button><button className="icon-button" onClick={onClose}><X size={16} /></button></div></header><div className="details-body"><input className="details-title" value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => title.trim() && title !== task.title && void onSave({ title })} /><textarea className="details-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add description…" rows={8} /><button className="button secondary save-description" disabled={busy || description === task.description} onClick={() => void onSave({ description })}>{busy ? "Saving…" : "Save description"}</button><div className="properties-grid"><PropertyRow label="Status" icon={<CircleDot size={14} />}><select value={task.statusId} onChange={(event) => void onSave({ statusId: event.target.value })}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></PropertyRow><PropertyRow label="Priority" icon={<ArrowDownWideNarrow size={14} />}><select value={task.priority} onChange={(event) => void onSave({ priority: event.target.value })}>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></PropertyRow><PropertyRow label="Project" icon={<FolderKanban size={14} />}><select value={task.projectId ?? ""} onChange={(event) => void onSave({ projectId: event.target.value || null })}><option value="">No project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></PropertyRow><PropertyRow label="Release" icon={<Rocket size={14} />}><select value={task.releaseId ?? ""} onChange={(event) => void onSave({ releaseId: event.target.value || null })} disabled={!task.projectId}><option value="">No release</option>{data.releases.filter((release) => release.projectId === task.projectId).map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</select></PropertyRow><PropertyRow label="Due date" icon={<CalendarDays size={14} />}><input type="date" value={task.dueDate ?? ""} onChange={(event) => void onSave({ dueDate: event.target.value || null })} /></PropertyRow><PropertyRow label="Estimate" icon={<Zap size={14} />}><input type="number" min="0" max="100" value={task.estimate ?? ""} placeholder="No estimate" onBlur={(event) => void onSave({ estimate: event.target.value || null })} /></PropertyRow></div><div className="timestamps"><span>Created {longDate(task.createdAt)}</span><span>Updated {longDate(task.updatedAt)}</span>{task.completedAt && <span>Completed {longDate(task.completedAt)}</span>}</div><button className="button danger ghost archive-action" onClick={() => { void onSave({ archived: !task.archivedAt }); onClose(); }}><Archive size={14} />{task.archivedAt ? "Restore task" : "Archive task"}</button></div></aside></div>;
}

function PropertyRow({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) { return <label className="property-row"><span>{icon}{label}</span>{children}</label>; }
function PropertySelect({ icon, value, onChange, children, disabled }: { icon: React.ReactNode; value: string; onChange: (value: string) => void; children: React.ReactNode; disabled?: boolean }) { return <label className="property-select">{icon}<select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>{children}</select><ChevronDown size={11} /></label>; }

function FilterPopover({ statuses, priority, status, onPriority, onStatus, onClose }: { statuses: WorkflowStatusRecord[]; priority: Priority | "all"; status: string; onPriority: (value: Priority | "all") => void; onStatus: (value: string) => void; onClose: () => void }) { return <Popover title="Filter" onClose={onClose}><label className="popover-field"><span>Status</span><select value={status} onChange={(event) => onStatus(event.target.value)}><option value="all">Any status</option>{statuses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="popover-field"><span>Priority</span><select value={priority} onChange={(event) => onPriority(event.target.value as Priority | "all")}><option value="all">Any priority</option>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></label><button className="button ghost popover-clear" onClick={() => { onPriority("all"); onStatus("all"); }}>Clear filters</button></Popover>; }
function DisplayPopover({ layout, onLayout, onClose }: { layout: Layout; onLayout: (value: Layout) => void; onClose: () => void }) { return <Popover title="Display" onClose={onClose}><div className="display-option"><span>Layout</span><div className="segmented wide"><button className={layout === "list" ? "active" : ""} onClick={() => onLayout("list")}><LayoutList size={13} />List</button><button className={layout === "board" ? "active" : ""} onClick={() => onLayout("board")}><Columns3 size={13} />Board</button></div></div><div className="display-static"><span>Group by</span><b>Status</b></div><div className="display-static"><span>Order</span><b>Manual</b></div></Popover>; }
function Popover({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="popover"><header><b>{title}</b><button onClick={onClose}><X size={13} /></button></header>{children}</div>; }

function EntityDialog({ title, icon, fields, onClose, onSubmit, busy }: { title: string; icon: React.ReactNode; fields: Array<{ name: string; label: string; type?: string; required?: boolean }>; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; busy: boolean }) { return <Modal onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void onSubmit(Object.fromEntries(new FormData(event.currentTarget))); }}><DialogHeader title={title} icon={icon} onClose={onClose} /><div className="form-stack">{fields.map((field) => <label key={field.name}><span>{field.label}</span><input name={field.name} type={field.type ?? "text"} required={field.required} autoFocus={field === fields[0]} /></label>)}</div><DialogFooter busy={busy} label="Create" /></form></Modal>; }
function ReleaseDialog({ projects, initialProjectId, onClose, onSubmit, busy }: { projects: ProjectRecord[]; initialProjectId: string | null; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; busy: boolean }) { return <Modal onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void onSubmit(Object.fromEntries(new FormData(event.currentTarget))); }}><DialogHeader title="Create release" icon={<Rocket size={17} />} onClose={onClose} /><div className="form-stack"><label><span>Release name</span><input name="name" required autoFocus placeholder="v1.0" /></label><label><span>Project</span><select name="projectId" required defaultValue={initialProjectId ?? ""}><option value="" disabled>Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label><span>Target date</span><input name="targetDate" type="date" /></label></div>{!projects.length && <p className="inline-note">Create a project before adding a release.</p>}<DialogFooter busy={busy} label="Create release" disabled={!projects.length} /></form></Modal>; }
function ViewDialog({ search, status, priority, layout, onClose, onSubmit, busy }: { search: string; status: string; priority: Priority | "all"; layout: Layout; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; busy: boolean }) { const query: ViewQuery = { ...(search && { search }), ...(status !== "all" && { statusIds: [status] }), ...(priority !== "all" && { priorities: [priority] }) }; const display: ViewDisplay = { layout, groupBy: "status", orderBy: "manual", direction: "asc", showEmptyGroups: true, visibleFields: ["priority", "project", "release", "dueDate", "assignee"] }; return <Modal onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void onSubmit({ name: values.name, query, display }); }}><DialogHeader title="Save as view" icon={<Zap size={17} />} onClose={onClose} /><div className="form-stack"><label><span>View name</span><input name="name" required autoFocus placeholder="e.g. Upcoming launch" /></label></div><div className="view-summary"><span>{layout === "list" ? "List" : "Board"}</span><span>{Object.keys(query).length || "No"} active filters</span></div><DialogFooter busy={busy} label="Save view" /></form></Modal>; }

function ShareDialog({ target, collaborators, onClose, onShare, onRevoke, busy }: { target: { resourceType: "project" | "task" | "saved_view"; resourceId: string; label: string } | null; collaborators: AppSnapshot["collaborators"]; onClose: () => void; onShare: (input: Record<string, unknown>) => Promise<boolean>; onRevoke: (grantId: string) => Promise<boolean>; busy: boolean }) { if (!target) return null; const grants = collaborators.filter((grant) => grant.resourceType === target.resourceType && grant.resourceId === target.resourceId); return <Modal onClose={onClose}><form onSubmit={async (event) => { event.preventDefault(); const email = String(new FormData(event.currentTarget).get("email") ?? ""); const ok = await onShare({ ...target, email }); if (ok) event.currentTarget.reset(); }}><DialogHeader title={`Share ${target.label}`} icon={<Share2 size={17} />} onClose={onClose} /><p className="dialog-copy">People you add get full access. They must have signed in once with their verified email.</p><div className="share-input"><input name="email" type="email" required placeholder="name@example.com" autoFocus /><button className="button primary" disabled={busy}>{busy ? "Adding…" : "Add"}</button></div><div className="access-list"><div className="access-row"><span className="avatar">{initials("You")}</span><span><b>You</b><small>Owner</small></span><em>Full access</em></div>{grants.map((grant) => <div className="access-row" key={grant.grantId}><span className="avatar">{initials(grant.displayName)}</span><span><b>{grant.displayName}</b><small>{grant.email}</small></span><button type="button" onClick={() => void onRevoke(grant.grantId)}>Remove</button></div>)}</div></form></Modal>; }

function DialogHeader({ title, icon, onClose }: { title: string; icon: React.ReactNode; onClose: () => void }) { return <div className="dialog-header"><div>{icon}<h2>{title}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={15} /></button></div>; }
function DialogFooter({ busy, label, disabled }: { busy: boolean; label: string; disabled?: boolean }) { return <div className="dialog-footer"><span>Press Esc to close</span><button className="button primary" disabled={busy || disabled}>{busy ? "Saving…" : label}</button></div>; }
function Modal({ onClose, children, className = "" }: { onClose: () => void; children: React.ReactNode; className?: string }) { return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className={`modal ${className}`} role="dialog" aria-modal="true">{children}</div></div>; }

function ProjectsSurface({ projects, tasks, statuses, onOpen, onCreate }: { projects: ProjectRecord[]; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; onOpen: (id: string) => void; onCreate: () => void }) { if (!projects.length) return <EmptyState entity="project" onCreate={onCreate} />; return <div className="entity-grid">{projects.map((project) => { const scoped = tasks.filter((task) => task.projectId === project.id && !task.archivedAt); const progress = completion(scoped, statuses); return <button className="entity-card" key={project.id} onClick={() => onOpen(project.id)}><div className="entity-icon" style={{ background: `${project.color}20`, color: project.color }}><FolderKanban size={18} /></div><div className="entity-card-copy"><div><h2>{project.name}</h2><span className="status-badge">{project.status}</span></div><p>{project.summary || "No summary yet"}</p><div className="progress-meta"><span>{scoped.length} tasks</span>{project.targetDate && <span>Target {shortDate(project.targetDate)}</span>}</div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><small>{progress}% complete</small></div></button>; })}</div>; }
function ReleasesSurface({ releases, projects, tasks, statuses, onOpen, onCreate }: { releases: ReleaseRecord[]; projects: Map<string, ProjectRecord>; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; onOpen: (id: string) => void; onCreate: () => void }) { if (!releases.length) return <EmptyState entity="release" onCreate={onCreate} />; return <div className="release-list">{releases.map((release) => { const scoped = tasks.filter((task) => task.releaseId === release.id && !task.archivedAt); const progress = completion(scoped, statuses); return <button className="release-row" key={release.id} onClick={() => onOpen(release.id)}><span className="release-icon"><Rocket size={16} /></span><span className="release-main"><b>{release.name}</b><small>{projects.get(release.projectId)?.name}</small></span><span className={`status-badge release-${release.status}`}>{release.status}</span><span className="release-progress"><i><em style={{ width: `${progress}%` }} /></i><small>{progress}%</small></span><span className="release-date">{release.targetDate ? shortDate(release.targetDate) : "No date"}</span></button>; })}</div>; }
function EmptyState({ entity = "task", onCreate }: { entity?: "task" | "project" | "release"; onCreate: () => void }) { const labels = { task: ["No tasks here", "Create the first task and give this view a starting point."], project: ["No projects yet", "Create a project to group work around an outcome."], release: ["No releases yet", "Create a release to plan what ships together."] }; return <div className="empty-state"><div className="empty-illustration"><span /><span /><span /></div><h2>{labels[entity][0]}</h2><p>{labels[entity][1]}</p><button className="button primary" onClick={onCreate}><Plus size={14} />Create {entity}</button></div>; }
function Peek({ task, status, project, onClose, onOpen }: { task: TaskRecord; status?: WorkflowStatusRecord; project?: ProjectRecord; onClose: () => void; onOpen: () => void }) { return <div className="peek"><header><span>{task.identifier}</span><div><button onClick={onOpen}>Open</button><button onClick={onClose}><X size={13} /></button></div></header><h2>{task.title}</h2><p>{task.description || "No description"}</p><footer>{status && <span><StatusIcon status={status} />{status.name}</span>}{project && <span><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}</footer></div>; }
function BulkBar({ count, statuses, onStatus, onPriority, onArchive, onClose }: { count: number; statuses: WorkflowStatusRecord[]; onStatus: (value: string) => void; onPriority: (value: Priority) => void; onArchive: () => void; onClose: () => void }) { return <div className="bulk-bar"><b>{count} selected</b><select defaultValue="" onChange={(event) => event.target.value && onStatus(event.target.value)}><option value="" disabled>Status…</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select><select defaultValue="" onChange={(event) => event.target.value && onPriority(event.target.value as Priority)}><option value="" disabled>Priority…</option>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select><button onClick={onArchive}><Archive size={14} />Archive</button><button onClick={onClose}><X size={14} /></button></div>; }

function surfaceTitle(surface: string, data: AppSnapshot, view?: SavedViewRecord) { if (surface === "projects") return "Projects"; if (surface === "releases") return "Releases"; if (surface === "shared") return "Shared with me"; if (surface.startsWith("project:")) return data.projects.find((project) => project.id === surface.slice(8))?.name ?? "Project"; if (surface.startsWith("release:")) return data.releases.find((release) => release.id === surface.slice(8))?.name ?? "Release"; if (view) return view.name; return builtInViews.find((item) => item.id === surface)?.label ?? "My tasks"; }
function isCollectionSurface(surface: string) { return surface === "projects" || surface === "releases"; }
function shareTarget(surface: string, activeTask: TaskRecord | null, data: AppSnapshot) { if (activeTask) { if (activeTask.projectId) { const project = data.projects.find((item) => item.id === activeTask.projectId); return project ? { resourceType: "project" as const, resourceId: project.id, label: project.name } : null; } return { resourceType: "task" as const, resourceId: activeTask.id, label: activeTask.identifier }; } if (surface.startsWith("project:")) { const project = data.projects.find((item) => item.id === surface.slice(8)); return project ? { resourceType: "project" as const, resourceId: project.id, label: project.name } : null; } if (surface.startsWith("view:")) { const view = data.views.find((item) => item.id === surface.slice(5)); return view ? { resourceType: "saved_view" as const, resourceId: view.id, label: view.name } : null; } return null; }
function statusGroupsForTasks(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const owners = new Set(tasks.map((task) => task.ownerUserId)); return statuses.filter((status) => owners.has(status.ownerUserId) || tasks.length === 0).sort((a, b) => a.position - b.position); }
function taskCountForView(id: string, data: AppSnapshot, statusMap: Map<string, WorkflowStatusRecord>) { if (id === "archived") return data.tasks.filter((task) => task.archivedAt).length; if (id === "backlog") return data.tasks.filter((task) => !task.archivedAt && statusMap.get(task.statusId)?.category === "backlog").length; if (id === "active") return data.tasks.filter((task) => !task.archivedAt && ["unstarted", "started"].includes(statusMap.get(task.statusId)?.category ?? "")).length; return data.tasks.filter((task) => !task.archivedAt).length; }
function completion(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const statusMap = new Map(statuses.map((status) => [status.id, status])); const eligible = tasks.filter((task) => statusMap.get(task.statusId)?.category !== "canceled"); if (!eligible.length) return 0; return Math.round((eligible.filter((task) => statusMap.get(task.statusId)?.category === "completed").length / eligible.length) * 100); }
function toggleSet(current: Set<string>, value: string) { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }
function initials(value: string) { return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function shortDate(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`)); }
function longDate(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function isOverdue(value: string, category: string) { return new Date(`${value}T23:59:59`) < new Date() && category !== "completed" && category !== "canceled"; }
