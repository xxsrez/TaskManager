import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureActorResolverForTests } from "../lib/auth";
import { getAgentReleaseDetail } from "../lib/agent-api-repository";
import { ConflictError, PermissionError, ValidationError } from "../lib/domain";
import {
  createProject,
  createRelease,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  updateAccessRole,
  updateRelease,
  updateTask,
} from "../lib/repository";
import { getWorkspaceSync } from "../lib/workspace-sync";
import { PATCH as updateReleaseRoute } from "../app/api/releases/[id]/route";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "release-lifecycle-owner",
  displayName: "Release owner",
  email: "release-lifecycle-owner@example.test",
};
const memberActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "release-lifecycle-member",
  displayName: "Release member",
  email: "release-lifecycle-member@example.test",
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

test("Release metadata and lifecycle are versioned, ACL-scoped, synchronized, and readable by Agents", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "Release Project", taskCode: "RL" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Release Project")!;
  await createRelease(owner, {
    projectId: project.id,
    name: "0.9",
    description: "## Scope\n\nInitial release.",
    status: "active",
    targetDate: "2026-09-01",
    releaseNotes: "Initial notes",
  });
  let release = (await getSnapshot(owner)).releases.find((item) => item.name === "0.9")!;
  assert.equal(release.status, "active");
  assert.equal(release.releaseNotes, "Initial notes");

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: member.email,
    permission: "viewer",
  });
  await assert.rejects(
    updateRelease(member, release.id, { version: release.version, name: "Viewer edit" }),
    PermissionError,
  );
  const grant = (await getSnapshot(owner)).collaborators.find(
    (item) => item.resourceId === project.id && item.userId === member.id,
  )!;
  await updateAccessRole(owner, grant.grantId, { permission: "editor" });
  release = await updateRelease(member, release.id, {
    version: release.version,
    name: "1.0",
    description: "# Outcome\n\nNative Release lifecycle.",
    status: "active",
    targetDate: "2026-09-02",
    releaseNotes: "## Changes\n\nEditable Markdown notes.",
  });
  assert.equal(release.name, "1.0");
  assert.equal(release.targetDate, "2026-09-02");

  const createdTask = await createTask(owner, {
    title: "Open release Task",
    projectId: project.id,
    releaseId: release.id,
  });
  const task = (await getSnapshot(owner)).tasks.find((item) => item.id === createdTask.id)!;
  const baseline = await getSnapshot(owner);
  await assert.rejects(
    updateRelease(owner, release.id, { version: release.version, status: "released" }),
    /Confirm the terminal transition/,
  );
  const released = await updateRelease(owner, release.id, {
    version: release.version,
    status: "released",
    confirmOpenTasks: true,
  });
  assert.ok(released.releasedAt);
  assert.equal((await getSnapshot(owner)).tasks.find((item) => item.id === task.id)?.statusId, task.statusId);
  await assert.rejects(
    updateRelease(owner, release.id, { version: release.version, status: "canceled" }),
    ConflictError,
  );

  const notesEdit = await updateRelease(owner, released.id, {
    version: released.version,
    releaseNotes: "Published notes",
  });
  assert.equal(notesEdit.releasedAt, released.releasedAt);
  const reopened = await updateRelease(owner, notesEdit.id, {
    version: notesEdit.version,
    status: "active",
  });
  assert.equal(reopened.releasedAt, null);
  const canceled = await updateRelease(owner, reopened.id, {
    version: reopened.version,
    status: "canceled",
  });
  assert.equal(canceled.releasedAt, null);

  const sync = await getWorkspaceSync(owner, baseline.syncCursor!);
  assert.equal(sync.resetRequired, false);
  assert.ok(sync.changes.releases.upsert.some(
    (item) => item.id === release.id && item.status === "canceled",
  ));
  const agentDetail = await getAgentReleaseDetail(owner, release.publicId);
  assert.equal(agentDetail.status, "canceled");
  assert.equal(agentDetail.releaseNotes, "Published notes");
  assert.equal(agentDetail.version, canceled.version);
});

