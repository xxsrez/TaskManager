import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { configureActorResolverForTests } from "../lib/auth";
import {
  createProject,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTaskDetail,
  getWorkspaceCatalogPage,
  grantAccess,
  queryTaskSummaries,
  revokeAccess,
  searchTaskSummaries,
  transferProjectOwnership,
} from "../lib/repository";
import {
  navigationStateForWorkspaceScope,
  navigationStateWithWorkspaceScope,
  scopedUiApiPath,
  taskDetailUiApiPath,
  taskRelationSearchUiApiPath,
  workspaceScopeFromHistory,
} from "../components/task-tracker";
import { GET as getBootstrapRoute } from "../app/api/bootstrap/route";
import { GET as searchTasksRoute } from "../app/api/tasks/route";
import { GET as getTaskRoute } from "../app/api/tasks/[id]/route";
import {
  ALL_ACCESSIBLE_WORKSPACE_SCOPE,
  opaqueWorkspaceOwnerToken,
  parseWorkspaceScopeToken,
  resolveWorkspaceScopeMembership,
  sharedWithMeRoots,
  workspaceOwnerUserId,
} from "../lib/workspace-scope";
import { defaultViewDisplay, emptyViewQuery } from "../lib/view-contract";
import type {
  AppSnapshot,
  ProjectRecord,
  SavedViewRecord,
  TaskRecord,
  WorkspaceScopeDescriptor,
} from "../lib/types";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;

