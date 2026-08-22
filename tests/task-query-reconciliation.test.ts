import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTaskQueryDependencies,
  authoritativeTaskQueryRefreshLimit,
  createTaskQueryRefreshCoordinator,
  mutationAffectsTaskQuery,
  reconcileTaskQueryMembership,
  taskMutationDependencies,
  taskQueryRequestToken,
  taskQueryResponseIsCurrent,
  type TaskQueryDependency,
} from "../lib/task-query-reconciliation";
import type { TaskRecord, ViewDisplay, ViewQuery } from "../lib/types";

const display = (
  layout: ViewDisplay["layout"] = "list",
  groupBy: ViewDisplay["groupBy"] = "none",
  orderBy: ViewDisplay["orderBy"] = "manual",
): ViewDisplay => ({
  layout,
  groupBy,
  orderBy,
  direction: "asc",
  showEmptyGroups: false,
  visibleFields: [],
});

function task(id: string, values: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    publicId: `public-${id}`,
    ownerUserId: "owner",
    creatorUserId: "owner",
    identifier: id.toUpperCase(),
    sequenceNumber: 1,
    title: `Task ${id}`,
    description: null,
    statusId: "todo",
    priority: "none",
    assigneeUserId: null,
    projectId: "project-a",
    releaseId: null,
    estimate: null,
    dueDate: null,
    parentTaskId: null,
    rank: 1,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    commentCount: 0,
    version: 1,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    accessRole: "owner",
    ...values,
  };
}

test("active dependencies cover query, surface, scope, grouping, and ordering", () => {
  const query: ViewQuery = {
    version: 1,
    op: "all",
    search: "TM-296",
    conditions: [
      { field: "status_category", operator: "is", value: "started" },
      { field: "label", operator: "in", value: ["bug"] },
      { field: "label_group", operator: "is", value: { groupId: "team", mode: "any" } },
      { field: "subtasks", operator: "is", value: true },
      { field: "relation", operator: "is", value: { type: "blocks", direction: "either" } },
    ],
  };
  const dependencies = activeTaskQueryDependencies({
    query,
    surface: "release:release-a",
    scopeProjectId: "project-a",
    display: display("board", "label_group", "updated"),
  });

  for (const expected of [
    "identifier", "title", "description", "status", "status_category",
    "label", "label_group", "parent", "subtasks", "relation", "release",
    "project", "updated_at", "archived",
  ] satisfies TaskQueryDependency[]) {
    assert.equal(dependencies.has(expected), true, expected);
  }
});

test("only active membership or order dependencies invalidate the query", () => {
  const dependencies = activeTaskQueryDependencies({
    query: { version: 1, op: "all", conditions: [{ field: "release", operator: "is", value: "r1" }] },
    surface: "workspace",
    display: display("list", "status", "priority"),
  });

  assert.equal(mutationAffectsTaskQuery(dependencies, ["release"]), true);
  assert.equal(mutationAffectsTaskQuery(dependencies, ["status"]), true);
  assert.equal(mutationAffectsTaskQuery(dependencies, ["priority"]), true);
  assert.equal(mutationAffectsTaskQuery(dependencies, ["title"]), false);
  assert.equal(mutationAffectsTaskQuery(dependencies, ["relation", "label"]), false);
});

test("task diffs expose exact changed facets and new tasks expose all task-owned facets", () => {
  const before = task("a");
  const after = task("a", {
    statusId: "done",
    releaseId: "r2",
    parentTaskId: "parent",
    updatedAt: "2026-08-22T01:00:00.000Z",
    version: 2,
  });
  assert.deepEqual(
    [...taskMutationDependencies(before, after)].sort(),
    ["parent", "release", "status", "status_category", "updated_at"].sort(),
  );
  const created = taskMutationDependencies(null, after);
  assert.equal(created.has("release"), true);
  assert.equal(created.has("rank"), true);
  assert.equal(created.has("access_role"), true);
});

for (const layout of ["list", "board"] as const) {
  test(`${layout} membership reconciles match to non-match and non-match to match without dropping details`, () => {
    const leaving = task("leaving", { releaseId: "r2", description: "loaded detail" });
    const entering = task("entering", { releaseId: "r1", version: 2 });
    const unaffected = task("unaffected", { releaseId: "r1" });
    const state = {
      layout,
      query: "same-key",
      taskIds: ["leaving", "unaffected"],
      tasks: [leaving, entering, unaffected],
      status: "ready" as const,
    };
    let predicateCalls = 0;
    const next = reconcileTaskQueryMembership(
      state,
      [task("leaving", { releaseId: null, version: 2, description: "loaded detail" }), entering],
      (candidate) => {
        predicateCalls += 1;
        return candidate.releaseId === "r1";
      },
    );

    assert.equal(predicateCalls, 2, "only affected tasks are evaluated");
    assert.deepEqual(next.taskIds, ["unaffected", "entering"]);
    assert.equal(next.tasks.find((item) => item.id === "leaving")?.description, "loaded detail");
    assert.equal(next.tasks.find((item) => item.id === "entering")?.version, 2);
    assert.equal(next.layout, layout);
  });
}