test("released Release composition changes require an explicit server confirmation", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "released-composition-owner",
    email: "released-composition-owner@example.test",
  });
  await createProject(owner, { name: "Composition Project", taskCode: "CP" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Composition Project")!;
  await createRelease(owner, { projectId: project.id, name: "Released" });
  await createRelease(owner, { projectId: project.id, name: "Planned" });
  const snapshot = await getSnapshot(owner);
  let released = snapshot.releases.find((item) => item.name === "Released")!;
  const planned = snapshot.releases.find((item) => item.name === "Planned")!;
  released = await updateRelease(owner, released.id, {
    version: released.version,
    status: "released",
  });

  await assert.rejects(
    createTask(owner, { title: "Hidden membership", projectId: project.id, releaseId: released.id }),
    /Confirm changing the composition/,
  );
  const createdTask = await createTask(owner, {
    title: "Confirmed membership",
    projectId: project.id,
    releaseId: released.id,
    confirmReleasedComposition: true,
  });
  const task = (await getSnapshot(owner)).tasks.find((item) => item.id === createdTask.id)!;
  await assert.rejects(
    updateTask(owner, task.id, { version: task.version, releaseId: planned.id }),
    /Confirm changing the composition/,
  );
  let changed = await updateTask(owner, task.id, {
    version: task.version,
    releaseId: planned.id,
    confirmReleasedComposition: true,
  });
  await assert.rejects(
    updateTask(owner, changed.id, { version: changed.version, releaseId: released.id }),
    /Confirm changing the composition/,
  );
  changed = await updateTask(owner, changed.id, {
    version: changed.version,
    releaseId: released.id,
    confirmReleasedComposition: true,
  });
  assert.equal(changed.releaseId, released.id);

  await createProject(owner, { name: "Other Project", taskCode: "OP" });
  const other = (await getSnapshot(owner)).projects.find((item) => item.name === "Other Project")!;
  await assert.rejects(
    createTask(owner, { title: "Wrong Project", projectId: other.id, releaseId: released.id, confirmReleasedComposition: true }),
    ValidationError,
  );
});

test("Release PATCH returns authoritative lifecycle read-back", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "release-route-owner",
    email: "release-route-owner@example.test",
  });
  await createProject(owner, { name: "Route Project", taskCode: "RP" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Route Project")!;
  await createRelease(owner, { projectId: project.id, name: "Route Release" });
  const release = (await getSnapshot(owner)).releases.find((item) => item.name === "Route Release")!;
  configureActorResolverForTests(async () => ({
    ...ownerActor,
    providerAccountKey: "release-route-owner",
    email: "release-route-owner@example.test",
  }));
  const response = await updateReleaseRoute(
    new Request(`https://example.test/api/releases/${release.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: release.version,
        name: "Route Release Edited",
        status: "released",
        releaseNotes: "Published through PATCH",
      }),
    }),
    { params: Promise.resolve({ id: release.id }) },
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as { releases: Array<{ id: string; name: string; status: string; releasedAt: string | null; version: number }> };
  const updated = payload.releases.find((item) => item.id === release.id)!;
  assert.equal(updated.name, "Route Release Edited");
  assert.equal(updated.status, "released");
  assert.ok(updated.releasedAt);
  assert.equal(updated.version, release.version + 1);
});

test("concurrent Release transitions commit one coherent lifecycle state", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "release-race-owner",
    email: "release-race-owner@example.test",
  });
  await createProject(owner, { name: "Release Race Project", taskCode: "RR" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Release Race Project")!;
  await createRelease(owner, { projectId: project.id, name: "Race Release" });
  const release = (await getSnapshot(owner)).releases.find((item) => item.name === "Race Release")!;
  const results = await Promise.allSettled([
    updateRelease(owner, release.id, { version: release.version, status: "released" }),
    updateRelease(owner, release.id, { version: release.version, status: "canceled" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const committed = (await getSnapshot(owner)).releases.find((item) => item.id === release.id)!;
  assert.equal(committed.version, release.version + 1);
  assert.equal(Boolean(committed.releasedAt), committed.status === "released");
});
