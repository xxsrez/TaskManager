import type { AppSnapshot } from "./types";

export type Layout = "list" | "board";
export type IssueFilter = "all" | "active" | "backlog" | "archived";

export type NavigationTarget =
  | { kind: "root" }
  | { kind: "admin" }
  | { kind: "shared" }
  | { kind: "issues"; filter: IssueFilter; layout: Layout }
  | { kind: "issue"; id: string }
  | { kind: "legacyTask"; id: string }
  | { kind: "views" }
  | { kind: "view"; id: string; layout?: Layout }
  | { kind: "legacyBuiltInView"; filter: IssueFilter; layout: Layout }
  | { kind: "projects" }
  | { kind: "project"; id: string; layout?: Layout }
  | { kind: "projectReleases"; projectId: string }
  | {
      kind: "projectRelease";
      projectId: string;
      releaseId: string;
      layout?: Layout;
    }
  | { kind: "releases" }
  | { kind: "legacyRelease"; id: string; layout?: Layout };

export type ResolvedNavigation = {
  surface: string;
  layout: Layout;
  taskId: string | null;
};

const navigationStateKey = "taskManagerNavigation";

export const builtInViewIds = new Set<IssueFilter>([
  "all",
  "active",
  "backlog",
  "archived",
]);

export function parseNavigationPath(pathname: string): NavigationTarget | null {
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map(safeDecodeSegment);
  if (segments.some((segment) => segment === null)) return null;
  return parseNavigationSegments(segments as string[]);
}

export function parseNavigationSegments(
  segments: string[],
): NavigationTarget | null {
  if (segments.length === 0) return { kind: "root" };
  if (segments.length === 1 && segments[0] === "admin") {
    return { kind: "admin" };
  }
  if (segments.length === 1 && segments[0] === "shared") {
    return { kind: "shared" };
  }
  if (segments[0] === "issues") return parseIssueSegments(segments);
  if (segments[0] === "views") return parseViewSegments(segments);
  if (segments[0] === "projects") return parseProjectSegments(segments);
  if (segments[0] === "releases") return parseReleaseSegments(segments);
  if (segments.length === 2 && segments[0] === "tasks" && segments[1]) {
    return { kind: "legacyTask", id: segments[1] };
  }
  return null;
}

export function pathFromRouteSegments(segments: string[]): string {
  return `/${segments
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .map(encodeURIComponent)
    .join("/")}`;
}

export function resolveNavigationTarget(
  target: NavigationTarget,
  data: AppSnapshot,
): ResolvedNavigation | null {
  if (target.kind === "root") {
    return { surface: "all", layout: "list", taskId: null };
  }
  if (target.kind === "admin") {
    return data.admin
      ? { surface: "admin", layout: "list", taskId: null }
      : null;
  }
  if (target.kind === "shared") {
    return { surface: "shared", layout: "list", taskId: null };
  }
  if (target.kind === "issues" || target.kind === "legacyBuiltInView") {
    return {
      surface: target.filter,
      layout: target.layout,
      taskId: null,
    };
  }
  if (target.kind === "views" || target.kind === "projects") {
    return { surface: target.kind, layout: "list", taskId: null };
  }
  if (target.kind === "releases") {
    return { surface: "releases", layout: "list", taskId: null };
  }
  if (target.kind === "view") {
    const view = findAddressable(data.views, target.id);
    return view
      ? {
          surface: `view:${view.id}`,
          layout: target.layout ?? view.display.layout,
          taskId: null,
        }
      : null;
  }
  if (target.kind === "project") {
    const project = findAddressable(data.projects, target.id);
    return project
      ? {
          surface: `project:${project.id}`,
          layout: target.layout ?? "list",
          taskId: null,
        }
      : null;
  }
  if (target.kind === "projectReleases") {
    const project = findAddressable(data.projects, target.projectId);
    return project
      ? {
          surface: `project-releases:${project.id}`,
          layout: "list",
          taskId: null,
        }
      : null;
  }
  if (target.kind === "projectRelease") {
    const project = findAddressable(data.projects, target.projectId);
    const release = findAddressable(data.releases, target.releaseId);
    return project && release?.projectId === project.id
      ? {
          surface: `release:${release.id}`,
          layout: target.layout ?? "list",
          taskId: null,
        }
      : null;
  }
  if (target.kind === "legacyRelease") {
    const release = findAddressable(data.releases, target.id);
    return release
      ? {
          surface: `release:${release.id}`,
          layout: target.layout ?? "list",
          taskId: null,
        }
      : null;
  }

  const task = findAddressable(data.tasks, target.id);
  if (!task) return null;
  const surface = task.releaseId
    ? `release:${task.releaseId}`
    : task.projectId
      ? `project:${task.projectId}`
      : task.archivedAt
        ? "archived"
        : "all";
  return { surface, layout: "list", taskId: task.id };
}

