import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureRuntimeEnvironment } from "../lib/runtime-environment";
import {
  createProject,
  createRelease,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getWorkspaceCatalogPage,
} from "../lib/repository";
import { defaultViewDisplay, emptyViewQuery } from "../lib/view-contract";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;
let directCollectionReads = 0;
let batchCalls = 0;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
  configureRuntimeEnvironment({
    DB: instrumentDatabase(harness.database),
  });
});

after(async () => dispose?.());

test("workspace snapshot collection reads use one D1 batch round trip", async () => {
  const user = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "snapshot-performance-user",
    displayName: "Snapshot Performance",
    email: "snapshot-performance@example.test",
  });
  directCollectionReads = 0;
  batchCalls = 0;

  await getSnapshot(user, { taskLimit: 40 });

  assert.equal(directCollectionReads, 0);
  assert.equal(batchCalls, 1);
});

test("workspace bootstrap bounds navigation catalogs and reports accessible totals", async () => {
  const user = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "bounded-navigation-user",
    displayName: "Bounded Navigation",
    email: "bounded-navigation@example.test",
  });
  for (let index = 0; index < 6; index += 1) {
    await createProject(user, {
      name: `Project ${index}`,
      taskCode: `P${String.fromCharCode(65 + index)}`,
    });
    const project = (await getSnapshot(user)).projects[0]!;
    await createRelease(user, { projectId: project.id, name: `Release ${index}` });
    await createSavedView(user, {
      name: `View ${index}`,
      query: emptyViewQuery(),
      display: defaultViewDisplay(),
    });
  }

  const result = await getSnapshot(user, { taskLimit: 40, navigationLimit: 3 });
  assert.equal(result.projects.length, 3);
  assert.equal(result.releases.length, 3);
  assert.equal(result.views.length, 3);
  assert.deepEqual(result.navigationCollections, {
    projects: { total: 6, hasMore: true },
    releases: { total: 6, hasMore: true },
    views: { total: 6, hasMore: true },
  });

  const all = await getSnapshot(user);
  const recentProjectIds = new Set(result.projects.map((project) => project.id));
  const outsideProject = all.projects.find((project) => !recentProjectIds.has(project.id))!;
  const outsideRelease = all.releases.find(
    (release) => release.projectId === outsideProject.id,
  )!;
  await createTask(user, {
    projectId: outsideProject.id,
    releaseId: outsideRelease.id,
    title: "Task requiring bounded catalog context",
  });
  const withTaskContext = await getSnapshot(user, {
    taskLimit: 40,
    navigationLimit: 3,
  });
  assert.ok(withTaskContext.projects.some((project) => project.id === outsideProject.id));
  assert.ok(withTaskContext.releases.some((release) => release.id === outsideRelease.id));
});

test("workspace catalog uses ACL-scoped keyset pages without duplicates", async () => {
  const owner = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "bounded-navigation-user",
    displayName: "Bounded Navigation",
    email: "bounded-navigation@example.test",
  });
  const outsider = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "bounded-navigation-outsider",
    displayName: "Catalog Outsider",
    email: "catalog-outsider@example.test",
  });
  const first = await getWorkspaceCatalogPage(owner, {
    kind: "projects",
    limit: 2,
  });
  const second = await getWorkspaceCatalogPage(owner, {
    kind: "projects",
    limit: 2,
    cursor: first.page.nextCursor,
  });

  assert.equal(first.projects.length, 2);
  assert.equal(second.projects.length, 2);
  assert.equal(
    new Set([...first.projects, ...second.projects].map((project) => project.id)).size,
    4,
  );
  const search = await getWorkspaceCatalogPage(owner, {
    kind: "projects",
    search: "Project 5",
  });
  assert.deepEqual(search.projects.map((project) => project.name), ["Project 5"]);
  const byName = await getWorkspaceCatalogPage(owner, {
    kind: "projects",
    order: "name",
    direction: "asc",
    limit: 3,
  });
  assert.deepEqual(
    byName.projects.map((project) => project.name),
    ["Project 0", "Project 1", "Project 2"],
  );
  const byNameNext = await getWorkspaceCatalogPage(owner, {
    kind: "projects",
    order: "name",
    direction: "asc",
    limit: 3,
    cursor: byName.page.nextCursor,
  });
  assert.deepEqual(
    byNameNext.projects.map((project) => project.name),
    ["Project 3", "Project 4", "Project 5"],
  );
  const hidden = await getWorkspaceCatalogPage(outsider, { kind: "projects" });
  assert.equal(hidden.total, 0);
  assert.deepEqual(hidden.projects, []);
  const releases = await getWorkspaceCatalogPage(owner, {
    kind: "releases",
    limit: 2,
  });
  assert.ok(releases.releases.every((release) =>
    releases.projects.some((project) => project.id === release.projectId)));
});

function instrumentDatabase(database: D1Database): D1Database {
  const rawStatements = new WeakMap<object, D1PreparedStatement>();

  function instrumentStatement(statement: D1PreparedStatement): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => instrumentStatement(target.bind(...values));
        }
        if (property === "all") {
          return <T = unknown>() => {
            directCollectionReads += 1;
            return target.all<T>();
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1PreparedStatement;
    rawStatements.set(proxy, statement);
    return proxy;
  }

  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => instrumentStatement(target.prepare(query));
      }
      if (property === "batch") {
        return <T = unknown>(statements: D1PreparedStatement[]) => {
          batchCalls += 1;
          return target.batch<T>(
            statements.map((statement) => rawStatements.get(statement) ?? statement),
          );
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}
