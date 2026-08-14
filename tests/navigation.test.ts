import assert from "node:assert/strict";
import test from "node:test";
import {
  navigationHistoryState,
  navigationPath,
  parseNavigationPath,
  pathFromRouteSegments,
  resolveNavigationHistoryState,
  resolveNavigationTarget,
} from "../lib/navigation";
import type { AppSnapshot } from "../lib/types";

const snapshot = {
  projects: [{ id: "project-homeostat" }],
  releases: [
    { id: "release-01", projectId: "project-homeostat" },
  ],
  tasks: [
    {
      id: "task-1",
      projectId: "project-homeostat",
      releaseId: "release-01",
      archivedAt: null,
    },
  ],
  views: [
    {
      id: "view-homeostat",
      display: { layout: "list" },
    },
  ],
} as AppSnapshot;

test("REST-style paths identify views, boards, projects, releases, and tasks", () => {
  assert.deepEqual(parseNavigationPath("/views/view-homeostat/board"), {
    kind: "view",
    id: "view-homeostat",
    layout: "board",
  });
  assert.deepEqual(parseNavigationPath("/projects/project-homeostat"), {
    kind: "project",
    id: "project-homeostat",
    layout: undefined,
  });
  assert.deepEqual(parseNavigationPath("/releases/release-01/board"), {
    kind: "release",
    id: "release-01",
    layout: "board",
  });
  assert.deepEqual(parseNavigationPath("/tasks/task-1"), {
    kind: "task",
    id: "task-1",
  });
});

test("catch-all route segments are encoded exactly once in local and production runtimes", () => {
  assert.equal(
    pathFromRouteSegments(["linear:view:user-1:homeostat", "board"]),
    "/linear%3Aview%3Auser-1%3Ahomeostat/board",
  );
  assert.equal(
    pathFromRouteSegments(["linear%3Aview%3Auser-1%3Ahomeostat", "board"]),
    "/linear%3Aview%3Auser-1%3Ahomeostat/board",
  );
});

test("a direct view board path restores both its query surface and layout", () => {
  const target = parseNavigationPath("/views/view-homeostat/board");
  assert.ok(target);
  assert.deepEqual(resolveNavigationTarget(target, snapshot), {
    surface: "view:view-homeostat",
    layout: "board",
    taskId: null,
  });
});

test("unknown and malformed targets fail closed", () => {
  const unknown = parseNavigationPath("/projects/missing/board");
  assert.ok(unknown);
  assert.equal(resolveNavigationTarget(unknown, snapshot), null);
  assert.equal(parseNavigationPath("/views/view-homeostat/board/extra"), null);
  assert.equal(parseNavigationPath("/projects/project-homeostat/timeline"), null);
});

test("navigation state formats back to stable slash paths", () => {
  assert.equal(
    navigationPath({
      surface: "project:project-homeostat",
      layout: "board",
      taskId: null,
    }),
    "/projects/project-homeostat/board",
  );
  assert.equal(
    navigationPath({
      surface: "release:release-01",
      layout: "list",
      taskId: null,
    }),
    "/releases/release-01",
  );
  assert.equal(
    navigationPath({
      surface: "view:view-homeostat",
      layout: "list",
      taskId: "task-1",
    }),
    "/tasks/task-1",
  );
});

test("task history restores the board context without adding it to the task URL", () => {
  const navigation = {
    surface: "view:view-homeostat",
    layout: "board" as const,
    taskId: "task-1",
  };
  const state = navigationHistoryState(navigation);
  assert.equal(navigationPath(navigation), "/tasks/task-1");
  assert.deepEqual(
    resolveNavigationHistoryState(state, "/tasks/task-1", snapshot),
    navigation,
  );
  assert.equal(
    resolveNavigationHistoryState(state, "/tasks/missing", snapshot),
    null,
  );
});
