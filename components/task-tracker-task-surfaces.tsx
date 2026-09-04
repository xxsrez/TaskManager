"use client";

import {
PriorityIcon,
canStartPullRefresh,
pullRefreshDistance,
shouldTriggerPullRefresh,
taskRowReorderDirection,
type TaskCreateDefaults
} from "@/components/task-tracker-state";
import {
canEditContent,
} from "@/lib/access";
import {
taskPath,
} from "@/lib/navigation";
import {
canMoveTaskToGroup,
keyboardReorderNeighbors,
reorderInsertionNeighbors,
taskGroupCreateDefaults,
type TaskGroup,
} from "@/lib/task-groups";
import type {
AppSnapshot,
LabelRecord,
ProjectRecord,
ReleaseRecord,
SavedViewRecord,
TaskRecord,
UserRecord,
ViewDisplay,
WorkflowStatusRecord
} from "@/lib/types";
import {
CalendarDays,
Check,
ChevronDown,
Circle,
Copy,
LayoutList,
MoreHorizontal,
Plus,
Rocket,
UsersRound,
X,
Zap
} from "lucide-react";
import {
TouchEvent as ReactTouchEvent,
useMemo,
useRef,
useState
} from "react";

import {
displayLabel,
handleLocalLink,
initials,
isOverdue,
shortDate
} from "@/components/task-tracker-dialogs";

import {
EMPTY_TASK_HIERARCHY_SUMMARY,
EmptyState,
LabelChip,
TaskHierarchyChip,
buildTaskHierarchySummaries,
labelsForTask,
type TaskHierarchySummary,
} from "@/components/task-tracker-task-primitives";

export function NavItem({ compact, icon, label, active, href, onNavigate, count }: { compact: boolean; icon: React.ReactNode; label: string; active: boolean; href: string; onNavigate: () => void; count?: number }) {
  return <a className={`nav-item ${active ? "active" : ""}`} href={href} aria-current={active ? "page" : undefined} aria-label={label} onClick={(event) => handleLocalLink(event, onNavigate)} title={label}><span className="nav-icon">{icon}</span>{!compact && <><span className="nav-label">{label}</span>{count !== undefined && <small className="nav-count">{count}</small>}</>}</a>;
}

