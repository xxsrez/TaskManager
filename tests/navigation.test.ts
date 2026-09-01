import assert from "node:assert/strict";
import test from "node:test";
import {
  legacyRedirectPath,
  navigationHistoryState,
  navigationPath,
  navigationPathWithTemporaryFilter,
  parseNavigationPath,
  pathFromRouteSegments,
  resolveNavigationHistoryState,
  resolveNavigationTarget,
} from "../lib/navigation";
import { metadataForNavigation } from "../lib/navigation-metadata";
import type { AppSnapshot } from "../lib/types";

const projectPublicId = "11111111-1111-4111-8111-111111111111";
const releasePublicId = "22222222-2222-4222-8222-222222222222";
const taskPublicId = "33333333-3333-4333-8333-333333333333";
const viewPublicId = "44444444-4444-4444-8444-444444444444";
const teamPublicId = "55555555-5555-4555-8555-555555555555";

const snapshot = {
  projects: [{ id: "linear:project:homeostat", publicId: projectPublicId }],
  releases: [
    {
      id: "linear:release:release-01",
      publicId: releasePublicId,
      projectId: "linear:project:homeostat",
    },
  ],
  tasks: [
    {
      id: "linear:task:AND-1",
      publicId: taskPublicId,
      projectId: "linear:project:homeostat",
      releaseId: "linear:release:release-01",
      archivedAt: null,
    },
  ],
  views: [
    {
      id: "linear:view:homeostat",
      publicId: viewPublicId,
      display: { layout: "list" },
    },
  ],
} as AppSnapshot;

test("short REST paths cover issue, view, project, and release collections", () => {
  assert.deepEqual(parseNavigationPath("/workspace"), { kind: "workspace" });
  assert.deepEqual(parseNavigationPath("/admin"), { kind: "admin" });
  assert.deepEqual(parseNavigationPath("/issues"), {
    kind: "issues",
    filter: "mine",
    layout: "list",
  });
  assert.deepEqual(parseNavigationPath("/issues/board"), {
    kind: "issues",
    filter: "mine",
    layout: "board",
  });
  assert.deepEqual(parseNavigationPath("/issues/all"), {
    kind: "issues",
    filter: "all",
    layout: "list",
  });
  assert.deepEqual(parseNavigationPath("/views"), { kind: "views" });
  assert.deepEqual(parseNavigationPath("/projects"), { kind: "projects" });
  assert.deepEqual(parseNavigationPath("/releases"), { kind: "releases" });
  assert.deepEqual(parseNavigationPath("/teams"), { kind: "teams" });
  assert.deepEqual(parseNavigationPath(`/teams/${teamPublicId}`), {
    kind: "team",
    id: teamPublicId,
  });
  assert.deepEqual(parseNavigationPath("/settings"), {
    kind: "settings",
    section: "profile",
    canonical: false,
  });
  assert.deepEqual(parseNavigationPath("/settings/appearance"), {
    kind: "settings",
    section: "appearance",
    canonical: true,
  });
  assert.deepEqual(
    parseNavigationPath(`/projects/${projectPublicId}/releases`),
    { kind: "projectReleases", projectId: projectPublicId },
  );
});

test("Team collection and opaque detail refs round-trip without snapshot projection", () => {
  const collection = parseNavigationPath("/teams");
  const detail = parseNavigationPath(`/teams/${teamPublicId}`);
  assert.ok(collection);
  assert.ok(detail);
  assert.deepEqual(resolveNavigationTarget(collection, snapshot), {
    surface: "teams",
    layout: "list",
    taskId: null,
  });
  assert.deepEqual(resolveNavigationTarget(detail, snapshot), {
    surface: `team:${teamPublicId}`,
    layout: "list",
    taskId: null,
  });
  assert.equal(navigationPath({
    surface: `team:${teamPublicId}`,
    layout: "list",
    taskId: null,
  }, snapshot), `/teams/${teamPublicId}`);
  assert.equal(parseNavigationPath(`/teams/${teamPublicId}/members`), null);
  assert.equal(legacyRedirectPath(detail, snapshot), null);

  const collectionMetadata = metadataForNavigation(
    resolveNavigationTarget(collection, snapshot)!,
    snapshot,
  );
  const detailMetadata = metadataForNavigation(
    resolveNavigationTarget(detail, snapshot)!,
    snapshot,
  );
  assert.equal(collectionMetadata.title, "Teams – Task Manager");
  assert.equal(detailMetadata.title, "Team – Task Manager");
});

test("settings sections keep canonical direct URLs and reject unknown sections", () => {
  for (const section of [
    "profile",
    "appearance",
    "workflow-statuses",
    "labels",
    "integrations",
    "project-backup",
    "recently-deleted",
  ] as const) {
    const target = parseNavigationPath(`/settings/${section}`);
    assert.ok(target);
    const resolved = resolveNavigationTarget(target, snapshot);
    assert.deepEqual(resolved, {
      surface: `settings:${section}`,
      layout: "list",
      taskId: null,
    });
    assert.equal(navigationPath(resolved, snapshot), `/settings/${section}`);
  }
  assert.equal(parseNavigationPath("/settings/security"), null);
  assert.equal(
    legacyRedirectPath(parseNavigationPath("/settings")!, snapshot),
    "/settings/profile",
  );
});