test("membership update preserves existing ID order and collapses duplicate affected IDs", () => {
  const state = { taskIds: ["a", "b"], tasks: [task("a"), task("b")] };
  const next = reconcileTaskQueryMembership(
    state,
    [task("b", { version: 2 }), task("b", { version: 3 }), task("c")],
    () => true,
  );
  assert.deepEqual(next.taskIds, ["a", "b", "c"]);
  assert.equal(next.tasks.filter((item) => item.id === "b").length, 1);
  assert.equal(next.tasks.find((item) => item.id === "b")?.version, 3);
});

test("generation tokens reject late same-key first-page and pagination responses", () => {
  const firstPage = taskQueryRequestToken("view-key", 10);
  const page = taskQueryRequestToken("view-key", 10);
  assert.equal(taskQueryResponseIsCurrent(firstPage, "view-key", 10), true);
  assert.equal(taskQueryResponseIsCurrent(page, "view-key", 11), false);
  assert.equal(taskQueryResponseIsCurrent(firstPage, "other-key", 10), false);
  assert.equal(taskQueryResponseIsCurrent(taskQueryRequestToken("view-key", 11), "view-key", 11), true);
});

test("authoritative refresh preserves the loaded window and remains bounded", () => {
  assert.equal(authoritativeTaskQueryRefreshLimit(0), 500);
  assert.equal(authoritativeTaskQueryRefreshLimit(499), 500);
  assert.equal(authoritativeTaskQueryRefreshLimit(731), 731);
  assert.equal(authoritativeTaskQueryRefreshLimit(4_000), 2_000);
  assert.equal(authoritativeTaskQueryRefreshLimit(Number.NaN), 500);
});

test("refresh coordinator performs one refresh for a single relevant mutation", () => {
  const harness = schedulerHarness();
  const coordinator = createTaskQueryRefreshCoordinator(harness.schedule, harness.cancel, harness.refresh);
  const active = new Set<TaskQueryDependency>(["release"]);
  assert.equal(coordinator.request(active, ["release"]), true);
  assert.equal(coordinator.pending, true);
  harness.flush();
  assert.equal(harness.refreshCount(), 1);
  assert.equal(coordinator.pending, false);
});

test("refresh coordinator coalesces a relevant burst and one bulk result", () => {
  const harness = schedulerHarness();
  const coordinator = createTaskQueryRefreshCoordinator(harness.schedule, harness.cancel, harness.refresh);
  const active = new Set<TaskQueryDependency>(["release", "status"]);
  assert.equal(coordinator.request(active, ["release"]), true);
  assert.equal(coordinator.request(active, ["status"]), false);
  assert.equal(coordinator.request(active, ["release", "status"]), false, "bulk result joins pending refresh");
  harness.flush();
  assert.equal(harness.refreshCount(), 1);

  assert.equal(coordinator.request(active, ["release", "status"]), true, "one bulk result schedules once");
  harness.flush();
  assert.equal(harness.refreshCount(), 2);
});

test("refresh coordinator schedules nothing for irrelevant mutations and supports cancellation", () => {
  const harness = schedulerHarness();
  const coordinator = createTaskQueryRefreshCoordinator(harness.schedule, harness.cancel, harness.refresh);
  const active = new Set<TaskQueryDependency>(["release"]);
  assert.equal(coordinator.request(active, ["title", "relation"]), false);
  assert.equal(harness.queued(), 0);
  assert.equal(coordinator.request(active, ["release"]), true);
  coordinator.cancel();
  harness.flush();
  assert.equal(harness.refreshCount(), 0);
});

function schedulerHarness() {
  let nextHandle = 0;
  let refreshes = 0;
  const callbacks = new Map<number, () => void>();
  return {
    schedule(callback: () => void) {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle: number) {
      callbacks.delete(handle);
    },
    refresh() {
      refreshes += 1;
    },
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    queued: () => callbacks.size,
    refreshCount: () => refreshes,
  };
}
