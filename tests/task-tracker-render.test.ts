import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CodexSetupDialog,
  canStartPullRefresh,
  commentDraftStorageKey,
  fetchTaskSnapshot,
  applyMutationResult,
  mergeDeferredSnapshot,
  mergeSearchTaskSummaries,
  pullRefreshDistance,
  reconcileTaskDetail,
  reconcileTaskDetailAfterReset,
  reconcileTaskDetailFromSync,
  reconcileTaskSearch,
  rebaseTaskDraft,
  PriorityIcon,
  resolveArchiveBulkAction,
  runSingleFlight,
  shouldTriggerPullRefresh,
  taskMutationVersion,
  taskNeedsDetailRefresh,
  taskDraftSyncMode,
  taskDraftValueChanged,
  taskMatchesSearch,
  TASK_MANAGER_CLI_SETUP,
  TASK_MANAGER_MARKETPLACE_URL,
  TaskTracker,
} from "../components/task-tracker";
import type { AppSnapshot } from "../lib/types";

const now = "2026-08-14T09:00:00.000Z";
const snapshot: AppSnapshot = {
  user: {
    id: "user-1",
    displayName: "Test User",
    email: "test@example.com",
    timezone: "UTC",
  },
  isAdmin: false,
  admin: null,
  users: [],
  statuses: [
    {
      id: "todo",
      ownerUserId: "user-1",
      name: "Todo",
      category: "unstarted",
      color: "#888888",
      position: 0,
      isDefault: true,
      systemRole: null,
      archivedAt: null,
      version: 1,
    },
  ],
  projects: [],
  releases: [],
  tasks: [
    {
      id: "task-1",
      publicId: "33333333-3333-4333-8333-333333333333",
      ownerUserId: "user-1",
      creatorUserId: "user-1",
      identifier: "TM-1",
      sequenceNumber: 1,
      title: "Direct task",
      description: "",
      statusId: "todo",
      priority: "none",
      assigneeUserId: null,
      projectId: null,
      releaseId: null,
      estimate: 3,
      dueDate: null,
      parentTaskId: null,
      rank: 1000,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      archivedAt: null,
      commentCount: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
      accessRole: "owner",
      hasExternalSource: false,
    },
  ],
  labels: [],
  taskLabels: [],
  relations: [],
  views: [],
  collaborators: [],
};

test("bulk archive action restores an entirely archived selection", () => {
  assert.deepEqual(
    resolveArchiveBulkAction([{ archivedAt: now }, { archivedAt: now }]),
    { archived: false, label: "Restore" },
  );
});

test("workspace overview is a distinct linked surface", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: snapshot,
      initialNavigation: {
        surface: "workspace",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /<div class="breadcrumb-step" aria-current="page"><h1 class="breadcrumb-current" title="Workspace">Workspace<\/h1>/);
  assert.match(markup, /My work/);
  assert.match(markup, /Recent tasks/);
  assert.match(markup, /href="\/issues\/active"/);
  assert.match(markup, /href="\/issues\/33333333-3333-4333-8333-333333333333"/);
  assert.match(markup, /Projects/);
  assert.match(markup, /Releases/);
  assert.match(markup, /Saved views/);
  assert.match(markup, /Shared with me/);
  assert.doesNotMatch(markup, /Search tasks…/);
});

test("workspace overview counts only accessible top-level shared resources", () => {
  const sharedProject = {
    id: "project-shared",
    publicId: "44444444-4444-4444-8444-444444444444",
    ownerUserId: "user-2",
    creatorUserId: "user-2",
    name: "Shared project",
    summary: "",
    description: "",
    status: "active",
    leadUserId: null,
    startDate: null,
    targetDate: null,
    color: "#7766dd",
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "viewer" as const,
  };
  const sharedView = {
    id: "view-shared",
    publicId: "77777777-7777-4777-8777-777777777777",
    ownerUserId: "user-2",
    name: "Shared view",
    scopeProjectId: null,
    query: {},
    display: {
      layout: "list" as const,
      groupBy: "status" as const,
      orderBy: "manual" as const,
      direction: "asc" as const,
      showEmptyGroups: true,
      visibleFields: [],
    },
    version: 1,
    accessRole: "viewer" as const,
  };
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        projects: [sharedProject],
        tasks: snapshot.tasks.map((task) => ({
          ...task,
          ownerUserId: "user-2",
          accessRole: "viewer" as const,
        })),
        views: [sharedView],
      },
      initialNavigation: { surface: "workspace", layout: "list", taskId: null },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(
    markup,
    /<a class="workspace-metric" href="\/shared"[^>]*>[\s\S]*?<b>3<\/b><small>Shared with me<\/small>/,
  );
  assert.match(markup, /Shared project/);
  assert.match(markup, /Shared view/);
  assert.match(markup, /<b>1<\/b><small>Projects<\/small>/);
  assert.match(markup, /<b>1<\/b><small>Tasks<\/small>/);
  assert.match(markup, /<b>1<\/b><small>Views<\/small>/);
});

test("workspace overview has explicit empty states without admin data", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: { ...snapshot, tasks: [] },
      initialNavigation: {
        surface: "workspace",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /Your workspace is ready/);
  assert.match(markup, /No recent tasks/);
  assert.match(markup, /No projects yet/);
  assert.match(markup, /No releases yet/);
  assert.match(markup, /No saved views yet/);
  assert.doesNotMatch(markup, /Administration/);
});

test("bulk archive action archives an active selection", () => {
  assert.deepEqual(resolveArchiveBulkAction([{ archivedAt: null }]), {
    archived: true,
    label: "Archive",
  });
});

