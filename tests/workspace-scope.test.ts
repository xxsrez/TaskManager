import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createProject,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getWorkspaceCatalogPage,
  grantAccess,
  queryTaskSummaries,
  revokeAccess,
  transferProjectOwnership,
} from "../lib/repository";
import {
  navigationStateWithWorkspaceScope,
  scopedUiApiPath,
  workspaceScopeFromHistory,
} from "../components/task-tracker";
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

test("workspace scope tokens are opaque, bounded, and fail closed to the current user", async () => {
  const currentToken = await opaqueWorkspaceOwnerToken("usr_current-internal");
  const otherToken = await opaqueWorkspaceOwnerToken("usr_other-internal");
  const descriptors: WorkspaceScopeDescriptor[] = [
    { token: currentToken, kind: "owner", label: "Your work", current: true },
    { token: otherToken, kind: "owner", label: "Other Owner", current: false },
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
  const historyState = navigationStateWithWorkspaceScope(
    { surface: "projects", layout: "list", taskId: null },
    otherToken,
  );
  assert.equal(workspaceScopeFromHistory(historyState), otherToken);
  assert.equal(workspaceScopeFromHistory({ taskManagerWorkspaceScope: "usr_other-internal" }), null);
  assert.equal(
    scopedUiApiPath("/api/tasks?cursor=next", otherToken),
    `/api/tasks?cursor=next&workspace_scope=${encodeURIComponent(otherToken)}`,
  );

  assert.deepEqual(
    resolveWorkspaceScopeMembership(otherToken, descriptors, currentToken),
    { token: otherToken, fallback: false },
  );
  assert.deepEqual(
    resolveWorkspaceScopeMembership("wso_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", descriptors, currentToken),
    { token: currentToken, fallback: true },
  );
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

test("scoped snapshot, task query, catalogs, metrics, and shared roots narrow after ACL", async () => {
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
  assert.deepEqual(sharedSnapshot.projects.map((item) => item.name), ["Shared Project"]);
  assert.deepEqual(sharedSnapshot.tasks.map((item) => item.title), ["Shared Task"]);
  assert.deepEqual(sharedSnapshot.views.map((item) => item.name), ["Shared global view"]);
  assert.equal(sharedSnapshot.workspaceMetrics?.taskCounts.all, 1);
  assert.equal(sharedSnapshot.navigationCollections?.projects.total, 1);
  assert.equal(sharedSnapshot.workspaceScope?.selectedToken, sharedToken);
  assert.equal(sharedSnapshot.workspaceScope?.fallback, false);
  assert.ok(sharedSnapshot.workspaceScope?.options.some((item) => item.label === "Shared Owner"));
  assert.equal(JSON.stringify(sharedSnapshot.workspaceScope).includes(sharedOwner.id), false);
  assert.equal(JSON.stringify(sharedSnapshot.workspaceScope).includes(sharedOwner.email), false);

  const query = await queryTaskSummaries(current, {
    surface: "all",
    query: emptyViewQuery(),
    display: defaultViewDisplay(),
    workspaceScope: sharedToken,
  });
  assert.deepEqual(query.tasks.map((item) => item.title), ["Shared Task"]);
  const catalog = await getWorkspaceCatalogPage(current, {
    kind: "projects",
    workspaceScope: sharedToken,
  });
  assert.deepEqual(catalog.projects.map((item) => item.name), ["Shared Project"]);

  const sharedRoots = sharedWithMeRoots(sharedSnapshot);
  assert.deepEqual(sharedRoots.projects.map((item) => item.name), ["Shared Project"]);
  assert.deepEqual(sharedRoots.views.map((item) => item.name), ["Shared global view"]);
  assert.equal("tasks" in sharedRoots, false);

  const forged = await getSnapshot(current, { workspaceScope: hiddenToken });
  assert.equal(forged.workspaceScope?.fallback, true);
  assert.equal(forged.workspaceScope?.selectedToken, await opaqueWorkspaceOwnerToken(current.id));
  assert.deepEqual(forged.projects.map((item) => item.name), ["Current Project"]);

  const union = await getSnapshot(current);
  assert.ok(union.projects.some((item) => item.name === "Current Project"));
  assert.ok(union.projects.some((item) => item.name === "Shared Project"));
  assert.equal(union.projects.some((item) => item.name === "Hidden Project"), false);

  await transferProjectOwnership(sharedOwner, sharedProject.id, current.id);
  const afterTransferOldScope = await getSnapshot(current, { workspaceScope: sharedToken });
  assert.equal(afterTransferOldScope.projects.some((item) => item.name === "Shared Project"), false);
  assert.equal(afterTransferOldScope.tasks.some((item) => item.title === "Shared Task"), false);
  assert.deepEqual(afterTransferOldScope.views.map((item) => item.name), ["Shared global view"]);
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
