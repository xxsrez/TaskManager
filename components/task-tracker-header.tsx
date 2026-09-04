"use client";

import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  FolderKanban,
  LayoutList,
  Link2,
  ListFilter,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rocket,
  Search,
  Share2,
  SlidersHorizontal,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import type {
  Dispatch,
  RefObject,
  SetStateAction,
} from "react";
import { canEditContent } from "@/lib/access";
import {
  navigationPath,
  projectReleasesPath,
  type Layout,
} from "@/lib/navigation";
import type {
  ContextualActionContext,
  ContextualActionEntity,
} from "@/lib/contextual-actions";
import type { UserPreferenceChanges } from "@/lib/user-preference-save";
import type {
  AppSnapshot,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  TeamDetail,
  ViewDisplay,
  ViewQuery,
  WorkspaceCatalogKind,
} from "@/lib/types";
import {
  groupByOptions,
  toggleViewField,
  type AsyncValue,
  type Dialog,
  type TeamMutationState,
  viewFieldOptions,
  viewOrderOptions,
} from "@/components/task-tracker-state";
import {
  DisplayPopover,
  FilterChips,
  FilterPopover,
  SavedFilterChips,
  SavedViewFilterLayers,
  handleLocalLink,
  isCollectionSurface,
  queryFilterCount,
  type BreadcrumbItem,
} from "@/components/task-tracker-view";

type DisplayDependencies = {
  directionDisabled: boolean;
  directionReason: string | null;
  emptyGroupsDisabled: boolean;
  emptyGroupsReason: string | null;
};

type TaskTrackerHeaderProps = {
  data: AppSnapshot;
  surface: string;
  layout: Layout;
  breadcrumbs: BreadcrumbItem[];
  surfaceCount: number | string;
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  mobileMenuRef: RefObject<HTMLButtonElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  filterTriggerRef: RefObject<HTMLButtonElement | null>;
  displayTriggerRef: RefObject<HTMLButtonElement | null>;
  mobileActionsRef: RefObject<HTMLDivElement | null>;
  mobileSearchRef: RefObject<HTMLInputElement | null>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  searchLabel: string;
  filterOpen: boolean;
  setFilterOpen: Dispatch<SetStateAction<boolean>>;
  displayOpen: boolean;
  setDisplayOpen: Dispatch<SetStateAction<boolean>>;
  mobileActionsOpen: boolean;
  setMobileActionsOpen: Dispatch<SetStateAction<boolean>>;
  catalogLoading: boolean;
  catalogOrder: "updated" | "name";
  setCatalogOrder: Dispatch<SetStateAction<"updated" | "name">>;
  catalogDirection: "asc" | "desc";
  setCatalogDirection: Dispatch<SetStateAction<"asc" | "desc">>;
  activeSavedView?: SavedViewRecord;
  contextProject: string | null;
  contextProjectRecord?: ProjectRecord;
  contextReleaseRecord?: ReleaseRecord;
  activeTeamDetail: TeamDetail | null;
  teamDetailState: AsyncValue<TeamDetail>;
  teamMutation: TeamMutationState;
  currentDisplay: ViewDisplay;
  currentGroupBy: ViewDisplay["groupBy"];
  currentDisplayDependencies: DisplayDependencies;
  canonicalTemporaryQuery: ViewQuery;
  currentViewQuery: ViewQuery;
  hasTemporaryFilters: boolean;
  hasDisplayChanges: boolean;
  hasRuntimeViewChanges: boolean;
  canCreateTask: boolean;
  canSaveView: boolean;
  hasShareContext: boolean;
  surfaceContextualEntity: ContextualActionEntity | null;
  systemBackupBusy: boolean;
  setDialog: Dispatch<SetStateAction<Dialog>>;
  setMobileSidebarOpen: Dispatch<SetStateAction<boolean>>;
  saveUserPreferences: (changes: UserPreferenceChanges) => Promise<void>;
  closeMobileSidebar: () => void;
  navigateSurface: (surface: string, layout?: Layout) => void;
  changeLayout: (layout: Layout) => void;
  changeGroupBy: (groupBy: ViewDisplay["groupBy"]) => void;
  changeDisplay: (changes: Partial<ViewDisplay>) => void;
  clearTemporaryFilters: () => void;
  resetDisplayChanges: () => void;
  toggleFilters: (focusEditor?: boolean) => Promise<void>;
  toggleMobileViewControls: (focusSearch?: boolean) => Promise<void>;
  setTemporaryQuery: Dispatch<SetStateAction<ViewQuery>>;
  openCreate: () => Promise<void>;
  openDialogWithCatalog: (
    dialog: Exclude<Dialog, null>,
    kinds: readonly WorkspaceCatalogKind[],
  ) => Promise<void>;
  clearTeamAlert: () => void;
  downloadProjectBackup: (project: ProjectRecord) => Promise<void>;
  openContextualActions: (
    context: ContextualActionContext,
    x: number,
    y: number,
    restoreFocus: HTMLElement | null,
  ) => void;
  copyCurrentLink: () => Promise<void>;
};

