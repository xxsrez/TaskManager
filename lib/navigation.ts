import type { AppSnapshot } from "./types";

export type Layout = "list" | "board";

export type NavigationTarget =
  | { kind: "root" }
  | { kind: "shared" }
  | { kind: "projects" }
  | { kind: "releases" }
  | { kind: "view"; id: string; layout?: Layout }
  | { kind: "project"; id: string; layout?: Layout }
  | { kind: "release"; id: string; layout?: Layout }
  | { kind: "task"; id: string };

export type ResolvedNavigation = {
  surface: string;
  layout: Layout;
  taskId: string | null;
};

const navigationStateKey = "taskManagerNavigation";

export const builtInViewIds = new Set([
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
  if (segments.length === 1 && segments[0] === "shared") {
    return { kind: "shared" };
  }
  if (segments.length === 1 && segments[0] === "projects") {
    return { kind: "projects" };
  }
  if (segments.length === 1 && segments[0] === "releases") {
    return { kind: "releases" };
  }
  if (segments.length === 2 && segments[0] === "tasks") {
    return segments[1] ? { kind: "task", id: segments[1] } : null;
  }

  const kind = singularKind(segments[0]);
  if (!kind || !segments[1] || segments.length > 3) return null;
  if (segments[2] === undefined) {
    return { kind, id: segments[1], layout: undefined };
  }
  const layout = parseLayout(segments[2]);
  return layout ? { kind, id: segments[1], layout } : null;
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
  if (target.kind === "shared") {
    return { surface: "shared", layout: "list", taskId: null };
  }
  if (target.kind === "projects" || target.kind === "releases") {
    return { surface: target.kind, layout: "list", taskId: null };
  }
  if (target.kind === "view") {
    if (builtInViewIds.has(target.id)) {
      return {
        surface: target.id,
        layout: target.layout ?? "list",
        taskId: null,
      };
    }
    const view = data.views.find((item) => item.id === target.id);
    return view
      ? {
          surface: `view:${view.id}`,
          layout: target.layout ?? view.display.layout,
          taskId: null,
        }
      : null;
  }
  if (target.kind === "project") {
    return data.projects.some((item) => item.id === target.id)
      ? {
          surface: `project:${target.id}`,
          layout: target.layout ?? "list",
          taskId: null,
        }
      : null;
  }
  if (target.kind === "release") {
    return data.releases.some((item) => item.id === target.id)
      ? {
          surface: `release:${target.id}`,
          layout: target.layout ?? "list",
          taskId: null,
        }
      : null;
  }

  const task = data.tasks.find((item) => item.id === target.id);
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

export function navigationPath(navigation: ResolvedNavigation): string {
  if (navigation.taskId) return taskPath(navigation.taskId);
  const { surface, layout } = navigation;
  if (surface === "projects" || surface === "releases") return `/${surface}`;
  if (surface === "shared") return "/shared";
  if (surface.startsWith("view:")) {
    return collectionPath("views", surface.slice(5), layout, true);
  }
  if (surface.startsWith("project:")) {
    return collectionPath("projects", surface.slice(8), layout, false);
  }
  if (surface.startsWith("release:")) {
    return collectionPath("releases", surface.slice(8), layout, false);
  }
  return collectionPath("views", surface, layout, false);
}

export function taskPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}`;
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
  if (
    typeof value.surface !== "string" ||
    (value.layout !== "list" && value.layout !== "board") ||
    typeof value.taskId !== "string" ||
    taskPath(value.taskId) !== pathname ||
    !data.tasks.some((task) => task.id === value.taskId)
  ) {
    return null;
  }

  const backgroundTarget = parseNavigationPath(
    navigationPath({
      surface: value.surface,
      layout: value.layout,
      taskId: null,
    }),
  );
  if (!backgroundTarget || !resolveNavigationTarget(backgroundTarget, data)) {
    return null;
  }
  return {
    surface: value.surface,
    layout: value.layout,
    taskId: value.taskId,
  };
}

function collectionPath(
  collection: "views" | "projects" | "releases",
  id: string,
  layout: Layout,
  explicitList: boolean,
): string {
  const base = `/${collection}/${encodeURIComponent(id)}`;
  if (layout === "board") return `${base}/board`;
  return explicitList ? `${base}/list` : base;
}

function singularKind(value: string): "view" | "project" | "release" | null {
  if (value === "views") return "view";
  if (value === "projects") return "project";
  if (value === "releases") return "release";
  return null;
}

function parseLayout(value: string): Layout | null {
  return value === "list" || value === "board" ? value : null;
}

function safeDecodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
