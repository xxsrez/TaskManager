import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { GET as globalSearchRoute } from "../app/api/search/route";
import { configureActorResolverForTests } from "../lib/auth";
import {
  decodeGlobalSearchCursor,
  flattenGlobalSearchResults,
  nextGlobalSearchHighlight,
  resolveSearchShortcut,
  type GlobalSearchResponse,
} from "../lib/global-search";
import {
  createProject,
  createRelease,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  searchWorkspace,
} from "../lib/repository";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
});

after(async () => {
  configureActorResolverForTests(null);
  await dispose?.();
});

test("global search groups every accessible entity and never exposes an inaccessible match", async () => {
  const owner = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "global-search-owner",
    displayName: "Search Owner",
    email: "global-search-owner@example.test",
  });
  const viewer = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "global-search-viewer",
    displayName: "Search Viewer",
    email: "global-search-viewer@example.test",
  });
  const outsider = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "global-search-outsider",
    displayName: "Search Outsider",
    email: "global-search-outsider@example.test",
  });

  await createProject(owner, {
    name: "Orchid Search Project",
    taskCode: "OSP",
    summary: "Orchid workspace context",
  });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Orchid Search Project",
  )!;
  const release = await createRelease(owner, {
    projectId: project.id,
    name: "Orchid Search Release",
  });
  const createdTask = await createTask(owner, {
    projectId: project.id,
    releaseId: release.id,
    title: "Orchid Search Task",
    description: "The description-only token is orchid-description-token",
  });
  const task = (await getSnapshot(owner)).tasks.find((item) => item.id === createdTask.id)!;
  const view = await createSavedView(owner, {
    name: "Orchid Search View",
    scopeProjectId: project.id,
    query: {},
    display: {},
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: viewer.email,
    permission: "viewer",
  });

  const grouped = await searchWorkspace(viewer, { query: "orchid search" });
  assert.deepEqual(grouped.partialErrors, []);
  assert.ok(grouped.groups.tasks.some((item) => item.id === task.id));
  assert.ok(grouped.groups.projects.some((item) => item.id === project.id));
  assert.ok(grouped.groups.releases.some((item) => item.id === release.id));
  assert.ok(grouped.groups.views.some((item) => item.id === view.id));
  assert.match(grouped.groups.tasks[0]!.context, /Orchid Search Project/);
  assert.match(grouped.groups.releases[0]!.context, /Orchid Search Project/);
  assert.match(grouped.groups.views[0]!.context, /Orchid Search Project/);

  const descriptionMatch = await searchWorkspace(viewer, {
    query: "orchid-description-token",
  });
  assert.deepEqual(descriptionMatch.groups.tasks.map((item) => item.id), [task.id]);

  const exactIdentifier = await searchWorkspace(viewer, { query: task.identifier });
  assert.equal(exactIdentifier.groups.tasks[0]?.id, task.id);
  assert.equal(exactIdentifier.groups.tasks[0]?.href, `/issues/${task.publicId}`);

  const hidden = await searchWorkspace(outsider, { query: "orchid" });
  assert.deepEqual(flattenGlobalSearchResults(hidden), []);
});

test("global search uses a bounded opaque cursor instead of loading the workspace", async () => {
  const owner = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "global-search-page-owner",
    displayName: "Page Owner",
    email: "global-search-page-owner@example.test",
  });
  for (let index = 1; index <= 5; index += 1) {
    await createProject(owner, {
      name: `Paginated Search ${index}`,
      taskCode: `P${String.fromCharCode(64 + index)}`,
    });
  }

  const first = await searchWorkspace(owner, { query: "Paginated Search", limit: 2 });
  assert.equal(first.groups.projects.length, 2);
  assert.ok(first.nextCursor);
  assert.equal(decodeGlobalSearchCursor(first.nextCursor!).offset, 2);
  await assert.rejects(
    searchWorkspace(owner, {
      query: "Different query",
      limit: 2,
      cursor: first.nextCursor,
    }),
    /cursor is invalid/,
  );

  const second = await searchWorkspace(owner, {
    query: "Paginated Search",
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.groups.projects.length, 2);
  assert.ok(second.groups.projects.every(
    (item) => !first.groups.projects.some((firstItem) => firstItem.id === item.id),
  ));

  const clamped = await searchWorkspace(owner, { query: "Paginated Search", limit: 500 });
  assert.ok(Object.values(clamped.groups).every((items) => items.length <= 20));
});

test("authenticated global search route exposes the bounded contract", async () => {
  configureActorResolverForTests(async () => ({
    provider: "chatgpt",
    providerAccountKey: "global-search-owner",
    displayName: "Search Owner",
    email: "global-search-owner@example.test",
  }));
  try {
    const response = await globalSearchRoute(new Request(
      "https://task-manager.example/api/search?query=Orchid%20Search&limit=2",
    ));
    assert.equal(response.status, 200);
    const body = await response.json() as GlobalSearchResponse;
    assert.equal(body.query, "orchid search");
    assert.ok(body.groups.tasks.length <= 2);

    const invalid = await globalSearchRoute(new Request(
      "https://task-manager.example/api/search?query=Orchid&cursor=not-a-cursor",
    ));
    assert.equal(invalid.status, 400);
  } finally {
    configureActorResolverForTests(null);
  }
});

test("flattened global-search results keep the UI group order", () => {
  const response: GlobalSearchResponse = {
    query: "same",
    groups: {
      tasks: [{ type: "task", id: "t", publicId: "pt", title: "Task", identifier: "TM-1", context: "Project", href: "/issues/pt" }],
      projects: [{ type: "project", id: "p", publicId: "pp", title: "Project", context: "Active", href: "/projects/pp" }],
      releases: [{ type: "release", id: "r", publicId: "pr", title: "Release", context: "Project", href: "/projects/pp/releases/pr" }],
      views: [{ type: "view", id: "v", publicId: "pv", title: "View", context: "Global view", href: "/views/pv" }],
    },
    nextCursor: null,
    partialErrors: [],
  };
  assert.deepEqual(
    flattenGlobalSearchResults(response).map((item) => item.type),
    ["task", "project", "release", "view"],
  );
});

test("global and local search shortcuts remain distinct and keyboard highlight wraps", () => {
  const slash = { key: "/", metaKey: false, ctrlKey: false, altKey: false };
  const commandF = { key: "f", metaKey: true, ctrlKey: false, altKey: false };
  assert.equal(resolveSearchShortcut(slash, { typing: false, localSearchAvailable: true }), "global");
  assert.equal(resolveSearchShortcut(slash, { typing: true, localSearchAvailable: true }), null);
  assert.equal(resolveSearchShortcut(commandF, { typing: false, localSearchAvailable: true }), "local");
  assert.equal(resolveSearchShortcut(commandF, { typing: false, localSearchAvailable: false }), null);
  assert.equal(nextGlobalSearchHighlight(3, "next", 4), 0);
  assert.equal(nextGlobalSearchHighlight(0, "previous", 4), 3);
  assert.equal(nextGlobalSearchHighlight(0, "next", 0), 0);
});
