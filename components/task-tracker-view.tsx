"use client";

import {
  Archive,
  ArchiveRestore,
  Boxes,
  ChevronRight,
  Circle,
  CircleHelp,
  CircleDot,
  Download,
  FolderKanban,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Rocket,
  RotateCw,
  Search,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import {
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  canEditContent,
} from "@/lib/access";
import {
  navigationPath,
  taskPath,
  type Layout,
  type ResolvedNavigation,
  type SettingsSection,
} from "@/lib/navigation";
import {
  emptyGlobalSearchResponse,
  flattenGlobalSearchResults,
  mergeGlobalSearchResponses,
  nextGlobalSearchHighlight,
  type GlobalSearchEntityType,
  type GlobalSearchResponse,
  type GlobalSearchResult,
} from "@/lib/global-search";
import {
  formatReleaseName,
} from "@/lib/release-presentation";
import {
  selectRecentNavigation,
} from "@/lib/recent-navigation";
import {
  sharedWithMeRoots,
} from "@/lib/workspace-scope";
import {
  taskMutationVersion,
} from "@/lib/task-detail-reconciliation";
import {
  type ContextualActionEntity,
} from "@/lib/contextual-actions";
import type {
  AdminOverview,
  AccessRole,
  AppSnapshot,
  LabelRecord,
  Priority,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  TeamDetail,
  TeamList,
  TeamMembershipRecord,
  TaskRecord,
  UserRecord,
  ViewDisplay,
  WorkflowStatusRecord,
} from "@/lib/types";
import {
  builtInViews,
  filterTeamList,
  priorityMeta,
  resolveArchiveBulkAction,
  type AsyncValue,
  type ShareContext,
  type ShareTarget,
  type TeamMutationState,
  type TeamShareRoute,
} from "@/components/task-tracker-state";

import {
  DialogHeader,
  Modal,
  ProjectIcon,
  handleLocalLink,
  initials,
  projectStatusLabel,
  settingsNavigation,
  shortDate,
  zonedDateTime,
} from "@/components/task-tracker-dialogs";

import {
  EmptyState,
  LabelChip,
  MarkdownBody,
  StatusIcon,
  TaskHierarchyChip,
  WorkspaceScopeSelector,
  type TaskHierarchySummary,
} from "@/components/task-tracker-tasks";

export {
  AppearanceSettingsPanel,
  CodexSetupDialog,
  DialogFooter,
  DialogHeader,
  DisplayPopover,
  FOCUSABLE_SELECTOR,
  FilterChips,
  FilterConditionEditor,
  FilterLayerSummary,
  FilterPopover,
  FilterValueEditor,
  LabelGroupSettingsDialog,
  LabelSettingsDialog,
  Modal,
  Popover,
  ProfileSettingsPanel,
  ProjectDialog,
  ProjectIcon,
  ReleaseDialog,
  SavedFilterChips,
  SavedViewFilterLayers,
  SettingsSectionHeader,
  SettingsSurface,
  SetupCopyBlock,
  SetupStep,
  ShareDialog,
  SystemBackupExportDialog,
  SystemBackupPreview,
  SystemBackupProgress,
  SystemImportDialog,
  TeamGrantAccessRow,
  ViewDialog,
  ViewDisplayEditor,
  WorkflowSettingsDialog,
  backupByteSize,
  backupOriginLabel,
  backupPhaseLabel,
  browserSessionStorage,
  canManageTeamRouteGrant,
  clearBackupStatus,
  comparableViewDialogDraft,
  confirmReleasedCompositionChange,
  defaultFilterCondition,
  displayLabel,
  emptyAsyncValue,
  filterConditionSummary,
  filterConditionValue,
  filterFieldOptions,
  filterOperatorLabels,
  filterOperators,
  handleFilterPickerEscape,
  handleLocalLink,
  initials,
  isOverdue,
  longDate,
  longDateTime,
  normalizedTeamSharePermission,
  projectStatusLabel,
  projectStatusOptions,
  queryFilterCount,
  releaseStatusOptions,
  releasedCompositionNeedsConfirmation,
  rememberBackupStatus,
  roleLabel,
  settingsNavigation,
  sharePersonOptions,
  shortDate,
  supportedTimeZones,
  teamRouteRoles,
  trapFocus,
  type LabelGroupSettingsRecord,
  type LabelSettingsRecord,
  type ViewDialogDraft,
  type WorkflowSettingsStatus,
  validShareEmail,
  viewDialogDraftIsDirty,
  viewDialogDraftQuery,
  workflowCategoryLabels,
  zonedDateTime,
} from "@/components/task-tracker-dialogs";
export {
  ActivityTimelineEvent,
  CommentEntry,
  CommentMarkdown,
  CommentThread,
  DetailsSection,
  EMPTY_TASK_HIERARCHY_SUMMARY,
  EmptyState,
  FileAttachmentIcon,
  LabelChip,
  LabelPicker,
  MarkdownBody,
  NavItem,
  PropertyRow,
  PropertySelect,
  PropertyValue,
  PullRefreshIndicator,
  ReadOnlyTaskDetails,
  RotateComposerIcon,
  SidebarSavedViewItem,
  SidebarSection,
  StatusIcon,
  TaskActivity,
  TaskBoard,
  TaskBoardCard,
  TaskComposer,
  TaskDescriptionMarkdown,
  TaskDetails,
  TaskDetailsLoading,
  TaskGroupIcon,
  TaskHierarchyChip,
  TaskList,
  TaskMoveDialog,
  TaskReference,
  TaskRelations,
  TaskRow,
  TaskStatusControl,
  WorkspaceScopeSelector,
  activityEventFallback,
  activityEventLabel,
  activityFieldLabel,
  activityValue,
  avatarHue,
  buildTaskHierarchySummaries,
  canCreateInTaskGroup,
  composerAttachmentStatus,
  composerAttachmentWithStoredFile,
  copyCommentPermalink,
  fetchCommentJson,
  formatCommentSelection,
  formatComposerBytes,
  hasNestedScrollContainer,
  labelsForTask,
  prefixCommentLines,
  readComposerRecoveryState,
  recoveredComposerAttachment,
  relationCandidateAllowedForKind,
  relationSelectionAfterKindChange,
  relativeRelationKind,
  relativeRelationSemantic,
  relativeTime,
  renderMarkdownInline,
  renderMarkdownInlineText,
  safeMarkdownHref,
  statusIconVariant,
  statusProgress,
  taskAssigneeOptions,
  taskHierarchySummary,
  taskStatusOptions,
  toggleLabelSelection,
  type ComposerAttachment,
  type ComposerRecoveryState,
  type StatusIconVariant,
  type TaskHierarchySummary,
  wouldCreateHierarchyCycle,
} from "@/components/task-tracker-tasks";

export type BreadcrumbItem = {
  label: string;
  surface?: string;
  layout?: Layout;
};

export const globalSearchSections: Array<{
  key: keyof GlobalSearchResponse["groups"];
  type: GlobalSearchEntityType;
  label: string;
}> = [
  { key: "tasks", type: "task", label: "Tasks" },
  { key: "projects", type: "project", label: "Projects" },
  { key: "releases", type: "release", label: "Releases" },
  { key: "views", type: "view", label: "Views" },
];

export function GlobalSearchResultIcon({ type }: { type: GlobalSearchEntityType }) {
  if (type === "task") return <CircleDot size={15} />;
  if (type === "project") return <FolderKanban size={15} />;
  if (type === "release") return <Rocket size={15} />;
  return <Zap size={15} />;
}

export function resolveGlobalSearchNavigation(
  result: GlobalSearchResult,
  data: Pick<AppSnapshot, "projects" | "releases" | "views">,
  current: ResolvedNavigation,
): ResolvedNavigation | null {
  if (result.type === "task") {
    return { ...current, taskId: result.id };
  }
  if (result.type === "project") {
    return data.projects.some((project) => project.id === result.id)
      ? { surface: `project:${result.id}`, layout: "list", taskId: null }
      : null;
  }
  if (result.type === "release") {
    return data.releases.some((release) => release.id === result.id)
      ? { surface: `release:${result.id}`, layout: "list", taskId: null }
      : null;
  }
  const view = data.views.find((item) => item.id === result.id && !item.archivedAt);
  return view
    ? { surface: `view:${view.id}`, layout: view.display.layout, taskId: null }
    : null;
}

export function GlobalSearchContinuationWarning({
  busy,
  onRetry,
}: {
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="global-search-partial continuation" role="alert">
      <span>Couldn’t load more results. Loaded matches are still available.</span>
      <button className="button ghost" type="button" disabled={busy} onClick={onRetry}>
        {busy ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

export function GlobalSearchOverlay({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (result: GlobalSearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<GlobalSearchResponse>(() => emptyGlobalSearchResponse());
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const [continuationError, setContinuationError] = useState<{
    query: string;
    cursor: string;
  } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef("");
  const results = flattenGlobalSearchResults(response);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      // A blank overlay is a prompt, not a request for an unbounded suggestion set.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResponse(emptyGlobalSearchResponse());
      setStatus("idle");
      setContinuationError(null);
      setHighlighted(0);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus("loading");
      void fetch(`/api/search?query=${encodeURIComponent(trimmed)}&limit=8`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (searchResponse) => {
        const value = await searchResponse.json() as GlobalSearchResponse | { error?: string };
        if (!searchResponse.ok || !("groups" in value)) {
          throw new Error("Workspace search is temporarily unavailable");
        }
        setResponse(value);
        setStatus(value.partialErrors.length === globalSearchSections.length ? "error" : "ready");
        setContinuationError(null);
        setHighlighted(0);
      }).catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setResponse(emptyGlobalSearchResponse(trimmed));
        setStatus("error");
        setContinuationError(null);
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function loadMore(cursor = response.nextCursor) {
    if (!cursor || loadingMore) return;
    const requestedQuery = response.query;
    const requestedCursor = cursor;
    setContinuationError(null);
    setLoadingMore(true);
    try {
      const next = await fetch(
        `/api/search?query=${encodeURIComponent(requestedQuery)}&limit=8&cursor=${encodeURIComponent(requestedCursor)}`,
        { cache: "no-store" },
      );
      const value = await next.json() as GlobalSearchResponse | { error?: string };
      if (!next.ok || !("groups" in value)) throw new Error("Search continuation failed");
      if (queryRef.current === requestedQuery) {
        setResponse((current) => current.query === requestedQuery
          ? mergeGlobalSearchResponses(current, value)
          : current);
        setContinuationError(null);
      }
    } catch {
      if (queryRef.current === requestedQuery) {
        setContinuationError({ query: requestedQuery, cursor: requestedCursor });
      }
    } finally {
      setLoadingMore(false);
    }
  }

  function handleKey(event: ReactKeyboardEvent<HTMLDialogElement>) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => nextGlobalSearchHighlight(current, "next", results.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => nextGlobalSearchHighlight(current, "previous", results.length));
      return;
    }
    if (event.key === "Enter" && results[highlighted]) {
      event.preventDefault();
      onOpen(results[highlighted]);
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'input, a[href], button:not([disabled])',
      ) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  let resultIndex = -1;
  return (
    <div className="global-search-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <dialog ref={dialogRef} className="global-search-dialog" aria-modal="true" aria-label="Global search" open onKeyDown={handleKey}>
        <header className="global-search-input-row">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              queryRef.current = nextQuery.trim().toLowerCase();
              setResponse(emptyGlobalSearchResponse(queryRef.current));
              setStatus(nextQuery.trim() ? "loading" : "idle");
              setContinuationError(null);
              setHighlighted(0);
            }}
            placeholder="Search tasks, projects, releases, and views…"
            aria-label="Global search query"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="global-search-results"
            aria-activedescendant={results[highlighted] ? `global-search-result-${results[highlighted].type}-${results[highlighted].id}` : undefined}
            autoComplete="off"
          />
          {query && <button className="icon-button" type="button" aria-label="Clear global search" onClick={() => setQuery("")}><X size={15} /></button>}
          <kbd>Esc</kbd>
        </header>
        <div className="global-search-results" id="global-search-results" role="listbox" aria-label="Global search results">
          {status === "idle" && <div className="global-search-state"><Search size={22} /><b>Search your workspace</b><span>Tasks, Projects, Releases, and Views</span></div>}
          {status === "loading" && <div className="global-search-state" aria-live="polite"><span className="global-search-spinner" /><b>Searching…</b></div>}
          {status === "error" && <div className="global-search-state" role="alert"><CircleHelp size={22} /><b>Search is temporarily unavailable</b><span>Try again without changing your current view.</span></div>}
          {status === "ready" && results.length === 0 && <div className="global-search-state"><Search size={22} /><b>No accessible results</b><span>Try another title or Task identifier.</span></div>}
          {status === "ready" && response.partialErrors.length > 0 && <p className="global-search-partial" role="status">Some results could not be loaded. Available matches are shown below.</p>}
          {status === "ready" && continuationError?.query === response.query && (
            <GlobalSearchContinuationWarning
              busy={loadingMore}
              onRetry={() => void loadMore(continuationError.cursor)}
            />
          )}
          {status === "ready" && globalSearchSections.map((section) => {
            const items = response.groups[section.key] as GlobalSearchResult[];
            if (!items.length) return null;
            return (
              <section className="global-search-group" role="group" aria-label={section.label} key={section.key}>
                <h2>{section.label}</h2>
                {items.map((item) => {
                  resultIndex += 1;
                  const index = resultIndex;
                  return (
                    <a
                      id={`global-search-result-${item.type}-${item.id}`}
                      key={`${item.type}:${item.id}`}
                      className={`global-search-result ${index === highlighted ? "highlighted" : ""}`}
                      href={item.href}
                      role="option"
                      aria-selected={index === highlighted}
                      onMouseEnter={() => setHighlighted(index)}
                      onClick={(event) => handleLocalLink(event, () => onOpen(item))}
                    >
                      <span className="global-search-result-icon"><GlobalSearchResultIcon type={item.type} /></span>
                      <span className="global-search-result-copy">
                        <b>{item.type === "task" ? <><code>{item.identifier}</code><span>{item.title}</span></> : item.title}</b>
                        <small>{item.context}</small>
                      </span>
                      <kbd>↵</kbd>
                    </a>
                  );
                })}
              </section>
            );
          })}
        </div>
        <footer className="global-search-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          {response.nextCursor && <button className="button ghost" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button>}
          <span><kbd>↵</kbd> Open</span>
        </footer>
      </dialog>
    </div>
  );
}

export function WorkspaceOverviewSurface({
  data,
  focusedData,
  statusMap,
  projectMap,
  workspaceScopeToken,
  workspaceScopeLoading,
  onWorkspaceScopeChange,
  onOpen,
  onOpenTask,
  onCreateTask,
  onCreateProject,
  onCreateRelease,
}: {
  data: AppSnapshot;
  focusedData: AppSnapshot;
  statusMap: Map<string, WorkflowStatusRecord>;
  projectMap: Map<string, ProjectRecord>;
  workspaceScopeToken: string;
  workspaceScopeLoading: boolean;
  onWorkspaceScopeChange: (token: string) => void;
  onOpen: (surface: string, layout?: Layout) => void;
  onOpenTask: (taskId: string) => void;
  onCreateTask: () => void;
  onCreateProject: () => void;
  onCreateRelease: () => void;
}) {
  const openTasks = focusedData.tasks.filter((task) => !task.archivedAt);
  const activeCount = focusedData.workspaceMetrics?.taskCounts.active ?? openTasks.filter((task) => {
    const category = statusMap.get(task.statusId)?.category;
    return category === "unstarted" || category === "started";
  }).length;
  const backlogCount = focusedData.workspaceMetrics?.taskCounts.backlog ?? openTasks.filter(
    (task) => statusMap.get(task.statusId)?.category === "backlog",
  ).length;
  const recentTasks = [...openTasks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
  const recentProjects = selectRecentNavigation(
    focusedData.navigationCollections?.projects.items ?? focusedData.projects,
  );
  const recentReleases = selectRecentNavigation(
    focusedData.navigationCollections?.releases.items ?? focusedData.releases,
  );
  const recentViews = selectRecentNavigation(
    focusedData.navigationCollections?.views.items ?? focusedData.views,
  );
  const { projects: sharedProjects, views: sharedViews } = sharedWithMeRoots(data);
  const sharedCount = sharedProjects.length + sharedViews.length;
  const isEmpty =
    openTasks.length === 0 &&
    (focusedData.navigationCollections?.projects.total ?? focusedData.projects.length) === 0 &&
    (focusedData.navigationCollections?.releases.total ?? focusedData.releases.length) === 0 &&
    (focusedData.navigationCollections?.views.total ?? focusedData.views.length) === 0 &&
    sharedCount === 0;
  const canCreateRelease = focusedData.projects.some((project) => canEditContent(project.accessRole));
  const scopeOptions = focusedData.workspaceScope?.options ?? data.workspaceScope?.options ?? [];
  const scopeLabel = scopeOptions.find((option) => option.token === workspaceScopeToken)?.label ?? "My";

  return (
    <div className="workspace-overview">
      {scopeOptions.length > 0 && (
        <div className="workspace-focus-row">
          <div>
            <b>Workspace focus</b>
            <span>{scopeLabel === "My" ? "Only resources you own" : "Every resource you can access"}</span>
          </div>
          <WorkspaceScopeSelector
            value={workspaceScopeToken}
            options={scopeOptions}
            busy={workspaceScopeLoading}
            onChange={onWorkspaceScopeChange}
          />
        </div>
      )}
      {isEmpty && (
        <section className="workspace-empty-banner" aria-labelledby="workspace-empty-title">
          <span className="workspace-empty-icon"><Boxes size={20} /></span>
          <div>
            <h2 id="workspace-empty-title">Your workspace is ready</h2>
            <p>Create a task or project to start organizing work. Every section will stay scoped to resources you can access.</p>
          </div>
          <div className="workspace-empty-actions">
            <button className="button primary" type="button" onClick={onCreateTask}><Plus size={14} />New task</button>
            <button className="button ghost" type="button" onClick={onCreateProject}><FolderKanban size={14} />New project</button>
          </div>
        </section>
      )}

      <section className="workspace-section" aria-labelledby="workspace-my-work">
        <WorkspaceSectionHeader
          id="workspace-my-work"
          title="Focused work"
          description={`${scopeLabel} resources inside Workspace only.`}
          href="/issues"
          label="My tasks"
          onOpen={() => onOpen("mine")}
        />
        <div className="workspace-metrics">
          <WorkspaceMetric label="Active" value={activeCount} icon={<Zap size={16} />} />
          <WorkspaceMetric label="Backlog" value={backlogCount} icon={<Inbox size={16} />} />
          <WorkspaceMetric label="Projects" value={focusedData.navigationCollections?.projects.total ?? focusedData.projects.length} icon={<FolderKanban size={16} />} />
          <WorkspaceMetric href="/shared" label="Shared with me" value={sharedCount} icon={<UsersRound size={16} />} onOpen={() => onOpen("shared")} />
        </div>
        <div className="workspace-panel workspace-recent-panel">
          <div className="workspace-panel-title"><h3>Recent tasks</h3><button className="button ghost compact" type="button" onClick={onCreateTask}><Plus size={13} />New task</button></div>
          {recentTasks.length ? (
            <ul className="workspace-record-list">
              {recentTasks.map((task) => {
                const status = statusMap.get(task.statusId);
                return (
                  <li key={task.id}>
                    <a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, () => onOpenTask(task.id))}>
                      <span className="workspace-record-icon">{status ? <StatusIcon status={status} /> : <Circle size={13} />}</span>
                      <span className="workspace-record-copy"><b>{task.title}</b><small>{task.identifier} · {status?.name ?? "Unknown status"}</small></span>
                      <time dateTime={task.updatedAt}>{shortDate(task.updatedAt.slice(0, 10))}</time>
                      <ChevronRight size={14} aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <WorkspaceSectionEmpty title="No recent tasks" description="Tasks you create or can access will appear here." />
          )}
        </div>
      </section>

      <div className="workspace-overview-grid">
        <section className="workspace-section workspace-panel" aria-labelledby="workspace-projects">
          <WorkspaceSectionHeader id="workspace-projects" title="Projects" description="Owned and shared outcomes." href="/projects" label="All projects" onOpen={() => onOpen("projects")} />
          {recentProjects.length ? (
            <ul className="workspace-record-list">
              {recentProjects.map((project) => {
                const tasks = openTasks.filter((task) => task.projectId === project.id);
                return (
                  <li key={project.id}>
                    <a href={`/projects/${encodeURIComponent(project.publicId)}`} onClick={(event) => handleLocalLink(event, () => onOpen(`project:${project.id}`))}>
                      <span className="workspace-record-icon" style={{ color: project.color }}><FolderKanban size={15} /></span>
                      <span className="workspace-record-copy"><b>{project.name}</b><small>{tasks.length} tasks · {completion(tasks, focusedData.statuses)}% complete</small></span>
                      {project.accessRole !== "owner" && <span className="status-badge">Shared</span>}
                      <ChevronRight size={14} aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : <WorkspaceSectionEmpty title="No projects yet" description="Create a project to group work around an outcome." />}
          <button className="workspace-create-link" type="button" onClick={onCreateProject}><Plus size={13} />Create project</button>
        </section>

        <section className="workspace-section workspace-panel" aria-labelledby="workspace-releases">
          <WorkspaceSectionHeader id="workspace-releases" title="Releases" description="Current delivery scopes with project context." href="/releases" label="All releases" onOpen={() => onOpen("releases")} />
          {recentReleases.length ? (
            <ul className="workspace-record-list">
              {recentReleases.map((release) => {
                const project = projectMap.get(release.projectId);
                const tasks = openTasks.filter((task) => task.releaseId === release.id);
                const href = project ? `/projects/${encodeURIComponent(project.publicId)}/releases/${encodeURIComponent(release.publicId)}` : "/releases";
                return (
                  <li key={release.id}>
                    <a href={href} onClick={(event) => handleLocalLink(event, () => onOpen(`release:${release.id}`))}>
                      <span className="workspace-record-icon"><Rocket size={15} /></span>
                      <span className="workspace-record-copy"><b>{formatReleaseName(project?.name, release.name)}</b><small>{tasks.length} tasks · {completion(tasks, focusedData.statuses)}% complete</small></span>
                      <span className={`status-badge release-${release.status}`}>{release.status}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : <WorkspaceSectionEmpty title="No releases yet" description="Releases you can access will appear with their project context." />}
          {canCreateRelease && <button className="workspace-create-link" type="button" onClick={onCreateRelease}><Plus size={13} />Create release</button>}
        </section>

        <section className="workspace-section workspace-panel" aria-labelledby="workspace-views">
          <WorkspaceSectionHeader id="workspace-views" title="Saved views" description="Reusable perspectives over accessible tasks." href="/views" label="All views" onOpen={() => onOpen("views")} />
          {recentViews.length ? (
            <ul className="workspace-record-list">
              {recentViews.map((view) => (
                <li key={view.id}>
                  <a href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)} onClick={(event) => handleLocalLink(event, () => onOpen(`view:${view.id}`, view.display.layout))}>
                    <span className="workspace-record-icon"><Zap size={15} /></span>
                    <span className="workspace-record-copy"><b>{view.name}</b><small>{view.scopeProjectId ? "Project-scoped" : "Workspace view"} · {view.display.layout}</small></span>
                    {view.accessRole !== "owner" && <span className="status-badge">Shared</span>}
                    <ChevronRight size={14} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : <WorkspaceSectionEmpty title="No saved views yet" description="Saved filters will appear here without copying tasks." />}
        </section>

        <section className="workspace-section workspace-panel" aria-labelledby="workspace-shared">
          <WorkspaceSectionHeader id="workspace-shared" title="Shared with me" description="Top-level resources other people granted you." href="/shared" label="Open shared" onOpen={() => onOpen("shared")} />
          {sharedCount ? (
            <div className="workspace-shared-summary">
              <WorkspaceSharedCount label="Projects" value={sharedProjects.length} />
              <WorkspaceSharedCount label="Tasks" value={0} />
              <WorkspaceSharedCount label="Views" value={sharedViews.length} />
            </div>
          ) : <WorkspaceSectionEmpty title="Nothing shared yet" description="Resources shared with your account will appear here." />}
        </section>
      </div>
    </div>
  );
}

export function WorkspaceSectionHeader({ id, title, description, href, label, onOpen }: { id: string; title: string; description: string; href: string; label: string; onOpen: () => void }) {
  return <header className="workspace-section-header"><div><h2 id={id}>{title}</h2><p>{description}</p></div><a href={href} onClick={(event) => handleLocalLink(event, onOpen)}>{label}<ChevronRight size={13} aria-hidden="true" /></a></header>;
}

export function WorkspaceMetric({ href, label, value, icon, onOpen }: { href?: string; label: string; value: number; icon: React.ReactNode; onOpen?: () => void }) {
  const content = <><span className="workspace-metric-icon">{icon}</span><span><b>{value}</b><small>{label}</small></span>{href && <ChevronRight size={14} aria-hidden="true" />}</>;
  return href && onOpen
    ? <a className="workspace-metric" href={href} onClick={(event) => handleLocalLink(event, onOpen)}>{content}</a>
    : <div className="workspace-metric">{content}</div>;
}

export function WorkspaceSectionEmpty({ title, description }: { title: string; description: string }) {
  return <div className="workspace-section-empty"><b>{title}</b><p>{description}</p></div>;
}

export function WorkspaceSharedCount({ label, value }: { label: string; value: number }) {
  return <span><b>{value}</b><small>{label}</small></span>;
}

export function SharedWithMeSurface({ data, tasks, statuses, users, onOpenProject, onOpenView, onProjectContextActions }: {
  data: AppSnapshot;
  tasks: TaskRecord[];
  statuses: WorkflowStatusRecord[];
  users: Map<string, UserRecord>;
  onOpenProject: (id: string) => void;
  onOpenView: (view: SavedViewRecord) => void;
  onProjectContextActions: (project: ProjectRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void;
}) {
  const roots = sharedWithMeRoots(data);
  if (!roots.projects.length && !roots.views.length) {
    return <div className="empty-state"><UsersRound size={22} /><h2>Nothing shared yet</h2><p>Projects and global Saved Views granted directly to you will appear here.</p></div>;
  }
  return (
    <div className="shared-roots-surface">
      {roots.projects.length > 0 && (
        <section aria-labelledby="shared-project-roots">
          <header className="shared-roots-heading"><h2 id="shared-project-roots">Projects</h2><p>Project grants include their Tasks, Releases, and project views.</p></header>
          <ProjectsSurface
            projects={roots.projects}
            tasks={tasks}
            statuses={statuses}
            users={users}
            onOpen={onOpenProject}
            onContextActions={onProjectContextActions}
            onCreate={() => undefined}
          />
        </section>
      )}
      {roots.views.length > 0 && (
        <section aria-labelledby="shared-view-roots">
          <header className="shared-roots-heading"><h2 id="shared-view-roots">Global Saved Views</h2><p>Direct view grants never expand access to underlying Tasks.</p></header>
          <div className="entity-grid shared-view-grid">
            {roots.views.map((view) => (
              <a
                className="entity-card"
                key={view.id}
                href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)}
                onClick={(event) => handleLocalLink(event, () => onOpenView(view))}
              >
                <div className="entity-icon"><Zap size={18} /></div>
                <div className="entity-card-copy">
                  <div><h2>{view.name}</h2><span className="status-badge">{view.accessRole}</span></div>
                  <p>Global view · {view.display.layout}</p>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function ViewsSurface({ data, statusMap, onOpen, onContextActions, onRestore, busy }: { data: AppSnapshot; statusMap: Map<string, WorkflowStatusRecord>; onOpen: (surface: string, layout: Layout) => void; onContextActions: (view: SavedViewRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onRestore: (view: SavedViewRecord) => Promise<boolean>; busy: boolean }) {
  const activeViews = data.views.filter((view) => !view.archivedAt);
  const archivedViews = data.views.filter((view) => Boolean(view.archivedAt));
  return <div className="views-collection">
    <div className="entity-grid">
      {builtInViews.map((view) => <a className="entity-card" key={view.id} href={navigationPath({ surface: view.id, layout: "list", taskId: null }, data)} onClick={(event) => handleLocalLink(event, () => onOpen(view.id, "list"))}><div className="entity-icon"><Inbox size={18} /></div><div className="entity-card-copy"><div><h2>{view.label}</h2><span className="status-badge">Built-in</span></div><p>Workspace issue view</p><div className="progress-meta"><span>{taskCountForView(view.id, data, statusMap)} issues</span><span>List or board</span></div></div></a>)}
      {activeViews.map((view) => {
        const editable = canEditContent(view.accessRole);
        return <div className="entity-card-shell" key={view.id}>
          <a
            className="entity-card"
            data-context-entity-kind="saved_view"
            data-context-entity-id={view.id}
            href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)}
            onContextMenu={editable ? (event) => { event.preventDefault(); onContextActions(view, event.clientX, event.clientY, event.currentTarget); } : undefined}
            onClick={(event) => handleLocalLink(event, () => onOpen(`view:${view.id}`, view.display.layout))}
          ><div className="entity-icon"><Zap size={18} /></div><div className="entity-card-copy"><div><h2>{view.name}</h2><span className="status-badge">Saved</span></div><p>{view.scopeProjectId ? "Project-scoped query" : "Workspace query"}</p><div className="progress-meta"><span>{view.display.layout}</span><span>Grouped by {view.display.groupBy}</span></div></div></a>
          {editable && <button className="entity-card-action" type="button" aria-label={`Open actions for ${view.name}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onContextActions(view, rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={16} /></button>}
        </div>;
      })}
    </div>
    {archivedViews.length > 0 && <section className="archived-view-section"><h2>Archived views</h2><div className="entity-grid">{archivedViews.map((view) => <article className="entity-card archived" key={view.id}><div className="entity-icon"><Archive size={18} /></div><div className="entity-card-copy"><div><h2>{view.name}</h2><span className="status-badge">Archived</span></div><p>Unavailable in navigation and direct routes.</p><div className="progress-meta"><span>{view.display.layout}</span>{canEditContent(view.accessRole) && <button className="button ghost compact" type="button" disabled={busy} onClick={() => void onRestore(view)}><ArchiveRestore size={13} />Restore legacy archived view</button>}</div></div></article>)}</div></section>}
  </div>;
}
export function openProjectTaskCount(projectId: string, tasks: TaskRecord[], statuses: Map<string, WorkflowStatusRecord>) {
  return tasks.filter((task) => {
    if (task.projectId !== projectId || task.archivedAt) return false;
    const category = statuses.get(task.statusId)?.category;
    return category !== "completed" && category !== "canceled";
  }).length;
}

export function openReleaseTaskCount(releaseId: string, tasks: TaskRecord[], statuses: Map<string, WorkflowStatusRecord>) {
  return tasks.filter((task) => {
    if (task.releaseId !== releaseId || task.archivedAt) return false;
    const category = statuses.get(task.statusId)?.category;
    return category !== "completed" && category !== "canceled";
  }).length;
}

export function projectMemberOptions(data: AppSnapshot, project: ProjectRecord): UserRecord[] {
  const ids = new Set<string>([project.ownerUserId]);
  for (const collaborator of data.collaborators) {
    if (collaborator.resourceType === "project" && collaborator.resourceId === project.id) {
      ids.add(collaborator.userId);
    }
  }
  return data.users.filter((user) => ids.has(user.id));
}

export function ProjectOverview({ project, lead, tasks, statuses, onEdit }: { project: ProjectRecord; lead?: UserRecord; tasks: TaskRecord[]; statuses: Map<string, WorkflowStatusRecord>; onEdit?: () => void }) {
  const progress = completion(tasks, [...statuses.values()]);
  const openTasks = openProjectTaskCount(project.id, tasks, statuses);
  return <section className={`project-overview ${project.archivedAt ? "archived" : ""}`} aria-label={`${project.name} project summary`}><div className="project-overview-heading"><span className="project-overview-icon" style={{ background: `${project.color}20`, color: project.color }}><ProjectIcon project={project} size={20} /></span><div><span className="project-code">{project.taskCode}</span><h2>{project.name}</h2><p>{project.summary || "No summary yet"}</p></div><div className="project-overview-actions"><span className={`status-badge project-${project.status}`}>{projectStatusLabel(project.status)}</span>{project.archivedAt && <span className="status-badge">Archived</span>}{onEdit && <button className="button ghost compact" onClick={onEdit}>Edit</button>}</div></div><div className="project-overview-metadata"><span><b>{tasks.length}</b> Tasks</span><span><b>{openTasks}</b> open</span><span><b>{progress}%</b> complete</span><span><b>{lead?.displayName ?? "No lead"}</b> lead</span>{project.startDate && <span>Starts <b>{shortDate(project.startDate)}</b></span>}{project.targetDate && <span>Target <b>{shortDate(project.targetDate)}</b></span>}</div>{project.description && <MarkdownBody body={project.description} className="project-description-markdown" />}</section>;
}

export function ReleaseOverview({ release, project, tasks, statuses, onEdit }: { release: ReleaseRecord; project?: ProjectRecord; tasks: TaskRecord[]; statuses: Map<string, WorkflowStatusRecord>; onEdit?: () => void }) {
  const progress = completion(tasks, [...statuses.values()]);
  const openTasks = openReleaseTaskCount(release.id, tasks, statuses);
  const fullName = formatReleaseName(project?.name, release.name);
  return <section className="project-overview release-overview" aria-label={`${fullName} release summary`}><div className="project-overview-heading"><span className="project-overview-icon release-overview-icon"><Rocket size={20} /></span><div><span className="project-code">Release</span><h2>{fullName}</h2><p>{release.description ? "Native release scope" : "No description yet"}</p></div><div className="project-overview-actions"><span className={`status-badge release-${release.status}`}>{projectStatusLabel(release.status)}</span>{onEdit && <button className="button ghost compact" onClick={onEdit}>Edit</button>}</div></div><div className="project-overview-metadata"><span><b>{tasks.length}</b> Tasks</span><span><b>{openTasks}</b> open</span><span><b>{progress}%</b> complete</span>{release.targetDate && <span>Target <b>{shortDate(release.targetDate)}</b></span>}{release.releasedAt && <span>Released <b>{shortDate(release.releasedAt.slice(0, 10))}</b></span>}</div>{release.description && <MarkdownBody body={release.description} className="project-description-markdown" />}{release.releaseNotes && <section className="release-notes"><h3>Release notes</h3><MarkdownBody body={release.releaseNotes} className="project-description-markdown" /></section>}</section>;
}

export function TeamsSurface({ state, query, onRetry, onCreate, onOpen }: {
  state: AsyncValue<TeamList>;
  query: string;
  onRetry: () => void;
  onCreate: () => void;
  onOpen: (publicId: string) => void;
}) {
  if ((state.status === "idle" || state.status === "loading") && (!state.value || state.value.teams.length === 0)) {
    return <TeamSurfaceState status="Loading Teams…" busy />;
  }
  if (state.status === "error" && (!state.value || state.value.teams.length === 0)) {
    return <TeamSurfaceState status={state.error} onRetry={onRetry} />;
  }

  const visible = filterTeamList(state.value ?? { teams: [] }, query);
  const empty = state.status === "ready" && state.value?.teams.length === 0;
  const noMatch = state.status === "ready" && !empty && visible.length === 0;
  const groups = [
    {
      id: "owned-teams",
      title: "Owned by you",
      description: "You manage these Team memberships.",
      teams: visible.filter(({ currentMembership }) => currentMembership.role === "owner"),
    },
    {
      id: "joined-teams",
      title: "Joined",
      description: "Teams where you are an active member.",
      teams: visible.filter(({ currentMembership }) => currentMembership.role === "member"),
    },
  ].filter((group) => group.teams.length > 0);

  return <div className="teams-surface" aria-busy={state.status === "loading" || undefined}>
    <div className="team-live-region" role="status" aria-live="polite">{state.status === "loading" ? "Refreshing Teams…" : ""}</div>
    {state.status === "error" && <div className="team-local-alert" role="alert"><span>{state.error}</span><button className="button ghost compact" type="button" onClick={onRetry}>Retry</button></div>}
    {empty ? <section className="team-empty-state"><span className="empty-icon"><UsersRound size={20} /></span><h2>No Teams yet</h2><p>Create a Team to manage a reusable member list.</p><button className="button primary" type="button" onClick={onCreate}><Plus size={14} />New Team</button></section>
      : noMatch ? <section className="team-empty-state"><Search size={20} /><h2>No Teams match “{query.trim()}”</h2><p>Try a different Team name.</p></section>
      : <div className="teams-catalog-groups" aria-label="Teams">{groups.map((group) => <section className="team-members-section team-catalog-group" key={group.id} aria-labelledby={group.id}><header><div><h2 id={group.id}>{group.title}</h2><p>{group.description}</p></div><span className="count-pill">{group.teams.length}</span></header><div className="entity-grid team-grid">{group.teams.map(({ team, currentMembership, activeMemberCount }) => <a className="entity-card team-card" key={team.id} href={`/teams/${encodeURIComponent(team.publicId)}`} onClick={(event) => handleLocalLink(event, () => onOpen(team.publicId))}><div className="entity-icon team-icon"><UsersRound size={18} /></div><div className="entity-card-copy"><div><h2 title={team.name}>{team.name}</h2><span className="status-badge">{currentMembership.role}</span></div><p>{activeMemberCount} active member{activeMemberCount === 1 ? "" : "s"}</p><div className="progress-meta"><span>Your membership</span><span>{currentMembership.status}</span></div></div></a>)}</div></section>)}</div>}
  </div>;
}

export function TeamSurfaceState({ status, busy = false, onRetry }: { status: string; busy?: boolean; onRetry?: () => void }) {
  return <section className="team-surface-state" aria-busy={busy || undefined}>{busy ? <RotateCw size={20} className="spin" aria-hidden="true" /> : <UsersRound size={20} aria-hidden="true" />}<h2>{status}</h2>{onRetry && <button className="button ghost" type="button" onClick={onRetry}>Retry</button>}</section>;
}

export function TeamDetailSurface({ state, alert, mutation, onRetry, onMembershipAction, onDelete }: {
  state: AsyncValue<TeamDetail>;
  alert: string;
  mutation: TeamMutationState;
  onRetry: () => void;
  onMembershipAction: (membership: TeamMembershipRecord, action: "deactivate" | "reactivate") => void;
  onDelete: (membership: TeamMembershipRecord) => void;
}) {
  if ((state.status === "idle" || state.status === "loading") && !state.value) return <TeamSurfaceState status="Loading Team…" busy />;
  if (state.status === "error" && !state.value) return <TeamSurfaceState status={state.error === "Team unavailable" ? state.error : alert || state.error} onRetry={onRetry} />;
  const detail = state.value;
  if (!detail) return <TeamSurfaceState status="Team unavailable" onRetry={onRetry} />;

  const isOwner = detail.currentMembership.role === "owner";
  const activeMembers = detail.members.filter((membership) => membership.status === "active");
  const inactiveMembers = detail.members.filter((membership) => membership.status === "inactive");
  const memberRow = (membership: TeamMembershipRecord) => {
    const isCurrent = membership.id === detail.currentMembership.id;
    const mutable = isOwner && membership.role !== "owner";
    const membershipBusy = mutation?.key === membership.id;
    return <li className="team-member-row" key={membership.id} aria-busy={membershipBusy || undefined}><span className="avatar">{initials(membership.displayName)}</span><span className="team-member-identity"><span><b>{membership.displayName}</b>{isCurrent && <em>You</em>}</span><small>{membership.email}</small></span><span className="team-member-state"><span className="status-badge">{membership.role}</span><span className={`status-badge team-membership-${membership.status}`}>{membership.status}</span></span>{mutable && <span className="team-member-actions"><button className="button ghost compact" type="button" disabled={Boolean(mutation) || state.status !== "ready"} onClick={() => onMembershipAction(membership, membership.status === "active" ? "deactivate" : "reactivate")}>{membership.status === "active" ? "Deactivate" : "Reactivate"}</button><button className="button danger compact" type="button" disabled={Boolean(mutation) || state.status !== "ready"} onClick={() => onDelete(membership)}>Delete</button></span>}</li>;
  };

  return <div className="team-detail-surface" aria-busy={state.status === "loading" || undefined}>
    <div className="team-live-region" role="status" aria-live="polite">{state.status === "loading" ? "Refreshing Team…" : ""}</div>
    {alert && <div className="team-local-alert" role="alert">{alert}</div>}
    {state.status === "error" && <div className="team-local-alert" role="alert"><span>{state.error}</span><button className="button ghost compact" type="button" onClick={onRetry}>Retry</button></div>}
    <section className="team-overview" aria-labelledby="team-overview-heading"><span className="team-overview-icon"><UsersRound size={20} /></span><div><span className="project-code">Team</span><h2 id="team-overview-heading">{detail.team.name}</h2><p>{activeMembers.length} active member{activeMembers.length === 1 ? "" : "s"}</p></div><dl><div><dt>Your role</dt><dd>{detail.currentMembership.role}</dd></div><div><dt>Your state</dt><dd>{detail.currentMembership.status}</dd></div></dl></section>
    <section className="team-members-section" aria-labelledby="active-team-members"><header><div><h2 id="active-team-members">Active members</h2><p>People currently included in this Team.</p></div><span className="count-pill">{activeMembers.length}</span></header><ul className="team-member-list">{activeMembers.map(memberRow)}</ul></section>
    {inactiveMembers.length > 0 && <section className="team-members-section" aria-labelledby="inactive-team-members"><header><div><h2 id="inactive-team-members">Inactive members</h2><p>Reactivate or delete a previous membership.</p></div><span className="count-pill">{inactiveMembers.length}</span></header><ul className="team-member-list">{inactiveMembers.map(memberRow)}</ul></section>}
  </div>;
}

export function TeamNameDialog({ title, submitLabel, initialName = "", error, busy, onClose, onSubmit }: { title: string; submitLabel: string; initialName?: string; error: string; busy: boolean; onClose: () => void; onSubmit: (name: string) => Promise<boolean> }) {
  return <Modal onClose={onClose} className="team-dialog" ariaLabel={title}><DialogHeader title={title} icon={<UsersRound size={17} />} onClose={onClose} /><form className="form-stack team-dialog-form" aria-busy={busy || undefined} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); void onSubmit(String(input.get("name") ?? "")); }}><label><span>Name</span><input name="name" required maxLength={100} defaultValue={initialName} autoFocus /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button className="button ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : submitLabel}</button></div></form></Modal>;
}

export function TeamMemberDialog({ error, busy, onClose, onSubmit }: { error: string; busy: boolean; onClose: () => void; onSubmit: (email: string) => Promise<boolean> }) {
  return <Modal onClose={onClose} className="team-dialog" ariaLabel="Add Team member"><DialogHeader title="Add Team member" icon={<UserRound size={17} />} onClose={onClose} /><form className="form-stack team-dialog-form" aria-busy={busy || undefined} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); void onSubmit(String(input.get("email") ?? "")); }}><p className="dialog-copy">Add a registered user by verified email. They must have signed in once; no email is sent.</p><label><span>Email</span><input name="email" type="email" required autoComplete="off" placeholder="name@example.com" autoFocus /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button className="button ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Adding…" : "Add member"}</button></div></form></Modal>;
}

export function TeamMemberDeleteDialog({ membership, error, busy, onClose, onConfirm }: { membership: TeamMembershipRecord; error: string; busy: boolean; onClose: () => void; onConfirm: () => Promise<boolean> }) {
  return <Modal onClose={onClose} className="team-dialog" ariaLabel="Delete Team membership"><DialogHeader title="Delete Team membership" icon={<Trash2 size={17} />} onClose={onClose} /><div className="team-delete-copy"><p>Delete the membership for <b>{membership.displayName}</b>?</p><small>{membership.email}</small><p>This removes the membership record. Use Deactivate when the membership may need to be restored later.</p></div>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions team-delete-actions"><button className="button ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button danger" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void onConfirm()}>{busy ? "Deleting…" : "Delete membership"}</button></div></Modal>;
}

export function ProjectsSurface({ projects, tasks, statuses, users, onOpen, onContextActions, onCreate }: { projects: ProjectRecord[]; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; users: Map<string, UserRecord>; onOpen: (id: string) => void; onContextActions: (project: ProjectRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onCreate: () => void }) {
  if (!projects.length) return <EmptyState entity="project" onCreate={onCreate} />;
  return <div className="entity-grid">{projects.map((project) => {
    const scoped = tasks.filter((task) => task.projectId === project.id && !task.archivedAt);
    const progress = completion(scoped, statuses);
    const lead = project.leadUserId ? users.get(project.leadUserId) : undefined;
    const editable = canEditContent(project.accessRole);
    return <div className="entity-card-shell" key={project.id}>
      <a
        className={`entity-card ${project.archivedAt ? "archived" : ""}`}
        data-context-entity-kind="project"
        data-context-entity-id={project.id}
        href={`/projects/${encodeURIComponent(project.publicId)}`}
        onContextMenu={editable ? (event) => { event.preventDefault(); onContextActions(project, event.clientX, event.clientY, event.currentTarget); } : undefined}
        onClick={(event) => handleLocalLink(event, () => onOpen(project.id))}
      ><div className="entity-icon" style={{ background: `${project.color}20`, color: project.color }}><ProjectIcon project={project} /></div><div className="entity-card-copy"><div><h2>{project.name}</h2><span className="status-badge">{project.archivedAt ? "archived" : project.status}</span></div><p>{project.summary || "No summary yet"}</p><div className="project-card-meta"><span>{lead ? `${lead.displayName} · Lead` : "No lead"}</span><span>{project.startDate ? `Start ${shortDate(project.startDate)}` : "No start"}</span><span>{project.targetDate ? `Target ${shortDate(project.targetDate)}` : "No target"}</span></div><div className="progress-meta"><span>{scoped.length} tasks</span><span>{progress}% complete</span></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div></a>
      {editable && <button className="entity-card-action" type="button" aria-label={`Open actions for ${project.name}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onContextActions(project, rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={16} /></button>}
    </div>;
  })}</div>;
}

export function ReleasesSurface({ releases, projects, tasks, statuses, onOpen, onContextActions, onCreate }: { releases: ReleaseRecord[]; projects: Map<string, ProjectRecord>; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; onOpen: (id: string) => void; onContextActions: (release: ReleaseRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onCreate: () => void }) {
  if (!releases.length) return <EmptyState entity="release" onCreate={onCreate} />;
  return <div className="release-list">{releases.map((release) => {
    const scoped = tasks.filter((task) => task.releaseId === release.id && !task.archivedAt);
    const progress = completion(scoped, statuses);
    const project = projects.get(release.projectId);
    const releaseName = formatReleaseName(project?.name, release.name);
    const editable = canEditContent(release.accessRole);
    return <div className="release-row-shell" key={release.id}>
      <a
        className="release-row"
        data-context-entity-kind="release"
        data-context-entity-id={release.id}
        aria-label={releaseName}
        title={releaseName}
        href={project ? `/projects/${encodeURIComponent(project.publicId)}/releases/${encodeURIComponent(release.publicId)}` : "/releases"}
        onContextMenu={editable ? (event) => { event.preventDefault(); onContextActions(release, event.clientX, event.clientY, event.currentTarget); } : undefined}
        onClick={(event) => handleLocalLink(event, () => onOpen(release.id))}
      ><span className="release-icon"><Rocket size={16} /></span><span className="release-main"><b>{releaseName}</b><small>{scoped.length} Task{scoped.length === 1 ? "" : "s"}</small></span><span className={`status-badge release-${release.status}`}>{release.status}</span><span className="release-progress"><i><em style={{ width: `${progress}%` }} /></i><small>{progress}%</small></span><span className="release-date">{release.releasedAt ? `Released ${shortDate(release.releasedAt.slice(0, 10))}` : release.targetDate ? `Target ${shortDate(release.targetDate)}` : "No date"}</span></a>
      {editable && <button className="release-row-action" type="button" aria-label={`Open actions for ${releaseName}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onContextActions(release, rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={16} /></button>}
    </div>;
  })}</div>;
}
export function AdminSurface({ overview, timeZone, backupBusy, exportActive, onExport, onImport }: {
  overview: AdminOverview;
  timeZone: string;
  backupBusy: boolean;
  exportActive: boolean;
  onExport: () => void;
  onImport: () => void;
}) {
  return (
    <div className="admin-surface">
      <section className="admin-metrics" aria-label="System overview">
        <AdminMetric label="Registered users" value={overview.registeredUserCount} note="All accounts" icon={<UsersRound size={16} />} />
        <AdminMetric label="Active users" value={overview.activeUserCount} note="Last 7 days" icon={<Zap size={16} />} />
        <AdminMetric label="Tasks" value={overview.taskCount} note={`${overview.projectCount} projects`} icon={<Inbox size={16} />} />
        <AdminMetric label="Saved views" value={overview.viewCount} note={`${overview.releaseCount} releases`} icon={<Boxes size={16} />} />
        <AdminMetric label="Attachment objects" value={overview.attachmentObjectCount} note={`${formatAttachmentBytes(overview.attachmentObjectBytes)} · ${overview.orphanAttachmentObjectCount === null ? "orphan scan bounded" : `${overview.orphanAttachmentObjectCount} orphan`} · ${overview.stagingAttachmentObjectCount} staged · ${overview.pendingAttachmentCount} pending · ${overview.failedAttachmentCount} failed`} icon={<Paperclip size={16} />} />
      </section>
      <section className="admin-panel admin-backup-panel" aria-labelledby="admin-backup-heading">
        <header>
          <div>
            <h2 id="admin-backup-heading">Резервное копирование и восстановление</h2>
            <p>Полная резервная копия содержит данные всех пользователей, идентификаторы и права доступа. Храните файл <code>.tmbak</code> как секрет; восстановление полностью заменяет текущее состояние.</p>
          </div>
          <span className="status-badge admin-badge">Только администратор</span>
        </header>
        <div className="admin-backup-actions">
          <article>
            <span className="admin-backup-icon"><Download size={17} /></span>
            <div>
              <h3>Экспорт</h3>
              <p>Создать переносимый снимок D1 и R2 в возобновляемом формате <code>.tmbak</code>.</p>
            </div>
            <button className="button ghost" type="button" disabled={backupBusy && !exportActive} onClick={onExport}><Download size={14} />{exportActive ? "Открыть экспорт" : "Экспорт"}</button>
          </article>
          <article className="destructive">
            <span className="admin-backup-icon"><Upload size={17} /></span>
            <div>
              <h3>Полное восстановление</h3>
              <p>Проверить резервную копию и заменить все данные после отдельного подтверждения.</p>
            </div>
            <button className="button danger" type="button" disabled={backupBusy} onClick={onImport}><Upload size={14} />Импорт</button>
          </article>
        </div>
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
export function AdminMetric({ label, value, note, icon }: { label: string; value: number; note: string; icon: React.ReactNode }) { return <article className="admin-metric"><span className="admin-metric-icon">{icon}</span><div><span>{label}</span><b>{value}</b><small>{note}</small></div></article>; }
export function formatAttachmentBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`; return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`; }
export function TaskSearchNotice({ status }: { status: "loading" | "error" }) { return <div className="empty-state" role="status"><Search size={22} /><h2>{status === "loading" ? "Searching tasks…" : "Search unavailable"}</h2><p>{status === "loading" ? "Looking across every task you can access." : "The search request failed. Change the query or try again."}</p></div>; }
export function TaskQueryPagination({ busy, onMore }: { busy: boolean; onMore: () => void }) { return <div className="task-query-pagination" role="status"><span>More matching tasks are available.</span><button className="button ghost" type="button" disabled={busy} onClick={onMore}>{busy ? "Loading…" : "Load more"}</button></div>; }
export function CatalogPagination({ busy, onMore }: { busy: boolean; onMore: () => void }) { return <div className="task-query-pagination" role="status"><span>More records are available.</span><button className="button ghost" type="button" disabled={busy} onClick={onMore}>{busy ? "Loading…" : "Load more"}</button></div>; }
export function Peek({ task, status, project, labels, hierarchy, onClose, onOpen }: { task: TaskRecord; status?: WorkflowStatusRecord; project?: ProjectRecord; labels: LabelRecord[]; hierarchy: TaskHierarchySummary; onClose: () => void; onOpen: () => void }) { return <div className="peek" role="dialog" aria-label={`Preview ${task.identifier}`}><header><span>{task.identifier}</span><div><a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)}>Open</a><button onClick={onClose}><X size={13} /></button></div></header><h2>{task.title}</h2><p>{task.description === null ? "Loading preview…" : task.description || "No description"}</p>{labels.length > 0 && <div className="card-labels">{labels.map((label) => <LabelChip key={label.id} label={label} />)}</div>}{(hierarchy.parent || hierarchy.subtaskCount > 0) && <div className="peek-hierarchy"><TaskHierarchyChip hierarchy={hierarchy} /></div>}<footer>{status && <span><StatusIcon status={status} />{status.name}</span>}{project && <span><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}<span><MessageSquare size={12} />{task.commentCount}</span></footer></div>; }

export function BulkProjectDialog({ data, tasks, busy, onClose, onSubmit, initialTargetProjectId = "" }: { data: AppSnapshot; tasks: TaskRecord[]; busy: boolean; onClose: () => void; onSubmit: (input: { targetProjectId: string; clearRelease: boolean; clearAssignee: boolean; confirmReleasedComposition: boolean }) => Promise<unknown>; initialTargetProjectId?: string }) {
  const [targetProjectId, setTargetProjectId] = useState(initialTargetProjectId);
  const [clearRelease, setClearRelease] = useState(false);
  const [clearAssignee, setClearAssignee] = useState(false);
  const [confirmReleasedComposition, setConfirmReleasedComposition] = useState(false);
  const target = data.projects.find((project) => project.id === targetProjectId);
  const moving = target ? tasks.filter((task) => task.projectId !== target.id) : [];
  const movingIds = new Set(moving.map((task) => task.id));
  const releaseChanges = moving.filter((task) => task.releaseId !== null);
  const releasedChanges = releaseChanges.filter((task) => data.releases.find((release) => release.id === task.releaseId)?.status === "released");
  const hierarchyBlocks = moving.filter((task) => task.parentTaskId || data.tasks.some((child) => child.parentTaskId === task.id));
  const archivedBlocks = moving.filter((task) => Boolean(task.archivedAt));
  const targetMembers = new Set<string>();
  if (target) {
    targetMembers.add(target.ownerUserId);
    for (const collaborator of data.collaborators) {
      if (collaborator.resourceType === "project" && collaborator.resourceId === target.id) {
        targetMembers.add(collaborator.userId);
      }
    }
  }
  const assigneeChanges = moving.filter((task) => task.assigneeUserId && !targetMembers.has(task.assigneeUserId));
  const expectedStart = target ? target.taskSequence + 1 : 0;
  const eligibleProjects = data.projects.filter((project) =>
    !project.archivedAt && project.status !== "canceled" && canEditContent(project.accessRole)
  );
  const canSubmit = Boolean(target && movingIds.size > 0 && !hierarchyBlocks.length && !archivedBlocks.length) &&
    (!releaseChanges.length || clearRelease) &&
    (!assigneeChanges.length || clearAssignee) &&
    (!releasedChanges.length || confirmReleasedComposition);
  return <Modal onClose={onClose} className="project-dialog bulk-move-dialog" ariaLabel="Move selected tasks"><form onSubmit={(event) => { event.preventDefault(); if (target && canSubmit) void onSubmit({ targetProjectId: target.id, clearRelease, clearAssignee, confirmReleasedComposition }); }}><DialogHeader title="Move selected tasks" icon={<FolderKanban size={17} />} onClose={onClose} /><div className="form-stack project-form-stack"><label><span>Target Project</span><select required autoFocus value={targetProjectId} onChange={(event) => { setTargetProjectId(event.target.value); setClearRelease(false); setClearAssignee(false); setConfirmReleasedComposition(false); }}><option value="" disabled>Select Project…</option>{eligibleProjects.map((project) => <option key={project.id} value={project.id}>{project.taskCode} · {project.name}</option>)}</select></label>{target && <div className="bulk-preview" role="status"><h3>Commit preview</h3><p><b>{moving.length}</b> Task{moving.length === 1 ? "" : "s"} will move to <b>{target.name}</b>; {tasks.length - moving.length} same-Project selection{tasks.length - moving.length === 1 ? " is" : "s are"} no-op.</p>{moving.length > 0 && <p>Expected identifiers: <b>{target.taskCode}-{expectedStart}</b>{moving.length > 1 ? ` … ${target.taskCode}-${expectedStart + moving.length - 1}` : ""}. Final sequences are reserved only by the atomic commit.</p>}{releaseChanges.length > 0 && <label className="check-row"><input type="checkbox" checked={clearRelease} onChange={(event) => setClearRelease(event.target.checked)} />Clear {releaseChanges.length} incompatible Release assignment{releaseChanges.length === 1 ? "" : "s"}</label>}{assigneeChanges.length > 0 && <label className="check-row"><input type="checkbox" checked={clearAssignee} onChange={(event) => setClearAssignee(event.target.checked)} />Clear {assigneeChanges.length} assignee{assigneeChanges.length === 1 ? "" : "s"} without target access</label>}{releasedChanges.length > 0 && <label className="check-row"><input type="checkbox" checked={confirmReleasedComposition} onChange={(event) => setConfirmReleasedComposition(event.target.checked)} />Confirm changing {releasedChanges.length} released Release composition{releasedChanges.length === 1 ? "" : "s"}</label>}{hierarchyBlocks.length > 0 && <p className="dialog-warning">Blocked: detach or reparent {hierarchyBlocks.length} selected Task hierarchy{hierarchyBlocks.length === 1 ? "" : "ies"} first.</p>}{archivedBlocks.length > 0 && <p className="dialog-warning">Blocked: restore {archivedBlocks.length} archived Task{archivedBlocks.length === 1 ? "" : "s"} first.</p>}</div>}</div><div className="project-dialog-footer"><span /><div><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !canSubmit}>{busy ? "Moving…" : "Move tasks"}</button></div></div></form></Modal>;
}

export function BulkReleaseDialog({ data, tasks, busy, onClose, onSubmit, initialChoice = "" }: { data: AppSnapshot; tasks: TaskRecord[]; busy: boolean; onClose: () => void; onSubmit: (input: { releaseId: string | null; confirmReleasedComposition: boolean }) => Promise<unknown>; initialChoice?: string }) {
  const [choice, setChoice] = useState(initialChoice);
  const [confirmReleasedComposition, setConfirmReleasedComposition] = useState(false);
  const projectIds = new Set(tasks.map((task) => task.projectId));
  const compatibleProjectId = projectIds.size === 1 ? tasks[0]?.projectId ?? null : null;
  const releases = compatibleProjectId
    ? data.releases.filter((release) => release.projectId === compatibleProjectId)
    : [];
  const releaseId = choice === "__clear__" ? null : choice || null;
  const selectedRelease = releaseId ? data.releases.find((release) => release.id === releaseId) : null;
  const changed = choice
    ? tasks.filter((task) => task.releaseId !== releaseId)
    : [];
  const touchesReleased = changed.some((task) =>
    data.releases.find((release) => release.id === task.releaseId)?.status === "released"
  ) || selectedRelease?.status === "released";
  const canSubmit = Boolean(choice && changed.length) && (!touchesReleased || confirmReleasedComposition);
  return <Modal onClose={onClose} className="project-dialog bulk-move-dialog" ariaLabel="Change selected releases"><form onSubmit={(event) => { event.preventDefault(); if (canSubmit) void onSubmit({ releaseId, confirmReleasedComposition }); }}><DialogHeader title="Change selected releases" icon={<Rocket size={17} />} onClose={onClose} /><div className="form-stack project-form-stack"><label><span>Release</span><select required autoFocus value={choice} onChange={(event) => { setChoice(event.target.value); setConfirmReleasedComposition(false); }}><option value="" disabled>Select Release…</option><option value="__clear__">No Release</option>{releases.map((release) => <option key={release.id} value={release.id}>{formatReleaseName(data.projects.find((project) => project.id === release.projectId)?.name, release.name)}</option>)}</select></label>{projectIds.size > 1 && <p className="dialog-warning">The selected Tasks span multiple Projects. Only clearing Release is compatible; choosing a Release never moves a Task between Projects.</p>}{choice && <div className="bulk-preview" role="status"><h3>Commit preview</h3><p><b>{changed.length}</b> Task{changed.length === 1 ? "" : "s"} will use {selectedRelease ? <b>{selectedRelease.name}</b> : <b>No Release</b>}; {tasks.length - changed.length} selection{tasks.length - changed.length === 1 ? " is" : "s are"} no-op.</p>{touchesReleased && <label className="check-row"><input type="checkbox" checked={confirmReleasedComposition} onChange={(event) => setConfirmReleasedComposition(event.target.checked)} />Confirm changing released Release composition</label>}</div>}</div><div className="project-dialog-footer"><span /><div><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !canSubmit}>{busy ? "Saving…" : "Apply Release"}</button></div></div></form></Modal>;
}

export function BulkBar({ data, tasks, statuses, archiveAction, onStatus, onPriority, onAssignee, onProject, onRelease, onLabel, onArchive, onClose }: { data: AppSnapshot; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; archiveAction: ReturnType<typeof resolveArchiveBulkAction>; onStatus: (value: string) => void; onPriority: (value: Priority) => void; onAssignee: (value: string | null) => void; onProject: () => void; onRelease: () => void; onLabel: (labelId: string, active: boolean) => void; onArchive: () => void; onClose: () => void }) {
  const [labels, setLabels] = useState<LabelRecord[]>([]);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const oneCatalog = new Set(tasks.map((task) => task.ownerUserId)).size === 1;
  const catalogProjectId = tasks[0]?.projectId ?? null;
  const assigneeOptions = bulkAssigneeOptions(data, tasks).filter((user) => {
    const needle = assigneeSearch.trim().toLowerCase();
    return !needle || user.displayName.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle);
  });
  useEffect(() => {
    if (!oneCatalog || !catalogProjectId) return;
    const controller = new AbortController();
    void fetch(`/api/labels?projectId=${encodeURIComponent(catalogProjectId)}&includeArchived=true`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const value = await response.json() as { labels?: LabelRecord[] };
        if (response.ok && value.labels) setLabels(value.labels);
      }).catch(() => undefined);
    return () => controller.abort();
  }, [catalogProjectId, oneCatalog]);
  return <div className="bulk-bar"><b>{tasks.length} selected</b><select defaultValue="" onChange={(event) => event.target.value && onStatus(event.target.value)}><option value="" disabled>Status…</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select><select defaultValue="" onChange={(event) => event.target.value && onPriority(event.target.value as Priority)}><option value="" disabled>Priority…</option>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select><div className="bulk-assignee"><input type="search" aria-label="Search bulk assignees" placeholder="Find assignee…" value={assigneeSearch} onChange={(event) => setAssigneeSearch(event.target.value)} /><select aria-label="Bulk assignee" defaultValue="" title={assigneeOptions.length ? "Assign every selected task" : "No user has access to every selected task; Unassigned remains available"} onChange={(event) => { if (!event.target.value) return; onAssignee(event.target.value === "__unassigned__" ? null : event.target.value); event.target.value = ""; }}><option value="" disabled>Assignee…</option><option value="__unassigned__">Unassigned</option>{assigneeOptions.map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select></div><button type="button" onClick={onProject}><FolderKanban size={14} />Project…</button><button type="button" onClick={onRelease}><Rocket size={14} />Release…</button>{oneCatalog && <><select aria-label="Bulk add Label" defaultValue="" onChange={(event) => { if (event.target.value) onLabel(event.target.value, true); event.target.value = ""; }}><option value="" disabled>Add label…</option>{labels.filter((label) => !label.archivedAt).map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select><select aria-label="Bulk remove Label" defaultValue="" onChange={(event) => { if (event.target.value) onLabel(event.target.value, false); event.target.value = ""; }}><option value="" disabled>Remove label…</option>{labels.map((label) => <option key={label.id} value={label.id}>{label.name}{label.archivedAt ? " (archived)" : ""}</option>)}</select></>}<button onClick={onArchive}>{archiveAction.archived ? <Archive size={14} /> : <ArchiveRestore size={14} />}{archiveAction.label}</button><button onClick={onClose}><X size={14} /></button></div>;
}

export function bulkAssigneeOptions(data: AppSnapshot, tasks: TaskRecord[]): UserRecord[] {
  if (!tasks.length) return [];
  let intersection: Set<string> | null = null;
  for (const task of tasks) {
    const candidateIds = new Set<string>();
    if (task.projectId) {
      const project = data.projects.find((item) => item.id === task.projectId);
      if (project) candidateIds.add(project.ownerUserId);
      for (const collaborator of data.collaborators) {
        if (collaborator.resourceType === "project" && collaborator.resourceId === task.projectId) {
          candidateIds.add(collaborator.userId);
        }
      }
    } else {
      candidateIds.add(task.ownerUserId);
      for (const collaborator of data.collaborators) {
        if (collaborator.resourceType === "task" && collaborator.resourceId === task.id) {
          candidateIds.add(collaborator.userId);
        }
      }
    }
    const currentIntersection: Set<string> | null = intersection;
    intersection = currentIntersection === null
      ? candidateIds
      : new Set<string>(
          [...currentIntersection].filter((id: string) => candidateIds.has(id)),
        );
  }
  const users = new Map([data.user, ...data.users].map((user) => [user.id, user]));
  return [...(intersection ?? [])]
    .map((id) => users.get(id))
    .filter((user): user is UserRecord => Boolean(user))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function defaultLayoutForSurface(surface: string, data: AppSnapshot): Layout {
  if (!surface.startsWith("view:")) return "list";
  return data.views.find(
    (view) => view.id === surface.slice(5) && !view.archivedAt,
  )?.display.layout ?? "list";
}

export function surfaceBreadcrumbs(
  surface: string,
  data: AppSnapshot,
  view?: SavedViewRecord,
  teamName?: string,
): BreadcrumbItem[] {
  const workspace: BreadcrumbItem = {
    label: "Workspace",
    surface: "workspace",
    layout: "list",
  };
  const current = (label: string): BreadcrumbItem => ({ label });
  const ancestor = (label: string, ancestorSurface: string, layout: Layout = "list"): BreadcrumbItem => ({
    label,
    surface: ancestorSurface,
    layout,
  });

  if (surface === "workspace") return [current("Workspace")];
  if (surface === "admin") return [workspace, current("Administration")];
  if (surface.startsWith("settings:")) {
    const section = surface.slice("settings:".length) as SettingsSection;
    const label = settingsNavigation.flatMap((group) => group.items)
      .find((item) => item.section === section)?.label ?? "Profile";
    return [workspace, ancestor("Settings", "settings:profile"), current(label)];
  }
  if (surface === "views") return [workspace, current("Views")];
  if (surface === "projects") return [workspace, current("Projects")];
  if (surface === "releases") return [workspace, current("Releases")];
  if (surface === "teams") return [workspace, current("Teams")];
  if (surface.startsWith("team:")) return [workspace, ancestor("Teams", "teams"), current(teamName ?? "Team")];
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
      current(formatReleaseName(project.name, release.name)),
    ];
  }

  const builtIn = builtInViews.find((item) => item.id === surface);
  return [workspace, current(builtIn?.label ?? "My tasks")];
}
export function isCollectionSurface(surface: string) { return surface === "workspace" || surface === "shared" || surface === "admin" || surface === "views" || surface === "projects" || surface === "releases" || surface === "teams" || surface.startsWith("team:") || surface.startsWith("project-releases:") || surface.startsWith("settings:"); }
export function taskContextualEntity(task: TaskRecord): ContextualActionEntity {
  return { kind: "task", id: task.id, label: task.identifier, accessRole: task.accessRole, archivedAt: task.archivedAt, version: taskMutationVersion(task) };
}
export function projectContextualEntity(project: ProjectRecord): ContextualActionEntity {
  return { kind: "project", id: project.id, label: project.name, accessRole: project.accessRole, archivedAt: project.archivedAt ?? null, version: project.version };
}
export function releaseContextualEntity(release: ReleaseRecord): ContextualActionEntity {
  return { kind: "release", id: release.id, label: release.name, accessRole: release.accessRole, archivedAt: null, version: release.version };
}
export function viewContextualEntity(view: SavedViewRecord): ContextualActionEntity {
  return { kind: "saved_view", id: view.id, label: view.name, accessRole: view.accessRole, archivedAt: view.archivedAt ?? null, version: view.version };
}
export function resolveShareContext(
  surface: string,
  activeTask: TaskRecord | null,
  data: AppSnapshot,
): ShareContext | null {
  const canManage = (role: AccessRole) => role === "owner" || role === "manager";
  const projectTarget = (project: ProjectRecord | undefined): ShareTarget | null => {
    if (!project || !canManage(project.accessRole)) return null;
    return {
      resourceType: "project",
      resourceId: project.id,
      label: project.name,
      accessRole: project.accessRole,
      ownerUserId: project.ownerUserId,
      inherited: true,
    };
  };
  const projectRoute = (project: ProjectRecord | undefined): TeamShareRoute | null => {
    if (!project || !canManage(project.accessRole)) return null;
    return {
      key: `project:${project.id}`,
      resourceType: "project",
      resourceId: project.id,
      publicId: project.publicId,
      label: "Project access",
      explanation: "Adds the Team to the Project. Every Task, Release, and Project-scoped View inherits this role.",
      accessRole: project.accessRole,
    };
  };
  const taskRoute = (task: TaskRecord): TeamShareRoute | null => {
    if (!canManage(task.accessRole)) return null;
    return {
      key: `task:${task.id}`,
      resourceType: "task",
      resourceId: task.id,
      publicId: task.publicId,
      label: "This Task only",
      explanation: "Adds an explicit route to this Task only. It does not expose the Project, sibling Tasks, or Releases.",
      accessRole: task.accessRole,
    };
  };

  if (activeTask) {
    if (activeTask.projectId) {
      const project = data.projects.find((item) => item.id === activeTask.projectId);
      if (!project) return null;
      const directTarget = projectTarget(project);
      const teamRoutes = [projectRoute(project), taskRoute(activeTask)].filter(
        (route): route is TeamShareRoute => route !== null,
      );
      return directTarget || teamRoutes.length
        ? {
            key: `task:${activeTask.id}`,
            label: activeTask.identifier,
            directTarget,
            teamRoutes,
            teamUnavailableCopy: null,
          }
        : null;
    }
    const directTarget: ShareTarget | null = activeTask.accessRole === "owner"
      ? {
          resourceType: "task",
          resourceId: activeTask.id,
          label: activeTask.identifier,
          accessRole: activeTask.accessRole,
          ownerUserId: activeTask.ownerUserId,
          inherited: false,
        }
      : null;
    const route = taskRoute(activeTask);
    return directTarget || route
      ? {
          key: `task:${activeTask.id}`,
          label: activeTask.identifier,
          directTarget,
          teamRoutes: route ? [route] : [],
          teamUnavailableCopy: null,
        }
      : null;
  }
  if (surface.startsWith("project:")) {
    const project = data.projects.find((item) => item.id === surface.slice(8));
    const directTarget = projectTarget(project);
    const route = projectRoute(project);
    return directTarget && project
      ? {
          key: `project:${project.id}`,
          label: project.name,
          directTarget,
          teamRoutes: route ? [route] : [],
          teamUnavailableCopy: null,
        }
      : null;
  }
  if (surface.startsWith("project-releases:")) {
    const project = data.projects.find((item) => item.id === surface.slice("project-releases:".length));
    const directTarget = projectTarget(project);
    const route = projectRoute(project);
    return directTarget && project
      ? {
          key: `project-releases:${project.id}`,
          label: project.name,
          directTarget,
          teamRoutes: route ? [route] : [],
          teamUnavailableCopy: null,
        }
      : null;
  }
  if (surface.startsWith("release:")) {
    const release = data.releases.find((item) => item.id === surface.slice(8));
    const project = release
      ? data.projects.find((item) => item.id === release.projectId)
      : undefined;
    const directTarget = projectTarget(project);
    return release && directTarget
      ? {
          key: `release:${release.id}`,
          label: formatReleaseName(project?.name, release.name),
          directTarget,
          teamRoutes: [],
          teamUnavailableCopy: "Releases do not have a Team grant route. Manage Team access from the Project surface; direct People access here remains Project-based.",
        }
      : null;
  }
  if (surface.startsWith("view:")) {
    const view = data.views.find((item) => item.id === surface.slice(5));
    if (!view) return null;
    if (view.scopeProjectId) {
      const project = data.projects.find((item) => item.id === view.scopeProjectId);
      const directTarget = projectTarget(project);
      const route = projectRoute(project);
      return directTarget
        ? {
            key: `view:${view.id}`,
            label: view.name,
            directTarget,
            teamRoutes: route ? [route] : [],
            teamUnavailableCopy: null,
          }
        : null;
    }
    const directTarget: ShareTarget | null = view.accessRole === "owner"
      ? {
          resourceType: "saved_view",
          resourceId: view.id,
          label: view.name,
          accessRole: view.accessRole,
          ownerUserId: view.ownerUserId,
          inherited: false,
        }
      : null;
    const route = canManage(view.accessRole)
      ? {
          key: `saved_view:${view.id}`,
          resourceType: "saved_view" as const,
          resourceId: view.id,
          publicId: view.publicId,
          label: "This global View",
          explanation: "Adds the Team to this global View. The View still returns only Tasks each member can already access.",
          accessRole: view.accessRole,
        }
      : null;
    return directTarget || route
      ? {
          key: `view:${view.id}`,
          label: view.name,
          directTarget,
          teamRoutes: route ? [route] : [],
          teamUnavailableCopy: null,
        }
      : null;
  }
  return null;
}
export function statusGroupsForTasks(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const owners = new Set(tasks.map((task) => task.ownerUserId)); return statuses.filter((status) => !status.archivedAt && (owners.has(status.ownerUserId) || tasks.length === 0)).sort((a, b) => a.position - b.position); }
export function sortTasks(tasks: TaskRecord[], display?: ViewDisplay) {
  const orderBy = display?.orderBy ?? "priority";
  const direction = orderBy !== "manual" && display?.direction === "desc" ? -1 : 1;
  const priorityOrder: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  return [...tasks].sort((a, b) => {
    let comparison = 0;
    if (orderBy === "priority") comparison = priorityOrder[a.priority] - priorityOrder[b.priority];
    else if (orderBy === "created") comparison = a.createdAt.localeCompare(b.createdAt);
    else if (orderBy === "updated") comparison = a.updatedAt.localeCompare(b.updatedAt);
    else if (orderBy === "due") comparison = (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31");
    else if (orderBy === "title") comparison = a.title.toLocaleLowerCase().localeCompare(b.title.toLocaleLowerCase());
    else comparison = a.rank - b.rank;
    return comparison * direction || a.rank - b.rank || a.publicId.localeCompare(b.publicId);
  });
}
export function taskCountForView(id: string, data: AppSnapshot, statusMap: Map<string, WorkflowStatusRecord>) { const exact = data.workspaceMetrics?.taskCounts; if (id === "mine") return exact?.mine ?? data.tasks.filter((task) => !task.archivedAt && task.assigneeUserId === data.user.id).length; if (id === "archived") return exact?.archived ?? data.tasks.filter((task) => task.archivedAt).length; if (id === "backlog") return exact?.backlog ?? data.tasks.filter((task) => !task.archivedAt && statusMap.get(task.statusId)?.category === "backlog").length; if (id === "active") return exact?.active ?? data.tasks.filter((task) => !task.archivedAt && ["unstarted", "started"].includes(statusMap.get(task.statusId)?.category ?? "")).length; return exact?.all ?? data.tasks.filter((task) => !task.archivedAt).length; }
export function completion(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const statusMap = new Map(statuses.map((status) => [status.id, status])); const eligible = tasks.filter((task) => statusMap.get(task.statusId)?.category !== "canceled"); if (!eligible.length) return 0; return Math.round((eligible.filter((task) => statusMap.get(task.statusId)?.category === "completed").length / eligible.length) * 100); }
export function toggleSet(current: Set<string>, value: string) { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }
export function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) { return left.size === right.size && [...left].every((value) => right.has(value)); }