test("a focused task mutation patches one record without replacing the snapshot", () => {
  const updatedTask = { ...snapshot.tasks[0]!, title: "Updated", version: 2 };
  const result = applyMutationResult(snapshot, { task: updatedTask });

  assert.equal(result.tasks[0], updatedTask);
  assert.equal(result.projects, snapshot.projects);
  assert.equal(result.releases, snapshot.releases);
});

test("a bulk mutation patches only returned task records", () => {
  const updatedTask = { ...snapshot.tasks[0]!, priority: "high" as const, version: 2 };
  const result = applyMutationResult(snapshot, { taskUpdates: [updatedTask] });

  assert.equal(result.tasks[0], updatedTask);
  assert.equal(result.projects, snapshot.projects);
  assert.equal(result.releases, snapshot.releases);
});

test("deferred task loading expands the window without discarding newer or loaded tasks", () => {
  const loadedTask = { ...snapshot.tasks[0]!, description: "Loaded body" };
  const localTask = {
    ...snapshot.tasks[0]!,
    id: "task-local",
    publicId: "88888888-8888-4888-8888-888888888888",
    identifier: "TM-2",
    sequenceNumber: 2,
    title: "Created while loading",
    version: 2,
  };
  const current: AppSnapshot = {
    ...snapshot,
    tasks: [loadedTask, localTask],
    taskWindow: { limit: 40, truncated: true },
  };
  const incoming: AppSnapshot = {
    ...snapshot,
    tasks: [{ ...loadedTask, description: null }],
    taskWindow: { limit: 2_000, truncated: false },
  };

  const merged = mergeDeferredSnapshot(current, incoming);

  assert.equal(merged.tasks.find((task) => task.id === loadedTask.id)?.description, "Loaded body");
  assert.equal(merged.tasks[0]?.id, localTask.id);
  assert.deepEqual(merged.taskWindow, { limit: 2_000, truncated: false });
});

test("a newer deferred summary keeps loaded content without masking its optimistic version", () => {
  const loadedTask = {
    ...snapshot.tasks[0]!,
    description: "Unsaved draft base",
    version: 3,
    updatedAt: "2026-08-14T09:01:00.000Z",
  };
  const incomingTask = {
    ...loadedTask,
    title: "Changed in another session",
    description: null,
    version: 4,
    updatedAt: "2026-08-14T09:02:00.000Z",
  };

  const merged = mergeDeferredSnapshot(
    { ...snapshot, tasks: [loadedTask] },
    { ...snapshot, tasks: [incomingTask] },
  );
  const task = merged.tasks[0]!;

  assert.equal(task.title, "Changed in another session");
  assert.equal(task.version, 4);
  assert.equal(task.description, "Unsaved draft base");
  assert.equal(task.detailVersion, 3);
  assert.equal(taskMutationVersion(task), 3);
});

test("a clean task detail does not surface a manual conflict for a newer summary", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        tasks: [
          {
            ...snapshot.tasks[0]!,
            description: "Loaded body",
            version: 4,
            detailVersion: 3,
          },
        ],
      },
      initialNavigation: {
        surface: "all",
        layout: "list",
        taskId: snapshot.tasks[0]!.id,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.doesNotMatch(markup, /This task changed elsewhere/);
  assert.doesNotMatch(markup, /Load latest and keep draft/);
  assert.doesNotMatch(markup, /window\.location\.reload/);
  assert.match(markup, /<select disabled=""/);
  assert.match(markup, /archive-action" disabled=""/);
  assert.doesNotMatch(markup, /Loading task details/);
});

test("task draft sync mode auto-applies clean updates and preserves dirty drafts", () => {
  const clean = { title: false, description: false, estimate: false };
  const dirty = { ...clean, description: true };

  assert.equal(taskDraftSyncMode(false, clean), "none");
  assert.equal(taskDraftSyncMode(true, clean), "auto");
  assert.equal(taskDraftSyncMode(true, dirty), "manual");
});

test("task detail dirty state follows an actual value difference", () => {
  assert.equal(taskDraftValueChanged("unchanged", "unchanged"), false);
  assert.equal(taskDraftValueChanged("draft", "saved"), true);
  assert.equal(taskDraftValueChanged("saved", "saved"), false);
});

test("rebasing a concurrent task keeps dirty draft fields and refreshes untouched fields", () => {
  const rebased = rebaseTaskDraft(
    {
      title: "Old title",
      description: "Unsaved local description",
      estimate: "3",
    },
    {
      title: false,
      description: true,
      estimate: false,
    },
    {
      ...snapshot.tasks[0]!,
      title: "Latest server title",
      description: "Latest server description",
      estimate: 8,
      version: 4,
    },
  );

  assert.deepEqual(rebased, {
    title: "Latest server title",
    description: "Unsaved local description",
    estimate: "8",
  });
});

test("a newer loaded detail supersedes an older deferred summary", () => {
  const loadedTask = {
    ...snapshot.tasks[0]!,
    description: "Newest body",
    version: 5,
  };
  const incomingTask = {
    ...loadedTask,
    description: null,
    version: 4,
  };

  const merged = mergeDeferredSnapshot(
    { ...snapshot, tasks: [loadedTask] },
    { ...snapshot, tasks: [incomingTask] },
  );

  assert.equal(merged.tasks[0], loadedTask);
  assert.equal(taskMutationVersion(merged.tasks[0]!), 5);
});

