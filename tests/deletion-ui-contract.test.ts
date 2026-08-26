import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeletionUndoToast,
  PermanentDeleteDialog,
  RecoverableDeleteDialog,
  deletionImpactLines,
} from "../components/deletion-dialogs";
import {
  DeletionConvergenceAlert,
  deletionExplanation,
  mergeDeletedRows,
  recentlyDeletedActions,
  remainingUntil,
} from "../components/recently-deleted-manager";
import {
  DeletionRequestError,
  convergeDeletionWorkspace,
  deletionActionRequest,
  deletionErrorRequiresRefetch,
  fetchReleaseDeletionPreview,
  performDeletionAction,
  pruneDeletedEntityFromCatalogPages,
  pruneDeletedEntityFromSnapshot,
  workspaceSyncAffectsRecentlyDeleted,
} from "../lib/deletion-client";
import type {
  AppSnapshot,
  DeletionPreview,
  RecentlyDeletedRecord,
  WorkspaceSyncChanges,
} from "../lib/types";

const cutoff = "2026-09-25T12:00:00.000Z";
const ownerRow: RecentlyDeletedRecord = {
  type: "task",
  id: "task-1",
  publicId: "11111111-1111-4111-8111-111111111111",
  displayName: "TM-1 Deletion contract",
  context: "Task Manager",
  deletedAt: "2026-08-26T12:00:00.000Z",
  deletedBy: { displayName: "Owner", isCurrentUser: true },
  purgeAfter: cutoff,
  version: 2,
  accessRole: "owner",
  actions: { canRestore: true, canPurge: true },
  purgeState: "ready",
};

test("delete, deleted restore, and permanent purge stay distinct client commands", () => {
  const removed = deletionActionRequest("saved_view", "view/id", "delete", 4);
  assert.equal(removed.path, "/api/views/view%2Fid");
  assert.equal(removed.init.method, "DELETE");
  assert.deepEqual(JSON.parse(String(removed.init.body)), { version: 4 });

  const restored = deletionActionRequest("saved_view", "view/id", "restore_deleted", 5);
  assert.equal(restored.path, "/api/views/view%2Fid/restore");
  assert.equal(restored.init.method, "POST");

  const purged = deletionActionRequest("project", "project-1", "purge", 6, "DELETE PERMANENTLY");
  assert.equal(purged.path, "/api/projects/project-1/purge");
  assert.deepEqual(JSON.parse(String(purged.init.body)), {
    version: 6,
    confirmation: "DELETE PERMANENTLY",
  });

  const released = deletionActionRequest(
    "release",
    "release-1",
    "delete",
    7,
    undefined,
    { confirmReleasedComposition: true },
  );
  assert.deepEqual(JSON.parse(String(released.init.body)), {
    version: 7,
    confirmReleasedComposition: true,
  });
});