before(async () => {
  const harness = await createD1TestHarness();
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => dispose?.());
afterEach(() => configureActorResolverForTests(null));

test("workspace focus exposes only My and All accessible and stays out of non-workspace history", async () => {
  const currentToken = await opaqueWorkspaceOwnerToken("usr_current-internal");
  const otherToken = await opaqueWorkspaceOwnerToken("usr_other-internal");
  const descriptors: WorkspaceScopeDescriptor[] = [
    { token: currentToken, kind: "owner", label: "My", current: true },
    { token: ALL_ACCESSIBLE_WORKSPACE_SCOPE, kind: "all", label: "All accessible", current: false },
  ];

  assert.deepEqual(parseWorkspaceScopeToken(currentToken), {
    kind: "owner",
    token: currentToken,
  });
  assert.deepEqual(parseWorkspaceScopeToken(ALL_ACCESSIBLE_WORKSPACE_SCOPE), {
    kind: "all",
    token: ALL_ACCESSIBLE_WORKSPACE_SCOPE,
  });
  assert.equal(parseWorkspaceScopeToken("usr_other-internal"), null);
  assert.equal(parseWorkspaceScopeToken("other@example.test"), null);
  assert.equal(parseWorkspaceScopeToken("owner:../../usr_other-internal"), null);
  assert.equal(currentToken.includes("usr_current"), false);
  const historyState = navigationStateForWorkspaceScope(
    { surface: "projects", layout: "list", taskId: null },
    otherToken,
  );
  assert.equal(workspaceScopeFromHistory(historyState), null);
  const workspaceHistoryState = navigationStateForWorkspaceScope(
    { surface: "workspace", layout: "list", taskId: null },
    currentToken,
  );
  assert.equal(workspaceScopeFromHistory(workspaceHistoryState), currentToken);
  assert.equal(
    workspaceScopeFromHistory(navigationStateWithWorkspaceScope(
      { surface: "workspace", layout: "list", taskId: null },
      currentToken,
    )),
    currentToken,
  );
  assert.equal(workspaceScopeFromHistory({ taskManagerWorkspaceScope: "usr_other-internal" }), null);
  assert.equal(
    scopedUiApiPath("/api/tasks?cursor=next", otherToken),
    `/api/tasks?cursor=next&workspace_scope=${encodeURIComponent(otherToken)}`,
  );
  assert.equal(
    taskDetailUiApiPath("task/a", otherToken),
    `/api/tasks/task%2Fa?workspace_scope=${encodeURIComponent(otherToken)}`,
  );
  assert.equal(
    taskRelationSearchUiApiPath("needle / one", "task/anchor", "blocked_by"),
    "/api/tasks?search=needle+%2F+one&relation_search=true&relation_anchor=task%2Fanchor&relation_kind=blocked_by",
  );

  assert.deepEqual(
    resolveWorkspaceScopeMembership(otherToken, descriptors, currentToken),
    { token: currentToken, fallback: true },
  );
  assert.deepEqual(
    resolveWorkspaceScopeMembership("wso_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", descriptors, currentToken),
    { token: currentToken, fallback: true },
  );
});

test("task detail and relation search use the readable ACL union across UI owner scopes", async () => {
  const currentActor = {
    provider: "chatgpt" as const,
    providerAccountKey: "workspace-detail-current",
    displayName: "Workspace Detail Current",
    email: "workspace-detail-current@example.test",
  };
  const foreignActor = {
    provider: "chatgpt" as const,
    providerAccountKey: "workspace-detail-foreign",
    displayName: "Workspace Detail Foreign",
    email: "workspace-detail-foreign@example.test",
  };
  const current = await getOrCreateUser(currentActor);
  const foreign = await getOrCreateUser(foreignActor);
  await createProject(current, { name: "Scope Detail Current", taskCode: "SDC" });
  await createProject(foreign, { name: "Scope Detail Foreign", taskCode: "SDF" });
  const currentProject = (await getSnapshot(current)).projects.find(
    (project) => project.name === "Scope Detail Current",
  )!;
  const foreignProject = (await getSnapshot(foreign)).projects.find(
    (project) => project.name === "Scope Detail Foreign",
  )!;
  const source = await createTask(current, {
    projectId: currentProject.id,
    title: "Scoped relation needle source",
  });
  const foreignTarget = await createTask(foreign, {
    projectId: foreignProject.id,
    title: "Scoped relation needle foreign",
  });
  const foreignCandidate = await createTask(foreign, {
    projectId: foreignProject.id,
    title: "Scoped relation needle candidate",
  });
  await grantAccess(foreign, {
    resourceType: "project",
    resourceId: foreignProject.id,
    email: current.email,
    permission: "editor",
  });
  const foreignGrant = (await getSnapshot(foreign)).collaborators.find(
    (grant) => grant.resourceType === "project" &&
      grant.resourceId === foreignProject.id &&
      grant.userId === current.id,
  )!;
  await database.prepare(`INSERT INTO task_relations
    (id, source_task_id, target_task_id, type, creator_user_id, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(
      "relation-workspace-detail-cross-owner",
      source.id,
      foreignTarget.id,
      "related",
      current.id,
      "relation-workspace-detail-cross-owner",
    )
    .run();

  const currentToken = await opaqueWorkspaceOwnerToken(current.id);
  const unionDetail = await getTaskDetail(current, source.id);
  assert.deepEqual(unionDetail.relatedTasks.map((task) => task.id), [foreignTarget.id]);
  assert.equal(unionDetail.relations.length, 1);
  const scopedDetail = await getTaskDetail(current, source.id, {
    workspaceScope: currentToken,
  });
  assert.deepEqual(scopedDetail.relatedTasks.map((task) => task.id), [foreignTarget.id]);
  assert.equal(scopedDetail.relations.length, 1);

  const unionSearch = await searchTaskSummaries(current, "Scoped relation needle");
  assert.deepEqual(
    new Set(unionSearch.map((task) => task.id)),
    new Set([source.id, foreignTarget.id, foreignCandidate.id]),
  );
  const scopedSearch = await searchTaskSummaries(current, "Scoped relation needle", {
    workspaceScope: currentToken,
  });
  assert.deepEqual(scopedSearch.map((task) => task.id), [source.id]);

  configureActorResolverForTests(async () => currentActor);
  const detailResponse = await getTaskRoute(
    new Request(
      `https://example.test/api/tasks/${source.id}?workspace_scope=${encodeURIComponent(currentToken)}`,
    ),
    { params: Promise.resolve({ id: source.id }) },
  );
  assert.equal(detailResponse.status, 200);
  const detailPayload = await detailResponse.json() as typeof scopedDetail;
  assert.deepEqual(detailPayload.relatedTasks.map((task) => task.id), [foreignTarget.id]);
  assert.equal(detailPayload.relations.length, 1);

  const searchResponse = await searchTasksRoute(new Request(
    `https://example.test/api/tasks?search=Scoped+relation+needle&workspace_scope=${encodeURIComponent(currentToken)}`,
  ));
  assert.equal(searchResponse.status, 200);
  const searchPayload = await searchResponse.json() as { tasks: TaskRecord[] };
  assert.deepEqual(searchPayload.tasks.map((task) => task.id), [source.id]);

  const relationSearchResponse = await searchTasksRoute(new Request(
    `https://example.test/api/tasks?search=Scoped+relation+needle&relation_search=true&relation_anchor=${source.id}&relation_kind=related&workspace_scope=${encodeURIComponent(currentToken)}`,
  ));
  assert.equal(relationSearchResponse.status, 200);
  const relationSearchPayload = await relationSearchResponse.json() as {
    tasks: TaskRecord[];
    projects: ProjectRecord[];
  };
  assert.deepEqual(relationSearchPayload.tasks.map((task) => task.id), [foreignCandidate.id]);
  assert.deepEqual(
    new Set(relationSearchPayload.projects.map((project) => project.id)),
    new Set([foreignProject.id]),
  );

  await revokeAccess(foreign, foreignGrant.grantId);
  const revokedRelationSearchResponse = await searchTasksRoute(new Request(
    `https://example.test/api/tasks?search=Scoped+relation+needle&relation_search=true&relation_anchor=${source.id}&relation_kind=related&workspace_scope=${encodeURIComponent(currentToken)}`,
  ));
  assert.equal(revokedRelationSearchResponse.status, 200);
  const revokedRelationSearchPayload = await revokedRelationSearchResponse.json() as {
    tasks: TaskRecord[];
    projects: ProjectRecord[];
  };
  assert.deepEqual(revokedRelationSearchPayload.tasks, []);
  assert.deepEqual(revokedRelationSearchPayload.projects, []);
  const revokedDetail = await getTaskDetail(current, source.id, {
    workspaceScope: currentToken,
  });
  assert.deepEqual(revokedDetail.relatedTasks, []);
  assert.deepEqual(revokedDetail.relations, []);
});

