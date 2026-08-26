import assert from "node:assert/strict";
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
  deletionExplanation,
  mergeDeletedRows,
  recentlyDeletedActions,
  remainingUntil,
} from "../components/recently-deleted-manager";
import {
  DeletionRequestError,
  deletionActionRequest,
  deletionErrorRequiresRefetch,
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
  } as AppSnapshot;
  const projectPruned = pruneDeletedEntityFromSnapshot(snapshot, "project", "project-1");
  assert.deepEqual(projectPruned.projects.map((item) => item.id), ["project-2"]);
  assert.deepEqual(projectPruned.releases.map((item) => item.id), ["release-2"]);
  assert.deepEqual(projectPruned.tasks.map((item) => item.id), ["task-2"]);
  assert.deepEqual(projectPruned.views.map((item) => item.id), ["view-2"]);
  assert.deepEqual(projectPruned.taskLabels.map((item) => item.taskId), ["task-2"]);
  assert.deepEqual(projectPruned.relations, []);

  const releasePruned = pruneDeletedEntityFromSnapshot(snapshot, "release", "release-1");
  assert.equal(releasePruned.tasks.find((item) => item.id === "task-1")?.releaseId, null);
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
  assert.equal(deletionErrorRequiresRefetch(new DeletionRequestError("gone", 404)), true);
  assert.equal(deletionErrorRequiresRefetch(new DeletionRequestError("failed", 500)), false);
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
