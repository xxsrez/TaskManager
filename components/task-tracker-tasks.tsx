"use client";

import {
  Archive,
  ArrowDown,
  ArrowDownWideNarrow,
  Boxes,
  CalendarDays,
  Check,
  ChevronDown,
  Circle,
  CircleDot,
  Copy,
  FolderKanban,
  LayoutList,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Rocket,
  Search,
  Share2,
  Tag,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  canEditContent,
} from "@/lib/access";
import {
  canMoveTaskToGroup,
  keyboardReorderNeighbors,
  reorderInsertionNeighbors,
  taskGroupCreateDefaults,
  type TaskGroup,
} from "@/lib/task-groups";
import {
  taskPath,
} from "@/lib/navigation";
import {
  type TaskQueryDependency,
} from "@/lib/task-query-reconciliation";
import {
  rebaseTaskDraft,
  resizeTaskTitle,
  taskDraftSyncMode,
  taskDraftValueChanged,
  taskNeedsDetailRefresh,
  type TaskDraftDirty,
} from "@/lib/task-detail-reconciliation";
import {
  type PublicAttachmentRecord,
  TaskAttachments,
  TaskDescriptionFileLink,
  TaskDescriptionImage,
} from "@/components/task-attachments";
import {
  bindStoredFileToTask,
  deleteStoredFile,
  getStoredFile,
  startStoredFileUpload,
  type PublicStoredFileRecord,
} from "@/lib/staged-file-upload";
import {
  TaskDescriptionEditor,
} from "@/components/task-description-editor";
import {
  CommentAttachmentAuthoring,
} from "@/components/comment-attachment-authoring";
import {
  CommentAttachmentMetadataProvider,
  useCommentAttachmentMetadata,
} from "@/components/comment-attachment-metadata";
import {
  isTaskMarkdownEscaped,
  parseTaskAttachmentReferences,
  parseTaskFileToken,
  parseTaskImageLine,
  parseTaskMarkdownInlineTokens,
  parseTaskMarkdownLines,
} from "@/lib/task-description-format";
import {
  commentBodyPreview,
} from "@/lib/comment-rendering";
import type {
  ActivityEventRecord,
  ActivityPage,
  AppSnapshot,
  CommentPage,
  CommentRecord,
  CommentThreadRecord,
  LabelRecord,
  Priority,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  TaskRecord,
  UserRecord,
  ViewDisplay,
  WorkflowStatusRecord,
} from "@/lib/types";
import {
  PriorityIcon,
  canStartPullRefresh,
  commentDraftStorageKey,
  priorityMeta,
  pullRefreshDistance,
  relationCandidateProjectLabel,
  shouldTriggerPullRefresh,
  taskRelationGroupOrder,
  taskRelationPresentations,
  taskRelationSearchUiApiPath,
  taskRowReorderDirection,
  type LabelMutationResult,
  type RelativeRelationKind,
  type TaskCreateDefaults,
  type TaskRelationPresentation,
} from "@/components/task-tracker-state";

import {
  DialogFooter,
  DialogHeader,
  Modal,
  confirmReleasedCompositionChange,
  displayLabel,
  handleLocalLink,
  initials,
  isOverdue,
  longDate,
  longDateTime,
  shortDate,
} from "@/components/task-tracker-dialogs";

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

export type ComposerAttachment = {
  id: string;
  uploadKey: string;
  bindKey: string;
  file: File | null;
  fileRef: string | null;
  fileVersion: number | null;
  filename: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string | null;
  readyExpiresAt: string | null;
  progress: number;
  status: "uploading" | "staged" | "binding" | "failed" | "canceled" | "complete";
  failedPhase: "upload" | "bind" | "delete" | null;
  error: string | null;
};

export type ComposerRecoveryState = {
  version: 1;
  createdTask: { id: string; identifier: string } | null;
  files: Array<{
    id: string;
    uploadKey: string;
    bindKey: string;
    fileRef: string;
    fileVersion: number;
    filename: string;
    mediaType: string;
    byteSize: number;
    checksumSha256: string;
    readyExpiresAt: string | null;
  }>;
};