test("workspace has a canonical route and the old root redirects to it", () => {
  const workspace = parseNavigationPath("/workspace");
  const root = parseNavigationPath("/");
  assert.ok(workspace);
  assert.ok(root);
  assert.deepEqual(resolveNavigationTarget(workspace, snapshot), {
    surface: "workspace",
    layout: "list",
    taskId: null,
  });
  assert.equal(
    navigationPath(
      { surface: "workspace", layout: "list", taskId: null },
      snapshot,
    ),
    "/workspace",
  );
  assert.equal(legacyRedirectPath(root, snapshot), "/workspace");
});

test("admin navigation fails closed unless the server snapshot grants access", () => {
  const target = parseNavigationPath("/admin");
  assert.ok(target);
  assert.equal(resolveNavigationTarget(target, snapshot), null);
  assert.deepEqual(
    resolveNavigationTarget(target, {
      ...snapshot,
      isAdmin: true,
      admin: {
        registeredUserCount: 1,
        activeUserCount: 1,
        taskCount: 0,
        projectCount: 0,
        releaseCount: 0,
        viewCount: 0,
        attachmentCount: 0,
        attachmentBytes: 0,
        attachmentObjectCount: 0,
        attachmentObjectBytes: 0,
        stagingAttachmentObjectCount: 0,
        orphanAttachmentObjectCount: 0,
        attachmentStorageTruncated: false,
        pendingAttachmentCount: 0,
        failedAttachmentCount: 0,
        deletedAttachmentCount: 0,
        users: [],
      },
    }),
    { surface: "admin", layout: "list", taskId: null },
  );
});

test("single public UUID paths address saved views and nested releases", () => {
  assert.deepEqual(parseNavigationPath(`/views/${viewPublicId}/board`), {
    kind: "view",
    id: viewPublicId,
    layout: "board",
  });
  assert.deepEqual(parseNavigationPath(`/projects/${projectPublicId}`), {
    kind: "project",
    id: projectPublicId,
    layout: undefined,
  });
  assert.deepEqual(
    parseNavigationPath(
      `/projects/${projectPublicId}/releases/${releasePublicId}/board`,
    ),
    {
      kind: "projectRelease",
      projectId: projectPublicId,
      releaseId: releasePublicId,
      layout: "board",
    },
  );
  assert.deepEqual(parseNavigationPath(`/issues/${taskPublicId}`), {
    kind: "issue",
    id: taskPublicId,
  });
});

test("catch-all route segments are encoded exactly once", () => {
  assert.equal(
    pathFromRouteSegments(["linear:view:user-1:homeostat", "board"]),
    "/linear%3Aview%3Auser-1%3Ahomeostat/board",
  );
  assert.equal(
    pathFromRouteSegments(["linear%3Aview%3Auser-1%3Ahomeostat", "board"]),
    "/linear%3Aview%3Auser-1%3Ahomeostat/board",
  );
});

test("a direct saved-view board path restores its query surface and layout", () => {
  const target = parseNavigationPath(`/views/${viewPublicId}/board`);
  assert.ok(target);
  assert.deepEqual(resolveNavigationTarget(target, snapshot), {
    surface: "view:linear:view:homeostat",
    layout: "board",
    taskId: null,
  });
});

test("an archived Saved View is removed from direct navigation until restored", () => {
  const archived = {
    ...snapshot,
    views: snapshot.views.map((view) => ({
      ...view,
      archivedAt: "2026-08-18T05:00:00.000Z",
    })),
  } as AppSnapshot;
  const target = parseNavigationPath(`/views/${viewPublicId}`);
  assert.ok(target);
  assert.equal(resolveNavigationTarget(target, archived), null);
  assert.equal(
    navigationPath(
      { surface: "view:linear:view:homeostat", layout: "list", taskId: null },
      archived,
    ),
    "/views",
  );
});

test("project release collection and release detail keep project scope", () => {
  const collection = parseNavigationPath(
    `/projects/${projectPublicId}/releases`,
  );
  const detail = parseNavigationPath(
    `/projects/${projectPublicId}/releases/${releasePublicId}`,
  );
  assert.ok(collection);
  assert.ok(detail);
  assert.deepEqual(resolveNavigationTarget(collection, snapshot), {
    surface: "project-releases:linear:project:homeostat",
    layout: "list",
    taskId: null,
  });
  assert.deepEqual(resolveNavigationTarget(detail, snapshot), {
    surface: "release:linear:release:release-01",
    layout: "list",
    taskId: null,
  });
});