test("relation search filters invalid candidates before applying its result limit", async () => {
  const actor = {
    provider: "chatgpt" as const,
    providerAccountKey: "relation-search-limit-owner",
    displayName: "Relation search limit owner",
    email: "relation-search-limit-owner@example.test",
  };
  const owner = await getOrCreateUser(actor);
  await createProject(owner, { name: "Relation search local", taskCode: "RSL" });
  await createProject(owner, { name: "Relation search foreign", taskCode: "RSF" });
  const projects = (await getSnapshot(owner)).projects;
  const localProject = projects.find((project) => project.name === "Relation search local")!;
  const foreignProject = projects.find((project) => project.name === "Relation search foreign")!;
  const anchor = await createTask(owner, {
    projectId: localProject.id,
    title: "Relation search anchor",
  });
  const validCandidate = await createTask(owner, {
    projectId: localProject.id,
    title: "Twenty candidate needle valid",
  });
  const invalidCandidateIds: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    invalidCandidateIds.push((await createTask(owner, {
      projectId: foreignProject.id,
      title: `Twenty candidate needle foreign ${index}`,
    })).id);
  }
  await database.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`)
    .bind("2020-01-01T00:00:00.000Z", validCandidate.id).run();
  await database.prepare(`UPDATE tasks SET updated_at = ?
    WHERE id IN (${invalidCandidateIds.map(() => "?").join(", ")})`)
    .bind("2030-01-01T00:00:00.000Z", ...invalidCandidateIds).run();

  const rawMatches = await searchTaskSummaries(owner, "Twenty candidate needle");
  assert.ok(rawMatches.findIndex((task) => task.id === validCandidate.id) >= 20);

  configureActorResolverForTests(async () => actor);
  const response = await searchTasksRoute(new Request(
    `https://example.test/api/tasks?search=Twenty+candidate+needle&relation_search=true&relation_anchor=${anchor.id}&relation_kind=duplicate_of`,
  ));
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    tasks: TaskRecord[];
    projects: ProjectRecord[];
  };
  assert.deepEqual(payload.tasks.map((task) => task.id), [validCandidate.id]);
  assert.deepEqual(payload.projects.map((project) => project.id), [localProject.id]);
});

