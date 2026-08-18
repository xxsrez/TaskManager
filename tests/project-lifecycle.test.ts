import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureActorResolverForTests } from "../lib/auth";
import { getAgentProjectDetail } from "../lib/agent-api-repository";
import { ConflictError, PermissionError, ValidationError } from "../lib/domain";
import {
  createProject,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  revokeAccess,
  updateAccessRole,
  updateProject,
} from "../lib/repository";
import { getWorkspaceSync } from "../lib/workspace-sync";
import { PATCH as updateProjectRoute } from "../app/api/projects/[id]/route";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "project-lifecycle-owner",
  displayName: "Project owner",
  email: "project-lifecycle-owner@example.test",
};
const memberActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "project-lifecycle-member",
  displayName: "Project member",
  email: "project-lifecycle-member@example.test",
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

test("Project create and versioned edit cover metadata, roles, code locking, lifecycle, and Agent detail", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, {
    name: "Lifecycle Project",
    taskCode: "LP",
    summary: "Initial summary",
    description: "## Outcome\n\nNative Project lifecycle.",
    status: "active",
    leadUserId: owner.id,
    startDate: "2026-08-01",
    targetDate: "2026-09-01",
    icon: "rocket",
    color: "#336699",
  });
  let project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Lifecycle Project",
  )!;
  assert.equal(project.icon, "rocket");
  assert.equal(project.color, "#336699");
  assert.equal(project.status, "active");
  assert.equal(project.leadUserId, owner.id);

  await assert.rejects(
    createProject(owner, { name: "Duplicate Project code", taskCode: "LP" }),
    /already in use/,
  );
  project = await updateProject(owner, project.id, {
    version: project.version,
    taskCode: "LX",
  });
  assert.equal(project.taskCode, "LX");

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: member.email,
    permission: "viewer",
  });
  await assert.rejects(
    updateProject(member, project.id, {
      version: project.version,
      name: "Viewer edit",
    }),
    PermissionError,
  );
  let grant = (await getSnapshot(owner)).collaborators.find(
    (item) => item.resourceId === project.id && item.userId === member.id,
  )!;
  await updateAccessRole(owner, grant.grantId, { permission: "editor" });
  project = await updateProject(member, project.id, {
    version: project.version,
    name: "Lifecycle Project Edited",
    summary: "Edited summary",
    description: "# Edited\n\nShared native metadata.",
    status: "paused",
    leadUserId: member.id,
    startDate: "2026-08-02",
    targetDate: "2026-09-02",
    icon: "target",
    color: "#aa5500",
  });
  assert.deepEqual(
    {
      name: project.name,
      summary: project.summary,
      status: project.status,
      leadUserId: project.leadUserId,
      startDate: project.startDate,
      targetDate: project.targetDate,
      icon: project.icon,
      color: project.color,
    },
    {
      name: "Lifecycle Project Edited",
      summary: "Edited summary",
      status: "paused",
      leadUserId: member.id,
      startDate: "2026-08-02",
      targetDate: "2026-09-02",
      icon: "target",
      color: "#aa5500",
    },
  );

  const agentDetail = await getAgentProjectDetail(owner, project.publicId);
  assert.equal(agentDetail.version, project.version);
  assert.equal(agentDetail.icon, "target");
  assert.equal(agentDetail.color, "#aa5500");
  assert.equal(agentDetail.lead?.displayName, member.displayName);

  await createTask(owner, { title: "Open Project Task", projectId: project.id });
  project = (await getSnapshot(owner)).projects.find((item) => item.id === project.id)!;
  await assert.rejects(
    updateProject(owner, project.id, {
      version: project.version,
      taskCode: "LY",
    }),
    /code is locked/,
  );
  await assert.rejects(
    updateProject(owner, project.id, {
      version: project.version,
      status: "completed",
    }),
    /Confirm the terminal transition/,
  );
  const completed = await updateProject(owner, project.id, {
    version: project.version,
    status: "completed",
    confirmOpenTasks: true,
  });
  assert.equal(completed.status, "completed");
  await assert.rejects(
    updateProject(owner, project.id, {
      version: project.version,
      summary: "Stale write",
    }),
    ConflictError,
  );

  grant = (await getSnapshot(owner)).collaborators.find(
    (item) => item.resourceId === project.id && item.userId === member.id,
  )!;
  const leadVersion = completed.version;
  await revokeAccess(owner, grant.grantId);
  project = (await getSnapshot(owner)).projects.find((item) => item.id === project.id)!;
  assert.equal(project.leadUserId, null);
  assert.equal(project.version, leadVersion + 1);
});

test("Project archive remains ACL-scoped for sync and restore, and PATCH returns read-back", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "project-archive-owner",
    email: "project-archive-owner@example.test",
  });
  await createProject(owner, { name: "Archive Project", taskCode: "AP" });
  let project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Archive Project",
  )!;
  const baseline = await getSnapshot(owner);
  project = await updateProject(owner, project.id, {
    version: project.version,
    archived: true,
  });
  assert.ok(project.archivedAt);
  assert.ok((await getSnapshot(owner)).projects.some(
    (item) => item.id === project.id && item.archivedAt,
  ));
  const archivedSync = await getWorkspaceSync(owner, baseline.syncCursor!);
  assert.equal(archivedSync.resetRequired, false);
  assert.ok(archivedSync.changes.projects.upsert.some(
    (item) => item.id === project.id && item.archivedAt,
  ));

  configureActorResolverForTests(async () => ({
    ...ownerActor,
    providerAccountKey: "project-archive-owner",
    email: "project-archive-owner@example.test",
  }));
  const response = await updateProjectRoute(
    new Request(`https://example.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: project.version, archived: false }),
    }),
    { params: Promise.resolve({ id: project.id }) },
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as { projects: Array<{ id: string; archivedAt: string | null; version: number }> };
  const restored = payload.projects.find((item) => item.id === project.id)!;
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.version, project.version + 1);

  await assert.rejects(
    updateProject(owner, project.id, {
      version: restored.version,
      leadUserId: "missing-user",
    }),
    ValidationError,
  );
});

test("concurrent first Task and code correction leave one coherent Project identity", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "project-code-race-owner",
    email: "project-code-race-owner@example.test",
  });
  await createProject(owner, { name: "Code Race Project", taskCode: "RC" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Code Race Project",
  )!;
  const [codeResult, taskResult] = await Promise.allSettled([
    updateProject(owner, project.id, {
      version: project.version,
      taskCode: "RD",
    }),
    createTask(owner, { title: "Code race Task", projectId: project.id }),
  ]);
  assert.equal(taskResult.status, "fulfilled");
  if (codeResult.status === "rejected") {
    assert.ok(codeResult.reason instanceof ConflictError || codeResult.reason instanceof ValidationError);
  }
  const snapshot = await getSnapshot(owner);
  const committedProject = snapshot.projects.find((item) => item.id === project.id)!;
  const task = snapshot.tasks.find((item) => item.title === "Code race Task")!;
  assert.equal(committedProject.taskSequence, 1);
  assert.equal(task.identifier, `${committedProject.taskCode}-1`);
  assert.ok(committedProject.codeLockedAt);
});