export function TaskComposer({ data, contextProject, contextRelease, defaults, onClose, onSubmit, busy }: { data: AppSnapshot; contextProject: string | null; contextRelease: string | null; defaults: TaskCreateDefaults; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<TaskRecord | null>; busy: boolean }) {
  const editableProjects = data.projects.filter(
    (project) => !project.archivedAt && canEditContent(project.accessRole),
  );
  const initialReleaseId = defaults.releaseId !== undefined
    ? defaults.releaseId ?? ""
    : contextRelease ?? "";
  const releaseProjectId = initialReleaseId
    ? data.releases.find((release) => release.id === initialReleaseId)?.projectId
    : undefined;
  const initialProjectId = defaults.projectId !== undefined
    ? defaults.projectId ?? ""
    : contextProject ?? releaseProjectId ?? "";
  const [projectId, setProjectId] = useState(initialProjectId);
  const ownerId = data.projects.find((project) => project.id === projectId)?.ownerUserId ?? data.user.id;
  const statuses = data.statuses.filter(
    (status) => status.ownerUserId === ownerId && !status.archivedAt,
  );
  const [statusId, setStatusId] = useState(defaults.statusId && statuses.some((status) => status.id === defaults.statusId) ? defaults.statusId : statuses.find((status) => status.isDefault)?.id ?? statuses[0]?.id ?? "");
  const [releaseId, setReleaseId] = useState(initialReleaseId);
  const [priority, setPriority] = useState<Priority>(defaults.priority ?? "none");
  const [assigneeUserId, setAssigneeUserId] = useState(
    defaults.assigneeUserId !== undefined
      ? defaults.assigneeUserId ?? ""
      : data.user.id,
  );
  const assignees = taskAssigneeOptions(data, projectId || null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [labelCatalog, setLabelCatalog] = useState<LabelRecord[]>(
    data.labels.filter((label) => label.ownerUserId === ownerId && !label.archivedAt),
  );
  const [selectedLabelIds, setSelectedLabelIds] = useState<Set<string>>(
    new Set(defaults.labelId ? [defaults.labelId] : []),
  );
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [createdTask, setCreatedTask] = useState<{ id: string; identifier: string } | null>(null);
  const [recoveryHydrated, setRecoveryHydrated] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeUploads = useRef(new Map<string, () => void>());
  const recoveryKey = `tm:task-composer-staged:${data.user.id}`;

  useEffect(() => () => {
    for (const cancel of activeUploads.current.values()) cancel();
    activeUploads.current.clear();
  }, []);

  useEffect(() => {
    let stopped = false;
    const timer = window.setTimeout(() => {
      const saved = readComposerRecoveryState(window.localStorage.getItem(recoveryKey));
      if (!saved) {
        setRecoveryHydrated(true);
        return;
      }
      setCreatedTask(saved.createdTask);
      void Promise.all(saved.files.map(async (file) => {
        try {
          const current = await getStoredFile(file.fileRef);
          return recoveredComposerAttachment(file, current);
        } catch {
          return null;
        }
      })).then((files) => {
        if (stopped) return;
        setAttachments(files.filter((file): file is ComposerAttachment => file !== null));
        setRecoveryHydrated(true);
      });
    }, 0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [recoveryKey]);

  useEffect(() => {
    if (!recoveryHydrated) return;
    const files = attachments.flatMap((attachment) =>
      attachment.fileRef && attachment.fileVersion && attachment.checksumSha256 && attachment.status !== "complete"
        ? [{
            id: attachment.id,
            uploadKey: attachment.uploadKey,
            bindKey: attachment.bindKey,
            fileRef: attachment.fileRef,
            fileVersion: attachment.fileVersion,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            byteSize: attachment.byteSize,
            checksumSha256: attachment.checksumSha256,
            readyExpiresAt: attachment.readyExpiresAt,
          }]
        : [],
    );
    if (!createdTask && files.length === 0) {
      window.localStorage.removeItem(recoveryKey);
      return;
    }
    const state: ComposerRecoveryState = { version: 1, createdTask, files };
    window.localStorage.setItem(recoveryKey, JSON.stringify(state));
  }, [attachments, createdTask, recoveryHydrated, recoveryKey]);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void fetch(`/api/labels?projectId=${encodeURIComponent(projectId)}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const value = await response.json() as { labels?: LabelRecord[]; error?: string };
      if (!response.ok || !value.labels) throw new Error(value.error ?? "Labels could not be loaded");
      setLabelCatalog(value.labels);
      setSelectedLabelIds((current) => new Set(
        [...current].filter((id) => value.labels!.some((label) => label.id === id)),
      ));
    }).catch((requestError: unknown) => {
      if (!(requestError instanceof DOMException && requestError.name === "AbortError")) {
        setComposerError(requestError instanceof Error ? requestError.message : "Labels could not be loaded");
      }
    });
    return () => controller.abort();
  }, [projectId]);

  function patchAttachment(id: string, patch: Partial<ComposerAttachment>) {
    setAttachments((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function addFiles(files: FileList | File[]) {
    if (createdTask) return;
    const additions = Array.from(files).map((file) => {
      const id = crypto.randomUUID();
      return {
        id,
        uploadKey: `task-composer-file:${id}`,
        bindKey: `task-composer-bind:${id}`,
        file,
        fileRef: null,
        fileVersion: null,
        filename: file.name,
        mediaType: file.type || "application/octet-stream",
        byteSize: file.size,
        checksumSha256: null,
        readyExpiresAt: null,
        progress: 0,
        status: "uploading" as const,
        failedPhase: null,
        error: null,
      };
    });
    setAttachments((current) => [...current, ...additions]);
    for (const attachment of additions) void stageOne(attachment);
  }

  async function stageOne(attachment: ComposerAttachment) {
    if (!attachment.file) {
      patchAttachment(attachment.id, {
        status: "failed",
        failedPhase: "upload",
        error: "Choose the local file again to retry this upload.",
      });
      return null;
    }
    patchAttachment(attachment.id, {
      status: "uploading",
      failedPhase: null,
      progress: 0,
      error: null,
    });
    const running = startStoredFileUpload(
      attachment.file,
      attachment.uploadKey,
      (progress) => patchAttachment(attachment.id, { progress }),
    );
    activeUploads.current.set(attachment.id, running.cancel);
    try {
      const stored = await running.promise;
      patchAttachment(attachment.id, {
        fileRef: stored.ref,
        fileVersion: stored.version,
        filename: stored.filename,
        mediaType: stored.mediaType,
        byteSize: stored.byteSize,
        checksumSha256: stored.checksumSha256,
        readyExpiresAt: stored.readyExpiresAt,
        status: "staged",
        failedPhase: null,
        progress: 100,
        error: null,
      });
      return stored;
    } catch (requestError) {
      const canceled = requestError instanceof DOMException && requestError.name === "AbortError";
      patchAttachment(attachment.id, {
        status: canceled ? "canceled" : "failed",
        failedPhase: "upload",
        error: canceled
          ? "Upload canceled"
          : requestError instanceof Error
            ? requestError.message
            : "Upload failed",
      });
      return null;
    } finally {
      activeUploads.current.delete(attachment.id);
    }
  }

  async function bindOne(
    task: { id: string; identifier: string },
    attachment: ComposerAttachment,
  ) {
    if (!attachment.fileRef) return false;
    patchAttachment(attachment.id, {
      status: "binding",
      failedPhase: null,
      progress: 100,
      error: null,
    });
    const controller = new AbortController();
    activeUploads.current.set(attachment.id, () => controller.abort());
    try {
      await bindStoredFileToTask(
        task.id,
        attachment.fileRef,
        attachment.bindKey,
        controller.signal,
      );
      patchAttachment(attachment.id, {
        status: "complete",
        failedPhase: null,
        error: null,
      });
      return true;
    } catch (requestError) {
      const canceled = requestError instanceof DOMException && requestError.name === "AbortError";
      patchAttachment(attachment.id, {
        status: canceled ? "canceled" : "failed",
        failedPhase: "bind",
        error: `${task.identifier}: ${canceled
          ? "binding canceled"
          : requestError instanceof Error ? requestError.message : "binding failed"}`,
      });
      return false;
    } finally {
      activeUploads.current.delete(attachment.id);
    }
  }

  async function retryAttachment(attachment: ComposerAttachment) {
    if (attachment.failedPhase === "delete") {
      await removeAttachment(attachment);
      return;
    }
    if (attachment.fileRef) {
      if (createdTask) await bindOne(createdTask, attachment);
      else patchAttachment(attachment.id, { status: "staged", failedPhase: null, error: null });
      return;
    }
    await stageOne(attachment);
  }

  async function removeAttachment(attachment: ComposerAttachment) {
    activeUploads.current.get(attachment.id)?.();
    if (!attachment.fileRef) {
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      return;
    }
    try {
      await deleteStoredFile(attachment.fileRef, attachment.fileVersion ?? 0);
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    } catch (requestError) {
      patchAttachment(attachment.id, {
        status: "failed",
        failedPhase: "delete",
        error: requestError instanceof Error ? requestError.message : "Staged file could not be deleted",
      });
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if ((!createdTask && (!title.trim() || !projectId)) || busy) return;
    setComposerError("");
    const selectedRelease = data.releases.find((release) => release.id === releaseId);
    const confirmReleasedComposition = !createdTask && selectedRelease?.status === "released";
    if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return;
    let bindCandidates = [...attachments];
    let stagingFailed = 0;
    for (const attachment of bindCandidates.filter((item) => !item.fileRef && item.status !== "complete")) {
      const stored = await stageOne(attachment);
      if (!stored) {
        stagingFailed += 1;
        continue;
      }
      bindCandidates = bindCandidates.map((item) => item.id === attachment.id
        ? composerAttachmentWithStoredFile(item, stored)
        : item);
    }
    if (stagingFailed > 0) {
      setComposerError(`${stagingFailed} file${stagingFailed === 1 ? "" : "s"} could not be staged. Retry or remove them before creating the Task.`);
      return;
    }
    const task = createdTask ?? await onSubmit({
      title,
      description,
      projectId,
      releaseId: releaseId || null,
      statusId,
      priority,
      assigneeUserId: assigneeUserId || null,
      labelIds: [...selectedLabelIds],
      ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}),
    });
    if (!task) {
      setComposerError("Task was not created. Staged files are still available for retry or deletion until their TTL expires.");
      return;
    }
    const taskIdentity = { id: task.id, identifier: task.identifier };
    setCreatedTask(taskIdentity);
    const pending = bindCandidates.filter((item) => item.status !== "complete");
    let failed = 0;
    for (const attachment of pending) {
      if (!(await bindOne(taskIdentity, attachment))) failed += 1;
    }
    if (failed === 0) {
      window.localStorage.removeItem(recoveryKey);
      onClose();
    } else {
      setComposerError(`${task.identifier} was created, but ${failed} staged file${failed === 1 ? "" : "s"} failed to bind. Each file remains available for a stable-key retry.`);
    }
  }

  function closeComposer() {
    for (const cancel of activeUploads.current.values()) cancel();
    onClose();
  }

  const pendingCount = attachments.filter((item) => item.status !== "complete").length;
  const fileWorkActive = attachments.some((item) => item.status === "uploading" || item.status === "binding");
  return (
    <Modal onClose={closeComposer} className="composer-modal">
      <form onSubmit={submit}>
        <div className="modal-title-row">
          <span className="muted">{createdTask ? `${createdTask.identifier} created` : "New task"}</span>
          <button type="button" className="icon-button" onClick={closeComposer}><X size={15} /></button>
        </div>
        <fieldset className="composer-fields" disabled={Boolean(createdTask)}>
          <input className="composer-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" autoFocus />
          <textarea className="composer-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add description…" rows={4} onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(); }} />
          <div className="property-bar">
            <PropertySelect icon={<CircleDot size={13} />} value={statusId} onChange={setStatusId}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</PropertySelect>
            <PropertySelect icon={<ArrowDownWideNarrow size={13} />} value={priority} onChange={(value) => setPriority(value as Priority)}>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</PropertySelect>
            <PropertySelect icon={<UsersRound size={13} />} value={assigneeUserId} onChange={setAssigneeUserId}><option value="">No assignee</option>{assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}</PropertySelect>
            <PropertySelect icon={<FolderKanban size={13} />} value={projectId} onChange={(value) => { setProjectId(value); setReleaseId(""); setSelectedLabelIds(new Set()); const nextOwner = data.projects.find((project) => project.id === value)?.ownerUserId ?? data.user.id; const nextAssignees = taskAssigneeOptions(data, value || null); setAssigneeUserId((current) => current === "" || nextAssignees.some((assignee) => assignee.id === current) ? current : data.user.id); setStatusId(data.statuses.find((status) => status.ownerUserId === nextOwner && status.isDefault)?.id ?? data.statuses.find((status) => status.ownerUserId === nextOwner)?.id ?? ""); }}><option value="" disabled>Select project</option>{editableProjects.map((project) => <option key={project.id} value={project.id}>{project.taskCode} · {project.name}</option>)}</PropertySelect>
            <PropertySelect icon={<Rocket size={13} />} value={releaseId} onChange={setReleaseId} disabled={!projectId}><option value="">No release</option>{data.releases.filter((release) => release.projectId === projectId && canEditContent(release.accessRole)).map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</PropertySelect>
          </div>
          <LabelPicker labels={labelCatalog} selected={selectedLabelIds} onToggle={(labelId) => setSelectedLabelIds((current) => toggleLabelSelection(current, labelId, labelCatalog))} disabled={Boolean(createdTask)} label="Task labels" />
        </fieldset>
        {!editableProjects.length && <p className="inline-note">Create an editable Project before adding a Task.</p>}
        <section
          className={`composer-attachments ${dragActive ? "drag-active" : ""}`}
          aria-label="Task attachments"
          onDragEnter={(event) => { if (!createdTask) { event.preventDefault(); setDragActive(true); } }}
          onDragOver={(event) => { if (!createdTask) event.preventDefault(); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
          onDrop={(event) => { if (createdTask) return; event.preventDefault(); setDragActive(false); addFiles(event.dataTransfer.files); }}
          onPaste={(event) => { if (createdTask || !event.clipboardData.files.length) return; event.preventDefault(); addFiles(event.clipboardData.files); }}
        >
          <div>
            <button className="button ghost" type="button" disabled={Boolean(createdTask)} onClick={() => fileInputRef.current?.click()}><Paperclip size={14} />Add files</button>
            <span>{attachments.length ? `${attachments.length} file${attachments.length === 1 ? "" : "s"} · staged before Task creation` : "Files are staged before Task creation"}</span>
          </div>
          <input ref={fileInputRef} className="visually-hidden" type="file" multiple aria-label="Choose files for the new task" disabled={Boolean(createdTask)} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
          {attachments.length > 0 && (
            <div className="composer-attachment-list" aria-live="polite">
              {attachments.map((attachment) => (
                <article key={attachment.id} data-upload-state={attachment.status}>
                  <FileAttachmentIcon filename={attachment.filename} />
                  <div>
                    <b title={attachment.filename}>{attachment.filename}</b>
                    <small>{composerAttachmentStatus(attachment)}</small>
                    {attachment.status === "uploading" && <progress value={attachment.progress} max="100" aria-label={`Upload progress for ${attachment.filename}`} />}
                  </div>
                  <div className="composer-attachment-actions">
                    {(attachment.status === "uploading" || attachment.status === "binding") && <button className="icon-button" type="button" aria-label={`Cancel ${attachment.filename}`} onClick={() => activeUploads.current.get(attachment.id)?.()}><X size={14} /></button>}
                    {(attachment.status === "failed" || attachment.status === "canceled") && <button className="icon-button" type="button" aria-label={`Retry ${attachment.filename}`} onClick={() => void retryAttachment(attachment)}><RotateComposerIcon /></button>}
                    {attachment.status !== "complete" && attachment.status !== "uploading" && attachment.status !== "binding" && <button className="icon-button" type="button" aria-label={`Delete staged ${attachment.filename}`} onClick={() => void removeAttachment(attachment)}><X size={14} /></button>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        {composerError && <p className="composer-upload-error" role="alert">{composerError}</p>}
        <div className="modal-footer">
          <span className="shortcut-hint">{createdTask ? "Unbound staged files remain recoverable until their TTL expires." : <><kbd>⌘</kbd><kbd>Enter</kbd> to create</>}</span>
          <button className="button primary" disabled={busy || (!createdTask && (!title.trim() || !projectId)) || fileWorkActive || !recoveryHydrated}>{busy || fileWorkActive ? "Working…" : createdTask ? pendingCount ? `Retry ${pendingCount} file${pendingCount === 1 ? "" : "s"}` : "Done" : attachments.length ? "Create and attach" : "Create task"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function composerAttachmentWithStoredFile(
  attachment: ComposerAttachment,
  stored: PublicStoredFileRecord,
): ComposerAttachment {
  return {
    ...attachment,
    fileRef: stored.ref,
    fileVersion: stored.version,
    filename: stored.filename,
    mediaType: stored.mediaType,
    byteSize: stored.byteSize,
    checksumSha256: stored.checksumSha256,
    readyExpiresAt: stored.readyExpiresAt,
    progress: 100,
    status: "staged",
    failedPhase: null,
    error: null,
  };
}

export function recoveredComposerAttachment(
  saved: ComposerRecoveryState["files"][number],
  stored: PublicStoredFileRecord,
): ComposerAttachment {
  return composerAttachmentWithStoredFile({
    id: saved.id,
    uploadKey: saved.uploadKey,
    bindKey: saved.bindKey,
    file: null,
    fileRef: saved.fileRef,
    fileVersion: saved.fileVersion,
    filename: saved.filename,
    mediaType: saved.mediaType,
    byteSize: saved.byteSize,
    checksumSha256: saved.checksumSha256,
    readyExpiresAt: saved.readyExpiresAt,
    progress: 100,
    status: "staged",
    failedPhase: null,
    error: null,
  }, stored);
}

export function readComposerRecoveryState(value: string | null): ComposerRecoveryState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ComposerRecoveryState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) return null;
    const createdTask = parsed.createdTask &&
      typeof parsed.createdTask.id === "string" &&
      typeof parsed.createdTask.identifier === "string"
      ? { id: parsed.createdTask.id, identifier: parsed.createdTask.identifier }
      : null;
    const files = parsed.files.filter((file) =>
      file &&
      typeof file.id === "string" &&
      typeof file.uploadKey === "string" &&
      typeof file.bindKey === "string" &&
      typeof file.fileRef === "string" &&
      Number.isSafeInteger(file.fileVersion) &&
      typeof file.filename === "string" &&
      typeof file.mediaType === "string" &&
      Number.isSafeInteger(file.byteSize) &&
      typeof file.checksumSha256 === "string" &&
      (file.readyExpiresAt === null || typeof file.readyExpiresAt === "string"),
    );
    return { version: 1, createdTask, files };
  } catch {
    return null;
  }
}

export function composerAttachmentStatus(attachment: ComposerAttachment) {
  if (attachment.status === "uploading") return `${attachment.progress}% uploaded to staging`;
  if (attachment.status === "staged") return `Staged · ${formatComposerBytes(attachment.byteSize)} · ready to attach`;
  if (attachment.status === "binding") return "Attaching to Task…";
  if (attachment.status === "complete") return "Attached";
  return attachment.error ?? (attachment.status === "canceled" ? "Canceled" : "Failed");
}

export function formatComposerBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

export function FileAttachmentIcon({ filename }: { filename: string }) {
  return <span className="composer-attachment-icon" aria-hidden="true">{filename.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE"}</span>;
}

export function RotateComposerIcon() {
  return <span aria-hidden="true">↻</span>;
}

export function TaskDetails({ task, data, catalogReady, onClose, onOpenTask, onContextActions, onSave, onMove, onSetParent, onCreateSubtask, onSetLabel, onRebase, onRelationMutation, onShare, busy }: { task: TaskRecord; data: AppSnapshot; catalogReady: boolean; onClose: () => void; onOpenTask: (id: string) => void; onContextActions: (x: number, y: number, restoreFocus: HTMLElement | null) => void; onSave: (input: Record<string, unknown>) => Promise<unknown>; onMove: (input: Record<string, unknown>) => Promise<unknown>; onSetParent: (parentTaskId: string | null) => Promise<unknown>; onCreateSubtask: (title: string) => Promise<unknown>; onSetLabel: (labelId: string, active: boolean) => Promise<unknown>; onRebase: (taskId: string) => Promise<TaskRecord | null>; onRelationMutation: (tasks: TaskRecord[], dependencies: TaskQueryDependency[]) => void; onShare: () => void; busy: boolean }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionUploadActive, setDescriptionUploadActive] = useState(false);
  const [estimate, setEstimate] = useState(task.estimate?.toString() ?? "");
  const [rebasing, setRebasing] = useState(false);
  const [dirty, setDirty] = useState<TaskDraftDirty>({
    title: false,
    description: false,
    estimate: false,
  });
  const autoRebaseKey = useRef<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const cancelTitleSave = useRef(false);
  const [autoRebaseFailed, setAutoRebaseFailed] = useState(false);
  const [moveTargetProjectId, setMoveTargetProjectId] = useState<string | null>(null);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [labelCatalog, setLabelCatalog] = useState<LabelRecord[]>(
    data.labels.filter((label) => label.ownerUserId === task.ownerUserId),
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/tasks/${encodeURIComponent(task.id)}/labels`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const value = await response.json() as LabelMutationResult | { error?: string };
      if (!response.ok || !("labels" in value)) throw new Error("error" in value ? value.error ?? "Labels could not be loaded" : "Labels could not be loaded");
      setLabelCatalog(value.labels);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [task.id]);
  const hasVersionConflict = taskNeedsDetailRefresh(task);
  const syncMode = taskDraftSyncMode(hasVersionConflict, dirty);

  useEffect(() => {
    resizeTaskTitle(titleRef.current);
  }, [title]);

  useEffect(() => {
    const resize = () => resizeTaskTitle(titleRef.current);
    window.addEventListener("resize", resize);
    const observer = typeof ResizeObserver === "undefined" || !titleRef.current?.parentElement
      ? null
      : new ResizeObserver(resize);
    if (observer && titleRef.current?.parentElement) {
      observer.observe(titleRef.current.parentElement);
    }
    return () => {
      window.removeEventListener("resize", resize);
      observer?.disconnect();
    };
  }, [task.id]);

  const rebaseDraft = useCallback(async () => {
    setRebasing(true);
    setAutoRebaseFailed(false);
    const latest = await onRebase(task.id);
    if (latest && latest.version >= task.version) {
      const next = rebaseTaskDraft(
        { title, description, estimate },
        dirty,
        latest,
      );
      setTitle(next.title);
      setDescription(next.description);
      setEstimate(next.estimate);
    } else {
      setAutoRebaseFailed(true);
    }
    setRebasing(false);
  }, [description, dirty, estimate, onRebase, task.id, task.version, title]);

  useEffect(() => {
    if (syncMode !== "auto") {
      autoRebaseKey.current = null;
      return;
    }
    const rebaseKey = `${task.version}:${task.detailStale ? "stale" : "version"}`;
    if (autoRebaseKey.current === rebaseKey) return;
    autoRebaseKey.current = rebaseKey;
    void rebaseDraft();
  }, [rebaseDraft, syncMode, task.detailStale, task.version]);

  if (!canEditContent(task.accessRole)) {
    return <ReadOnlyTaskDetails task={task} data={data} onClose={onClose} onOpenTask={onOpenTask} />;
  }
  const statuses = data.statuses.filter(
    (status) => status.ownerUserId === task.ownerUserId &&
      (!status.archivedAt || status.id === task.statusId),
  );
  const currentProject = data.projects.find((project) => project.id === task.projectId);
  const moveTargets = data.projects.filter(
    (project) => project.id !== task.projectId &&
      project.status !== "canceled" &&
      canEditContent(project.accessRole),
  );
  const moveTargetProject = moveTargetProjectId
    ? moveTargets.find((project) => project.id === moveTargetProjectId)
    : undefined;
  const assignees = taskAssigneeOptions(data, task.projectId, task.id);
  const taskMap = new Map(data.tasks.map((item) => [item.id, item]));
  const assignedLabels = data.taskLabels
    .filter((assignment) => assignment.taskId === task.id)
    .map((assignment) => data.labels.find((label) => label.id === assignment.labelId))
    .filter((label) => label !== undefined);
  const parent = task.parentTaskId ? taskMap.get(task.parentTaskId) : undefined;
  const subtasks = data.tasks.filter((item) => item.parentTaskId === task.id);
  const hierarchyCandidates = data.tasks.filter((candidate) =>
    candidate.id !== task.id &&
    candidate.projectId === task.projectId &&
    (!candidate.archivedAt || candidate.id === task.parentTaskId) &&
    !wouldCreateHierarchyCycle(task.id, candidate.id, taskMap));
  async function saveDraftField(
    field: keyof TaskDraftDirty,
    input: Record<string, unknown>,
  ) {
    const saved = await onSave(input);
    if (saved === true) {
      setDirty((current) => ({ ...current, [field]: false }));
    }
    return saved === true;
  }

  const showVersionConflict = syncMode === "manual" ||
    (syncMode === "auto" && autoRebaseFailed);

  return (
    <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="details-panel">
        <header>
          <div className="details-crumb"><span>{task.identifier}</span><button title="Copy link" onClick={() => void navigator.clipboard.writeText(window.location.href)}><Link2 size={13} /></button></div>
          <div><button className="button ghost" onClick={onShare}><Share2 size={13} />Share</button><button className="icon-button" type="button" aria-label={`Open contextual actions for ${task.identifier}`} title="Actions (Cmd/Ctrl+K)" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onContextActions(rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={16} /></button><button className="icon-button" onClick={onClose}><X size={16} /></button></div>
        </header>
        <div className="details-body">
          {showVersionConflict && (
            <div className="task-version-conflict" role="alert">
              <p>This task changed elsewhere. Your draft is preserved in this panel; load the latest version before saving.</p>
              <button className="button secondary" type="button" disabled={rebasing} onClick={() => void rebaseDraft()}>{rebasing ? "Loading latest…" : "Load latest and keep draft"}</button>
            </div>
          )}
          <textarea
            ref={titleRef}
            className="details-title"
            rows={1}
            aria-label="Task title"
            value={title}
            onChange={(event) => {
              const nextTitle = event.target.value.replace(/[\r\n]+/g, " ");
              cancelTitleSave.current = false;
              setDirty((current) => ({ ...current, title: taskDraftValueChanged(nextTitle, task.title) }));
              setTitle(nextTitle);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelTitleSave.current = true;
                setTitle(task.title);
                setDirty((current) => ({ ...current, title: false }));
                event.currentTarget.blur();
              } else if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            onBlur={() => {
              if (cancelTitleSave.current) {
                cancelTitleSave.current = false;
                return;
              }
              if (!title.trim()) {
                setTitle(task.title);
                setDirty((current) => ({ ...current, title: false }));
                return;
              }
              if (!hasVersionConflict && title.trim() && title !== task.title) {
                void saveDraftField("title", { title });
              }
            }}
          />
          <section className="task-description-section" aria-label="Description">
            <header>
              <span>Description</span>
              {!editingDescription && (
                <button
                  className="button ghost"
                  type="button"
                  disabled={hasVersionConflict}
                  onClick={() => setEditingDescription(true)}
                >
                  Edit description
                </button>
              )}
            </header>
            {editingDescription ? (
              <div className="task-description-editor">
                <TaskDescriptionEditor
                  taskId={task.id}
                  value={description}
                  onChange={(nextDescription) => {
                    setDirty((current) => ({ ...current, description: taskDraftValueChanged(nextDescription, task.description ?? "") }));
                    setDescription(nextDescription);
                  }}
                  onUploadActiveChange={setDescriptionUploadActive}
                  disabled={busy || hasVersionConflict}
                />
                <div className="task-description-editor-actions">
                  <button
                    className="button ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDescription(task.description ?? "");
                      setDirty((current) => ({ ...current, description: false }));
                      setEditingDescription(false);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="button secondary save-description"
                    type="button"
                    disabled={busy || descriptionUploadActive || hasVersionConflict || description === (task.description ?? "")}
                    onClick={() => void saveDraftField("description", { description })
                      .then((saved) => saved && setEditingDescription(false))}
                  >
                    {busy ? "Saving…" : "Save description"}
                  </button>
                </div>
              </div>
            ) : description ? (
              <TaskDescriptionMarkdown task={task} body={description} className="task-description-markdown" />
            ) : (
              <p className="task-description-empty">No description</p>
            )}
          </section>
          <div className="properties-grid">
            <PropertyRow label="Status" icon={<CircleDot size={14} />}><select value={task.statusId} disabled={hasVersionConflict} onChange={(event) => void onSave({ statusId: event.target.value })}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></PropertyRow>
            <PropertyRow label="Priority" icon={<ArrowDownWideNarrow size={14} />}><select value={task.priority} disabled={hasVersionConflict} onChange={(event) => void onSave({ priority: event.target.value })}>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></PropertyRow>
            <PropertyRow label="Assignee" icon={<UsersRound size={14} />}><select value={task.assigneeUserId ?? ""} disabled={hasVersionConflict} onChange={(event) => void onSave({ assigneeUserId: event.target.value || null })}><option value="">No assignee</option>{assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}</select></PropertyRow>
            <PropertyRow label="Project" icon={<FolderKanban size={14} />}><select value={task.projectId} disabled={!catalogReady || hasVersionConflict || busy || moveTargets.length === 0} title={!catalogReady ? "Loading Projects…" : moveTargets.length ? "Move this Task to another Project" : "No other editable active Project"} onChange={(event) => setMoveTargetProjectId(event.target.value)}><option value={task.projectId}>{currentProject?.taskCode} · {currentProject?.name}</option>{moveTargets.map((project) => <option key={project.id} value={project.id}>{project.taskCode} · {project.name}</option>)}</select></PropertyRow>
            <PropertyRow label="Release" icon={<Rocket size={14} />}><select value={task.releaseId ?? ""} onChange={(event) => void onSave({ releaseId: event.target.value || null })} disabled={!catalogReady || hasVersionConflict || !task.projectId}><option value="">{catalogReady ? "No release" : "Loading Releases…"}</option>{data.releases.filter((release) => release.projectId === task.projectId).map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</select></PropertyRow>
            <PropertyRow label="Due date" icon={<CalendarDays size={14} />}><input type="date" value={task.dueDate ?? ""} disabled={hasVersionConflict} onChange={(event) => void onSave({ dueDate: event.target.value || null })} /></PropertyRow>
            <PropertyRow label="Estimate" icon={<Zap size={14} />}><input type="number" min="0" max="100" value={estimate} placeholder="No estimate" onChange={(event) => { const nextEstimate = event.target.value; setDirty((current) => ({ ...current, estimate: taskDraftValueChanged(nextEstimate, task.estimate?.toString() ?? "") })); setEstimate(nextEstimate); }} onBlur={() => { const value = estimate === "" ? null : Number(estimate); if (!hasVersionConflict && value !== task.estimate) void saveDraftField("estimate", { estimate: value }); }} /></PropertyRow>
          </div>
          <DetailsSection title="Labels" icon={<Tag size={14} />}><LabelPicker labels={labelCatalog} selected={new Set(assignedLabels.map((label) => label.id))} onToggle={(labelId) => void onSetLabel(labelId, !assignedLabels.some((label) => label.id === labelId))} disabled={busy} label="Edit Task labels" /></DetailsSection>
          <DetailsSection title="Hierarchy" icon={<Boxes size={14} />}>
            {(parent || subtasks.length > 0) && <div className="details-links">{parent && <TaskReference label="Parent" task={parent} onOpen={onOpenTask} />}{subtasks.map((subtask) => <TaskReference key={subtask.id} label="Subtask" task={subtask} onOpen={onOpenTask} />)}</div>}
            <div className="hierarchy-controls">
              <label>
                <span>Parent</span>
                <select
                  aria-label="Task parent"
                  value={task.parentTaskId ?? ""}
                  disabled={busy || hasVersionConflict}
                  onChange={(event) => void onSetParent(event.target.value || null)}
                >
                  <option value="">No parent</option>
                  {hierarchyCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.identifier} · {candidate.title}</option>)}
                </select>
              </label>
              <form onSubmit={(event) => {
                event.preventDefault();
                const nextTitle = subtaskTitle.trim();
                if (!nextTitle || busy || hasVersionConflict) return;
                void onCreateSubtask(nextTitle).then((created) => {
                  if (created === true) setSubtaskTitle("");
                });
              }}>
                <input
                  aria-label="New subtask title"
                  value={subtaskTitle}
                  maxLength={500}
                  placeholder="New subtask title"
                  disabled={busy || hasVersionConflict || Boolean(task.archivedAt)}
                  onChange={(event) => setSubtaskTitle(event.target.value)}
                />
                <button className="button ghost" type="submit" disabled={busy || hasVersionConflict || Boolean(task.archivedAt) || !subtaskTitle.trim()}><Plus size={13} />Add subtask</button>
              </form>
            </div>
          </DetailsSection>
          <TaskRelations
            task={task}
            data={data}
            onOpenTask={onOpenTask}
            onRefresh={onRebase}
            onMutation={onRelationMutation}
            canWrite
            busy={busy}
          />
          <TaskAttachments task={task} currentUser={data.user} users={data.users} canWrite description={task.description} />
          <TaskActivity task={task} currentUser={data.user} canWrite />
          <div className="timestamps"><span>Created {longDate(task.createdAt, data.user.timezone)}</span><span>Updated {longDate(task.updatedAt, data.user.timezone)}</span>{task.completedAt && <span>Completed {longDate(task.completedAt, data.user.timezone)}</span>}</div>
          <button className="button danger ghost archive-action" disabled={hasVersionConflict} onClick={() => { void onSave({ archived: !task.archivedAt }); onClose(); }}><Archive size={14} />{task.archivedAt ? "Restore task" : "Archive task"}</button>
        </div>
      </aside>
      {moveTargetProject && currentProject && (
        <TaskMoveDialog
          task={task}
          sourceProject={currentProject}
          targetProject={moveTargetProject}
          data={data}
          parent={parent}
          subtasks={subtasks}
          busy={busy}
          onClose={() => setMoveTargetProjectId(null)}
          onMove={async (input) => {
            const moved = await onMove(input);
            if (moved === true) setMoveTargetProjectId(null);
          }}
        />
      )}
    </div>
  );
}

export function TaskMoveDialog({ task, sourceProject, targetProject, data, parent, subtasks, busy, onClose, onMove }: { task: TaskRecord; sourceProject: ProjectRecord; targetProject: ProjectRecord; data: AppSnapshot; parent?: TaskRecord; subtasks: TaskRecord[]; busy: boolean; onClose: () => void; onMove: (input: Record<string, unknown>) => Promise<void> }) {
  const targetReleases = data.releases.filter(
    (release) => release.projectId === targetProject.id && canEditContent(release.accessRole),
  );
  const targetAssignees = taskAssigneeOptions(data, targetProject.id, task.id);
  const currentRelease = data.releases.find((release) => release.id === task.releaseId);
  const currentAssignee = [...data.users, data.user].find(
    (user) => user.id === task.assigneeUserId,
  );
  const currentAssigneeRemains = task.assigneeUserId === null || targetAssignees.some(
    (assignee) => assignee.id === task.assigneeUserId,
  );
  const [releaseId, setReleaseId] = useState(task.releaseId ? "__required__" : "");
  const [assigneeUserId, setAssigneeUserId] = useState(
    currentAssigneeRemains ? (task.assigneeUserId ?? "") : "__required__",
  );
  const hierarchyBlocked = Boolean(parent || subtasks.length);
  const choicesIncomplete = releaseId === "__required__" || assigneeUserId === "__required__";
  const expectedIdentifier = `${targetProject.taskCode}-${targetProject.taskSequence + 1}`;

  return (
    <Modal onClose={() => !busy && onClose()} className="task-move-modal" ariaLabel={`Move ${task.identifier}`}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (hierarchyBlocked || choicesIncomplete) return;
        void onMove({
          targetProjectId: targetProject.id,
          releaseId: releaseId || null,
          assigneeUserId: assigneeUserId || null,
        });
      }}>
        <DialogHeader title="Move task" icon={<FolderKanban size={17} />} onClose={() => !busy && onClose()} />
        <div className="task-move-summary">
          <span><small>From</small><b>{sourceProject.name}</b><code>{task.identifier}</code></span>
          <ArrowDown size={15} aria-hidden="true" />
          <span><small>To</small><b>{targetProject.name}</b><code>{expectedIdentifier} expected</code></span>
        </div>
        <p className="dialog-copy">The final identifier is allocated only when the move commits. The response is authoritative; the old identifier remains searchable.</p>
        <div className="form-stack task-move-effects">
          <label>
            <span>Release effect</span>
            <select value={releaseId} onChange={(event) => setReleaseId(event.target.value)}>
              {task.releaseId && <option value="__required__" disabled>Choose how to replace {currentRelease?.name ?? "the current Release"}</option>}
              <option value="">Clear Release</option>
              {targetReleases.map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}
            </select>
          </label>
          <label>
            <span>Assignee effect</span>
            <select value={assigneeUserId} onChange={(event) => setAssigneeUserId(event.target.value)}>
              {!currentAssigneeRemains && <option value="__required__" disabled>Choose how to replace {currentAssignee?.displayName ?? "the current assignee"}</option>}
              <option value="">No assignee</option>
              {targetAssignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}
            </select>
          </label>
        </div>
        {hierarchyBlocked && <p className="dialog-error" role="alert">Detach or reparent {parent ? "the parent" : ""}{parent && subtasks.length ? " and " : ""}{subtasks.length ? `${subtasks.length} subtask${subtasks.length === 1 ? "" : "s"}` : ""} before moving this Task.</p>}
        <DialogFooter busy={busy} label="Move task" disabled={hierarchyBlocked || choicesIncomplete} />
      </form>
    </Modal>
  );
}

export function TaskDetailsLoading({ task, onClose }: { task: TaskRecord; onClose: () => void }) {
  return <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="details-panel" aria-busy="true"><header><div className="details-crumb"><span>{task.identifier}</span></div><button className="icon-button" onClick={onClose}><X size={16} /></button></header><div className="details-body task-details-loading"><h1 className="read-only-title">{task.title}</h1><p>Loading task details…</p></div></aside></div>;
}

export function ReadOnlyTaskDetails({ task, data, onClose, onOpenTask }: { task: TaskRecord; data: AppSnapshot; onClose: () => void; onOpenTask: (id: string) => void }) {
  const status = data.statuses.find((item) => item.id === task.statusId);
  const project = task.projectId ? data.projects.find((item) => item.id === task.projectId) : undefined;
  const release = task.releaseId ? data.releases.find((item) => item.id === task.releaseId) : undefined;
  const assignee = task.assigneeUserId
    ? [...data.users, data.user].find((item) => item.id === task.assigneeUserId)
    : undefined;
  const parent = task.parentTaskId ? data.tasks.find((item) => item.id === task.parentTaskId) : undefined;
  const subtasks = data.tasks.filter((item) => item.parentTaskId === task.id);
  const labels = labelsForTask(data, task.id);
  return <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="details-panel read-only"><header><div className="details-crumb"><span>{task.identifier}</span><small className="role-badge">Viewer</small></div><button className="icon-button" onClick={onClose}><X size={16} /></button></header><div className="details-body"><h1 className="read-only-title">{task.title}</h1>{task.description ? <TaskDescriptionMarkdown task={task} body={task.description} className="task-description-markdown" /> : <p className="task-description-empty">No description</p>}<div className="properties-grid"><PropertyValue label="Status" value={status?.name ?? "Unknown"} /><PropertyValue label="Priority" value={priorityMeta[task.priority].label} /><PropertyValue label="Assignee" value={assignee?.displayName ?? "No assignee"} /><PropertyValue label="Project" value={project ? `${project.taskCode} · ${project.name}` : "Unavailable"} /><PropertyValue label="Release" value={release?.name ?? "No release"} /><PropertyValue label="Due date" value={task.dueDate ? shortDate(task.dueDate) : "No due date"} /><PropertyValue label="Estimate" value={task.estimate == null ? "No estimate" : String(task.estimate)} /></div>{labels.length > 0 && <DetailsSection title="Labels" icon={<Tag size={14} />}><div className="label-chip-list">{labels.map((label) => <LabelChip key={label.id} label={label} />)}</div></DetailsSection>}{(parent || subtasks.length > 0) && <DetailsSection title="Hierarchy" icon={<Boxes size={14} />}><div className="details-links">{parent && <TaskReference label="Parent" task={parent} onOpen={onOpenTask} />}{subtasks.map((subtask) => <TaskReference key={subtask.id} label="Subtask" task={subtask} onOpen={onOpenTask} />)}</div></DetailsSection>}<TaskRelations task={task} data={data} onOpenTask={onOpenTask} onRefresh={async () => task} onMutation={() => undefined} canWrite={false} busy={false} /><TaskAttachments task={task} currentUser={data.user} users={data.users} canWrite={false} description={task.description} /><TaskActivity task={task} currentUser={data.user} canWrite={false} /><div className="timestamps"><span>Created {longDate(task.createdAt, data.user.timezone)}</span><span>Updated {longDate(task.updatedAt, data.user.timezone)}</span></div></div></aside></div>;
}

export function relationCandidateAllowedForKind(
  kind: RelativeRelationKind,
  anchor: TaskRecord,
  candidate: TaskRecord,
) {
  return kind !== "duplicate_of" || candidate.projectId === anchor.projectId;
}

export function relationSelectionAfterKindChange(
  kind: RelativeRelationKind,
  anchor: TaskRecord,
  candidates: TaskRecord[],
  selectedTaskId: string,
) {
  const selected = candidates.find((candidate) => candidate.id === selectedTaskId);
  return selected && relationCandidateAllowedForKind(kind, anchor, selected)
    ? selectedTaskId
    : "";
}

export function TaskRelations({
  task,
  data,
  onOpenTask,
  onRefresh,
  onMutation,
  canWrite,
  busy,
}: {
  task: TaskRecord;
  data: AppSnapshot;
  onOpenTask: (id: string) => void;
  onRefresh: (taskId: string) => Promise<TaskRecord | null>;
  onMutation: (tasks: TaskRecord[], dependencies: TaskQueryDependency[]) => void;
  canWrite: boolean;
  busy: boolean;
}) {
  const presentations = taskRelationPresentations(task, data);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<RelativeRelationKind>("related");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<TaskRecord[]>(data.tasks);
  const [candidateProjects, setCandidateProjects] = useState<ProjectRecord[]>(data.projects);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [searching, setSearching] = useState(false);
  const [pendingRelationId, setPendingRelationId] = useState<string | null>(null);
  const [relationError, setRelationError] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const existingTargetIds = new Set(presentations.map((item) => item.target.id));
  const availableCandidates = candidates
    .filter((candidate) =>
      candidate.id !== task.id &&
      candidate.projectId !== null &&
      canEditContent(candidate.accessRole) &&
      relationCandidateAllowedForKind(kind, task, candidate) &&
      !existingTargetIds.has(candidate.id) &&
      (!query.trim() || `${candidate.identifier} ${candidate.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
    .slice(0, 8);

  function searchCandidates(nextQuery: string) {
    setQuery(nextQuery);
    setSelectedTaskId("");
    setCandidates(data.tasks);
    setCandidateProjects(data.projects);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!nextQuery.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      void fetch(taskRelationSearchUiApiPath(nextQuery.trim(), task.id, kind), {
        cache: "no-store",
      })
        .then(async (response) => {
          const value = await response.json() as {
            tasks?: TaskRecord[];
            projects?: ProjectRecord[];
            error?: string;
          };
          if (!response.ok || value.error) throw new Error(value.error ?? "Task search failed");
          setCandidates(value.tasks ?? []);
          setCandidateProjects(value.projects ?? []);
          setRelationError("");
        })
        .catch((requestError: unknown) => {
          setRelationError(requestError instanceof Error ? requestError.message : "Task search failed");
        })
        .finally(() => setSearching(false));
    }, 180);
  }

  function changeKind(nextKind: RelativeRelationKind) {
    setKind(nextKind);
    setSelectedTaskId(relationSelectionAfterKindChange(
      nextKind,
      task,
      candidates,
      selectedTaskId,
    ));
  }

  async function sendRelationMutation(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    input: Record<string, unknown>,
    pendingId: string,
    affectedTaskIds: string[],
  ) {
    setPendingRelationId(pendingId);
    setRelationError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const value = await response.json() as { error?: string };
      if (!response.ok || value.error) throw new Error(value.error ?? "Relation could not be saved");
      const refreshed = await onRefresh(task.id);
      const affected = new Map(
        data.tasks
          .filter((candidate) => affectedTaskIds.includes(candidate.id))
          .map((candidate) => [candidate.id, candidate]),
      );
      if (refreshed) affected.set(refreshed.id, refreshed);
      onMutation(
        [...affected.values()],
        input.type === "duplicate_of" && method !== "DELETE"
          ? ["relation", "status", "status_category"]
          : ["relation"],
      );
      return true;
    } catch (requestError) {
      setRelationError(requestError instanceof Error ? requestError.message : "Relation could not be saved");
      return false;
    } finally {
      setPendingRelationId(null);
    }
  }

  async function createRelation() {
    if (!selectedTaskId || kind === "duplicates") return;
    const semantic = relativeRelationSemantic(kind);
    const saved = await sendRelationMutation(
      `/api/tasks/${encodeURIComponent(task.id)}/relations`,
      "POST",
      {
        targetTaskId: selectedTaskId,
        ...semantic,
        taskVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      },
      "new",
      [task.id, selectedTaskId],
    );
    if (saved) {
      setAdding(false);
      setQuery("");
      setSelectedTaskId("");
    }
  }

  async function updateRelation(item: TaskRelationPresentation, nextKind: RelativeRelationKind) {
    if (nextKind === "duplicates") return;
    await sendRelationMutation(
      `/api/tasks/${encodeURIComponent(task.id)}/relations/${encodeURIComponent(item.relation.id)}`,
      "PATCH",
      {
        version: item.relation.version,
        ...relativeRelationSemantic(nextKind),
        taskVersion: task.version,
      },
      item.relation.id,
      [task.id, item.target.id],
    );
  }

  async function removeRelation(item: TaskRelationPresentation) {
    await sendRelationMutation(
      `/api/tasks/${encodeURIComponent(task.id)}/relations/${encodeURIComponent(item.relation.id)}`,
      "DELETE",
      { version: item.relation.version },
      item.relation.id,
      [task.id, item.target.id],
    );
  }

  if (!canWrite && presentations.length === 0) return null;
  const grouped = taskRelationGroupOrder
    .map((group) => ({ group, items: presentations.filter((item) => item.group === group) }))
    .filter(({ items }) => items.length > 0);
  const relationBusy = busy || pendingRelationId !== null;

  return <section className="details-section task-relations" aria-label="Task relations">
    <div className="task-relations-header">
      <h2><Link2 size={14} />Relations</h2>
      {canWrite && task.projectId && <button className="button ghost" type="button" disabled={relationBusy} onClick={() => { setAdding((current) => !current); setRelationError(""); }}><Plus size={13} />Add relation</button>}
    </div>
    {!task.projectId && canWrite && <p className="inline-note">Add this Task to a Project before creating relations.</p>}
    {grouped.map(({ group, items }) => <div className="task-relation-group" key={group}>
      <h3>{group}</h3>
      <div className="details-links">
        {items.map((item) => <div className="task-relation-row" key={item.relation.id} aria-busy={pendingRelationId === item.relation.id}>
          <TaskReference
            label={data.projects.some((project) => project.id === item.target.projectId)
              ? `${item.label} · ${relationCandidateProjectLabel(item.target, data.projects)}`
              : item.label}
            task={item.target}
            onOpen={onOpenTask}
          />
          {canWrite && <div className="task-relation-actions">
            <select aria-label={`Change relation to ${item.target.identifier}`} value={relativeRelationKind(item)} disabled={relationBusy} onChange={(event) => void updateRelation(item, event.target.value as RelativeRelationKind)}>
              <option value="related">Related</option>
              <option value="blocks">Blocks</option>
              <option value="blocked_by">Blocked by</option>
              {item.target.projectId === task.projectId && <option value="duplicate_of">Duplicate of</option>}
              {relativeRelationKind(item) === "duplicates" && <option value="duplicates" disabled>Duplicate</option>}
            </select>
            <button className="icon-button" type="button" aria-label={`Remove relation to ${item.target.identifier}`} disabled={relationBusy} onClick={() => void removeRelation(item)}><X size={13} /></button>
          </div>}
        </div>)}
      </div>
    </div>)}
    {adding && <div className="task-relation-composer">
      <div>
        <select aria-label="Relation type" value={kind} disabled={relationBusy} onChange={(event) => changeKind(event.target.value as RelativeRelationKind)}>
          <option value="related">Related</option>
          <option value="blocks">Blocks</option>
          <option value="blocked_by">Blocked by</option>
          <option value="duplicate_of">Duplicate of</option>
        </select>
        <input aria-label="Search Tasks for relation" value={query} disabled={relationBusy} placeholder="Search by identifier or title…" onChange={(event) => searchCandidates(event.target.value)} />
      </div>
      <div className="task-relation-candidates" aria-busy={searching}>
        {searching && <span>Searching…</span>}
        {!searching && availableCandidates.length === 0 && <span>No editable project Tasks found.</span>}
        {!searching && availableCandidates.map((candidate) => <button type="button" key={candidate.id} className={selectedTaskId === candidate.id ? "selected" : ""} onClick={() => setSelectedTaskId(candidate.id)}><span>{candidate.identifier}</span><b>{relationCandidateProjectLabel(candidate, candidateProjects)} · {candidate.title}</b></button>)}
      </div>
      <div className="task-relation-composer-actions">
        <button className="button ghost" type="button" disabled={relationBusy} onClick={() => setAdding(false)}>Cancel</button>
        <button className="button secondary" type="button" disabled={relationBusy || !selectedTaskId} onClick={() => void createRelation()}>{pendingRelationId === "new" ? "Adding…" : kind === "duplicate_of" ? "Mark duplicate" : "Add relation"}</button>
      </div>
    </div>}
    {relationError && <p className="task-relation-error" role="alert">{relationError}</p>}
  </section>;
}

export function relativeRelationSemantic(kind: Exclude<RelativeRelationKind, "duplicates">) {
  if (kind === "blocked_by") return { type: "blocks" as const, direction: "incoming" as const };
  return {
    type: kind,
    direction: "outgoing" as const,
  };
}

export function relativeRelationKind(item: TaskRelationPresentation): RelativeRelationKind {
  if (item.relation.type === "related") return "related";
  if (item.relation.type === "duplicate_of") {
    return item.direction === "outgoing" ? "duplicate_of" : "duplicates";
  }
  return item.direction === "outgoing" ? "blocks" : "blocked_by";
}

export function TaskActivity({ task, currentUser, canWrite }: {
  task: TaskRecord;
  currentUser: UserRecord;
  canWrite: boolean;
}) {
  const [page, setPage] = useState<CommentPage | null>(null);
  const [activityPage, setActivityPage] = useState<ActivityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(true);
  const [error, setError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadBlocked, setUploadBlocked] = useState(false);
  const [composerEpoch, setComposerEpoch] = useState(0);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const pendingIdempotencyKeys = useRef(new Map<string, string>());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const draftKey = commentDraftStorageKey(currentUser.id, task.id, replyTo ?? undefined);

  useEffect(() => {
    const saved = window.localStorage.getItem(draftKey);
    // Local storage is the external source for an unsent per-user task/thread draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(saved ?? "");
  }, [draftKey]);

  useEffect(() => {
    if (draft) window.localStorage.setItem(draftKey, draft);
    else window.localStorage.removeItem(draftKey);
  }, [draft, draftKey]);

  async function loadComments(cursor: string | null = null, append = false) {
    setLoading(true);
    setError("");
    try {
      const next = await fetchCommentJson<CommentPage>(
        `/api/tasks/${encodeURIComponent(task.id)}/comments?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setPage((current) => append && current ? {
        ...next,
        threads: [...current.threads, ...next.threads],
      } : next);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comments could not be loaded");
    } finally {
      setLoading(false);
    }
  }

  async function loadActivity(cursor: string | null = null, append = false) {
    setActivityLoading(true);
    setActivityError("");
    try {
      const next = await fetchCommentJson<ActivityPage>(
        `/api/tasks/${encodeURIComponent(task.id)}/activity?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setActivityPage((current) => append && current ? {
        ...next,
        events: [...current.events, ...next.events],
      } : next);
    } catch (requestError) {
      setActivityError(requestError instanceof Error ? requestError.message : "Activity could not be loaded");
    } finally {
      setActivityLoading(false);
    }
  }

  useEffect(() => {
    // Keep the draft, but discard the loaded page after a remote comment event.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(null);
    const timer = window.setTimeout(() => void loadComments(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.commentInvalidationCursor, task.id]);

  useEffect(() => {
    // Activity is a separate lazy projection; reload only for the open Task.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActivityPage(null);
    const timer = window.setTimeout(() => void loadActivity(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.activityInvalidationCursor, task.id]);

  useEffect(() => {
    if (!page || !window.location.hash.startsWith("#comment-")) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("permalink-target");
    const timer = window.setTimeout(() => target.classList.remove("permalink-target"), 1800);
    return () => window.clearTimeout(timer);
  }, [page]);

  async function submitComment() {
    if (!canWrite || busy || uploadBlocked || !draft.trim()) return;
    const submittedDraftKey = draftKey;
    const submittedReplyTo = replyTo;
    const idempotencyKey = pendingIdempotencyKeys.current.get(submittedDraftKey) ?? crypto.randomUUID();
    pendingIdempotencyKeys.current.set(submittedDraftKey, idempotencyKey);
    setBusy(true);
    setError("");
    try {
      await fetchCommentJson<CommentRecord>(
        `/api/tasks/${encodeURIComponent(task.id)}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: draft,
            parentCommentId: replyTo,
            idempotencyKey,
          }),
        },
      );
      pendingIdempotencyKeys.current.delete(submittedDraftKey);
      window.localStorage.removeItem(submittedDraftKey);
      setComposerEpoch((current) => current + 1);
      setReplyTo(null);
      setDraft(submittedReplyTo
        ? window.localStorage.getItem(commentDraftStorageKey(currentUser.id, task.id)) ?? ""
        : "");
      await Promise.all([loadComments(), loadActivity()]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comment could not be saved");
    } finally {
      setBusy(false);
    }
  }

  async function mutateComment(path: string, method: string, input: Record<string, unknown>) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await fetchCommentJson(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await Promise.all([loadComments(), loadActivity()]);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comment action failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function commentPath(commentId: string, suffix = "") {
    return `/api/tasks/${encodeURIComponent(task.id)}/comments/${encodeURIComponent(commentId)}${suffix}`;
  }

  function switchComposer(threadId: string | null) {
    setReplyTo(threadId);
    setDraft(window.localStorage.getItem(
      commentDraftStorageKey(currentUser.id, task.id, threadId ?? undefined),
    ) ?? "");
  }

  const count = page?.totalCount ?? task.commentCount;
  const activityCount = activityPage?.totalCount ?? 0;
  return <section className="task-activity details-section" aria-labelledby={`activity-${task.id}`}>
    <header className="activity-header">
      <h2 id={`activity-${task.id}`}><MessageSquare size={14} />Activity</h2>
      <span>{activityCount} {activityCount === 1 ? "event" : "events"} · {count} {count === 1 ? "comment" : "comments"}</span>
    </header>
    {activityLoading && !activityPage && <p className="inline-note" role="status">Loading activity…</p>}
    {activityError && <div className="comment-error" role="alert"><span>{activityError}</span><button type="button" onClick={() => void loadActivity()}>Retry</button></div>}
    {activityPage && activityPage.events.length > 0 && <div className="activity-events">
      {activityPage.events.map((event) => <ActivityTimelineEvent key={event.id} event={event} />)}
    </div>}
    {activityPage?.hasMore && <button className="button ghost load-comments" type="button" disabled={activityLoading} onClick={() => void loadActivity(activityPage.nextCursor, true)}>{activityLoading ? "Loading…" : "Load older activity"}</button>}
    {loading && !page && <p className="inline-note" role="status">Loading comments…</p>}
    {error && <div className="comment-error" role="alert"><span>{error}</span><button type="button" onClick={() => void loadComments()}>Retry</button></div>}
    {page && page.threads.length === 0 && <p className="activity-empty">No comments yet.</p>}
    <CommentAttachmentMetadataProvider task={task}>
      <div className="comment-threads">
        {page?.threads.map((thread) => <CommentThread
          key={`${thread.root.id}:${thread.root.resolvedAt ?? "open"}`}
          taskId={task.id}
          thread={thread}
          busy={busy}
          onReply={(rootId) => {
            switchComposer(rootId);
            window.setTimeout(() => composerRef.current?.focus(), 0);
          }}
          onEdit={(comment, body) => mutateComment(commentPath(comment.id), "PATCH", { version: comment.version, body })}
          onDelete={(comment) => mutateComment(commentPath(comment.id), "DELETE", { version: comment.version })}
          onReact={(comment, emoji, active) => mutateComment(commentPath(comment.id, "/reactions"), "PUT", { emoji, active })}
          onResolve={(comment, resolved) => mutateComment(commentPath(comment.id, "/resolution"), "PUT", { version: comment.version, resolved })}
        />)}
      </div>
    </CommentAttachmentMetadataProvider>
    {page?.hasMore && <button className="button ghost load-comments" type="button" disabled={loading} onClick={() => void loadComments(page.nextCursor, true)}>{loading ? "Loading…" : "Load older threads"}</button>}
    {canWrite && <div className="comment-composer">
      <span className="comment-avatar" style={{ "--avatar-hue": avatarHue(currentUser.id) } as React.CSSProperties}>{initials(currentUser.displayName)}</span>
      <div className="comment-composer-box">
        {replyTo && <div className="reply-context"><span>Replying in thread</span><button type="button" onClick={() => switchComposer(null)}>Cancel</button></div>}
        <CommentAttachmentAuthoring
          key={`${draftKey}:${composerEpoch}`}
          taskId={task.id}
          value={draft}
          onChange={setDraft}
          textareaRef={composerRef}
          disabled={busy}
          onBlockingChange={setUploadBlocked}
        >
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submitComment();
              }
            }}
            placeholder="Leave a comment…"
            aria-label="Comment body"
            rows={draft.includes("\n") ? 5 : 3}
          />
        </CommentAttachmentAuthoring>
        <div className="comment-composer-actions">
          <div className="comment-toolbar" role="toolbar" aria-label="Comment formatting">
            <button type="button" title="Bold" aria-label="Bold" onClick={() => formatCommentSelection(composerRef.current, setDraft, "**")}><b>B</b></button>
            <button type="button" title="Italic" aria-label="Italic" onClick={() => formatCommentSelection(composerRef.current, setDraft, "*")}><i>I</i></button>
            <button type="button" title="Inline code" aria-label="Inline code" onClick={() => formatCommentSelection(composerRef.current, setDraft, "`")}><code>&lt;/&gt;</code></button>
            <button type="button" title="Quote" aria-label="Quote" onClick={() => prefixCommentLines(composerRef.current, setDraft, "> ")}>&gt;</button>
            <button type="button" title="List" aria-label="List" onClick={() => prefixCommentLines(composerRef.current, setDraft, "- ")}>•</button>
            <button type="button" title="Link" aria-label="Link" onClick={() => formatCommentSelection(composerRef.current, setDraft, "[", "](https://)")}>↗</button>
          </div>
          <span><kbd>⌘</kbd><kbd>Enter</kbd></span>
          <button className="button primary" type="button" disabled={busy || uploadBlocked || !draft.trim()} onClick={() => void submitComment()}>{busy ? "Saving…" : uploadBlocked ? "Upload pending" : replyTo ? "Reply" : "Comment"}</button>
        </div>
      </div>
    </div>}
  </section>;
}