test("project children use the current Project owner while global views use their own owner", () => {
  const project = { id: "project-a", ownerUserId: "owner-new" } as ProjectRecord;
  const task = {
    id: "task-a",
    projectId: project.id,
    ownerUserId: "owner-historical",
  } as TaskRecord;
  const scopedView = {
    id: "view-project",
    scopeProjectId: project.id,
    ownerUserId: "owner-historical",
  } as SavedViewRecord;
  const globalView = {
    id: "view-global",
    scopeProjectId: null,
    ownerUserId: "view-owner",
  } as SavedViewRecord;
  const projects = new Map([[project.id, project]]);

  assert.equal(workspaceOwnerUserId(task, projects), "owner-new");
  assert.equal(workspaceOwnerUserId(scopedView, projects), "owner-new");
  assert.equal(workspaceOwnerUserId(globalView, projects), "view-owner");
});

test("workspace focus supports only My or the complete ACL union across grant changes", async () => {
  const current = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "workspace-scope-current",
    displayName: "Current Person",
    email: "workspace-current@example.test",
  });
  const sharedOwner = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "workspace-scope-shared-owner",
    displayName: "Shared Owner",
    email: "workspace-shared-owner@example.test",
  });
  const hiddenOwner = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "workspace-scope-hidden-owner",
    displayName: "Hidden Owner",
    email: "workspace-hidden-owner@example.test",
  });

  await createProject(current, { name: "Current Project", taskCode: "CUR" });
  await createProject(sharedOwner, { name: "Shared Project", taskCode: "SHR" });
  await createProject(hiddenOwner, { name: "Hidden Project", taskCode: "HID" });
  const currentProject = (await getSnapshot(current)).projects.find((item) => item.name === "Current Project")!;
  const sharedProject = (await getSnapshot(sharedOwner)).projects.find((item) => item.name === "Shared Project")!;
  const hiddenProject = (await getSnapshot(hiddenOwner)).projects.find((item) => item.name === "Hidden Project")!;
  await createTask(current, { projectId: currentProject.id, title: "Current Task" });
  const sharedTask = await createTask(sharedOwner, {
    projectId: sharedProject.id,
    title: "Shared Task",
  });
  // Project ownership is the scope authority even when the denormalized child
  // owner records an earlier owner, as it does after ownership transfer.
  await database.prepare("UPDATE tasks SET owner_user_id = ? WHERE id = ?")
    .bind(hiddenOwner.id, sharedTask.id)
    .run();
  await createTask(hiddenOwner, { projectId: hiddenProject.id, title: "Hidden Task" });
  await createSavedView(sharedOwner, {
    name: "Shared global view",
    query: emptyViewQuery(),
    display: defaultViewDisplay(),
  });
  const sharedView = (await getSnapshot(sharedOwner)).views.find((item) => item.name === "Shared global view")!;
  await grantAccess(sharedOwner, {
    resourceType: "project",
    resourceId: sharedProject.id,
    email: current.email,
    permission: "viewer",
  });
  await grantAccess(sharedOwner, {
    resourceType: "saved_view",
    resourceId: sharedView.id,
    email: current.email,
    permission: "viewer",
  });

  const sharedToken = await opaqueWorkspaceOwnerToken(sharedOwner.id);
  const hiddenToken = await opaqueWorkspaceOwnerToken(hiddenOwner.id);
  const sharedSnapshot = await getSnapshot(current, {
    workspaceScope: sharedToken,
    navigationLimit: 3,
  });
  assert.deepEqual(sharedSnapshot.projects.map((item) => item.name), ["Current Project"]);
  assert.deepEqual(sharedSnapshot.tasks.map((item) => item.title), ["Current Task"]);
  assert.deepEqual(sharedSnapshot.views, []);
  assert.equal(sharedSnapshot.workspaceMetrics?.taskCounts.all, 1);
  assert.equal(sharedSnapshot.navigationCollections?.projects.total, 1);
  assert.equal(sharedSnapshot.workspaceScope?.selectedToken, await opaqueWorkspaceOwnerToken(current.id));
  assert.equal(sharedSnapshot.workspaceScope?.fallback, true);
  assert.deepEqual(sharedSnapshot.workspaceScope?.options.map((item) => item.label), [
    "My",
    "All accessible",
  ]);
  assert.equal(JSON.stringify(sharedSnapshot.workspaceScope).includes(sharedOwner.id), false);
  assert.equal(JSON.stringify(sharedSnapshot.workspaceScope).includes(sharedOwner.email), false);

  const query = await queryTaskSummaries(current, {
    surface: "all",
    query: emptyViewQuery(),
    display: defaultViewDisplay(),
    workspaceScope: ALL_ACCESSIBLE_WORKSPACE_SCOPE,
  });
  assert.deepEqual(new Set(query.tasks.map((item) => item.title)), new Set(["Current Task", "Shared Task"]));
  const catalog = await getWorkspaceCatalogPage(current, {
    kind: "projects",
    workspaceScope: ALL_ACCESSIBLE_WORKSPACE_SCOPE,
  });
  assert.deepEqual(new Set(catalog.projects.map((item) => item.name)), new Set(["Current Project", "Shared Project"]));

  const union = await getSnapshot(current, { workspaceScope: ALL_ACCESSIBLE_WORKSPACE_SCOPE });
  const sharedRoots = sharedWithMeRoots(union);
  assert.deepEqual(sharedRoots.projects.map((item) => item.name), ["Shared Project"]);
  assert.deepEqual(sharedRoots.views.map((item) => item.name), ["Shared global view"]);
  assert.equal("tasks" in sharedRoots, false);

  const forged = await getSnapshot(current, { workspaceScope: hiddenToken });
  assert.equal(forged.workspaceScope?.fallback, true);
  assert.equal(forged.workspaceScope?.selectedToken, await opaqueWorkspaceOwnerToken(current.id));
  assert.deepEqual(forged.projects.map((item) => item.name), ["Current Project"]);

  assert.ok(union.projects.some((item) => item.name === "Current Project"));
  assert.ok(union.projects.some((item) => item.name === "Shared Project"));
  assert.equal(union.projects.some((item) => item.name === "Hidden Project"), false);

  configureActorResolverForTests(async () => ({
    provider: "chatgpt" as const,
    providerAccountKey: "workspace-scope-current",
    displayName: "Current Person",
    email: "workspace-current@example.test",
  }));
  const defaultBootstrapResponse = await getBootstrapRoute(new Request("https://example.test/api/bootstrap"));
  assert.equal(defaultBootstrapResponse.status, 200);
  const defaultBootstrap = await defaultBootstrapResponse.json() as AppSnapshot;
  assert.ok(defaultBootstrap.projects.some((item) => item.name === "Shared Project"));
  assert.equal(defaultBootstrap.workspaceScope, undefined);

  await transferProjectOwnership(sharedOwner, sharedProject.id, current.id);
  const afterTransferOldScope = await getSnapshot(current, { workspaceScope: sharedToken });
  assert.equal(afterTransferOldScope.workspaceScope?.fallback, true);
  assert.equal(afterTransferOldScope.projects.some((item) => item.name === "Shared Project"), true);
  assert.equal(afterTransferOldScope.tasks.some((item) => item.title === "Shared Task"), true);
  const afterTransferCurrentScope = await getSnapshot(current, { workspaceScope: null });
  assert.equal(afterTransferCurrentScope.projects.some((item) => item.name === "Shared Project"), true);
  const transferredTask = afterTransferCurrentScope.tasks.find((item) => item.title === "Shared Task");
  assert.ok(transferredTask);
  assert.equal(
    afterTransferCurrentScope.statuses.some((status) => status.id === transferredTask.statusId),
    true,
    "historical child catalog references remain renderable in the current Project owner scope",
  );

  const viewGrant = (await getSnapshot(sharedOwner)).collaborators.find(
    (grant) => grant.resourceType === "saved_view" && grant.resourceId === sharedView.id,
  );
  assert.ok(viewGrant);
  await revokeAccess(sharedOwner, viewGrant.grantId);
  const afterRevoke = await getSnapshot(current, { workspaceScope: sharedToken });
  assert.equal(afterRevoke.workspaceScope?.fallback, true);
  assert.equal(afterRevoke.workspaceScope?.selectedToken, await opaqueWorkspaceOwnerToken(current.id));
});