test("a full deferred snapshot drops revoked tasks but retains tasks created after the request began", () => {
  const revokedTask = {
    ...snapshot.tasks[0]!,
    updatedAt: "2026-08-14T09:00:00.000Z",
  };
  const localTask = {
    ...snapshot.tasks[0]!,
    id: "task-local",
    publicId: "88888888-8888-4888-8888-888888888888",
    identifier: "TM-2",
    sequenceNumber: 2,
    updatedAt: "2026-08-14T09:02:00.000Z",
  };

  const merged = mergeDeferredSnapshot(
    {
      ...snapshot,
      tasks: [revokedTask, localTask],
      labels: [{ id: "label-revoked", ownerUserId: "user-1", name: "Old", color: "#777777" }],
      taskLabels: [{ taskId: revokedTask.id, labelId: "label-revoked" }],
      relations: [{ sourceTaskId: revokedTask.id, targetTaskId: localTask.id, type: "related" }],
    },
    { ...snapshot, tasks: [] },
    { taskIdsAtRequest: new Set([revokedTask.id]) },
  );

  assert.deepEqual(merged.tasks.map((task) => task.id), [localTask.id]);
  assert.deepEqual(merged.taskLabels, []);
  assert.deepEqual(merged.relations, []);
  assert.deepEqual(merged.labels, []);
});

test("a full deferred snapshot also drops removed projects, releases, and views from the request set", () => {
  const project = {
    id: "project-1",
    publicId: "44444444-4444-4444-8444-444444444444",
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "Stale project",
    summary: "",
    description: "",
    status: "planned" as const,
    leadUserId: null,
    startDate: null,
    targetDate: null,
    icon: "cube",
    color: "#777777",
    archivedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "owner" as const,
  };
  const release = {
    id: "release-1",
    publicId: "66666666-6666-4666-8666-666666666666",
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    projectId: project.id,
    name: "Stale release",
    description: "",
    status: "planned" as const,
    startDate: null,
    targetDate: null,
    releasedAt: null,
    releaseNotes: "",
    archivedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "owner" as const,
  };
  const view = {
    id: "view-1",
    publicId: "77777777-7777-4777-8777-777777777777",
    ownerUserId: "user-1",
    name: "Stale view",
    scopeProjectId: project.id,
    query: {},
    display: {
      layout: "list" as const,
      groupBy: "status" as const,
      orderBy: "manual" as const,
      direction: "asc" as const,
      showEmptyGroups: true,
      visibleFields: [],
    },
    version: 1,
    accessRole: "owner" as const,
  };

  const merged = mergeDeferredSnapshot(
    { ...snapshot, projects: [project], releases: [release], views: [view] },
    { ...snapshot, tasks: [] },
    {
      projectIdsAtRequest: new Set([project.id]),
      releaseIdsAtRequest: new Set([release.id]),
      viewIdsAtRequest: new Set([view.id]),
    },
  );

  assert.deepEqual(merged.projects, []);
  assert.deepEqual(merged.releases, []);
  assert.deepEqual(merged.views, []);
});

test("task detail reconciliation replaces synced labels and relations without keeping stale context", () => {
  const focusedTask = { ...snapshot.tasks[0]!, description: "Loaded body" };
  const staleRelated = {
    ...snapshot.tasks[0]!,
    id: "task-stale",
    publicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    identifier: "TM-3",
    sequenceNumber: 3,
    title: "Stale related",
  };
  const childTask = {
    ...snapshot.tasks[0]!,
    id: "task-child",
    publicId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    identifier: "TM-4",
    sequenceNumber: 4,
    title: "Fresh child",
    parentTaskId: focusedTask.id,
  };
  const nextTask = {
    ...focusedTask,
    updatedAt: "2026-08-14T09:05:00.000Z",
  };
  const reconciled = reconcileTaskDetail(
    {
      task: focusedTask,
      relatedTasks: [staleRelated],
      labels: [{ id: "label-stale", ownerUserId: "user-1", name: "Stale", color: "#111111" }],
      taskLabels: [{ taskId: focusedTask.id, labelId: "label-stale" }],
      relations: [{ sourceTaskId: focusedTask.id, targetTaskId: staleRelated.id, type: "related" }],
    },
    nextTask,
    {
      tasks: [nextTask, childTask],
      labels: [{ id: "label-fresh", ownerUserId: "user-1", name: "Fresh", color: "#22aa22" }],
      taskLabels: [{ taskId: focusedTask.id, labelId: "label-fresh" }],
      relations: [],
    },
    new Set([staleRelated.id]),
  );

  assert.deepEqual(reconciled.labels.map((label) => label.id), ["label-fresh"]);
  assert.deepEqual(reconciled.taskLabels, [{ taskId: focusedTask.id, labelId: "label-fresh" }]);
  assert.deepEqual(reconciled.relations, []);
  assert.deepEqual(reconciled.relatedTasks.map((task) => task.id), [childTask.id]);
});

test("task detail reconciliation patches and removes related task summaries", () => {
  const focusedTask = { ...snapshot.tasks[0]!, description: "Loaded body" };
  const childTask = {
    ...snapshot.tasks[0]!,
    id: "task-child",
    publicId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    identifier: "TM-4",
    sequenceNumber: 4,
    title: "Old child title",
    parentTaskId: focusedTask.id,
  };
  const detail = {
    task: focusedTask,
    relatedTasks: [childTask],
    labels: [],
    taskLabels: [],
    relations: [],
  };
  const updated = reconcileTaskDetailFromSync(detail, {
    tasks: { upsert: [{ ...childTask, title: "New child title", version: 2 }], remove: [] },
    projects: { upsert: [], remove: [] },
    releases: { upsert: [], remove: [] },
    views: { upsert: [], remove: [] },
    invalidations: {
      taskDetails: [],
      taskComments: [],
      taskAttachments: [],
      taskExternalSources: [],
    },
    labels: [],
    taskLabels: [],
    relations: [],
  });
  assert.equal(updated?.relatedTasks[0]?.title, "New child title");

  const removed = reconcileTaskDetailFromSync(updated!, {
    tasks: { upsert: [], remove: [childTask.id] },
    projects: { upsert: [], remove: [] },
    releases: { upsert: [], remove: [] },
    views: { upsert: [], remove: [] },
    invalidations: {
      taskDetails: [],
      taskComments: [],
      taskAttachments: [],
      taskExternalSources: [],
    },
    labels: [],
    taskLabels: [],
    relations: [],
  });
  assert.deepEqual(removed?.relatedTasks, []);
});