export function ActivityTimelineEvent({ event }: { event: ActivityEventRecord }) {
  const changes = event.payload.changes && typeof event.payload.changes === "object"
    ? event.payload.changes as Record<string, unknown>
    : null;
  const summary = changes
    ? Object.entries(changes).map(([field, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return field;
      const change = value as Record<string, unknown>;
      return `${activityFieldLabel(field)}: ${activityValue(change.before)} → ${activityValue(change.after)}`;
    }).join(" · ")
    : activityEventFallback(event);
  return <div className="activity-event">
    <span className="activity-event-icon"><CircleDot size={12} /></span>
    <div>
      <header><b>{event.actor.displayName}</b><span>{activityEventLabel(event.eventType)}</span>{event.actor.kind === "historical" && <small>Imported history</small>}<time dateTime={event.createdAt} title={longDateTime(event.createdAt)}>{relativeTime(event.createdAt)}</time></header>
      {summary && <p>{summary}</p>}
    </div>
  </div>;
}

export function activityEventLabel(value: string) {
  return ({
    task_created: "created the task",
    task_updated: "updated the task",
    task_moved: "moved the task",
    task_archived: "archived the task",
    task_restored: "restored the task",
    task_deleted: "moved the task to Recently deleted",
    task_delete_restored: "restored the task from Recently deleted",
    status_changed: "changed status",
    hierarchy_changed: "changed hierarchy",
    labels_changed: "changed labels",
    relation_created: "added a relation",
    relation_updated: "updated a relation",
    relation_deleted: "removed a relation",
    comment_added: "added a comment",
    comment_edited: "edited a comment",
    comment_deleted: "deleted a comment",
    comment_resolved: "resolved a thread",
    comment_reopened: "reopened a thread",
    comment_reaction_changed: "changed a reaction",
  } as Record<string, string>)[value] ?? value.replaceAll("_", " ");
}

export function activityFieldLabel(value: string) {
  return ({ assigneeUserId: "Assignee", dueDate: "Due date", estimate: "Estimate", parentTaskId: "Parent", project: "Project", projectId: "Project", releaseId: "Release", archivedAt: "Archive", status: "Status", priority: "Priority", identifier: "Identifier", title: "Title" } as Record<string, string>)[value] ?? value;
}

export function activityValue(value: unknown): string {
  if (value == null || value === "") return "None";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return String(record.name ?? record.identifier ?? record.id ?? "Changed");
  }
  return "Changed";
}

