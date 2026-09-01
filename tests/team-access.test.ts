import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ConflictError, PermissionError } from "../lib/domain";
import {
  grantTeamAccess,
  listTeamGrants,
  revokeTeamAccess,
  updateTeamAccess,
} from "../lib/team-grants";
import {
  addTeamMember,
  createTeam,
  setTeamMembershipStatus,
} from "../lib/teams";
import {
  createProject,
  createRelease,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  searchWorkspace,
  updateProject,
  updateRelease,
  updateSavedView,
  updateTask,
} from "../lib/repository";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "team-access-owner",
  displayName: "Team access owner",
  email: "team-access-owner@example.test",
};
const memberActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "team-access-member",
  displayName: "Team access member",
  email: "team-access-member@example.test",
};
const secondMemberActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "team-access-second-member",
  displayName: "Second Team member",
  email: "team-access-second-member@example.test",
};

let database: D1Database;
let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => {
  await dispose?.();
});

test("Project Team route inherits to Tasks and strongest direct role survives revocation", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "Team project route", taskCode: "TPR" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Team project route")!;
  await createTask(owner, { title: "Inherited Team task", projectId: project.id });
  const task = (await getSnapshot(owner)).tasks.find((item) => item.projectId === project.id)!;
  const team = await createTeam(owner, { name: "Project viewers" });
  await addTeamMember(owner, team.id, { email: member.email });

  let grants = await grantTeamAccess(owner, {
    teamRef: team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  });
  assert.equal(grants[0]?.permission, "viewer");
  await assert.rejects(
    updateTeamAccess(owner, grants[0]!.id, {
      version: grants[0]!.version + 1,
      permission: "editor",
    }),
    ConflictError,
  );
  await assert.rejects(
    listTeamGrants(member, { resourceType: "project", resourceId: project.id }),
    PermissionError,
  );
  let snapshot = await getSnapshot(member);
  assert.equal(snapshot.projects.find((item) => item.id === project.id)?.accessRole, "viewer");
  assert.equal(snapshot.tasks.find((item) => item.id === task.id)?.accessRole, "viewer");
  await assert.rejects(
    updateTask(member, task.id, { version: task.version, title: "Denied" }),
    PermissionError,
  );

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: member.email,
    permission: "editor",
  });
  const directBefore = await database.prepare(
    `SELECT * FROM access_grants
     WHERE resource_type = 'project' AND resource_id = ? AND grantee_user_id = ?`,
  ).bind(project.id, member.id).first<Record<string, unknown>>();
  snapshot = await getSnapshot(member);
  assert.equal(snapshot.projects.find((item) => item.id === project.id)?.accessRole, "editor");

  grants = await updateTeamAccess(owner, grants[0]!.id, {
    version: grants[0]!.version,
    permission: "editor",
  });
  await revokeTeamAccess(owner, grants[0]!.id, { version: grants[0]!.version });
  const directAfter = await database.prepare(
    `SELECT * FROM access_grants
     WHERE resource_type = 'project' AND resource_id = ? AND grantee_user_id = ?`,
  ).bind(project.id, member.id).first<Record<string, unknown>>();
  assert.deepEqual(directAfter, directBefore);
  assert.equal(
    (await getSnapshot(member)).projects.find((item) => item.id === project.id)?.accessRole,
    "editor",
  );
});