export function navigationPath(
  navigation: ResolvedNavigation,
  data: AppSnapshot,
): string {
  if (navigation.taskId) {
    const task = data.tasks.find((item) => item.id === navigation.taskId);
    return task ? taskPath(task.publicId) : "/issues";
  }

  const { surface, layout } = navigation;
  if (surface === "admin") return "/admin";
  if (surface === "views" || surface === "projects" || surface === "releases") {
    return `/${surface}`;
  }
  if (surface === "shared") return "/shared";
  if (surface.startsWith("view:")) {
    const view = data.views.find((item) => item.id === surface.slice(5));
    if (!view) return "/views";
    const base = `/views/${encodeURIComponent(view.publicId)}`;
    return layout === view.display.layout ? base : `${base}/${layout}`;
  }
  if (surface.startsWith("project-releases:")) {
    const project = data.projects.find(
      (item) => item.id === surface.slice("project-releases:".length),
    );
    return project
      ? `/projects/${encodeURIComponent(project.publicId)}/releases`
      : "/projects";
  }
  if (surface.startsWith("project:")) {
    const project = data.projects.find((item) => item.id === surface.slice(8));
    if (!project) return "/projects";
    return collectionPath(
      `/projects/${encodeURIComponent(project.publicId)}`,
      layout,
    );
  }
  if (surface.startsWith("release:")) {
    const release = data.releases.find((item) => item.id === surface.slice(8));
    const project = release
      ? data.projects.find((item) => item.id === release.projectId)
      : undefined;
    if (!release || !project) return "/releases";
    return collectionPath(
      `/projects/${encodeURIComponent(project.publicId)}/releases/${encodeURIComponent(release.publicId)}`,
      layout,
    );
  }
  return issueCollectionPath(surface as IssueFilter, layout);
}

export function taskPath(publicId: string): string {
  return `/issues/${encodeURIComponent(publicId)}`;
}

export function projectReleasesPath(publicId: string): string {
  return `/projects/${encodeURIComponent(publicId)}/releases`;
}

export function legacyRedirectPath(
  target: NavigationTarget,
  data: AppSnapshot,
): string | null {
  const resolved = resolveNavigationTarget(target, data);
  if (!resolved) return null;
  const canonical = navigationPath(resolved, data);

  if (
    target.kind === "legacyTask" ||
    target.kind === "legacyRelease" ||
    target.kind === "legacyBuiltInView"
  ) {
    return canonical;
  }

  const usesInternalId =
    (target.kind === "view" &&
      data.views.some(
        (item) => item.id === target.id && item.publicId !== target.id,
      )) ||
    (target.kind === "project" &&
      data.projects.some(
        (item) => item.id === target.id && item.publicId !== target.id,
      )) ||
    (target.kind === "projectReleases" &&
      data.projects.some(
        (item) =>
          item.id === target.projectId && item.publicId !== target.projectId,
      )) ||
    (target.kind === "projectRelease" &&
      (data.projects.some(
        (item) =>
          item.id === target.projectId && item.publicId !== target.projectId,
      ) ||
        data.releases.some(
          (item) =>
            item.id === target.releaseId && item.publicId !== target.releaseId,
        ))) ||
    (target.kind === "issue" &&
      data.tasks.some(
        (item) => item.id === target.id && item.publicId !== target.id,
      ));
  return usesInternalId ? canonical : null;
}

export function navigationHistoryState(navigation: ResolvedNavigation) {
  return { [navigationStateKey]: navigation };
}