test("task detail invalidation marks loaded same-version context for lazy refresh", () => {
  const focusedTask = {
    ...snapshot.tasks[0]!,
    description: "Loaded body",
    detailVersion: 1,
  };
  const updated = reconcileTaskDetailFromSync({
    task: focusedTask,
    relatedTasks: [],
    labels: [],
    taskLabels: [],
    relations: [],
  }, {
    tasks: { upsert: [], remove: [] },
    projects: { upsert: [], remove: [] },
    releases: { upsert: [], remove: [] },
    views: { upsert: [], remove: [] },
    invalidations: {
      taskDetails: [focusedTask.id],
      taskComments: [],
      taskAttachments: [],
      taskExternalSources: [],
    },
    labels: [],
    taskLabels: [],
    relations: [],
  });

  assert.equal(updated?.task.detailStale, true);
  assert.equal(taskNeedsDetailRefresh(updated!.task), true);

  const duplicate = reconcileTaskDetailFromSync(updated!, {
    tasks: { upsert: [], remove: [] },
    projects: { upsert: [], remove: [] },
    releases: { upsert: [], remove: [] },
    views: { upsert: [], remove: [] },
    invalidations: {
      taskDetails: [focusedTask.id],
      taskComments: [],
      taskAttachments: [],
      taskExternalSources: [],
    },
    labels: [],
    taskLabels: [],
    relations: [],
  }, "sync-v1:detail");
  const onceWithCursor = reconcileTaskDetailFromSync({
    ...updated!,
    task: { ...updated!.task, detailInvalidationCursor: "sync-v1:detail" },
  }, {
    tasks: { upsert: [], remove: [] },
    projects: { upsert: [], remove: [] },
    releases: { upsert: [], remove: [] },
    views: { upsert: [], remove: [] },
    invalidations: {
      taskDetails: [focusedTask.id],
      taskComments: [],
      taskAttachments: [],
      taskExternalSources: [],
    },
    labels: [],
    taskLabels: [],
    relations: [],
  }, "sync-v1:detail");
  assert.equal(duplicate?.task.detailInvalidationCursor, "sync-v1:detail");
  assert.deepEqual(onceWithCursor, {
    ...updated!,
    task: { ...updated!.task, detailInvalidationCursor: "sync-v1:detail" },
  });
});

test("reset reconciliation preserves detail-only context until authoritative reload", () => {
  const focusedTask = { ...snapshot.tasks[0]!, description: "Loaded body" };
  const relatedTask = {
    ...snapshot.tasks[0]!,
    id: "task-related-outside-window",
    publicId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    identifier: "TM-40",
    sequenceNumber: 40,
    title: "Outside bootstrap window",
  };
  const detail = {
    task: focusedTask,
    relatedTasks: [relatedTask],
    labels: [],
    taskLabels: [],
    relations: [],
  };

  const reconciled = reconcileTaskDetailAfterReset(detail, {
    ...snapshot,
    tasks: [{ ...focusedTask, title: "Fresh focused summary", description: null }],
  });

  assert.equal(reconciled.task.title, "Fresh focused summary");
  assert.equal(reconciled.task.description, "Loaded body");
  assert.deepEqual(reconciled.relatedTasks, [relatedTask]);
});

test("background sync preserves active search while patching known results", () => {
  const task = snapshot.tasks[0]!;
  const current = {
    query: "direct",
    taskIds: [task.id],
    tasks: [task],
    status: "ready" as const,
  };
  const patched = reconcileTaskSearch(current, {
    tasks: { upsert: [{ ...task, title: "Updated direct", version: 2 }], remove: [] },
  });
  assert.equal(patched?.query, "direct");
  assert.equal(patched?.tasks[0]?.title, "Updated direct");

  const removed = reconcileTaskSearch(patched, {
    tasks: { upsert: [], remove: [task.id] },
  });
  assert.equal(removed?.query, "direct");
  assert.deepEqual(removed?.taskIds, []);
  assert.deepEqual(removed?.tasks, []);
});

test("search summaries add matches outside the snapshot without discarding loaded details", () => {
  const loadedTask = { ...snapshot.tasks[0]!, description: "Loaded body" };
  const remoteMatch = {
    ...snapshot.tasks[0]!,
    id: "task-remote",
    publicId: "99999999-9999-4999-8999-999999999999",
    identifier: "TM-99",
    sequenceNumber: 99,
    title: "Remote compact match",
    description: null,
  };

  const tasks = mergeSearchTaskSummaries(
    [loadedTask],
    [{ ...loadedTask, description: null }, remoteMatch],
  );

  assert.equal(tasks.find((task) => task.id === loadedTask.id)?.description, "Loaded body");
  assert.equal(tasks.find((task) => task.id === remoteMatch.id)?.title, remoteMatch.title);
  assert.equal(tasks.find((task) => task.id === remoteMatch.id)?.description, null);
});

test("completed server search IDs are authoritative over stale local text matches", () => {
  const task = { ...snapshot.tasks[0]!, title: "Local needle" };

  assert.equal(taskMatchesSearch(task, "needle", null), true);
  assert.equal(taskMatchesSearch(task, "needle", new Set()), false);
  assert.equal(taskMatchesSearch(task, "needle", new Set([task.id])), true);
});