export function activityEventFallback(event: ActivityEventRecord) {
  if (event.eventType === "labels_changed") {
    const label = event.payload.label as Record<string, unknown> | undefined;
    return `${event.payload.active ? "Added" : "Removed"} ${String(label?.name ?? "label")}`;
  }
  if (event.eventType.startsWith("relation_")) return "Task relation changed";
  if (event.eventType.startsWith("comment_")) return "Discussion activity";
  return "";
}

export function CommentThread({ taskId, thread, busy, onReply, onEdit, onDelete, onReact, onResolve }: {
  taskId: string;
  thread: CommentThreadRecord;
  busy: boolean;
  onReply: (rootId: string) => void;
  onEdit: (comment: CommentRecord, body: string) => Promise<boolean>;
  onDelete: (comment: CommentRecord) => Promise<boolean>;
  onReact: (comment: CommentRecord, emoji: string, active: boolean) => Promise<boolean>;
  onResolve: (comment: CommentRecord, resolved: boolean) => Promise<boolean>;
}) {
  const [collapsed, setCollapsed] = useState(Boolean(thread.root.resolvedAt));
  useEffect(() => {
    const targetId = window.location.hash.slice(1);
    if (!targetId || ![thread.root, ...thread.replies].some(
      (comment) => `comment-${comment.id}` === targetId,
    )) return;
    let focusFrame = 0;
    const openFrame = window.requestAnimationFrame(() => {
      setCollapsed(false);
      focusFrame = window.requestAnimationFrame(() => {
        const target = document.getElementById(targetId);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    return () => {
      window.cancelAnimationFrame(openFrame);
      window.cancelAnimationFrame(focusFrame);
    };
  }, [thread]);
  return <article className={`comment-thread ${thread.root.resolvedAt ? "resolved" : ""}`}>
    {thread.root.resolvedAt && <button className="resolved-thread-toggle" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><Check size={13} />Resolved thread · {thread.replies.length + 1} messages</button>}
    {!collapsed && <>
      <CommentEntry taskId={taskId} comment={thread.root} rootId={thread.root.id} busy={busy} onReply={onReply} onEdit={onEdit} onDelete={onDelete} onReact={onReact} onResolve={onResolve} />
      {thread.replies.length > 0 && <div className="comment-replies">{thread.replies.map((reply) => <CommentEntry key={reply.id} taskId={taskId} comment={reply} rootId={thread.root.id} busy={busy} onReply={onReply} onEdit={onEdit} onDelete={onDelete} onReact={onReact} onResolve={onResolve} />)}</div>}
    </>}
  </article>;
}

export function CommentEntry({ taskId, comment, rootId, busy, onReply, onEdit, onDelete, onReact, onResolve }: {
  taskId: string;
  comment: CommentRecord;
  rootId: string;
  busy: boolean;
  onReply: (rootId: string) => void;
  onEdit: (comment: CommentRecord, body: string) => Promise<boolean>;
  onDelete: (comment: CommentRecord) => Promise<boolean>;
  onReact: (comment: CommentRecord, emoji: string, active: boolean) => Promise<boolean>;
  onResolve: (comment: CommentRecord, resolved: boolean) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const [editUploadBlocked, setEditUploadBlocked] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const preview = commentBodyPreview(comment.body);
  const long = preview.truncated;
  const body = long && !expanded ? preview.body : comment.body;
  const isRoot = comment.parentCommentId === null;
  const permalink = `comment-${comment.id}`;
  return <div className="comment-entry" id={permalink} tabIndex={-1}>
    <span className="comment-avatar" style={{ "--avatar-hue": avatarHue(comment.author.id ?? comment.id) } as React.CSSProperties}>{initials(comment.author.displayName)}</span>
    <div className="comment-content">
      <header><b>{comment.author.displayName}</b>{comment.author.kind === "historical" && <small className="historical-comment-badge">Imported history</small>}<time dateTime={comment.createdAt} title={longDateTime(comment.createdAt)}>{relativeTime(comment.createdAt)}</time>{comment.source === "native" && comment.updatedAt !== comment.createdAt && <small>edited</small>}
        <details className="comment-menu"><summary aria-label="Comment actions"><MoreHorizontal size={14} /></summary><div>
          <button type="button" onClick={() => copyCommentPermalink(comment.id)}>Copy link</button>
          {comment.permissions.canEdit && <button type="button" onClick={() => setEditing(true)}>Edit</button>}
          {comment.permissions.canDelete && <button type="button" onClick={() => { if (window.confirm("Delete this comment?")) void onDelete(comment); }}>Delete</button>}
        </div></details>
      </header>
      {comment.historical?.quotedText && <blockquote className="historical-comment-quote">{comment.historical.quotedText}</blockquote>}
      {comment.deletedAt ? <p className="comment-tombstone">Comment deleted</p> : editing ? <div className="comment-edit"><CommentAttachmentAuthoring taskId={taskId} value={editBody} onChange={setEditBody} textareaRef={editRef} disabled={busy} onBlockingChange={setEditUploadBlocked}><textarea ref={editRef} value={editBody} onChange={(event) => setEditBody(event.target.value)} rows={4} autoFocus /></CommentAttachmentAuthoring><div><button className="button ghost" type="button" onClick={() => { setEditBody(comment.body); setEditing(false); }}>Cancel</button><button className="button primary" type="button" disabled={busy || editUploadBlocked || !editBody.trim()} onClick={() => void onEdit(comment, editBody).then((saved) => { if (saved) setEditing(false); })}>{editUploadBlocked ? "Upload pending" : "Save"}</button></div></div> : <><CommentMarkdown taskId={taskId} body={body} />{long && <button className="comment-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "Show more"}</button>}</>}
      {!comment.deletedAt && <div className="comment-actions">
        {comment.reactions.map((reaction) => <button key={reaction.emoji} className={reaction.reactedByCurrentUser ? "active" : ""} type="button" disabled={!comment.permissions.canReact || busy} onClick={() => void onReact(comment, reaction.emoji, !reaction.reactedByCurrentUser)}>{reaction.emoji} <span>{reaction.count}</span></button>)}
        {comment.permissions.canReact && ["👍", "❤️", "🎉"].filter((emoji) => !comment.reactions.some((reaction) => reaction.emoji === emoji)).map((emoji) => <button className="reaction-add" key={emoji} type="button" disabled={busy} aria-label={`React ${emoji}`} onClick={() => void onReact(comment, emoji, true)}>{emoji}</button>)}
        {isRoot && comment.permissions.canReact && <button type="button" disabled={busy} onClick={() => onReply(rootId)}>Reply</button>}
        {isRoot && comment.permissions.canResolve && <button type="button" disabled={busy} onClick={() => void onResolve(comment, !comment.resolvedAt)}>{comment.resolvedAt ? "Reopen" : "Resolve"}</button>}
      </div>}
    </div>
  </div>;
}

export function CommentMarkdown({ taskId, body }: { taskId: string; body: string }) {
  const attachments = useCommentAttachmentMetadata(body);
  return <MarkdownBody body={body} className="comment-body" taskId={taskId} attachments={attachments} />;
}

export function TaskDescriptionMarkdown({
  task,
  body,
  className,
}: {
  task: TaskRecord;
  body: string;
  className: string;
}) {
  const [attachmentState, setAttachmentState] = useState<{
    key: string;
    records: Map<string, PublicAttachmentRecord>;
  }>({ key: "", records: new Map() });
  const attachmentRefKey = [...new Set(
    parseTaskAttachmentReferences(body).map((reference) => reference.ref),
  )].sort().join(",");

  useEffect(() => {
    if (!attachmentRefKey) return;
    const controller = new AbortController();
    const requestedRefs = new Set(attachmentRefKey.split(","));
    void fetch(`/api/tasks/${encodeURIComponent(task.id)}/attachments`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await response.json() as
          | { attachments: PublicAttachmentRecord[] }
          | { error?: string };
        if (!response.ok || !("attachments" in value)) {
          throw new Error("Native attachments could not be loaded");
        }
        setAttachmentState({
          key: attachmentRefKey,
          records: new Map(value.attachments
            .filter((attachment) => requestedRefs.has(attachment.ref))
            .map((attachment) => [attachment.ref, attachment])),
        });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAttachmentState({ key: attachmentRefKey, records: new Map() });
      });
    return () => controller.abort();
  }, [attachmentRefKey, task.id, task.attachmentInvalidationCursor]);

  const attachments = attachmentState.key === attachmentRefKey
    ? attachmentState.records
    : null;
  return <MarkdownBody body={body} className={className} taskId={task.id} attachments={attachments} />;
}

export function MarkdownBody({
  body,
  className,
  taskId,
  attachments,
}: {
  body: string;
  className: string;
  taskId?: string;
  attachments?: Map<string, PublicAttachmentRecord> | null;
}) {
  const lines = parseTaskMarkdownLines(body);
  const blocks: React.ReactNode[] = [];
  let code: string[] | null = null;
  let list: { ordered: boolean; items: React.ReactNode[]; key: number } | null = null;

  function flushList() {
    if (!list) return;
    const current = list;
    blocks.push(current.ordered
      ? <ol key={`list-${current.key}`}>{current.items}</ol>
      : <ul key={`list-${current.key}`}>{current.items}</ul>);
    list = null;
  }

  function appendListItem(ordered: boolean, item: React.ReactNode, key: number) {
    if (!list || list.ordered !== ordered) {
      flushList();
      list = { ordered, items: [], key };
    }
    list.items.push(<li key={key}>{item}</li>);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const markdownLine = lines[index]!;
    const line = markdownLine.text;
    if (markdownLine.kind === "fence") {
      if (code) {
        blocks.push(<pre key={`code-${index}`}><code>{code.join("\n")}</code></pre>);
        code = null;
      } else {
        flushList();
        code = [];
      }
      continue;
    }
    if (markdownLine.kind === "code") {
      if (!code) code = [];
      code.push(line);
      continue;
    }
    const nativeImage = taskId ? parseTaskImageLine(line) : null;
    if (nativeImage) {
      flushList();
      blocks.push(
        <TaskDescriptionImage
          key={`image-${index}-${nativeImage.ref}`}
          taskId={taskId!}
          attachment={attachments === null || attachments === undefined
            ? undefined
            : attachments.get(nativeImage.ref) ?? null}
          alt={nativeImage.alt}
          caption={nativeImage.caption}
          width={nativeImage.width}
        />,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const checklist = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (checklist) {
      appendListItem(false, <label className="markdown-checklist-item"><input type="checkbox" checked={checklist[1].toLowerCase() === "x"} readOnly disabled /><span>{renderMarkdownInline(checklist[2], taskId, attachments)}</span></label>, index);
    } else if (bullet) {
      appendListItem(false, renderMarkdownInline(bullet[1], taskId, attachments), index);
    } else if (ordered) {
      appendListItem(true, renderMarkdownInline(ordered[1], taskId, attachments), index);
    } else {
      flushList();
      if (heading) {
        if (heading[1].length === 1) blocks.push(<h2 key={index}>{renderMarkdownInline(heading[2], taskId, attachments)}</h2>);
        else if (heading[1].length === 2) blocks.push(<h3 key={index}>{renderMarkdownInline(heading[2], taskId, attachments)}</h3>);
        else blocks.push(<h4 key={index}>{renderMarkdownInline(heading[2], taskId, attachments)}</h4>);
      } else if (line.startsWith("> ")) {
        blocks.push(<blockquote key={index}>{renderMarkdownInline(line.slice(2), taskId, attachments)}</blockquote>);
      } else if (line.trim()) {
        blocks.push(<p key={index}>{renderMarkdownInline(line, taskId, attachments)}</p>);
      }
    }
  }
  if (code) blocks.push(<pre key="code-final"><code>{code.join("\n")}</code></pre>);
  flushList();
  return <div className={className}>{blocks}</div>;
}

export function renderMarkdownInline(
  value: string,
  taskId?: string,
  attachments?: Map<string, PublicAttachmentRecord> | null,
) {
  const nodes: React.ReactNode[] = [];
  for (const token of parseTaskMarkdownInlineTokens(value)) {
    if (token.kind === "code") {
      nodes.push(<code key={token.start}>{token.text}</code>);
    } else {
      nodes.push(...renderMarkdownInlineText(
        token.text,
        token.start,
        taskId,
        attachments,
      ));
    }
  }
  return nodes;
}

export function renderMarkdownInlineText(
  value: string,
  keyOffset: number,
  taskId?: string,
  attachments?: Map<string, PublicAttachmentRecord> | null,
) {
  const pattern = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const nodes: React.ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > offset) nodes.push(value.slice(offset, match.index));
    const token = match[0];
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const escaped = isTaskMarkdownEscaped(value, match.index) ||
        (match.index > 0 && value[match.index - 1] === "!");
      const nativeFile = taskId && !escaped ? parseTaskFileToken(token) : null;
      if (nativeFile) {
        nodes.push(
          <TaskDescriptionFileLink
            key={keyOffset + match.index}
            taskId={taskId!}
            attachment={attachments === null || attachments === undefined
              ? undefined
              : attachments.get(nativeFile.ref) ?? null}
            label={nativeFile.label}
          />,
        );
      } else if (!escaped) {
        const href = safeMarkdownHref(link[2]);
        nodes.push(href ? <a key={keyOffset + match.index} href={href} target="_blank" rel="noreferrer">{link[1]}</a> : token);
      } else nodes.push(token);
    } else if (token.startsWith("**")) nodes.push(<strong key={keyOffset + match.index}>{token.slice(2, -2)}</strong>);
    else nodes.push(<em key={keyOffset + match.index}>{token.slice(1, -1)}</em>);
    offset = match.index + token.length;
  }
  if (offset < value.length) nodes.push(value.slice(offset));
  return nodes;
}

export function safeMarkdownHref(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

export function formatCommentSelection(textarea: HTMLTextAreaElement | null, setValue: (value: string) => void, before: string, after = before) {
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const next = `${textarea.value.slice(0, start)}${before}${textarea.value.slice(start, end)}${after}${textarea.value.slice(end)}`;
  setValue(next);
  window.setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(start + before.length, end + before.length);
  }, 0);
}

export function prefixCommentLines(textarea: HTMLTextAreaElement | null, setValue: (value: string) => void, prefix: string) {
  if (!textarea) return;
  const start = textarea.selectionStart;
  const lineStart = textarea.value.lastIndexOf("\n", start - 1) + 1;
  setValue(`${textarea.value.slice(0, lineStart)}${prefix}${textarea.value.slice(lineStart)}`);
  window.setTimeout(() => textarea.focus(), 0);
}

export async function fetchCommentJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = await response.json() as T | { error: string };
  if (!response.ok || (value && typeof value === "object" && "error" in value)) {
    throw new Error(value && typeof value === "object" && "error" in value ? value.error : "Comment request failed");
  }
  return value as T;
}

export function copyCommentPermalink(commentId: string) {
  const url = new URL(window.location.href);
  url.hash = `comment-${commentId}`;
  void navigator.clipboard.writeText(url.toString());
}

export function relativeTime(value: string) {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of ranges) if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  return formatter.format(seconds, "second");
}

export function avatarHue(value: string) {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

export function PropertyValue({ label, value }: { label: string; value: string }) {
  return <div className="property-row read-only"><span>{label}</span><b>{value}</b></div>;
}

export function DetailsSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <section className="details-section"><h2>{icon}{title}</h2>{children}</section>; }
export function TaskReference({ label, task, onOpen }: { label: string; task: TaskRecord; onOpen: (id: string) => void }) { return <a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, () => onOpen(task.id))}><small>{label}</small><span>{task.identifier}</span><b>{task.title}</b></a>; }

