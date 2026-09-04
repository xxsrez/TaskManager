"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useRef,
} from "react";
import {
  Boxes,
  ChevronDown,
  Circle,
  CircleDot,
  Inbox,
  LogOut,
  PanelsTopLeft,
  Plus,
  Rocket,
  Search,
  Settings2,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import { navigationPath, type Layout } from "@/lib/navigation";
import { formatReleaseName } from "@/lib/release-presentation";
import type { ContextualActionContext } from "@/lib/contextual-actions";
import type {
  AppSnapshot,
  ProjectRecord,
  UserRecord,
  WorkflowStatusRecord,
  WorkspaceCatalogKind,
} from "@/lib/types";
import {
  builtInViews,
  type Dialog,
  type TaskCreateDefaults,
} from "@/components/task-tracker-state";
import {
  NavItem,
  SidebarSavedViewItem,
  SidebarSection,
  handleLocalLink,
  initials,
  taskCountForView,
  viewContextualEntity,
} from "@/components/task-tracker-view";

export function nextAccountMenuFocusIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | null {
  if (itemCount <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
  if (key === "ArrowUp") {
    return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
  }
  return null;
}

export function AccountMenu({
  user,
  isAdmin,
  onNavigate,
}: {
  user: UserRecord;
  isAdmin: boolean;
  onNavigate: (event: ReactMouseEvent<HTMLAnchorElement>, surface: string) => void;
}) {
  const accountMenuFirstItemRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => accountMenuFirstItemRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex = nextAccountMenuFocusIndex(event.key, currentIndex, items.length);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  return (
    <div className="account-menu" role="menu" aria-label="Account menu" tabIndex={-1} onKeyDown={handleKeyDown}>
      <a className="account-menu-user account-menu-identity" href="/settings/profile" role="menuitem" ref={accountMenuFirstItemRef} aria-label={`Open profile settings for ${user.displayName}, ${user.email}`} onClick={(event) => onNavigate(event, "settings:profile")}>
        <span className="avatar">{initials(user.displayName)}</span>
        <span><b>{user.displayName}</b><small>{user.email}</small><small className="account-provider">Signed in with ChatGPT</small></span>
      </a>
      <div className="account-menu-separator" role="separator" />
      <a className="account-menu-item" href="/workspace" role="menuitem" onClick={(event) => onNavigate(event, "workspace")}><Boxes size={14} /><span>Workspace</span></a>
      <a className="account-menu-item" href="/settings/profile" role="menuitem" onClick={(event) => onNavigate(event, "settings:profile")}><Settings2 size={14} /><span>Settings</span></a>
      {isAdmin && <a className="account-menu-item" href="/admin" role="menuitem" onClick={(event) => onNavigate(event, "admin")}><ShieldCheck size={14} /><span>Administration</span></a>}
    </div>
  );
}

export function TaskTrackerSidebar({
  data,
  surface,
  compact,
  mobileOpen,
  mobileCloseRef,
  accountMenuRef,
  accountTriggerRef,
  accountMenuOpen,
  setAccountMenuOpen,
  signOutPath,
  sidebarViews,
  sidebarProjects,
  sidebarReleases,
  statusMap,
  projectMap,
  navigateSurface,
  openCreate,
  openGlobalSearch,
  closeMobileSidebar,
  openDialogWithCatalog,
  openProjectDialog,
  openContextualActions,
}: {
  data: AppSnapshot;
  surface: string;
  compact: boolean;
  mobileOpen: boolean;
  mobileCloseRef: RefObject<HTMLButtonElement | null>;
  accountMenuRef: RefObject<HTMLDivElement | null>;
  accountTriggerRef: RefObject<HTMLButtonElement | null>;
  accountMenuOpen: boolean;
  setAccountMenuOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  signOutPath: string;
  sidebarViews: AppSnapshot["views"];
  sidebarProjects: AppSnapshot["projects"];
  sidebarReleases: AppSnapshot["releases"];
  statusMap: Map<string, WorkflowStatusRecord>;
  projectMap: Map<string, ProjectRecord>;
  navigateSurface: (surface: string, layout?: Layout) => void;
  openCreate: (defaults?: TaskCreateDefaults) => Promise<void>;
  openGlobalSearch: () => void;
  closeMobileSidebar: () => void;
  openDialogWithCatalog: (
    dialog: Exclude<Dialog, null>,
    kinds: readonly WorkspaceCatalogKind[],
  ) => Promise<void>;
  openProjectDialog: () => void;
  openContextualActions: (
    context: ContextualActionContext,
    x: number,
    y: number,
    restoreFocus: HTMLElement | null,
  ) => void;
}) {
  return (
    <aside className="sidebar" id="workspace-sidebar">
      <div className="sidebar-head">
        <a className="workspace-switcher" href={navigationPath({ surface: "workspace", layout: "list", taskId: null }, data)} title="Go to workspace" aria-current={surface === "workspace" ? "page" : undefined} onClick={(event) => handleLocalLink(event, () => navigateSurface("workspace", "list"))}>
          <span className="product-mark">T</span>
          {!compact && <span className="workspace-name">Task Manager</span>}
        </a>
        {!compact && <button className="icon-button" onClick={() => void openCreate()} title="Create task (C)"><Plus size={15} /></button>}
        {compact && <button className="icon-button" type="button" onClick={openGlobalSearch} title="Global search (/)" aria-label="Open global search"><Search size={15} /></button>}
        {mobileOpen && <button ref={mobileCloseRef} className="icon-button mobile-sidebar-close" type="button" aria-label="Close navigation" onClick={closeMobileSidebar} autoFocus><X size={16} /></button>}
      </div>
      {!compact && <button className="sidebar-search" onClick={openGlobalSearch}><Search size={14} /><span>Search</span><kbd>/</kbd></button>}
      <nav className="nav-scroll" aria-label="Workspace">
        <NavItem compact={compact} icon={<PanelsTopLeft size={15} />} label="Workspace" active={surface === "workspace"} href="/workspace" onNavigate={() => navigateSurface("workspace", "list")} />
        <NavItem compact={compact} icon={<Inbox size={15} />} label="My tasks" active={surface === "mine"} href="/issues" onNavigate={() => navigateSurface("mine", "list")} count={taskCountForView("mine", data, statusMap)} />
        <NavItem compact={compact} icon={<UsersRound size={15} />} label="Shared with me" active={surface === "shared"} href="/shared" onNavigate={() => navigateSurface("shared", "list")} />
        <NavItem compact={compact} icon={<UsersRound size={15} />} label="Teams" active={surface === "teams" || surface.startsWith("team:")} href="/teams" onNavigate={() => navigateSurface("teams", "list")} />
        {!compact && <>
          <SidebarSection title="Views" action={() => void openDialogWithCatalog("view", ["projects"])}>
            <NavItem compact={false} icon={<Boxes size={13} />} label="All views" active={surface === "views"} href="/views" onNavigate={() => navigateSurface("views", "list")} />
            {builtInViews.filter((view) => view.id !== "mine").map((view) => <NavItem key={view.id} compact={false} icon={<Circle size={9} />} label={view.label} active={surface === view.id} href={navigationPath({ surface: view.id, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(view.id, "list")} count={taskCountForView(view.id, data, statusMap)} />)}
            {sidebarViews.map((view) => <SidebarSavedViewItem key={view.id} view={view} active={surface === `view:${view.id}`} href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)} onNavigate={() => navigateSurface(`view:${view.id}`, view.display.layout)} onContextActions={(x, y, focus) => openContextualActions({ entities: [viewContextualEntity(view)] }, x, y, focus)} />)}
          </SidebarSection>
          <SidebarSection title="Projects" action={openProjectDialog}>
            <NavItem compact={false} icon={<Boxes size={13} />} label="All projects" active={surface === "projects"} href="/projects" onNavigate={() => navigateSurface("projects", "list")} />
            {sidebarProjects.map((project) => <NavItem key={project.id} compact={false} icon={<span className="project-dot" style={{ background: project.color }} />} label={project.name} active={surface === `project:${project.id}`} href={navigationPath({ surface: `project:${project.id}`, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(`project:${project.id}`, "list")} />)}
          </SidebarSection>
          <SidebarSection title="Releases" action={() => void openDialogWithCatalog("release", ["projects"])}>
            <NavItem compact={false} icon={<Rocket size={13} />} label="All releases" active={surface === "releases"} href="/releases" onNavigate={() => navigateSurface("releases", "list")} />
            {sidebarReleases.map((release) => <NavItem key={release.id} compact={false} icon={<CircleDot size={12} />} label={formatReleaseName(projectMap.get(release.projectId)?.name, release.name)} active={surface === `release:${release.id}`} href={navigationPath({ surface: `release:${release.id}`, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(`release:${release.id}`, "list")} />)}
          </SidebarSection>
        </>}
      </nav>
      <div className="sidebar-foot">
        <div className="account-control" ref={accountMenuRef}>
          {accountMenuOpen && <AccountMenu user={data.user} isAdmin={data.isAdmin} onNavigate={(event, nextSurface) => handleLocalLink(event, () => { navigateSurface(nextSurface, "list"); setAccountMenuOpen(false); })} />}
          <div className="profile-row">
            <button className="profile-trigger" ref={accountTriggerRef} type="button" aria-haspopup="menu" aria-expanded={accountMenuOpen} title={compact ? "Open account menu" : undefined} onClick={() => setAccountMenuOpen((value) => !value)}>
              <span className="avatar small">{initials(data.user.displayName)}</span>
              {!compact && <span className="profile-label"><b>{data.user.displayName}</b><small>{data.user.email}</small></span>}
              {!compact && <ChevronDown size={13} className={`profile-chevron ${accountMenuOpen ? "open" : ""}`} />}
            </button>
            <a className="profile-logout" href={signOutPath} title="Sign out" aria-label="Sign out"><LogOut size={14} /></a>
          </div>
        </div>
      </div>
    </aside>
  );
}