test("a bounded initial task window renders background-loading progress", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        taskWindow: { limit: 40, truncated: true },
      },
      initialNavigation: {
        surface: "all",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /aria-label="Loading remaining tasks"/);
  assert.doesNotMatch(markup, /Showing the 40 most recently updated tasks/);
});

test("pull-to-refresh starts only for a coarse mobile touch at the list top", () => {
  const eligible = {
    mobile: true,
    coarsePointer: true,
    scrollTop: 0,
    refreshing: false,
    touchCount: 1,
  };
  assert.equal(canStartPullRefresh(eligible), true);
  assert.equal(canStartPullRefresh({ ...eligible, mobile: false }), false);
  assert.equal(canStartPullRefresh({ ...eligible, coarsePointer: false }), false);
  assert.equal(canStartPullRefresh({ ...eligible, scrollTop: 1 }), false);
  assert.equal(canStartPullRefresh({ ...eligible, refreshing: true }), false);
  assert.equal(canStartPullRefresh({ ...eligible, touchCount: 2 }), false);
  assert.equal(pullRefreshDistance(-20), 0);
  assert.ok(pullRefreshDistance(80) > 0);
  assert.equal(shouldTriggerPullRefresh(20), false);
  assert.equal(shouldTriggerPullRefresh(72), true);
});

test("pull-to-refresh performs one request, reports errors, and allows retry", async () => {
  const holder: { current: Promise<AppSnapshot> | null } = { current: null };
  let calls = 0;
  const operation = () => {
    calls += 1;
    return fetchTaskSnapshot(async () => new Response(JSON.stringify(snapshot)));
  };

  const first = runSingleFlight(holder, operation);
  const duplicate = runSingleFlight(holder, operation);
  assert.equal(first, duplicate);
  assert.equal((await first).user.id, snapshot.user.id);
  assert.equal(calls, 1);

  await assert.rejects(
    fetchTaskSnapshot(async () => new Response(
      JSON.stringify({ error: "Refresh failed" }),
      { status: 503 },
    )),
    /Refresh failed/,
  );
  assert.equal(holder.current, null);
  await runSingleFlight(holder, operation);
  assert.equal(calls, 2);
});

test("an unassigned task row does not invent a current-user assignee", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: snapshot,
      initialNavigation: {
        surface: "all",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.doesNotMatch(markup, /title="Assignee"/);
});

test("priority icons distinguish medium and high by active bar count", () => {
  const medium = renderToStaticMarkup(createElement(PriorityIcon, { priority: "medium" }));
  const high = renderToStaticMarkup(createElement(PriorityIcon, { priority: "high" }));
  const urgent = renderToStaticMarkup(createElement(PriorityIcon, { priority: "urgent" }));

  assert.match(medium, /data-active-bars="2"/);
  assert.match(high, /data-active-bars="3"/);
  assert.equal((medium.match(/priority-bar active/g) ?? []).length, 2);
  assert.equal((high.match(/priority-bar active/g) ?? []).length, 3);
  assert.match(urgent, /aria-label="Urgent priority"/);
  assert.match(urgent, /priority-symbol/);
});

test("a saved priority grouping is rendered consistently in list and board", () => {
  const groupedSnapshot: AppSnapshot = {
    ...snapshot,
    views: [
      {
        id: "view-priority",
        publicId: "55555555-5555-4555-8555-555555555555",
        ownerUserId: "user-1",
        name: "By priority",
        scopeProjectId: null,
        query: {},
        display: {
          layout: "list",
          groupBy: "priority",
          orderBy: "manual",
          direction: "asc",
          showEmptyGroups: true,
          visibleFields: ["priority"],
        },
        version: 1,
        accessRole: "owner",
      },
    ],
  };

  for (const layout of ["list", "board"] as const) {
    const markup = renderToStaticMarkup(
      createElement(TaskTracker, {
        initialData: groupedSnapshot,
        initialNavigation: {
          surface: "view:view-priority",
          layout,
          taskId: null,
        },
        signOutPath: "/sign-out",
      }),
    );

    assert.match(markup, layout === "list"
      ? /class="group-header"[\s\S]*?Urgent/
      : /class="column-header"[\s\S]*?Urgent/);
    assert.match(markup, /data-priority="medium" data-active-bars="2"/);
    assert.match(markup, /data-priority="high" data-active-bars="3"/);
    assert.match(markup, /No priority/);
  }
});

test("a saved assignee grouping is rendered consistently in list and board", () => {
  const groupedSnapshot: AppSnapshot = {
    ...snapshot,
    users: [
      {
        id: "user-2",
        displayName: "Alex Editor",
        email: "alex@example.test",
        timezone: "UTC",
      },
    ],
    tasks: [
      { ...snapshot.tasks[0]!, assigneeUserId: "user-2" },
      {
        ...snapshot.tasks[0]!,
        id: "task-2",
        publicId: "66666666-6666-4666-8666-666666666666",
        identifier: "TM-2",
        sequenceNumber: 2,
        title: "Unassigned task",
      },
    ],
    views: [
      {
        id: "view-assignee",
        publicId: "77777777-7777-4777-8777-777777777777",
        ownerUserId: "user-1",
        name: "By assignee",
        scopeProjectId: null,
        query: {},
        display: {
          layout: "list",
          groupBy: "assignee",
          orderBy: "manual",
          direction: "asc",
          showEmptyGroups: true,
          visibleFields: ["assignee"],
        },
        version: 1,
        accessRole: "owner",
      },
    ],
  };

  for (const layout of ["list", "board"] as const) {
    const markup = renderToStaticMarkup(
      createElement(TaskTracker, {
        initialData: groupedSnapshot,
        initialNavigation: {
          surface: "view:view-assignee",
          layout,
          taskId: null,
        },
        signOutPath: "/sign-out",
      }),
    );

    assert.match(markup, layout === "list"
      ? /class="group-header"[\s\S]*?Alex Editor/
      : /class="column-header"[\s\S]*?Alex Editor/);
    assert.match(markup, /No assignee/);
  }
});