test("Undo sends the version returned by the successful delete", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({
      path: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      entity: {
        type: "task",
        id: "task-1",
        publicId: "11111111-1111-4111-8111-111111111111",
        version: requests.length === 1 ? 9 : 10,
        deletedAt: requests.length === 1 ? "2026-08-26T12:00:00.000Z" : null,
        purgeAfter: requests.length === 1 ? cutoff : null,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const deleted = await performDeletionAction("task", "task-1", "delete", 8, { fetcher });
  assert.ok("entity" in deleted);
  await performDeletionAction("task", "task-1", "restore_deleted", deleted.entity.version, { fetcher });

  assert.deepEqual(requests, [
    { path: "/api/tasks/task-1", body: { version: 8 } },
    { path: "/api/tasks/task-1/restore", body: { version: 9 } },
  ]);
});

test("Viewer gets no mutations while Editor and Owner follow restore and purge roles", () => {
  assert.deepEqual(recentlyDeletedActions(ownerRow, Date.parse("2026-08-27T00:00:00Z")), {
    expired: false,
    restore: true,
    purge: true,
    readOnly: false,
  });
  assert.deepEqual(recentlyDeletedActions({
    ...ownerRow,
    actions: { canRestore: true, canPurge: false },
  }, Date.parse("2026-08-27T00:00:00Z")), {
    expired: false,
    restore: true,
    purge: false,
    readOnly: false,
  });
  assert.deepEqual(recentlyDeletedActions({
    ...ownerRow,
    actions: { canRestore: false, canPurge: false },
  }, Date.parse("2026-08-27T00:00:00Z")), {
    expired: false,
    restore: false,
    purge: false,
    readOnly: true,
  });
  assert.equal(recentlyDeletedActions(ownerRow, Date.parse(cutoff)).restore, false);
});

test("destructive dialogs expose exact confirmation, impact, focus labels, and Undo live region", () => {
  const preview: DeletionPreview = {
    type: "project",
    id: "project-1",
    publicId: "22222222-2222-4222-8222-222222222222",
    displayName: "Task Manager",
    context: null,
    version: 3,
    confirmation: "DELETE PERMANENTLY",
    impact: {
      tasks: 7,
      releases: 2,
      savedViews: 3,
      comments: 11,
      attachments: 4,
      releaseMemberships: 0,
    },
  };
  const permanent = renderToStaticMarkup(createElement(PermanentDeleteDialog, {
    preview,
    onConfirm: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(permanent, /role="dialog"/);
  assert.match(permanent, /aria-modal="true"/);
  assert.match(permanent, /Permanent deletion confirmation/);
  assert.match(permanent, /DELETE PERMANENTLY/);
  assert.match(permanent, /7 Tasks/);
  assert.match(permanent, /11 comments/);
  assert.match(permanent, /4 Attachments/);
  assert.match(permanent, /disabled=""[^>]*>Delete permanently/);
  assert.deepEqual(deletionImpactLines(preview).length, 5);

  const recoverable = renderToStaticMarkup(createElement(RecoverableDeleteDialog, {
    target: ownerRow,
    onConfirm: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(recoverable, /Recently deleted for 30 days/);
  assert.match(recoverable, /Archive remains a separate action/);

  const undo = renderToStaticMarkup(createElement(DeletionUndoToast, {
    label: "TM-1",
    onUndo: () => undefined,
    onDismiss: () => undefined,
  }));
  assert.match(undo, /role="status"/);
  assert.match(undo, /aria-live="polite"/);
  assert.match(undo, />Undo</);
  assert.match(undo, /Dismiss deletion notification/);
});

test("delete cache pruning handles Project shadow and Release membership before refetch", () => {
  const snapshot = {
    projects: [{ id: "project-1" }, { id: "project-2" }],
    releases: [
      { id: "release-1", projectId: "project-1" },
      { id: "release-2", projectId: "project-2" },
    ],
    tasks: [
      { id: "task-1", projectId: "project-1", releaseId: "release-1" },
      { id: "task-2", projectId: "project-2", releaseId: "release-2" },
    ],
    views: [
      { id: "view-1", scopeProjectId: "project-1" },
      { id: "view-2", scopeProjectId: null },
    ],
    taskLabels: [{ taskId: "task-1" }, { taskId: "task-2" }],
    relations: [{ sourceTaskId: "task-1", targetTaskId: "task-2" }],
    navigationCollections: {
      projects: { items: [{ id: "project-1" }, { id: "project-2" }], total: 2, hasMore: false },
      releases: {
        items: [
          { id: "release-1", projectId: "project-1" },
          { id: "release-2", projectId: "project-2" },
        ],
        total: 2,
        hasMore: false,
      },
      views: {
        items: [
          { id: "view-1", scopeProjectId: "project-1" },
          { id: "view-2", scopeProjectId: null },
        ],
        total: 2,
        hasMore: false,
      },
    },
  } as AppSnapshot;
  const projectPruned = pruneDeletedEntityFromSnapshot(snapshot, "project", "project-1");
  assert.deepEqual(projectPruned.projects.map((item) => item.id), ["project-2"]);
  assert.deepEqual(projectPruned.releases.map((item) => item.id), ["release-2"]);
  assert.deepEqual(projectPruned.tasks.map((item) => item.id), ["task-2"]);
  assert.deepEqual(projectPruned.views.map((item) => item.id), ["view-2"]);
  assert.deepEqual(projectPruned.taskLabels.map((item) => item.taskId), ["task-2"]);
  assert.deepEqual(projectPruned.relations, []);
  assert.deepEqual(projectPruned.navigationCollections?.projects.items.map((item) => item.id), ["project-2"]);
  assert.deepEqual(projectPruned.navigationCollections?.releases.items.map((item) => item.id), ["release-2"]);
  assert.deepEqual(projectPruned.navigationCollections?.views.items.map((item) => item.id), ["view-2"]);
  assert.equal(projectPruned.navigationCollections?.projects.total, 1);
  assert.equal(projectPruned.navigationCollections?.releases.total, 1);
  assert.equal(projectPruned.navigationCollections?.views.total, 1);

  const releasePruned = pruneDeletedEntityFromSnapshot(snapshot, "release", "release-1");
  assert.equal(releasePruned.tasks.find((item) => item.id === "task-1")?.releaseId, null);

  const hierarchySnapshot = {
    ...snapshot,
    tasks: [
      { id: "parent", projectId: "project-2", releaseId: null, parentTaskId: null },
      { id: "child", projectId: "project-2", releaseId: null, parentTaskId: "parent" },
    ],
  } as AppSnapshot;
  const parentPruned = pruneDeletedEntityFromSnapshot(hierarchySnapshot, "task", "parent");
  assert.deepEqual(parentPruned.tasks.map((task) => ({ id: task.id, parentTaskId: task.parentTaskId })), [
    { id: "child", parentTaskId: null },
  ]);

  const catalogPages = pruneDeletedEntityFromCatalogPages({
    projects: {
      kind: "projects",
      projects: snapshot.projects,
      releases: [],
      views: [],
      page: { hasMore: false, nextCursor: null },
      total: 2,
    },
    releases: {
      kind: "releases",
      projects: [],
      releases: snapshot.releases,
      views: [],
      page: { hasMore: false, nextCursor: null },
      total: 2,
    },
    views: {
      kind: "views",
      projects: [],
      releases: [],
      views: snapshot.views,
      page: { hasMore: false, nextCursor: null },
      total: 2,
    },
  }, "project", "project-1");
  assert.deepEqual(catalogPages.projects?.projects.map((item) => item.id), ["project-2"]);
  assert.deepEqual(catalogPages.releases?.releases.map((item) => item.id), ["release-2"]);
  assert.deepEqual(catalogPages.views?.views.map((item) => item.id), ["view-2"]);
  assert.equal(catalogPages.projects?.total, 1);
  assert.equal(catalogPages.releases?.total, 1);
  assert.equal(catalogPages.views?.total, 1);
});

test("released Release confirmation renders authoritative impact and blocks until acknowledged", () => {
  const markup = renderToStaticMarkup(createElement(RecoverableDeleteDialog, {
    target: {
      type: "release",
      displayName: "Task Manager 0.2",
      context: "Task Manager",
      description: "Tasks stay available.",
      warning: "This Release is already released.",
      impactLines: ["17 linked Tasks will keep their content and temporarily show no Release."],
      acknowledgement: "Confirm changing the composition of this released Release.",
    },
    onConfirm: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(markup, /17 linked Tasks/);
  assert.match(markup, /already released/);
  assert.match(markup, /Confirm changing the composition/);
  assert.match(markup, /disabled=""[^>]*>Move to Recently deleted/);
});

test("Release delete preview uses the authoritative active Release endpoint", async () => {
  let requestPath = "";
  let requestInit: RequestInit | undefined;
  const preview = await fetchReleaseDeletionPreview(
    "release/id",
    12,
    async (input, init) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        type: "release",
        id: "release/id",
        publicId: "77777777-7777-4777-8777-777777777777",
        displayName: "Task Manager 0.2",
        context: "Task Manager",
        version: 12,
        status: "released",
        taskMemberships: 17,
        requiresReleasedCompositionConfirmation: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  );

  assert.equal(requestPath, "/api/releases/release%2Fid/deletion-preview?version=12");
  assert.deepEqual(requestInit, { cache: "no-store" });
  assert.equal(preview.taskMemberships, 17);
  assert.equal(preview.requiresReleasedCompositionConfirmation, true);
});

test("sync entity changes invalidate trash and paginated rows merge without duplicates", () => {
  const changes = emptyChanges();
  assert.equal(workspaceSyncAffectsRecentlyDeleted({ changes }), false);
  changes.tasks.remove.push("task-1");
  assert.equal(workspaceSyncAffectsRecentlyDeleted({ changes }), true);
  assert.deepEqual(mergeDeletedRows([ownerRow], [ownerRow, {
    ...ownerRow,
    id: "task-2",
    publicId: "33333333-3333-4333-8333-333333333333",
  }]).map((item) => item.id), ["task-1", "task-2"]);
  assert.equal(deletionErrorRequiresRefetch(new DeletionRequestError("stale", 409)), true);
  assert.equal(deletionErrorRequiresRefetch(new DeletionRequestError("role changed", 403)), true);
  assert.equal(deletionErrorRequiresRefetch(new DeletionRequestError("gone", 404)), true);
  assert.equal(deletionErrorRequiresRefetch(new DeletionRequestError("failed", 500)), false);
});

test("a failed post-mutation refresh is visible and retries only convergence", async () => {
  let refreshCalls = 0;
  const failed = await convergeDeletionWorkspace(async () => {
    refreshCalls += 1;
    throw new Error("Bootstrap unavailable");
  });
  assert.deepEqual(failed, {
    ok: false,
    message: "The deletion action completed, but workspace data could not be refreshed. Bootstrap unavailable",
  });
  assert.equal(refreshCalls, 1);

  const markup = renderToStaticMarkup(createElement(DeletionConvergenceAlert, {
    message: failed.ok ? "" : failed.message,
    busy: false,
    onRetry: () => undefined,
  }));
  assert.match(markup, /role="alert"/);
  assert.match(markup, /server mutation already succeeded/);
  assert.match(markup, /Retry workspace refresh/);

  const retried = await convergeDeletionWorkspace(async () => {
    refreshCalls += 1;
  });
  assert.deepEqual(retried, { ok: true });
  assert.equal(refreshCalls, 2);
});

test("stale lifecycle failures close obsolete dialog and Undo controls before refetch", () => {
  const source = readFileSync(
    new URL("../components/task-tracker.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /async function selfHealStaleDeletionState\(\) \{\s*setRecoverableDeletion\(null\);\s*setDeletionUndo\(null\);\s*await convergeDeletionState\(\);\s*\}/,
  );
  assert.match(
    source,
    /if \(deletionErrorRequiresRefetch\(requestError\)\) \{\s*await selfHealStaleDeletionState\(\);\s*\}/,
  );
});

test("human-readable cutoff and entity explanations preserve deletion semantics", () => {
  assert.equal(remainingUntil("2026-08-28T00:00:00Z", Date.parse("2026-08-27T00:00:00Z")), "24h remaining");
  assert.equal(remainingUntil("2026-09-01T00:00:00Z", Date.parse("2026-08-27T00:00:00Z")), "5d remaining");
  assert.match(deletionExplanation("project"), /shadow/);
  assert.match(deletionExplanation("release"), /Tasks are kept/);
  assert.match(deletionExplanation("saved_view"), /temporary filters are unchanged/);
});

function emptyChanges(): WorkspaceSyncChanges {
  return {
    tasks: { upsert: [], remove: [] },
    projects: { upsert: [], remove: [] },
    releases: { upsert: [], remove: [] },
    views: { upsert: [], remove: [] },
    invalidations: {
      taskDetails: [],
      taskComments: [],
      taskActivities: [],
      taskAttachments: [],
    },
    labels: [],
    taskLabels: [],
    relations: [],
  };
}