export function SidebarSavedViewItem({ view, active, href, onNavigate, onContextActions }: {
  view: SavedViewRecord;
  active: boolean;
  href: string;
  onNavigate: () => void;
  onContextActions: (x: number, y: number, restoreFocus: HTMLElement | null) => void;
}) {
  const editable = canEditContent(view.accessRole);
  return <div className="sidebar-saved-view-item">
    <NavItem compact={false} icon={<Zap size={13} />} label={view.name} active={active} href={href} onNavigate={onNavigate} />
    {editable && <button type="button" aria-label={`Open actions for ${view.name}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onContextActions(rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={14} /></button>}
  </div>;
}

export function WorkspaceScopeSelector({ value, options, busy, onChange }: {
  value: string;
  options: NonNullable<AppSnapshot["workspaceScope"]>["options"];
  busy: boolean;
  onChange: (token: string) => void;
}) {
  return (
    <label className="workspace-scope-selector">
      <UsersRound size={14} aria-hidden="true" />
      <span>Workspace focus</span>
      <select
        value={value}
        disabled={busy}
        aria-label="Workspace focus"
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.token} value={option.token}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function SidebarSection({ title, action, children }: { title: string; action: () => void; children: React.ReactNode }) {
  return <section className="sidebar-section"><div className="section-label"><span>{title}</span><button onClick={action} title={`Add ${title.toLowerCase()}`}><Plus size={12} /></button></div>{children}</section>;
}

export function TaskList({ tasks, hierarchyTasks, groups, statuses, groupBy, visibleFields, canReorder, canMoveGroups, projects, releases, users, labelContext, selected, highlightedTaskId, collapsed, canCreate, createOwnerUserId, createAssigneeUserIds, pullRefreshing, pullRefreshError, pullRefreshDisabled, onRefresh, onToggleGroup, onSelect, onHighlight, onOpen, onContextActions, onCreate, onMove, onStatusChange, onDragState }: { tasks: TaskRecord[]; hierarchyTasks: TaskRecord[]; groups: TaskGroup[]; statuses: Map<string, WorkflowStatusRecord>; groupBy: ViewDisplay["groupBy"]; visibleFields: ViewDisplay["visibleFields"]; canReorder: boolean; canMoveGroups: boolean; projects: Map<string, ProjectRecord>; releases: Map<string, ReleaseRecord>; users: Map<string, UserRecord>; labelContext: Pick<AppSnapshot, "labels" | "taskLabels">; selected: Set<string>; highlightedTaskId: string | null; collapsed: Set<string>; canCreate: boolean; createOwnerUserId: string; createAssigneeUserIds: ReadonlySet<string>; pullRefreshing: boolean; pullRefreshError: string; pullRefreshDisabled: boolean; onRefresh: () => Promise<AppSnapshot>; onToggleGroup: (id: string) => void; onSelect: (id: string, extendRange?: boolean) => void; onHighlight: (taskId: string) => void; onOpen: (id: string) => void; onContextActions: (task: TaskRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onCreate: (defaults?: TaskCreateDefaults) => void; onMove: (task: TaskRecord, group: TaskGroup | null, previousTaskId: string | null, nextTaskId: string | null) => Promise<unknown>; onStatusChange: (task: TaskRecord, statusId: string) => Promise<unknown>; onDragState: (taskId: string | null) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const hierarchySummaries = useMemo(
    () => buildTaskHierarchySummaries(hierarchyTasks),
    [hierarchyTasks],
  );
  const pullListRef = useRef<HTMLDivElement>(null);
  const pullStart = useRef<{ y: number; active: boolean } | null>(null);
  const pullDistanceRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  let content: React.ReactNode;

  function updatePullDistance(distance: number) {
    pullDistanceRef.current = distance;
    setPullDistance(distance);
  }

  function handlePullStart(event: ReactTouchEvent<HTMLDivElement>) {
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const active = canStartPullRefresh({
      mobile,
      coarsePointer,
      scrollTop: pullListRef.current?.scrollTop ?? 0,
      refreshing: pullRefreshing || pullRefreshDisabled,
      touchCount: event.touches.length,
    }) && !hasNestedScrollContainer(event.target, pullListRef.current);
    pullStart.current = active ? { y: event.touches[0].clientY, active } : null;
  }

  function handlePullMove(event: ReactTouchEvent<HTMLDivElement>) {
    if (!pullStart.current?.active || event.touches.length !== 1) return;
    const distance = pullRefreshDistance(
      event.touches[0].clientY - pullStart.current.y,
    );
    if (distance > 0) event.preventDefault();
    updatePullDistance(distance);
  }

  function finishPull() {
    const shouldRefresh = pullStart.current?.active
      && shouldTriggerPullRefresh(pullDistanceRef.current)
      && !pullRefreshing
      && !pullRefreshDisabled;
    pullStart.current = null;
    if (shouldRefresh) {
      updatePullDistance(52);
      void onRefresh().finally(() => updatePullDistance(0)).catch(() => undefined);
    } else if (!pullRefreshing && !pullRefreshError) {
      updatePullDistance(0);
    }
  }

  function moveFromDrop(
    draggedTaskId: string,
    group: TaskGroup | null,
    groupTasks: TaskRecord[],
    beforeTaskId: string | null,
  ) {
    const task = tasks.find((item) => item.id === draggedTaskId);
    if (!task || selected.size > 1 || group && !canMoveTaskToGroup(task, group)) return;
    if (!canReorder && (!canMoveGroups || !group || beforeTaskId !== null)) return;
    const neighbors = canReorder
      ? reorderInsertionNeighbors(groupTasks, task.id, beforeTaskId)
      : { previousTaskId: null, nextTaskId: null };
    void onMove(task, group, neighbors.previousTaskId, neighbors.nextTaskId);
  }

  function moveFromKeyboard(
    task: TaskRecord,
    group: TaskGroup | null,
    groupTasks: TaskRecord[],
    direction: "up" | "down",
  ) {
    const neighbors = keyboardReorderNeighbors(groupTasks, task.id, direction);
    if (neighbors) void onMove(task, group, neighbors.previousTaskId, neighbors.nextTaskId);
  }

  if (!tasks.length) {
    content = <EmptyState onCreate={canCreate ? () => onCreate() : undefined} />;
  } else if (groupBy === "none") {
    content = tasks.map((task) => {
      const status = statuses.get(task.statusId);
      return status ? <TaskRow key={task.id} task={task} status={status} statusOptions={taskStatusOptions(task, statuses)} showStatus project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} labels={labelsForTask(labelContext, task.id)} hierarchy={hierarchySummaries.get(task.id) ?? EMPTY_TASK_HIERARCHY_SUMMARY} visibleFields={visibleFields} selected={selected.has(task.id)} highlighted={highlightedTaskId === task.id} canDrag={canReorder && selected.size <= 1} reorderEnabled={canReorder} dropBefore={over === `before:${task.id}`} onDragTarget={(active) => setOver(active ? `before:${task.id}` : null)} onDropBefore={(draggedId) => moveFromDrop(draggedId, null, tasks, task.id)} onKeyboardMove={(direction) => moveFromKeyboard(task, null, tasks, direction)} onStatusChange={(statusId) => onStatusChange(task, statusId)} onSelect={(extendRange) => onSelect(task.id, extendRange)} onHighlight={() => onHighlight(task.id)} onOpen={() => onOpen(task.id)} onContextActions={(x, y, focus) => onContextActions(task, x, y, focus)} onDragState={onDragState} /> : null;
    });
  } else {
    content = groups.map((group) => {
      const isCollapsed = collapsed.has(group.id);
      const groupCanCreate = canCreateInTaskGroup(group, canCreate, createOwnerUserId, createAssigneeUserIds);
      return <section
        className={`task-group ${over === group.id ? "drag-over" : ""}`}
        data-drop-target={group.kind}
        key={group.id}
        onDragOver={(event) => {
          if (!canMoveGroups) return;
          event.preventDefault();
          setOver(group.id);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
        }}
        onDrop={(event) => {
          if (!canMoveGroups) return;
          event.preventDefault();
          const id = event.dataTransfer.getData("text/task-id");
          const task = tasks.find((item) => item.id === id);
          setOver(null);
          onDragState(null);
          if (task) moveFromDrop(task.id, group, group.tasks, null);
        }}
      ><div className="group-header"><button className="group-title" onClick={() => onToggleGroup(group.id)}><ChevronDown size={13} className={isCollapsed ? "rotated" : ""} /><TaskGroupIcon group={group} /><span>{group.label}</span><small>{group.tasks.length}</small></button>{groupCanCreate && <button className="icon-button quiet" onClick={() => onCreate(taskGroupCreateDefaults(group) as TaskCreateDefaults)} title={`Add to ${group.label}`}><Plus size={13} /></button>}</div>{!isCollapsed && group.tasks.map((task) => { const status = statuses.get(task.statusId); return status ? <TaskRow key={task.id} task={task} status={status} statusOptions={taskStatusOptions(task, statuses)} showStatus={groupBy !== "status"} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} labels={labelsForTask(labelContext, task.id)} hierarchy={hierarchySummaries.get(task.id) ?? EMPTY_TASK_HIERARCHY_SUMMARY} visibleFields={visibleFields} selected={selected.has(task.id)} highlighted={highlightedTaskId === task.id} canDrag={(canReorder || canMoveGroups) && selected.size <= 1} reorderEnabled={canReorder} dragGroupLabel={displayLabel(group.kind)} dropBefore={canReorder && over === `before:${task.id}`} onDragTarget={(active) => setOver(active ? `before:${task.id}` : null)} onDropBefore={(draggedId) => moveFromDrop(draggedId, group, group.tasks, task.id)} onKeyboardMove={(direction) => moveFromKeyboard(task, group, group.tasks, direction)} onStatusChange={(statusId) => onStatusChange(task, statusId)} onSelect={(extendRange) => onSelect(task.id, extendRange)} onHighlight={() => onHighlight(task.id)} onOpen={() => onOpen(task.id)} onContextActions={(x, y, focus) => onContextActions(task, x, y, focus)} onDragState={onDragState} /> : null; })}</section>;
    });
  }

  return <div
    ref={pullListRef}
    role="list"
    aria-label="Tasks"
    className={`task-list ${groupBy === "none" ? "ungrouped" : ""} ${over === "end:none" ? "drag-over" : ""}`}
    onDragOver={(event) => {
      if (groupBy !== "none" || !canReorder) return;
      event.preventDefault();
      setOver("end:none");
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
    }}
    onDrop={(event) => {
      if (groupBy !== "none" || !canReorder) return;
      event.preventDefault();
      const draggedId = event.dataTransfer.getData("text/task-id");
      setOver(null);
      onDragState(null);
      if (draggedId) moveFromDrop(draggedId, null, tasks, null);
    }}
    onTouchStart={handlePullStart}
    onTouchMove={handlePullMove}
    onTouchEnd={finishPull}
    onTouchCancel={finishPull}
  >
    <PullRefreshIndicator
      distance={pullDistance}
      refreshing={pullRefreshing}
      error={pullRefreshError}
      onRetry={() => void onRefresh().catch(() => undefined)}
    />
    {content}
  </div>;
}

export function hasNestedScrollContainer(target: EventTarget, boundary: HTMLElement | null) {
  let element = target instanceof HTMLElement ? target : null;
  while (element && element !== boundary) {
    const overflowY = window.getComputedStyle(element).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll")
      && element.scrollHeight > element.clientHeight) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}

export function PullRefreshIndicator({ distance, refreshing, error, onRetry }: {
  distance: number;
  refreshing: boolean;
  error: string;
  onRetry: () => void;
}) {
  const height = refreshing || error ? 52 : distance;
  const ready = shouldTriggerPullRefresh(distance);
  return <div
    className="pull-refresh-indicator"
    role={error ? "alert" : "status"}
    style={{ height }}
  >
    {error ? <><span>{error}</span><button type="button" onClick={onRetry}>Retry</button></> : <><span className={`pull-refresh-spinner ${refreshing ? "refreshing" : ""}`} aria-hidden="true" /><span>{refreshing ? "Refreshing…" : ready ? "Release to refresh" : "Pull to refresh"}</span></>}
  </div>;
}

export function TaskRow({ task, status, statusOptions, showStatus, project, release, assignee, labels, hierarchy, visibleFields, selected, highlighted, canDrag, reorderEnabled, dragGroupLabel, dropBefore, onDragTarget, onDropBefore, onKeyboardMove, onStatusChange, onSelect, onHighlight, onOpen, onContextActions, onDragState }: { task: TaskRecord; status: WorkflowStatusRecord; statusOptions: WorkflowStatusRecord[]; showStatus: boolean; project?: ProjectRecord; release?: ReleaseRecord; assignee?: UserRecord; labels: LabelRecord[]; hierarchy: TaskHierarchySummary; visibleFields: ViewDisplay["visibleFields"]; selected: boolean; highlighted: boolean; canDrag: boolean; reorderEnabled: boolean; dragGroupLabel?: string; dropBefore: boolean; onDragTarget: (active: boolean) => void; onDropBefore: (draggedTaskId: string) => void; onKeyboardMove: (direction: "up" | "down") => void; onStatusChange: (statusId: string) => Promise<unknown>; onSelect: (extendRange?: boolean) => void; onHighlight: () => void; onOpen: () => void; onContextActions: (x: number, y: number, restoreFocus: HTMLElement | null) => void; onDragState: (taskId: string | null) => void }) {
  const editable = canEditContent(task.accessRole);
  const draggable = editable && canDrag;
  const reorderTitle = editable
    ? reorderEnabled
      ? "Drag to reorder; Option+Arrow Up or Down also moves this Task"
      : dragGroupLabel
        ? `Drag to change ${dragGroupLabel}; Priority order remains authoritative`
        : "Choose Manual order to reorder Tasks"
    : undefined;
  return <div role="button" tabIndex={0} data-task-keyboard-id={task.id} data-context-entity-kind="task" data-context-entity-id={task.id} aria-pressed={selected} aria-current={highlighted ? "true" : undefined} title={reorderTitle} className={`task-row ${showStatus ? "show-status" : ""} ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""} ${dropBefore ? "drop-before" : ""}`} draggable={draggable} onContextMenu={(event) => { event.preventDefault(); onContextActions(event.clientX, event.clientY, event.currentTarget); }} onDragStart={(event) => { if (!draggable) return; event.dataTransfer.setData("text/task-id", task.id); event.dataTransfer.effectAllowed = "move"; onDragState(task.id); }} onDragEnd={() => { onDragTarget(false); onDragState(null); }} onDragOver={(event) => { if (!reorderEnabled) return; event.preventDefault(); event.stopPropagation(); onDragTarget(true); }} onDragLeave={() => onDragTarget(false)} onDrop={(event) => { if (!reorderEnabled) return; event.preventDefault(); event.stopPropagation(); const draggedId = event.dataTransfer.getData("text/task-id"); onDragTarget(false); onDragState(null); if (draggedId) onDropBefore(draggedId); }} onClick={(event) => { if (event.target === event.currentTarget) onOpen(); }} onKeyDown={(event) => { const reorderDirection = taskRowReorderDirection({ draggable, reorderEnabled, altKey: event.altKey, key: event.key, targetIsRow: event.target === event.currentTarget }); if (reorderDirection) { event.preventDefault(); onKeyboardMove(reorderDirection); return; } if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); onOpen(); } }} onMouseEnter={onHighlight} onFocus={onHighlight}>{editable ? <button className={`row-check ${selected ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); onSelect(event.shiftKey); }} aria-label={selected ? "Deselect task" : "Select task"}>{selected ? <Check size={12} /> : <span />}</button> : <span className="row-check-spacer" />}{visibleFields.includes("priority") ? <PriorityIcon priority={task.priority} /> : <span className="priority-icon-placeholder" />}<a className="task-identity" href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)}>{task.identifier}</a>{showStatus && <TaskStatusControl status={status} statuses={statusOptions} onChange={editable ? onStatusChange : undefined} />}<a className="task-title" href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)} title={task.title}>{task.title}</a><div className="row-metadata">{labels.slice(0, 3).map((label) => <LabelChip key={label.id} label={label} />)}{labels.length > 3 && <span className="label-overflow">+{labels.length - 3}</span>}<TaskHierarchyChip hierarchy={hierarchy} />{visibleFields.includes("project") && project && <span className="metadata-chip" title={project.name}><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}{visibleFields.includes("release") && release && <span className="metadata-chip" title={release.name}><Rocket size={12} />{release.name}</span>}{visibleFields.includes("dueDate") && task.dueDate && <span className={`metadata-chip ${isOverdue(task.dueDate, status.category) ? "overdue" : ""}`}><CalendarDays size={12} />{shortDate(task.dueDate)}</span>}{visibleFields.includes("assignee") && assignee && <span className="avatar" title={assignee.displayName}>{initials(assignee.displayName)}</span>}<button className="row-more" type="button" data-context-entity-kind="task" data-context-entity-id={task.id} aria-label={`Open contextual actions for ${task.identifier}`} title="Actions" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onContextActions(rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={14} /></button></div></div>;
}