test("editable status-grouped list rows expose the same drag affordance as board cards", () => {
  const listMarkup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: snapshot,
      initialNavigation: { surface: "all", layout: "list", taskId: null },
      signOutPath: "/sign-out",
    }),
  );
  const boardMarkup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: snapshot,
      initialNavigation: { surface: "all", layout: "board", taskId: null },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(listMarkup, /class="task-row[^>]*draggable="true"/);
  assert.match(listMarkup, /data-drop-target="status"/);
  assert.match(boardMarkup, /class="task-card editable[^>]*draggable="true"/);
});

test("a direct task render has no controlled field warnings", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    renderToStaticMarkup(
      createElement(TaskTracker, {
        initialData: snapshot,
        initialNavigation: {
          surface: "all",
          layout: "list",
          taskId: "task-1",
        },
        signOutPath: "/sign-out",
      }),
    );
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(
    errors.filter((message) => message.includes("without an `onChange` handler")),
    [],
  );
});

test("a summary task opens a lightweight loading panel before its body arrives", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        tasks: snapshot.tasks.map((task) => ({ ...task, description: null })),
      },
      initialNavigation: {
        surface: "all",
        layout: "list",
        taskId: "task-1",
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /Loading task details/);
  assert.doesNotMatch(markup, /class="details-description"/);
});

test("editable task details render the full Markdown description before editing", () => {
  const description = [
    "# Full description",
    "",
    "- [x] Completed item",
    "- Regular item",
    "",
    "[Open source](https://example.com/source)",
    "",
    "![Architecture](attachment:v1:88ff4153-cb23-4043-aab8-6fbc97800762 \"Request flow\")",
    "",
    "```ts",
    "const longValue = true;",
    "```",
  ].join("\n");
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        tasks: snapshot.tasks.map((task) => ({ ...task, description })),
      },
      initialNavigation: {
        surface: "all",
        layout: "list",
        taskId: "task-1",
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /class="task-description-markdown"/);
  assert.match(markup, /<h2>Full description<\/h2>/);
  assert.match(markup, /type="checkbox"[^>]*checked=""/);
  assert.match(markup, /href="https:\/\/example\.com\/source"/);
  assert.match(markup, /Loading image…/);
  assert.doesNotMatch(markup, /attachment:v1:/);
  assert.match(markup, /<pre><code>const longValue = true;<\/code><\/pre>/);
  assert.match(markup, />Edit description</);
  assert.match(markup, />Attachments</);
  assert.match(markup, />Add files</);
  assert.doesNotMatch(markup, /class="details-description"/);
  assert.doesNotMatch(markup, />Save description</);
});

test("viewer task details are read-only and expose no mutation controls", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        user: {
          id: "user-viewer",
          displayName: "View Only",
          email: "viewer@example.com",
          timezone: "UTC",
        },
        tasks: snapshot.tasks.map((task) => ({
          ...task,
          accessRole: "viewer" as const,
        })),
      },
      initialNavigation: {
        surface: "shared",
        layout: "list",
        taskId: "task-1",
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /class="role-badge">Viewer/);
  assert.match(markup, /Direct task/);
  assert.doesNotMatch(markup, /Archive task/);
  assert.doesNotMatch(markup, /Save description/);
  assert.doesNotMatch(markup, /Members &amp; access/);
  assert.match(markup, />Activity</);
  assert.match(markup, />Attachments</);
  assert.doesNotMatch(markup, />Add files</);
  assert.doesNotMatch(markup, /Leave a comment/);
});

test("comment drafts are isolated by authenticated user and task", () => {
  assert.equal(
    commentDraftStorageKey("user-a", "task-a"),
    "tm:comment-draft:user-a:task-a:root",
  );
  assert.notEqual(
    commentDraftStorageKey("user-a", "task-a"),
    commentDraftStorageKey("user-b", "task-a"),
  );
  assert.notEqual(
    commentDraftStorageKey("user-a", "task-a"),
    commentDraftStorageKey("user-a", "task-b"),
  );
  assert.notEqual(
    commentDraftStorageKey("user-a", "task-a"),
    commentDraftStorageKey("user-a", "task-a", "root-comment-a"),
  );
});

test("imported task details defer the heavy source archive until the panel opens", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        tasks: snapshot.tasks.map((task) => ({
          ...task,
          hasExternalSource: true,
        })),
      },
      initialNavigation: {
        surface: "all",
        layout: "list",
        taskId: "task-1",
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /Loading imported context/);
});