export function TaskTrackerHeader({
  data,
  surface,
  layout,
  breadcrumbs,
  surfaceCount,
  sidebarCollapsed,
  mobileSidebarOpen,
  mobileMenuRef,
  searchRef,
  filterTriggerRef,
  displayTriggerRef,
  mobileActionsRef,
  mobileSearchRef,
  search,
  setSearch,
  searchLabel,
  filterOpen,
  setFilterOpen,
  displayOpen,
  setDisplayOpen,
  mobileActionsOpen,
  setMobileActionsOpen,
  catalogLoading,
  catalogOrder,
  setCatalogOrder,
  catalogDirection,
  setCatalogDirection,
  activeSavedView,
  contextProject,
  contextProjectRecord,
  contextReleaseRecord,
  activeTeamDetail,
  teamDetailState,
  teamMutation,
  currentDisplay,
  currentGroupBy,
  currentDisplayDependencies,
  canonicalTemporaryQuery,
  currentViewQuery,
  hasTemporaryFilters,
  hasDisplayChanges,
  hasRuntimeViewChanges,
  canCreateTask,
  canSaveView,
  hasShareContext,
  surfaceContextualEntity,
  systemBackupBusy,
  setDialog,
  setMobileSidebarOpen,
  saveUserPreferences,
  closeMobileSidebar,
  navigateSurface,
  changeLayout,
  changeGroupBy,
  changeDisplay,
  clearTemporaryFilters,
  resetDisplayChanges,
  toggleFilters,
  toggleMobileViewControls,
  setTemporaryQuery,
  openCreate,
  openDialogWithCatalog,
  clearTeamAlert,
  downloadProjectBackup,
  openContextualActions,
  copyCurrentLink,
}: TaskTrackerHeaderProps) {
  const filterCount = queryFilterCount(currentViewQuery);

  return (
    <>
      <header className="surface-header">
        <div className="title-row">
          <div className="title-cluster">
            <button
              className="icon-button desktop-sidebar-toggle"
              type="button"
              aria-controls="workspace-sidebar"
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
              onClick={() => void saveUserPreferences({ sidebarPreference: sidebarCollapsed ? "expanded" : "collapsed" })}
              title="Toggle navigation"
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
            <button
              ref={mobileMenuRef}
              className="icon-button mobile-menu"
              type="button"
              aria-controls="workspace-sidebar"
              aria-expanded={mobileSidebarOpen}
              aria-label={mobileSidebarOpen ? "Close navigation" : "Open navigation"}
              onClick={() => {
                if (mobileSidebarOpen) closeMobileSidebar();
                else setMobileSidebarOpen(true);
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
                  <div className="breadcrumb-step" key={`${item.label}:${index}`} aria-current={current ? "page" : undefined}>
                    {index > 0 && <ChevronRight size={12} className="breadcrumb-chevron" aria-hidden="true" />}
                    {current || !targetSurface ? (
                      <h1 className="breadcrumb-current" title={item.label}>{item.label}</h1>
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
            {surface === "teams" && <button className="button primary" type="button" disabled={Boolean(teamMutation)} aria-busy={teamMutation?.kind === "create" || undefined} onClick={() => { clearTeamAlert(); setDialog("teamCreate"); }}><Plus size={14} />New Team</button>}
            {activeTeamDetail?.currentMembership.role === "owner" && <button className="button ghost" type="button" disabled={Boolean(teamMutation) || teamDetailState.status !== "ready"} onClick={() => { clearTeamAlert(); setDialog("teamRename"); }}><UsersRound size={14} />Rename Team</button>}
            {activeTeamDetail?.currentMembership.role === "owner" && <button className="button primary" type="button" disabled={Boolean(teamMutation) || teamDetailState.status !== "ready"} onClick={() => { clearTeamAlert(); setDialog("teamMemberAdd"); }}><Plus size={14} />Add member</button>}
            {surface.startsWith("project:") && contextProjectRecord && <a className="button ghost" href={projectReleasesPath(contextProjectRecord.publicId)} onClick={(event) => handleLocalLink(event, () => navigateSurface(`project-releases:${contextProjectRecord.id}`, "list"))}><Rocket size={14} />Releases</a>}
            {surface.startsWith("project:") && contextProjectRecord && canEditContent(contextProjectRecord.accessRole) && <button className="button ghost" onClick={() => setDialog("projectEdit")}><FolderKanban size={14} />Edit project</button>}
            {surface.startsWith("release:") && contextReleaseRecord && canEditContent(contextReleaseRecord.accessRole) && <button className="button ghost" onClick={() => setDialog("releaseEdit")}><Rocket size={14} />Edit release</button>}
            {activeSavedView && canEditContent(activeSavedView.accessRole) && <button className="button ghost" onClick={() => void openDialogWithCatalog("viewEdit", ["projects", "releases"])}><Zap size={14} />Edit view</button>}
            {surface.startsWith("project:") && contextProjectRecord?.accessRole === "owner" && <button className="button ghost" disabled={systemBackupBusy} onClick={() => void downloadProjectBackup(contextProjectRecord)}><Download size={14} />{systemBackupBusy ? "Exporting…" : "Backup"}</button>}
            {hasShareContext && <button className="button ghost" onClick={() => setDialog("share")}><Share2 size={14} />Members &amp; access</button>}
            {surfaceContextualEntity && canEditContent(surfaceContextualEntity.accessRole) && <button className="icon-button" type="button" aria-label={`Open contextual actions for ${surfaceContextualEntity.label}`} title="Actions (Cmd/Ctrl+K)" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openContextualActions({ entities: [surfaceContextualEntity] }, rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={16} /></button>}
            <button className="icon-button" title="Copy direct link" onClick={() => void copyCurrentLink()}><Link2 size={16} /></button>
          </div>
        </div>
        {!isCollectionSurface(surface) && (
          <div className="toolbar-row">
            <div className="toolbar-left">
              <div className="desktop-view-controls">
                <div className="search-control">
                  <Search size={13} />
                  <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`${searchLabel}…`} aria-label={searchLabel} />
                  {search && <button onClick={() => setSearch("")}><X size={12} /></button>}
                </div>
                <div className="popover-anchor">
                  <button ref={filterTriggerRef} className={`button ghost ${filterOpen ? "active" : ""}`} aria-keyshortcuts="F" title="Filter (F)" onClick={() => { setDisplayOpen(false); void toggleFilters(); }}><ListFilter size={14} />Filter{filterCount > 0 && <span className="filter-count">{filterCount}</span>}</button>
                  {filterOpen && <FilterPopover data={data} savedView={activeSavedView} temporaryQuery={canonicalTemporaryQuery} scopeProjectId={activeSavedView?.scopeProjectId ?? contextProject} onTemporaryQuery={setTemporaryQuery} onEditSaved={activeSavedView && canEditContent(activeSavedView.accessRole) ? () => { setFilterOpen(false); void openDialogWithCatalog("viewEdit", ["projects", "releases"]); } : undefined} onClose={() => { setFilterOpen(false); filterTriggerRef.current?.focus(); }} />}
                </div>
                <div className="segmented" aria-label="Layout">
                  <button className={layout === "list" ? "active" : ""} aria-keyshortcuts="Meta+B Control+B" onClick={() => changeLayout("list")} title="List (⌘/Ctrl+B)"><LayoutList size={14} /></button>
                  <button className={layout === "board" ? "active" : ""} aria-keyshortcuts="Meta+B Control+B" onClick={() => changeLayout("board")} title="Board (⌘/Ctrl+B)"><Columns3 size={14} /></button>
                </div>
                <div className="popover-anchor display-anchor">
                  <button ref={displayTriggerRef} className={`button ghost ${displayOpen ? "active" : ""}`} aria-keyshortcuts="Shift+V" title="Display (Shift+V)" onClick={() => { setFilterOpen(false); setDisplayOpen((value) => !value); }}><SlidersHorizontal size={14} />Display</button>
                  {displayOpen && <DisplayPopover display={currentDisplay} labelGroups={data.labelGroups ?? []} onLayout={changeLayout} onDisplay={changeDisplay} onClose={() => { setDisplayOpen(false); displayTriggerRef.current?.focus(); }} />}
                </div>
                {hasTemporaryFilters && <button className="button ghost" onClick={clearTemporaryFilters}><X size={13} />Clear temporary</button>}
                {hasDisplayChanges && <button className="button ghost" onClick={resetDisplayChanges}><SlidersHorizontal size={13} />Reset display</button>}
                {canSaveView && (activeSavedView || hasRuntimeViewChanges) && <button className="button ghost" onClick={() => void openDialogWithCatalog("view", ["projects", "releases"])}><Copy size={13} />Save as</button>}
              </div>
              {activeSavedView && <SavedFilterChips data={data} view={activeSavedView} onEdit={canEditContent(activeSavedView.accessRole) ? () => void openDialogWithCatalog("viewEdit", ["projects", "releases"]) : undefined} />}
              {(canonicalTemporaryQuery.conditions?.length ?? 0) > 0 && <FilterChips data={data} query={canonicalTemporaryQuery} scopeProjectId={activeSavedView?.scopeProjectId ?? contextProject} onQuery={setTemporaryQuery} onEdit={() => void toggleFilters()} />}
              <div className="segmented mobile-layout-switcher" role="group" aria-label="Layout">
                <button type="button" className={layout === "list" ? "active" : ""} aria-label="List view" aria-pressed={layout === "list"} onClick={() => changeLayout("list")}><LayoutList size={16} /></button>
                <button type="button" className={layout === "board" ? "active" : ""} aria-label="Kanban view" aria-pressed={layout === "board"} onClick={() => changeLayout("board")}><Columns3 size={16} /></button>
              </div>
              <div className="mobile-view-controls-anchor" ref={mobileActionsRef}>
                <button
                  className={`icon-button mobile-view-controls-trigger ${mobileActionsOpen ? "active" : ""}`}
                  type="button"
                  aria-controls="mobile-view-controls"
                  aria-expanded={mobileActionsOpen}
                  aria-haspopup="dialog"
                  aria-label="Open view controls"
                  aria-busy={catalogLoading && !mobileActionsOpen}
                  onClick={() => void toggleMobileViewControls()}
                >
                  <SlidersHorizontal size={17} />
                  {filterCount > 0 && <span className="filter-count">{filterCount}</span>}
                </button>
                <div className="mobile-view-controls" id="mobile-view-controls" role="dialog" aria-modal="false" aria-label="View controls" hidden={!mobileActionsOpen}>
                  <header>
                    <b>View controls</b>
                    <button type="button" className="icon-button" aria-label="Close view controls" onClick={() => setMobileActionsOpen(false)}><X size={15} /></button>
                  </header>
                  <label className="mobile-search-control">
                    <Search size={15} />
                    <input ref={mobileSearchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`${searchLabel}…`} aria-label={`${searchLabel} on mobile`} />
                    {search && <button type="button" aria-label="Clear search" onClick={() => setSearch("")}><X size={13} /></button>}
                  </label>
                  <section className="mobile-control-section">
                    <h3>Filter</h3>
                    <SavedViewFilterLayers data={data} savedView={activeSavedView} temporaryQuery={canonicalTemporaryQuery} scopeProjectId={activeSavedView?.scopeProjectId ?? contextProject} onTemporaryQuery={setTemporaryQuery} onEditSaved={activeSavedView && canEditContent(activeSavedView.accessRole) ? () => { setMobileActionsOpen(false); void openDialogWithCatalog("viewEdit", ["projects", "releases"]); } : undefined} compact />
                  </section>
                  <section className="mobile-control-section">
                    <h3>Display</h3>
                    <div className="segmented wide" aria-label="Mobile layout">
                      <button className={layout === "list" ? "active" : ""} onClick={() => changeLayout("list")}><LayoutList size={14} />List</button>
                      <button className={layout === "board" ? "active" : ""} onClick={() => changeLayout("board")}><Columns3 size={14} />Board</button>
                    </div>
                    <label className="mobile-display-summary"><span>Group by</span><select value={currentGroupBy} onChange={(event) => changeGroupBy(event.target.value as ViewDisplay["groupBy"])}>{groupByOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                    {currentGroupBy === "label_group" && <label className="mobile-display-summary"><span>Label group</span><select value={currentDisplay.labelGroupId ?? ""} onChange={(event) => changeDisplay({ labelGroupId: event.target.value || null })}>{(data.labelGroups ?? []).filter((group) => !group.archivedAt || group.id === currentDisplay.labelGroupId).map((group) => <option key={group.id} value={group.id}>{group.name}{group.archivedAt ? " (archived)" : ""}</option>)}</select></label>}
                    <label className="mobile-display-summary"><span>Order</span><select value={currentDisplay.orderBy} onChange={(event) => changeDisplay({ orderBy: event.target.value as ViewDisplay["orderBy"] })}>{viewOrderOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                    <label className="mobile-display-summary"><span>Direction</span><select value={currentDisplay.direction} disabled={currentDisplayDependencies.directionDisabled} aria-describedby={currentDisplayDependencies.directionReason ? "mobile-direction-help" : undefined} onChange={(event) => changeDisplay({ direction: event.target.value as ViewDisplay["direction"] })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
                    {currentDisplayDependencies.directionReason && <small id="mobile-direction-help" className="display-dependency-hint">{currentDisplayDependencies.directionReason}</small>}
                    <fieldset className="display-properties"><legend>Properties</legend>{viewFieldOptions.map((option) => <label key={option.value}><input type="checkbox" checked={currentDisplay.visibleFields.includes(option.value)} onChange={() => changeDisplay({ visibleFields: toggleViewField(currentDisplay.visibleFields, option.value) })} />{option.label}</label>)}</fieldset>
                    <label className="display-checkbox"><input type="checkbox" checked={currentDisplay.showEmptyGroups} disabled={currentDisplayDependencies.emptyGroupsDisabled} aria-describedby={currentDisplayDependencies.emptyGroupsReason ? "mobile-empty-groups-help" : undefined} onChange={(event) => changeDisplay({ showEmptyGroups: event.target.checked })} /><span>Show empty groups</span></label>
                    {currentDisplayDependencies.emptyGroupsReason && <small id="mobile-empty-groups-help" className="display-dependency-hint">{currentDisplayDependencies.emptyGroupsReason}</small>}
                  </section>
                  <div className="mobile-controls-footer">
                    {hasTemporaryFilters && <button className="button ghost" type="button" onClick={clearTemporaryFilters}>Clear temporary</button>}
                    {hasDisplayChanges && <button className="button ghost" type="button" onClick={resetDisplayChanges}>Reset display</button>}
                    {canSaveView && (activeSavedView || hasRuntimeViewChanges) && <button className="button ghost" type="button" onClick={() => { setMobileActionsOpen(false); void openDialogWithCatalog("view", ["projects", "releases"]); }}><Copy size={14} />Save as</button>}
                  </div>
                </div>
              </div>
            </div>
            {canCreateTask && <button className="button primary" onClick={() => void openCreate()}><Plus size={14} />New task</button>}
          </div>
        )}
      </header>

      {surface === "teams" && (
        <div className="toolbar-row catalog-toolbar teams-toolbar" aria-label="Teams catalog controls">
          <div className="toolbar-left">
            <div className="search-control">
              <Search size={13} />
              <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search teams…" aria-label="Search teams" />
              {search && <button type="button" aria-label="Clear Team search" onClick={() => setSearch("")}><X size={12} /></button>}
            </div>
          </div>
        </div>
      )}

      {(surface === "projects" || surface === "releases" || surface === "views") && (
        <div className="toolbar-row catalog-toolbar" aria-label={`${surface} catalog controls`}>
          <div className="toolbar-left">
            <div className="search-control">
              <Search size={13} />
              <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`${searchLabel}…`} aria-label={searchLabel} />
              {search && <button type="button" aria-label="Clear catalog search" onClick={() => setSearch("")}><X size={12} /></button>}
            </div>
            <label className="catalog-sort">
              <span>Sort</span>
              <select
                aria-label="Sort catalog"
                value={catalogOrder}
                onChange={(event) => {
                  const order = event.target.value as "updated" | "name";
                  setCatalogOrder(order);
                  setCatalogDirection(order === "name" ? "asc" : "desc");
                }}
              >
                <option value="updated">Recently updated</option>
                <option value="name">Name</option>
              </select>
            </label>
            <button
              className="button ghost compact"
              type="button"
              aria-label={catalogDirection === "asc" ? "Sort descending" : "Sort ascending"}
              onClick={() => setCatalogDirection((current) => current === "asc" ? "desc" : "asc")}
            >
              {catalogDirection === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
              {catalogDirection === "asc" ? "Ascending" : "Descending"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