export function resolveNavigationHistoryState(
  state: unknown,
  pathname: string,
  data: AppSnapshot,
): ResolvedNavigation | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as Record<string, unknown>)[navigationStateKey];
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  const task =
    typeof value.taskId === "string"
      ? data.tasks.find((item) => item.id === value.taskId)
      : undefined;
  if (
    typeof value.surface !== "string" ||
    (value.layout !== "list" && value.layout !== "board") ||
    !task ||
    taskPath(task.publicId) !== pathname
  ) {
    return null;
  }

  const backgroundPath = navigationPath(
    {
      surface: value.surface,
      layout: value.layout,
      taskId: null,
    },
    data,
  );
  const backgroundTarget = parseNavigationPath(backgroundPath);
  if (!backgroundTarget || !resolveNavigationTarget(backgroundTarget, data)) {
    return null;
  }
  return {
    surface: value.surface,
    layout: value.layout,
    taskId: task.id,
  };
}

function parseIssueSegments(segments: string[]): NavigationTarget | null {
  if (segments.length === 1) {
    return { kind: "issues", filter: "all", layout: "list" };
  }
  if (segments.length === 2 && segments[1] === "board") {
    return { kind: "issues", filter: "all", layout: "board" };
  }
  const filter = parseIssueFilter(segments[1]);
  if (filter && filter !== "all") {
    if (segments.length === 2) {
      return { kind: "issues", filter, layout: "list" };
    }
    const layout = segments.length === 3 ? parseLayout(segments[2]) : null;
    return layout ? { kind: "issues", filter, layout } : null;
  }
  return segments.length === 2 && segments[1]
    ? { kind: "issue", id: segments[1] }
    : null;
}

function parseViewSegments(segments: string[]): NavigationTarget | null {
  if (segments.length === 1) return { kind: "views" };
  const builtIn = parseIssueFilter(segments[1]);
  if (builtIn) {
    if (segments.length === 2) {
      return { kind: "legacyBuiltInView", filter: builtIn, layout: "list" };
    }
    const layout = segments.length === 3 ? parseLayout(segments[2]) : null;
    return layout
      ? { kind: "legacyBuiltInView", filter: builtIn, layout }
      : null;
  }
  if (!segments[1] || segments.length > 3) return null;
  if (segments.length === 2) {
    return { kind: "view", id: segments[1], layout: undefined };
  }
  const layout = parseLayout(segments[2]);
  return layout ? { kind: "view", id: segments[1], layout } : null;
}

function parseProjectSegments(segments: string[]): NavigationTarget | null {
  if (segments.length === 1) return { kind: "projects" };
  if (!segments[1]) return null;
  if (segments.length === 2) {
    return { kind: "project", id: segments[1], layout: undefined };
  }
  if (segments.length === 3) {
    const layout = parseLayout(segments[2]);
    if (layout) return { kind: "project", id: segments[1], layout };
    if (segments[2] === "releases") {
      return { kind: "projectReleases", projectId: segments[1] };
    }
    return null;
  }
  if (
    segments[2] !== "releases" ||
    !segments[3] ||
    segments.length > 5
  ) {
    return null;
  }
  if (segments.length === 4) {
    return {
      kind: "projectRelease",
      projectId: segments[1],
      releaseId: segments[3],
      layout: undefined,
    };
  }
  const layout = parseLayout(segments[4]);
  return layout
    ? {
        kind: "projectRelease",
        projectId: segments[1],
        releaseId: segments[3],
        layout,
      }
    : null;
}

function parseReleaseSegments(segments: string[]): NavigationTarget | null {
  if (segments.length === 1) return { kind: "releases" };
  if (!segments[1] || segments.length > 3) return null;
  if (segments.length === 2) {
    return { kind: "legacyRelease", id: segments[1], layout: undefined };
  }
  const layout = parseLayout(segments[2]);
  return layout
    ? { kind: "legacyRelease", id: segments[1], layout }
    : null;
}

function collectionPath(base: string, layout: Layout): string {
  return layout === "board" ? `${base}/board` : base;
}

function issueCollectionPath(filter: IssueFilter, layout: Layout): string {
  const base = filter === "all" ? "/issues" : `/issues/${filter}`;
  return layout === "board" ? `${base}/board` : base;
}

function findAddressable<T extends { id: string; publicId: string }>(
  records: T[],
  id: string,
): T | undefined {
  return records.find((item) => item.publicId === id || item.id === id);
}

function parseIssueFilter(value: string | undefined): IssueFilter | null {
  return value && builtInViewIds.has(value as IssueFilter)
    ? (value as IssueFilter)
    : null;
}

function parseLayout(value: string | undefined): Layout | null {
  return value === "list" || value === "board" ? value : null;
}

function safeDecodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
