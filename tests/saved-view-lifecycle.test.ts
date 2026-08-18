import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureActorResolverForTests } from "../lib/auth";
import { getAgentSavedViewDetail } from "../lib/agent-api-repository";
import { ConflictError, PermissionError, ValidationError } from "../lib/domain";
import {
  createProject,
  createSavedView,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  updateAccessRole,
  updateSavedView,
} from "../lib/repository";
import { getWorkspaceSync } from "../lib/workspace-sync";
import { PATCH as updateSavedViewRoute } from "../app/api/views/[id]/route";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "saved-view-owner",
  displayName: "Saved view owner",
  email: "saved-view-owner@example.test",
};
const memberActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "saved-view-member",
  displayName: "Saved view member",
  email: "saved-view-member@example.test",
};

let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
});

after(async () => {
  configureActorResolverForTests(null);
  await dispose?.();
});

test("Saved View metadata, query, Display, scope, ACL, version, and sync are one atomic lifecycle", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "View Project", taskCode: "VP" });
  await createProject(owner, { name: "Other View Project", taskCode: "OV" });
  const projects = (await getSnapshot(owner)).projects;
  const project = projects.find((item) => item.name === "View Project")!;
  const otherProject = projects.find((item) => item.name === "Other View Project")!;

  const created = await createSavedView(owner, {
    name: "Native View",
    scopeProjectId: project.id,
    query: { projectId: project.id, priorities: ["high"] },
    display: {
      layout: "list",
      groupBy: "status",
      orderBy: "manual",
      direction: "asc",
      showEmptyGroups: false,
      visibleFields: ["priority", "project"],
    },
  });
  assert.equal(created.version, 1);

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: member.email,
    permission: "viewer",
  });
  await assert.rejects(
    updateSavedView(member, created.id, {
      version: created.version,
      name: "Viewer edit",
    }),
    PermissionError,
  );
  const grant = (await getSnapshot(owner)).collaborators.find(
    (item) => item.resourceId === project.id && item.userId === member.id,
  )!;
  await updateAccessRole(owner, grant.grantId, { permission: "editor" });
  const baseline = await getSnapshot(owner);

  const updated = await updateSavedView(member, created.id, {
    version: created.version,
    name: "Native View Edited",
    query: { projectId: project.id, priorities: ["urgent", "high"] },
    display: {
      layout: "board",
      groupBy: "priority",
      orderBy: "updated",
      direction: "desc",
      showEmptyGroups: true,
      visibleFields: ["priority", "dueDate", "assignee"],
    },
  });
  assert.deepEqual(updated.display, {
    layout: "board",
    groupBy: "priority",
    orderBy: "updated",
    direction: "desc",
    showEmptyGroups: true,
    visibleFields: ["priority", "dueDate", "assignee"],
  });
  const agentView = await getAgentSavedViewDetail(owner, created.publicId);
  assert.equal(agentView.name, "Native View Edited");
  assert.deepEqual(agentView.query, updated.query);
  assert.deepEqual(agentView.display, updated.display);
  assert.equal(agentView.version, updated.version);
  await assert.rejects(
    updateSavedView(owner, created.id, {
      version: updated.version,
      query: { projectId: otherProject.id },
    }),
    ValidationError,
  );
  await assert.rejects(
    updateSavedView(owner, created.id, {
      version: created.version,
      name: "Stale edit",
    }),
    ConflictError,
  );

  const sync = await getWorkspaceSync(owner, baseline.syncCursor!);
  assert.equal(sync.resetRequired, false);
  assert.ok(sync.changes.views.upsert.some(
    (item) => item.id === created.id && item.name === "Native View Edited",
  ));
});

test("Saved View archive is reversible and PATCH returns authoritative read-back", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "saved-view-archive-owner",
    email: "saved-view-archive-owner@example.test",
  });
  const view = await createSavedView(owner, {
    name: "Archive View",
    query: {},
    display: { layout: "list" },
  });
  const archived = await updateSavedView(owner, view.id, {
    version: view.version,
    archived: true,
  });
  assert.ok(archived.archivedAt);

  configureActorResolverForTests(async () => ({
    ...ownerActor,
    providerAccountKey: "saved-view-archive-owner",
    email: "saved-view-archive-owner@example.test",
  }));
  const response = await updateSavedViewRoute(
    new Request(`https://example.test/api/views/${view.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: archived.version, archived: false }),
    }),
    { params: Promise.resolve({ id: view.id }) },
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    views: Array<{ id: string; archivedAt: string | null; version: number }>;
  };
  const restored = payload.views.find((item) => item.id === view.id)!;
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.version, archived.version + 1);
});

test("concurrent Saved View writes commit one complete configuration", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "saved-view-race-owner",
    email: "saved-view-race-owner@example.test",
  });
  const view = await createSavedView(owner, {
    name: "Race View",
    query: {},
    display: { layout: "list" },
  });
  const results = await Promise.allSettled([
    updateSavedView(owner, view.id, {
      version: view.version,
      name: "Race A",
      display: { layout: "board", groupBy: "priority" },
    }),
    updateSavedView(owner, view.id, {
      version: view.version,
      name: "Race B",
      display: { layout: "list", groupBy: "assignee" },
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const committed = (await getSnapshot(owner)).views.find((item) => item.id === view.id)!;
  assert.equal(committed.version, view.version + 1);
  assert.ok(committed.name === "Race A" || committed.name === "Race B");
});