test("an administrator sees registration and activity statistics", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        isAdmin: true,
        admin: {
          registeredUserCount: 1,
          activeUserCount: 1,
          taskCount: 1,
          projectCount: 0,
          releaseCount: 0,
          viewCount: 2,
          attachmentCount: 3,
          attachmentBytes: 4096,
          attachmentObjectCount: 4,
          attachmentObjectBytes: 5120,
          stagingAttachmentObjectCount: 1,
          orphanAttachmentObjectCount: 1,
          attachmentStorageTruncated: false,
          pendingAttachmentCount: 1,
          failedAttachmentCount: 0,
          deletedAttachmentCount: 1,
          users: [
            {
              id: "user-1",
              displayName: "Test User",
              email: "test@example.com",
              isAdmin: true,
              registeredAt: now,
              lastSeenAt: now,
              lastContentActivityAt: now,
              taskCount: 1,
              recentTaskCount: 1,
              projectCount: 0,
              releaseCount: 0,
              viewCount: 2,
            },
          ],
        },
      },
      initialNavigation: {
        surface: "admin",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /Administration/);
  assert.match(markup, />Export</);
  assert.match(markup, />Import</);
  assert.match(markup, /Registered users/);
  assert.match(markup, /Attachment objects/);
  assert.match(markup, /1 orphan/);
  assert.match(markup, /test@example\.com/);
  assert.match(markup, /1 changed in 7d/);
  const primaryNavigation = markup.match(/<nav class="nav-scroll"[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.doesNotMatch(primaryNavigation, /Administration/);
});

test("the account identity is not the sign-out target", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: snapshot,
      initialNavigation: {
        surface: "all",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /<button[^>]*class="profile-trigger"/);
  assert.match(markup, /<a[^>]*class="profile-logout"[^>]*href="\/sign-out"/);
  assert.equal(markup.match(/href="\/sign-out"/g)?.length, 1);
});

test("Codex Desktop setup uses the marketplace and standard OAuth flow", () => {
  assert.equal(TASK_MANAGER_MARKETPLACE_URL, "https://github.com/xxsrez/marketplace");

  const markup = renderToStaticMarkup(
    createElement(CodexSetupDialog, { onClose: () => undefined }),
  );

  assert.match(markup, /aria-label="Connect Task Manager to Codex"/);
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /Codex Desktop/);
  assert.match(markup, /Add → Add a marketplace/);
  assert.match(markup, new RegExp(TASK_MANAGER_MARKETPLACE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(markup, />Install</);
  assert.match(markup, />Authenticate</);
  assert.match(markup, />Connect</);
  assert.match(markup, /No MCP URL, client ID, secret, or API token is required/);
});

test("Codex CLI setup exposes verified plugin commands and recovery steps", () => {
  assert.match(TASK_MANAGER_CLI_SETUP, /codex plugin marketplace add xxsrez\/marketplace/);
  assert.match(TASK_MANAGER_CLI_SETUP, /codex plugin add task-manager@srez-marketplace/);
  assert.doesNotMatch(TASK_MANAGER_CLI_SETUP, /task-manager-codex-connector/);

  const markup = renderToStaticMarkup(
    createElement(CodexSetupDialog, { onClose: () => undefined, initialMode: "cli" }),
  );

  for (const command of TASK_MANAGER_CLI_SETUP.split("\n")) {
    assert.match(markup, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(markup, /\/plugins/);
  assert.match(markup, /\/new/);
  assert.match(markup, /Show my tasks in Task Manager/);
});

test("workspace controls navigate to the overview without a false dropdown affordance", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: snapshot,
      initialNavigation: {
        surface: "views",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  const workspaceControl = markup.match(/<a class="workspace-switcher"[\s\S]*?<\/a>/)?.[0] ?? "";
  assert.match(workspaceControl, /href="\/workspace"/);
  assert.doesNotMatch(workspaceControl, /chevron-down/);
  assert.match(markup, /<a class="breadcrumb-link" href="\/workspace">Workspace<\/a>/);
});

test("mobile shell exposes complete navigation and view controls", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: snapshot,
      initialNavigation: {
        surface: "all",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(
    markup,
    /<button[^>]*aria-controls="workspace-sidebar"[^>]*aria-expanded="false"/,
  );
  assert.match(markup, /<aside[^>]*id="workspace-sidebar"/);
  assert.doesNotMatch(markup, /aria-label="Close navigation"/);
  assert.match(markup, /href="\/shared"/);
  assert.match(markup, /href="\/views"/);
  assert.match(markup, /href="\/projects"/);
  assert.match(markup, /href="\/releases"/);

  assert.match(
    markup,
    /<button[^>]*aria-controls="mobile-view-controls"[^>]*aria-expanded="false"/,
  );
  assert.match(markup, /id="mobile-view-controls"/);
  assert.match(markup, /aria-label="Search tasks on mobile"/);
  assert.match(markup, /class="segmented mobile-layout-switcher"/);
  assert.match(markup, /aria-label="List view" aria-pressed="true"/);
  assert.match(markup, /aria-label="Kanban view" aria-pressed="false"/);
  assert.match(markup, />Filter</);
  assert.match(markup, />Display</);
  assert.match(markup, />List</);
  assert.match(markup, />Board</);
  assert.match(markup, />New task</);
});

test("sidebar release and view labels expose the full name while truncating visually", () => {
  const project = {
    id: "project-sidebar",
    publicId: "88888888-8888-4888-8888-888888888888",
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "Task Manager",
    summary: "",
    description: "",
    status: "active",
    leadUserId: null,
    startDate: null,
    targetDate: null,
    color: "#7766dd",
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "owner" as const,
  };
  const release = {
    id: "release-sidebar",
    publicId: "99999999-9999-4999-8999-999999999999",
    projectId: project.id,
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "0.1",
    description: "",
    status: "planned" as const,
    targetDate: null,
    releasedAt: null,
    releaseNotes: "",
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "owner" as const,
  };
  const longViewName = "Изменённые задачи — последние 6 часов";
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        projects: [project],
        releases: [release],
        views: [{
          id: "view-long",
          publicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          ownerUserId: "user-1",
          name: longViewName,
          scopeProjectId: null,
          query: {},
          display: {
            layout: "list" as const,
            groupBy: "status" as const,
            orderBy: "manual" as const,
            direction: "asc" as const,
            showEmptyGroups: true,
            visibleFields: [],
          },
          version: 1,
          accessRole: "owner" as const,
        }],
      },
      initialNavigation: { surface: "all", layout: "list", taskId: null },
      signOutPath: "/sign-out",
    }),
  );
  const primaryNavigation = markup.match(/<nav class="nav-scroll"[\s\S]*?<\/nav>/)?.[0] ?? "";

  assert.match(primaryNavigation, /aria-label="Task Manager 0\.1"/);
  assert.match(primaryNavigation, /title="Task Manager 0\.1"/);
  assert.match(primaryNavigation, /<span class="nav-label">Task Manager 0\.1<\/span>/);
  assert.match(primaryNavigation, new RegExp(`aria-label="${longViewName}"`));
  assert.match(primaryNavigation, new RegExp(`<span class="nav-label">${longViewName}</span>`));
  assert.match(primaryNavigation, /href="\/projects\/88888888-8888-4888-8888-888888888888\/releases\/99999999-9999-4999-8999-999999999999"/);
});

