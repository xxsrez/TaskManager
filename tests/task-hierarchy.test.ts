import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createAgentSubtask,
  getAgentTaskDetail,
  setAgentTaskParent,
} from "../lib/agent-api-repository";
import { ConflictError, PermissionError, ValidationError } from "../lib/domain";
import {
  createProject,
  createSubtask,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTask,
  getTaskDetail,
  grantAccess,
  setTaskParent,
  updateAccessRole,
} from "../lib/repository";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "hierarchy-owner",
  displayName: "Hierarchy owner",
  email: "hierarchy-owner@example.test",
};
const collaboratorActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "hierarchy-collaborator",
  displayName: "Hierarchy collaborator",
  email: "hierarchy-collaborator@example.test",
};

let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
});

after(async () => dispose?.());

test("native hierarchy supports create, reparent, detach, and two-sided detail", async () => {
  const owner = await getOrCreateUser(ownerActor);
  await createProject(owner, { name: "Hierarchy project", taskCode: "HP" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Hierarchy project",
  )!;
  await createTask(owner, { title: "Parent A", projectId: project.id });
  await createTask(owner, { title: "Parent B", projectId: project.id });
  const initial = await getSnapshot(owner);
  const parentA = initial.tasks.find((item) => item.title === "Parent A")!;
  const parentB = initial.tasks.find((item) => item.title === "Parent B")!;

  const child = await createSubtask(owner, parentA.id, {
    version: parentA.version,
    title: "Native child",
  });
  assert.equal(child.projectId, project.id);
  assert.equal(child.parentTaskId, parentA.id);
  assert.match(child.identifier, /^HP-\d+$/);
  assert.equal((await getTask(owner, parentA.id)).version, parentA.version + 1);
  assert.ok((await getTaskDetail(owner, parentA.id)).relatedTasks.some(
    (task) => task.id === child.id && task.parentTaskId === parentA.id,
  ));
  assert.equal((await getTaskDetail(owner, child.id)).task.parentTaskId, parentA.id);

  const reparented = await setTaskParent(owner, child.id, {
    version: child.version,
    parentTaskId: parentB.id,
  });
  assert.equal(reparented.parentTaskId, parentB.id);
  assert.equal((await getTaskDetail(owner, parentA.id)).relatedTasks.some(
    (task) => task.id === child.id,
  ), false);
  assert.ok((await getTaskDetail(owner, parentB.id)).relatedTasks.some(
    (task) => task.id === child.id,
  ));

  const detached = await setTaskParent(owner, child.id, {
    version: reparented.version,
    parentTaskId: null,
  });
  assert.equal(detached.parentTaskId, null);
  assert.equal(
    (await setTaskParent(owner, child.id, {
      version: detached.version,
      parentTaskId: null,
    })).version,
    detached.version,
  );
});

test("hierarchy rejects self, cycles, cross-project edges, stale retries, and viewers", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "hierarchy-guard-owner",
    email: "hierarchy-guard-owner@example.test",
  });
  const collaborator = await getOrCreateUser(collaboratorActor);
  await createProject(owner, { name: "Hierarchy guards", taskCode: "HG" });
  await createProject(owner, { name: "Hierarchy other", taskCode: "HO" });
  const snapshot = await getSnapshot(owner);
  const project = snapshot.projects.find((item) => item.name === "Hierarchy guards")!;
  const otherProject = snapshot.projects.find((item) => item.name === "Hierarchy other")!;
  await createTask(owner, { title: "Guard root", projectId: project.id });
  await createTask(owner, { title: "Guard child", projectId: project.id });
  await createTask(owner, { title: "Other root", projectId: otherProject.id });
  const tasks = (await getSnapshot(owner)).tasks;
  const root = tasks.find((item) => item.title === "Guard root")!;
  const child = tasks.find((item) => item.title === "Guard child")!;
  const other = tasks.find((item) => item.title === "Other root")!;

  await assert.rejects(
    setTaskParent(owner, root.id, { version: root.version, parentTaskId: root.id }),
    ValidationError,
  );
  await assert.rejects(
    setTaskParent(owner, root.id, { version: root.version, parentTaskId: other.id }),
    /same Project/,
  );
  const linked = await setTaskParent(owner, child.id, {
    version: child.version,
    parentTaskId: root.id,
  });
  await assert.rejects(
    setTaskParent(owner, root.id, {
      version: root.version,
      parentTaskId: child.id,
    }),
    /cycle/,
  );

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: collaborator.email,
    permission: "viewer",
  });
  await assert.rejects(
    setTaskParent(collaborator, linked.id, {
      version: linked.version,
      parentTaskId: null,
    }),
    PermissionError,
  );
  const grant = (await getSnapshot(owner)).collaborators.find(
    (item) => item.resourceId === project.id,
  )!;
  await updateAccessRole(owner, grant.grantId, { permission: "editor" });
  const detached = await setTaskParent(collaborator, linked.id, {
    version: linked.version,
    parentTaskId: null,
  });
  assert.equal(detached.parentTaskId, null);
  await assert.rejects(
    setTaskParent(owner, detached.id, {
      version: linked.version,
      parentTaskId: root.id,
    }),
    ConflictError,
  );

  const latestRoot = await getTask(owner, root.id);
  await createSubtask(owner, root.id, {
    version: latestRoot.version,
    title: "Retry-safe child",
  });
  await assert.rejects(
    createSubtask(owner, root.id, {
      version: latestRoot.version,
      title: "Retry-safe child",
    }),
    ConflictError,
  );
});

test("Agent hierarchy commands resolve canonical refs and share the native contract", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "hierarchy-agent-owner",
    email: "hierarchy-agent-owner@example.test",
  });
  await createProject(owner, { name: "Hierarchy Agent", taskCode: "HA" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Hierarchy Agent",
  )!;
  await createTask(owner, { title: "Agent parent", projectId: project.id });
  await createTask(owner, { title: "Agent child", projectId: project.id });
  const tasks = (await getSnapshot(owner)).tasks;
  const parent = tasks.find((item) => item.title === "Agent parent")!;
  const child = tasks.find((item) => item.title === "Agent child")!;

  const attached = await setAgentTaskParent(owner, child.publicId, {
    version: child.version,
    parentTaskRef: parent.identifier,
  });
  assert.equal(attached.parent?.identifier, parent.identifier);
  const parentDetail = await getAgentTaskDetail(owner, parent.publicId);
  const created = await createAgentSubtask(owner, parent.publicId, {
    version: parentDetail.version,
    title: "Agent-created subtask",
  });
  assert.equal(created.parent?.identifier, parent.identifier);

  const detached = await setAgentTaskParent(owner, child.publicId, {
    version: attached.version,
    parentTaskRef: null,
  });
  assert.equal(detached.parent, null);
});