export function PropertyRow({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) { return <label className="property-row"><span>{icon}{label}</span>{children}</label>; }
export function PropertySelect({ icon, value, onChange, children, disabled }: { icon: React.ReactNode; value: string; onChange: (value: string) => void; children: React.ReactNode; disabled?: boolean }) { return <label className="property-select">{icon}<select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>{children}</select><ChevronDown size={11} /></label>; }

export function LabelChip({ label }: { label: LabelRecord }) {
  return <span className={`label-chip ${label.archivedAt ? "archived" : ""}`} style={{ "--label-color": label.color } as React.CSSProperties} title={label.description || label.name}>{label.name}</span>;
}

export function toggleLabelSelection(
  current: ReadonlySet<string>,
  labelId: string,
  labels: readonly LabelRecord[],
): Set<string> {
  const next = new Set(current);
  if (next.has(labelId)) {
    next.delete(labelId);
    return next;
  }
  const selected = labels.find((label) => label.id === labelId);
  if (selected?.groupId) {
    for (const label of labels) if (label.groupId === selected.groupId) next.delete(label.id);
  }
  next.add(labelId);
  return next;
}

export function LabelPicker({ labels, selected, onToggle, disabled, label }: { labels: LabelRecord[]; selected: ReadonlySet<string>; onToggle: (labelId: string) => void; disabled?: boolean; label: string }) {
  const [query, setQuery] = useState("");
  const selectedLabels = labels.filter((item) => selected.has(item.id));
  const assignable = labels.filter((item) => !item.archivedAt || selected.has(item.id));
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle
    ? assignable.filter((item) => `${item.name}\n${item.description}`.toLocaleLowerCase().includes(needle))
    : assignable;
  return <div className="label-picker"><div className="label-chip-list">{selectedLabels.map((item) => <LabelChip key={item.id} label={item} />)}{selectedLabels.length === 0 && <span className="muted-value">No labels</span>}</div><details><summary aria-label={label}><Tag size={13} />{selected.size ? `${selected.size} selected` : "Add labels"}<ChevronDown size={11} /></summary><div className="label-picker-menu" role="listbox" aria-multiselectable="true"><label className="label-picker-search"><Search size={13} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search labels…" aria-label="Search labels" /></label>{visible.length ? visible.map((item) => <label key={item.id} title={item.description || item.name}><input type="checkbox" checked={selected.has(item.id)} disabled={disabled || Boolean(item.archivedAt && !selected.has(item.id))} onChange={() => onToggle(item.id)} /><span className="label-color-dot" style={{ background: item.color }} /> <span>{item.name}</span>{item.archivedAt && <small>Archived</small>}</label>) : <p>{assignable.length ? "No matching labels." : "No active labels in this catalog."}</p>}</div></details></div>;
}


export function EmptyState({ entity = "task", onCreate }: { entity?: "task" | "project" | "release"; onCreate?: () => void }) { const labels = { task: ["No tasks here", "There is no work in this view yet."], project: ["No projects yet", "Create a project to group work around an outcome."], release: ["No releases yet", "There are no releases in this scope yet."] }; return <div className="empty-state"><div className="empty-illustration"><span /><span /><span /></div><h2>{labels[entity][0]}</h2><p>{labels[entity][1]}</p>{onCreate && <button className="button primary" onClick={onCreate}><Plus size={14} />Create {entity}</button>}</div>; }

export type TaskHierarchySummary = {
  parent?: TaskRecord;
  subtaskCount: number;
};
export const EMPTY_TASK_HIERARCHY_SUMMARY: TaskHierarchySummary = { subtaskCount: 0 };

export function wouldCreateHierarchyCycle(
  taskId: string,
  candidateParentId: string,
  tasks: ReadonlyMap<string, TaskRecord>,
): boolean {
  const visited = new Set<string>();
  let current: string | null = candidateParentId;
  while (current) {
    if (current === taskId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    current = tasks.get(current)?.parentTaskId ?? null;
  }
  return false;
}

export function taskHierarchySummary(
  task: TaskRecord,
  tasks: readonly TaskRecord[],
): TaskHierarchySummary {
  return buildTaskHierarchySummaries(tasks).get(task.id)
    ?? EMPTY_TASK_HIERARCHY_SUMMARY;
}

export function buildTaskHierarchySummaries(
  tasks: readonly TaskRecord[],
): Map<string, TaskHierarchySummary> {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const subtaskCounts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    subtaskCounts.set(
      task.parentTaskId,
      (subtaskCounts.get(task.parentTaskId) ?? 0) + 1,
    );
  }
  return new Map(tasks.map((task) => [task.id, {
    parent: task.parentTaskId ? tasksById.get(task.parentTaskId) : undefined,
    subtaskCount: subtaskCounts.get(task.id) ?? 0,
  }]));
}

export function TaskHierarchyChip({ hierarchy }: { hierarchy: TaskHierarchySummary }) {
  if (hierarchy.parent) {
    return <span className="metadata-chip hierarchy-chip" title={`Subtask of ${hierarchy.parent.identifier} · ${hierarchy.parent.title}`}><Boxes size={12} />{hierarchy.parent.identifier}</span>;
  }
  if (hierarchy.subtaskCount > 0) {
    return <span className="metadata-chip hierarchy-chip" title={`${hierarchy.subtaskCount} direct subtask${hierarchy.subtaskCount === 1 ? "" : "s"}`}><Boxes size={12} />{hierarchy.subtaskCount}</span>;
  }
  return null;
}


export function labelsForTask(
  context: Pick<AppSnapshot, "labels" | "taskLabels">,
  taskId: string,
) {
  const ids = new Set(context.taskLabels
    .filter((assignment) => assignment.taskId === taskId)
    .map((assignment) => assignment.labelId));
  return context.labels.filter((label) => ids.has(label.id));
}