test("Task Team route opens only that Task and follows membership and multi-Team churn", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(secondMemberActor);
  await createProject(owner, { name: "Task-only Team route", taskCode: "TOT" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Task-only Team route")!;
  await createTask(owner, { title: "Granted task", projectId: project.id });
  await createTask(owner, { title: "Sibling task", projectId: project.id });
  const ownerTasks = (await getSnapshot(owner)).tasks.filter((item) => item.projectId === project.id);
  const grantedTask = ownerTasks.find((item) => item.title === "Granted task")!;
  const siblingTask = ownerTasks.find((item) => item.title === "Sibling task")!;
  const editorTeam = await createTeam(owner, { name: "Task editors" });
  const viewerTeam = await createTeam(owner, { name: "Task viewers" });
  let editorDetail = await addTeamMember(owner, editorTeam.id, { email: member.email });
  await addTeamMember(owner, viewerTeam.id, { email: member.email });
  const editorMembership = editorDetail.members.find((item) => item.userId === member.id)!;

  let editorGrants = await grantTeamAccess(owner, {
    teamRef: editorTeam.id,
    resourceType: "task",
    resourceId: grantedTask.id,
    permission: "editor",
  });
  await grantTeamAccess(owner, {
    teamRef: viewerTeam.id,
    resourceType: "task",
    resourceId: grantedTask.id,
    permission: "viewer",
  });
  let snapshot = await getSnapshot(member);
  assert.equal(snapshot.tasks.find((item) => item.id === grantedTask.id)?.accessRole, "editor");
  assert.ok(!snapshot.tasks.some((item) => item.id === siblingTask.id));
  assert.ok(!snapshot.projects.some((item) => item.id === project.id));
  const edited = await updateTask(member, grantedTask.id, {
    version: grantedTask.version,
    title: "Granted task edited",
  });
  assert.equal(edited.title, "Granted task edited");

  editorDetail = await setTeamMembershipStatus(owner, editorTeam.id, editorMembership.id, {
    version: editorMembership.version,
    status: "inactive",
  });
  snapshot = await getSnapshot(member);
  assert.equal(snapshot.tasks.find((item) => item.id === grantedTask.id)?.accessRole, "viewer");
  await assert.rejects(
    updateTask(member, grantedTask.id, { version: edited.version, title: "Denied again" }),
    PermissionError,
  );
  const inactiveMembership = editorDetail.members.find((item) => item.id === editorMembership.id)!;
  await setTeamMembershipStatus(owner, editorTeam.id, editorMembership.id, {
    version: inactiveMembership.version,
    status: "active",
  });
  assert.equal(
    (await getSnapshot(member)).tasks.find((item) => item.id === grantedTask.id)?.accessRole,
    "editor",
  );

  editorGrants = await revokeTeamAccess(owner, editorGrants[0]!.id, {
    version: editorGrants[0]!.version,
  });
  assert.equal(editorGrants.length, 1);
  assert.equal(editorGrants[0]?.permission, "viewer");
  assert.equal(
    (await getSnapshot(member)).tasks.find((item) => item.id === grantedTask.id)?.accessRole,
    "viewer",
  );
});

test("global Saved View Team route does not expand its underlying ACL intersection", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "Private view data", taskCode: "PVD" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Private view data")!;
  await createTask(owner, { title: "Private view task", projectId: project.id });
  const privateTask = (await getSnapshot(owner)).tasks.find((item) => item.projectId === project.id)!;
  const view = await createSavedView(owner, {
    name: "Team global view",
    query: {},
    display: {
      layout: "list",
      groupBy: "status",
      orderBy: "manual",
      direction: "asc",
      showEmptyGroups: false,
      visibleFields: ["priority", "project"],
    },
  });
  const team = await createTeam(owner, { name: "View readers" });
  await addTeamMember(owner, team.id, { email: member.email });
  await grantTeamAccess(owner, {
    teamRef: team.id,
    resourceType: "saved_view",
    resourceId: view.id,
    permission: "viewer",
  });
  const snapshot = await getSnapshot(member);
  assert.equal(snapshot.views.find((item) => item.id === view.id)?.accessRole, "viewer");
  assert.ok(!snapshot.tasks.some((item) => item.id === privateTask.id));
  await assert.rejects(
    updateSavedView(member, view.id, { version: view.version, name: "Denied" }),
    PermissionError,
  );
});

test("Team Editor survives atomic Project, Release, Task, View, and search guards", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(secondMemberActor);
  await createProject(owner, { name: "Team editor mutations", taskCode: "TEM" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Team editor mutations")!;
  const team = await createTeam(owner, { name: "Project editors" });
  await addTeamMember(owner, team.id, { email: member.email });
  await grantTeamAccess(owner, {
    teamRef: team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "editor",
  });

  const updatedProject = await updateProject(member, project.id, {
    version: project.version,
    summary: "Changed through Team Editor",
  });
  assert.equal(updatedProject.summary, "Changed through Team Editor");
  await createTask(member, { title: "Team searchable mutation", projectId: project.id });
  const task = (await getSnapshot(member)).tasks.find((item) => item.title === "Team searchable mutation")!;
  assert.equal(task.accessRole, "editor");
  const search = await searchWorkspace(member, { query: "Team searchable mutation" });
  assert.equal(search.groups.tasks[0]?.id, task.id);

  const release = await createRelease(member, {
    projectId: project.id,
    name: "Team-created release",
  });
  const updatedRelease = await updateRelease(member, release.id, {
    version: release.version,
    description: "Changed through Team Editor",
  });
  assert.equal(updatedRelease.description, "Changed through Team Editor");
  const scopedView = await createSavedView(member, {
    name: "Team-created project view",
    scopeProjectId: project.id,
    query: { projectId: project.id },
    display: {
      layout: "list",
      groupBy: "status",
      orderBy: "manual",
      direction: "asc",
      showEmptyGroups: false,
      visibleFields: ["priority", "project"],
    },
  });
  const updatedView = await updateSavedView(member, scopedView.id, {
    version: scopedView.version,
    name: "Team-edited project view",
  });
  assert.equal(updatedView.name, "Team-edited project view");
});