export function TaskBoard({ tasks, hierarchyTasks, groups, groupBy, visibleFields, canReorder, canMoveGroups, statuses, projects, releases, users, labelContext, selected, highlightedTaskId, canCreate, createOwnerUserId, createAssigneeUserIds, onSelect, onHighlight, onOpen, onContextActions, onCreate, onMove, onDragState }: { tasks: TaskRecord[]; hierarchyTasks: TaskRecord[]; groups: TaskGroup[]; groupBy: ViewDisplay["groupBy"]; visibleFields: ViewDisplay["visibleFields"]; canReorder: boolean; canMoveGroups: boolean; statuses: Map<string, WorkflowStatusRecord>; projects: Map<string, ProjectRecord>; releases: Map<string, ReleaseRecord>; users: Map<string, UserRecord>; labelContext: Pick<AppSnapshot, "labels" | "taskLabels">; selected: Set<string>; highlightedTaskId: string | null; canCreate: boolean; createOwnerUserId: string; createAssigneeUserIds: ReadonlySet<string>; onSelect: (id: string, extendRange?: boolean) => void; onHighlight: (taskId: string) => void; onOpen: (id: string) => void; onContextActions: (task: TaskRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onCreate: (defaults?: TaskCreateDefaults) => void; onMove: (task: TaskRecord, group: TaskGroup | null, previousTaskId: string | null, nextTaskId: string | null) => Promise<unknown>; onDragState: (taskId: string | null) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const hierarchySummaries = useMemo(
    () => buildTaskHierarchySummaries(hierarchyTasks),
    [hierarchyTasks],
  );
  function moveFromDrop(draggedTaskId: string, group: TaskGroup | null, groupTasks: TaskRecord[], beforeTaskId: string | null) {
    const task = tasks.find((item) => item.id === draggedTaskId);
    if (!task || selected.size > 1 || group && !canMoveTaskToGroup(task, group)) return;
    if (!canReorder && (!canMoveGroups || !group || beforeTaskId !== null)) return;
    const neighbors = canReorder
      ? reorderInsertionNeighbors(groupTasks, task.id, beforeTaskId)
      : { previousTaskId: null, nextTaskId: null };
    void onMove(task, group, neighbors.previousTaskId, neighbors.nextTaskId);
  }
  function moveFromKeyboard(task: TaskRecord, group: TaskGroup | null, groupTasks: TaskRecord[], direction: "up" | "down") {
    const neighbors = keyboardReorderNeighbors(groupTasks, task.id, direction);
    if (neighbors) void onMove(task, group, neighbors.previousTaskId, neighbors.nextTaskId);
  }
  if (!tasks.length) return <EmptyState onCreate={canCreate ? () => onCreate() : undefined} />;
  if (groupBy === "none") {
    return <div className="board" role="list" aria-label="Tasks"><section className={`board-column ${over === "end:none" ? "drag-over" : ""}`} onDragOver={(event) => { if (!canReorder) return; event.preventDefault(); setOver("end:none"); }} onDragLeave={() => setOver(null)} onDrop={(event) => { if (!canReorder) return; event.preventDefault(); const draggedId = event.dataTransfer.getData("text/task-id"); setOver(null); onDragState(null); if (draggedId) moveFromDrop(draggedId, null, tasks, null); }}><div className="column-header"><div><LayoutList size={14} /><span>Tasks</span><small>{tasks.length}</small></div>{canCreate && <button className="icon-button quiet" onClick={() => onCreate()}><Plus size={13} /></button>}</div><div className="column-cards">{tasks.map((task) => <TaskBoardCard key={task.id} task={task} status={statuses.get(task.statusId)} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} labels={labelsForTask(labelContext, task.id)} hierarchy={hierarchySummaries.get(task.id) ?? EMPTY_TASK_HIERARCHY_SUMMARY} visibleFields={visibleFields} canDrag={canReorder && selected.size <= 1} reorderEnabled={canReorder} dropBefore={over === `before:${task.id}`} onDragTarget={(active) => setOver(active ? `before:${task.id}` : null)} onDropBefore={(draggedId) => moveFromDrop(draggedId, null, tasks, task.id)} onKeyboardMove={(direction) => moveFromKeyboard(task, null, tasks, direction)} showStatus showAssignee selected={selected.has(task.id)} highlighted={highlightedTaskId === task.id} onSelect={(extendRange) => onSelect(task.id, extendRange)} onHighlight={() => onHighlight(task.id)} onOpen={() => onOpen(task.id)} onContextActions={(x, y, focus) => onContextActions(task, x, y, focus)} onDragState={onDragState} />)}</div>{canCreate && <button className="add-card" onClick={() => onCreate()}><Plus size={13} />Add task</button>}</section></div>;
  }
  return (
    <div className="board" role="list" aria-label="Tasks">
      {groups.map((group) => {
        const groupCanCreate = canCreateInTaskGroup(group, canCreate, createOwnerUserId, createAssigneeUserIds);
        return (
          <section
            key={group.id}
            className={`board-column ${over === group.id ? "drag-over" : ""}`}
            onDragOver={(event) => {
              if (!canMoveGroups) return;
              event.preventDefault();
              setOver(group.id);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(event) => {
              if (!canMoveGroups) return;
              event.preventDefault();
              const id = event.dataTransfer.getData("text/task-id");
              const task = tasks.find((item) => item.id === id);
              setOver(null);
              onDragState(null);
              if (task) moveFromDrop(task.id, group, group.tasks, null);
            }}
          >
            <div className="column-header">
              <div>
                <TaskGroupIcon group={group} />
                <span>{group.label}</span>
                <small>{group.tasks.length}</small>
              </div>
              {groupCanCreate && <button className="icon-button quiet" onClick={() => onCreate(taskGroupCreateDefaults(group) as TaskCreateDefaults)}>
                <Plus size={13} />
              </button>}
            </div>
            <div className="column-cards">
              {group.tasks.map((task) => <TaskBoardCard key={task.id} task={task} status={statuses.get(task.statusId)} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} labels={labelsForTask(labelContext, task.id)} hierarchy={hierarchySummaries.get(task.id) ?? EMPTY_TASK_HIERARCHY_SUMMARY} visibleFields={visibleFields} canDrag={(canReorder || canMoveGroups) && selected.size <= 1} reorderEnabled={canReorder} dragGroupLabel={displayLabel(group.kind)} dropBefore={canReorder && over === `before:${task.id}`} onDragTarget={(active) => setOver(active ? `before:${task.id}` : null)} onDropBefore={(draggedId) => moveFromDrop(draggedId, group, group.tasks, task.id)} onKeyboardMove={(direction) => moveFromKeyboard(task, group, group.tasks, direction)} showStatus={group.kind !== "status"} showAssignee={group.kind !== "assignee"} selected={selected.has(task.id)} highlighted={highlightedTaskId === task.id} onSelect={(extendRange) => onSelect(task.id, extendRange)} onHighlight={() => onHighlight(task.id)} onOpen={() => onOpen(task.id)} onContextActions={(x, y, focus) => onContextActions(task, x, y, focus)} onDragState={onDragState} />)}
            </div>
            {groupCanCreate && <button className="add-card" onClick={() => onCreate(taskGroupCreateDefaults(group) as TaskCreateDefaults)}>
              <Plus size={13} />Add task
            </button>}
          </section>
        );
      })}
    </div>
  );
}

export function TaskBoardCard({ task, status, project, release, assignee, labels, hierarchy, visibleFields, canDrag, reorderEnabled, dragGroupLabel, dropBefore, onDragTarget, onDropBefore, onKeyboardMove, showStatus, showAssignee, selected, highlighted, onSelect, onHighlight, onOpen, onContextActions, onDragState }: { task: TaskRecord; status?: WorkflowStatusRecord; project?: ProjectRecord; release?: ReleaseRecord; assignee?: UserRecord; labels: LabelRecord[]; hierarchy: TaskHierarchySummary; visibleFields: ViewDisplay["visibleFields"]; canDrag: boolean; reorderEnabled: boolean; dragGroupLabel?: string; dropBefore: boolean; onDragTarget: (active: boolean) => void; onDropBefore: (draggedTaskId: string) => void; onKeyboardMove: (direction: "up" | "down") => void; showStatus: boolean; showAssignee: boolean; selected: boolean; highlighted: boolean; onSelect: (extendRange?: boolean) => void; onHighlight: () => void; onOpen: () => void; onContextActions: (x: number, y: number, restoreFocus: HTMLElement | null) => void; onDragState: (taskId: string | null) => void }) {
  const editable = canEditContent(task.accessRole);
  const draggable = editable && canDrag;
  const reorderTitle = editable
    ? reorderEnabled
      ? "Drag to reorder; Option+Arrow Up or Down also moves this Task"
      : dragGroupLabel
        ? `Drag to change ${dragGroupLabel}; Priority order remains authoritative`
        : "Choose Manual order to reorder Tasks"
    : undefined;
  return <div role="button" tabIndex={0} data-task-keyboard-id={task.id} data-context-entity-kind="task" data-context-entity-id={task.id} aria-pressed={selected} aria-current={highlighted ? "true" : undefined} title={reorderTitle} className={`task-card ${editable ? "editable" : ""} ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""} ${dropBefore ? "drop-before" : ""}`} draggable={draggable} onContextMenu={(event) => { event.preventDefault(); onContextActions(event.clientX, event.clientY, event.currentTarget); }} onDragStart={(event) => { if (!draggable) return; event.dataTransfer.setData("text/task-id", task.id); event.dataTransfer.effectAllowed = "move"; onDragState(task.id); }} onDragEnd={() => { onDragTarget(false); onDragState(null); }} onDragOver={(event) => { if (!reorderEnabled) return; event.preventDefault(); event.stopPropagation(); onDragTarget(true); }} onDragLeave={() => onDragTarget(false)} onDrop={(event) => { if (!reorderEnabled) return; event.preventDefault(); event.stopPropagation(); const draggedId = event.dataTransfer.getData("text/task-id"); onDragTarget(false); onDragState(null); if (draggedId) onDropBefore(draggedId); }} onClick={onOpen} onMouseEnter={onHighlight} onFocus={onHighlight} onKeyDown={(event) => { const direction = taskRowReorderDirection({ draggable, reorderEnabled, altKey: event.altKey, key: event.key, targetIsRow: event.target === event.currentTarget }); if (direction) { event.preventDefault(); onKeyboardMove(direction); return; } if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); onOpen(); } }}>{editable && <button className={`card-check ${selected ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); onSelect(event.shiftKey); }} aria-label={selected ? "Deselect task" : "Select task"}>{selected ? <Check size={11} /> : <span />}</button>}<button className="card-more" type="button" data-context-entity-kind="task" data-context-entity-id={task.id} aria-label={`Open contextual actions for ${task.identifier}`} title="Actions" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onContextActions(rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={14} /></button><a href={taskPath(task.publicId)} onClick={(event) => { event.stopPropagation(); handleLocalLink(event, onOpen); }}><h3>{task.title}</h3>{labels.length > 0 && <div className="card-labels">{labels.slice(0, 4).map((label) => <LabelChip key={label.id} label={label} />)}{labels.length > 4 && <span className="label-overflow">+{labels.length - 4}</span>}</div>}<div className="card-meta"><span className="card-identifier">{task.identifier}</span>{visibleFields.includes("priority") && <PriorityIcon priority={task.priority} />}<TaskHierarchyChip hierarchy={hierarchy} />{showStatus && status && <span className="metadata-chip"><StatusIcon status={status} />{status.name}</span>}{visibleFields.includes("project") && project && <span className="metadata-chip"><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}{visibleFields.includes("release") && release && <span className="metadata-chip"><Rocket size={12} />{release.name}</span>}{visibleFields.includes("dueDate") && task.dueDate && <span className={`metadata-chip ${status && isOverdue(task.dueDate, status.category) ? "overdue" : ""}`}><CalendarDays size={12} />{shortDate(task.dueDate)}</span>}{visibleFields.includes("assignee") && showAssignee && assignee && <span className="avatar" title={assignee.displayName}>{initials(assignee.displayName)}</span>}</div></a></div>;
}

export function TaskGroupIcon({ group }: { group: TaskGroup }) {
  if (group.status) return <StatusIcon status={group.status} />;
  if (group.priority) return <PriorityIcon priority={group.priority} />;
  if (group.assignee) return <span className="avatar group-avatar" title={group.assignee.displayName}>{initials(group.assignee.displayName)}</span>;
  if (group.project) return <span className="project-dot" style={{ background: group.project.color }} />;
  if (group.release) return <Rocket size={13} />;
  return <Circle size={11} />;
}

export function taskStatusOptions(
  task: TaskRecord,
  statuses: ReadonlyMap<string, WorkflowStatusRecord>,
) {
  return [...statuses.values()]
    .filter((status) => status.ownerUserId === task.ownerUserId)
    .filter((status) => !status.archivedAt || status.id === task.statusId)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

export function canCreateInTaskGroup(
  group: TaskGroup,
  canCreate: boolean,
  ownerUserId: string,
  createAssigneeUserIds: ReadonlySet<string>,
) {
  if (!canCreate) return false;
  if (group.status) return group.status.ownerUserId === ownerUserId;
  if (group.kind === "assignee") {
    return group.value === null || createAssigneeUserIds.has(group.value);
  }
  if (group.project) return canEditContent(group.project.accessRole);
  if (group.release) return canEditContent(group.release.accessRole);
  return true;
}

export function taskAssigneeOptions(
  data: AppSnapshot,
  projectId: string | null,
  taskId?: string,
): UserRecord[] {
  const userById = new Map([...data.users, data.user].map((user) => [user.id, user]));
  const ids = new Set<string>();
  if (projectId) {
    const project = data.projects.find((item) => item.id === projectId);
    if (project) ids.add(project.ownerUserId);
    ids.add(data.user.id);
    for (const collaborator of data.collaborators) {
      if (
        collaborator.resourceType === "project" &&
        collaborator.resourceId === projectId
      ) {
        ids.add(collaborator.userId);
      }
    }
  } else if (taskId) {
    const task = data.tasks.find((item) => item.id === taskId);
    if (task) ids.add(task.ownerUserId);
    ids.add(data.user.id);
    for (const collaborator of data.collaborators) {
      if (
        collaborator.resourceType === "task" &&
        collaborator.resourceId === taskId
      ) {
        ids.add(collaborator.userId);
      }
    }
  } else {
    ids.add(data.user.id);
  }
  return [...ids]
    .map((id) => userById.get(id))
    .filter((user): user is UserRecord => user !== undefined)
    .sort((left, right) =>
      left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
    );
}

export type StatusIconVariant = "backlog" | "todo" | "started" | "completed" | "canceled" | "duplicate";

export function statusIconVariant(status: WorkflowStatusRecord): StatusIconVariant {
  if (status.systemRole === "duplicate") return "duplicate";
  if (status.category === "backlog") return "backlog";
  if (status.category === "unstarted") return "todo";
  if (status.category === "started") return "started";
  if (status.category === "completed") return "completed";
  return "canceled";
}

export function statusProgress(status: WorkflowStatusRecord) {
  return 45 + (Math.abs(status.position) % 6) * 45;
}

export function StatusIcon({ status, announce = false }: { status: WorkflowStatusRecord; announce?: boolean }) {
  const variant = statusIconVariant(status);
  const progress = variant === "started" ? statusProgress(status) : undefined;
  const label = `Status: ${status.name}`;
  return <span
    className={`status-icon status-${status.category} status-variant-${variant}`}
    data-status-variant={variant}
    data-status-progress={progress}
    style={{
      "--status-color": status.color,
      ...(progress === undefined ? {} : { "--status-progress": `${progress}deg` }),
    } as React.CSSProperties}
    role={announce ? "img" : undefined}
    aria-label={announce ? label : undefined}
    aria-hidden={announce ? undefined : true}
    title={announce ? status.name : undefined}
  >
    {variant === "completed" && <Check size={9} aria-hidden="true" />}
    {variant === "canceled" && <X size={9} aria-hidden="true" />}
    {variant === "duplicate" && <Copy size={8} aria-hidden="true" />}
  </span>;
}

export function TaskStatusControl({ status, statuses, onChange }: { status: WorkflowStatusRecord; statuses: WorkflowStatusRecord[]; onChange?: (statusId: string) => Promise<unknown> }) {
  const editable = onChange !== undefined;
  const label = `Status: ${status.name}`;
  return <span className={`task-status-control ${editable ? "editable" : "read-only"}`} title={status.name}>
    <StatusIcon status={status} announce={!editable} />
    {editable && <select
      aria-label={label}
      title={status.name}
      value={status.id}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        if (event.target.value !== status.id) void onChange(event.target.value);
      }}
    >
      {statuses.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>}
  </span>;
}