test("legacy internal routes resolve but point to canonical public URLs", () => {
  const oldView = parseNavigationPath(
    "/views/linear%3Aview%3Ahomeostat/board",
  );
  const oldTask = parseNavigationPath("/tasks/linear%3Atask%3AAND-1");
  const oldRelease = parseNavigationPath(
    "/releases/linear%3Arelease%3Arelease-01/board",
  );
  assert.ok(oldView);
  assert.ok(oldTask);
  assert.ok(oldRelease);
  assert.equal(
    legacyRedirectPath(oldView, snapshot),
    `/views/${viewPublicId}/board`,
  );
  assert.equal(
    legacyRedirectPath(oldTask, snapshot),
    `/issues/${taskPublicId}`,
  );
  assert.equal(
    legacyRedirectPath(oldRelease, snapshot),
    `/projects/${projectPublicId}/releases/${releasePublicId}/board`,
  );
  assert.equal(
    legacyRedirectPath(
      parseNavigationPath(`/views/${viewPublicId}/board`)!,
      snapshot,
    ),
    null,
  );
});

test("old built-in view links redirect into the issues namespace", () => {
  const target = parseNavigationPath("/views/all");
  assert.ok(target);
  assert.equal(legacyRedirectPath(target, snapshot), "/issues/all");
});

test("My tasks and All tasks keep distinct canonical URLs", () => {
  assert.equal(
    navigationPath({ surface: "mine", layout: "list", taskId: null }, snapshot),
    "/issues",
  );
  assert.equal(
    navigationPath({ surface: "mine", layout: "board", taskId: null }, snapshot),
    "/issues/board",
  );
  assert.equal(
    navigationPath({ surface: "all", layout: "list", taskId: null }, snapshot),
    "/issues/all",
  );
  assert.equal(
    navigationPath({ surface: "all", layout: "board", taskId: null }, snapshot),
    "/issues/all/board",
  );
  assert.equal(
    metadataForNavigation({ surface: "mine", layout: "list", taskId: null }, snapshot).title,
    "My tasks – Task Manager",
  );
  assert.equal(
    metadataForNavigation({ surface: "all", layout: "list", taskId: null }, snapshot).title,
    "All tasks – Task Manager",
  );
});

test("unknown, mismatched, and malformed targets fail closed", () => {
  const unknown = parseNavigationPath(
    "/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/board",
  );
  const mismatchedRelease = parseNavigationPath(
    `/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/releases/${releasePublicId}`,
  );
  assert.ok(unknown);
  assert.ok(mismatchedRelease);
  assert.equal(resolveNavigationTarget(unknown, snapshot), null);
  assert.equal(resolveNavigationTarget(mismatchedRelease, snapshot), null);
  assert.equal(parseNavigationPath(`/views/${viewPublicId}/board/extra`), null);
  assert.equal(parseNavigationPath(`/projects/${projectPublicId}/timeline`), null);
});

test("navigation state formats back to concise public paths", () => {
  assert.equal(
    navigationPath(
      {
        surface: "project:linear:project:homeostat",
        layout: "board",
        taskId: null,
      },
      snapshot,
    ),
    `/projects/${projectPublicId}/board`,
  );
  assert.equal(
    navigationPath(
      {
        surface: "release:linear:release:release-01",
        layout: "list",
        taskId: null,
      },
      snapshot,
    ),
    `/projects/${projectPublicId}/releases/${releasePublicId}`,
  );
  assert.equal(
    navigationPath(
      {
        surface: "view:linear:view:homeostat",
        layout: "list",
        taskId: "linear:task:AND-1",
      },
      snapshot,
    ),
    `/issues/${taskPublicId}`,
  );
});

test("layout and task navigation preserve a shareable temporary filter", () => {
  const encoded = "eyJ2ZXJzaW9uIjoxLCJvcCI6ImFsbCJ9";
  assert.equal(
    navigationPathWithTemporaryFilter(
      `/views/${viewPublicId}/board`,
      `https://task-manager.example/views/${viewPublicId}?filter=${encoded}`,
    ),
    `/views/${viewPublicId}/board?filter=${encoded}`,
  );
  assert.equal(
    navigationPathWithTemporaryFilter(
      `/issues/${taskPublicId}`,
      `https://task-manager.example/views/${viewPublicId}?filter=${encoded}&ignored=1`,
    ),
    `/issues/${taskPublicId}?filter=${encoded}`,
  );
  assert.equal(
    navigationPathWithTemporaryFilter(
      `/views/${viewPublicId}/board`,
      `https://task-manager.example/views/${viewPublicId}`,
    ),
    `/views/${viewPublicId}/board`,
  );
});

test("task history restores board context without adding it to the issue URL", () => {
  const navigation = {
    surface: "view:linear:view:homeostat",
    layout: "board" as const,
    taskId: "linear:task:AND-1",
  };
  const state = navigationHistoryState(navigation);
  assert.equal(
    navigationPath(navigation, snapshot),
    `/issues/${taskPublicId}`,
  );
  assert.deepEqual(
    resolveNavigationHistoryState(
      state,
      `/issues/${taskPublicId}`,
      snapshot,
    ),
    navigation,
  );
  assert.equal(
    resolveNavigationHistoryState(state, "/issues/missing", snapshot),
    null,
  );
});