test("release pages use the project-qualified release name without losing header actions", () => {
  const project = {
    id: "project-release-header",
    publicId: "12121212-1212-4212-8212-121212121212",
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "Homeostat",
    summary: "",
    description: "",
    status: "active",
    leadUserId: null,
    startDate: null,
    targetDate: null,
    color: "#7766dd",
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "owner" as const,
  };
  const release = {
    id: "release-header",
    publicId: "34343434-3434-4434-8434-343434343434",
    projectId: project.id,
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "0.1",
    description: "",
    status: "planned" as const,
    targetDate: null,
    releasedAt: null,
    releaseNotes: "",
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "owner" as const,
  };
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: { ...snapshot, projects: [project], releases: [release] },
      initialNavigation: {
        surface: `release:${release.id}`,
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(
    markup,
    /<h1 class="breadcrumb-current" title="Homeostat 0\.1">Homeostat 0\.1<\/h1>/,
  );
  assert.match(markup, /title="Copy direct link"/);
  assert.match(markup, /aria-label="Homeostat 0\.1"/);
  assert.match(markup, /title="Homeostat 0\.1"/);
});

test("status grouping hides empty groups in list and board even for saved views", () => {
  const groupedSnapshot: AppSnapshot = {
    ...snapshot,
    statuses: [
      snapshot.statuses[0]!,
      {
        id: "done",
        ownerUserId: "user-1",
        name: "Done",
        category: "completed",
        color: "#22c55e",
        position: 1,
        isDefault: false,
        systemRole: null,
        archivedAt: null,
        version: 1,
      },
    ],
    views: [{
      id: "view-status",
      publicId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ownerUserId: "user-1",
      name: "By status",
      scopeProjectId: null,
      query: {},
      display: {
        layout: "list",
        groupBy: "status",
        orderBy: "manual",
        direction: "asc",
        showEmptyGroups: true,
        visibleFields: [],
      },
      version: 1,
      accessRole: "owner",
    }],
  };

  for (const layout of ["list", "board"] as const) {
    const markup = renderToStaticMarkup(
      createElement(TaskTracker, {
        initialData: groupedSnapshot,
        initialNavigation: { surface: "view:view-status", layout, taskId: null },
        signOutPath: "/sign-out",
      }),
    );
    assert.match(markup, layout === "list"
      ? /class="group-header"[\s\S]*?<span>Todo<\/span>/
      : /class="column-header"[\s\S]*?<span>Todo<\/span>/);
    assert.doesNotMatch(markup, layout === "list"
      ? /class="group-header"[\s\S]*?<span>Done<\/span>/
      : /class="column-header"[\s\S]*?<span>Done<\/span>/);
  }
});

test("an entirely empty task result uses the shared empty state in both layouts", () => {
  for (const layout of ["list", "board"] as const) {
    const markup = renderToStaticMarkup(
      createElement(TaskTracker, {
        initialData: { ...snapshot, tasks: [] },
        initialNavigation: { surface: "all", layout, taskId: null },
        signOutPath: "/sign-out",
      }),
    );
    assert.match(markup, /class="empty-state"/);
    assert.doesNotMatch(markup, /class="group-header"/);
    assert.doesNotMatch(markup, /class="column-header"/);
  }
});

test("release breadcrumbs expose every ancestor and leave the current level static", () => {
  const project = {
    id: "project-1",
    publicId: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "Project Alpha",
    summary: "",
    description: "",
    status: "active",
    leadUserId: null,
    startDate: null,
    targetDate: null,
    color: "#7766dd",
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "owner" as const,
  };
  const release = {
    id: "release-1",
    publicId: "22222222-2222-4222-8222-222222222222",
    projectId: project.id,
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "Release One",
    description: "",
    status: "active" as const,
    targetDate: null,
    releasedAt: null,
    releaseNotes: "",
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "owner" as const,
  };
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        projects: [project],
        releases: [release],
      },
      initialNavigation: {
        surface: `release:${release.id}`,
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /<a class="breadcrumb-link" href="\/projects">Projects<\/a>/);
  assert.match(markup, /<a class="breadcrumb-link" href="\/projects\/11111111-1111-4111-8111-111111111111">Project Alpha<\/a>/);
  assert.match(markup, /<a class="breadcrumb-link" href="\/projects\/11111111-1111-4111-8111-111111111111\/releases">Releases<\/a>/);
  assert.match(markup, /<h1 class="breadcrumb-current" title="Project Alpha Release One">Project Alpha Release One<\/h1>/);
  assert.doesNotMatch(markup, /<a class="breadcrumb-link"[^>]*>Project Alpha Release One<\/a>/);
});
