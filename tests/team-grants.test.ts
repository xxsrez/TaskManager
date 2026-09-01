import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NotFoundError, PermissionError, ValidationError } from "../lib/domain";
import {
  createProject,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  updateTask,
} from "../lib/repository";
import {
  grantTeamAccess,
  listTeamGrants,
  revokeTeamAccess,
  updateTeamAccess,
} from "../lib/team-grants";
import { addTeamMember, createTeam, setTeamMemberStatus } from "../lib/teams";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
});

after(async () => {
  await dispose?.();
});

const actor = (name: string) => ({
  provider: "chatgpt" as const,
  providerAccountKey: `${name}-grant-account`,
  displayName: name,
  email: `${name.toLocaleLowerCase()}-grant@example.test`,
});

test("Team Project grants inherit, choose the strongest route, and revoke independently", async () => {
  const owner = await getOrCreateUser(actor("ProjectOwner"));
  const member = await getOrCreateUser(actor("ProjectMember"));
  await createProject(owner, { name: "Team Project", taskCode: "TP" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Team Project")!;
  await createTask(owner, { title: "Inherited task", projectId: project.id });
  const task = (await getSnapshot(owner)).tasks.find((item) => item.projectId === project.id)!;
  const team = await createTeam(owner, { name: "Project Readers" });
  const managers = await createTeam(owner, { name: "Project Managers" });
  await addTeamMember(owner, team.id, { email: member.email });
  await addTeamMember(owner, managers.id, { email: member.email });

  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  });
  let memberSnapshot = await getSnapshot(member);
  assert.equal(memberSnapshot.projects.find((item) => item.id === project.id)?.accessRole, "viewer");
  assert.equal(memberSnapshot.tasks.find((item) => item.id === task.id)?.accessRole, "viewer");
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
  memberSnapshot = await getSnapshot(member);
  const editable = memberSnapshot.tasks.find((item) => item.id === task.id)!;
  assert.equal(editable.accessRole, "editor");
  await updateTask(member, editable.id, { version: editable.version, title: "Edited" });

  await grantTeamAccess(owner, {
    teamId: managers.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "manager",
  });
  memberSnapshot = await getSnapshot(member);
  assert.equal(memberSnapshot.projects.find((item) => item.id === project.id)?.accessRole, "manager");

  let grants = (await listTeamGrants(owner, "project", project.id)).teamGrants;
  const managerGrant = grants.find((item) => item.teamId === managers.id)!;
  await revokeTeamAccess(owner, managerGrant.id, { version: managerGrant.version });
  grants = (await listTeamGrants(owner, "project", project.id)).teamGrants;
  const viewerGrant = grants.find((item) => item.teamId === team.id)!;
  await revokeTeamAccess(owner, viewerGrant.id, { version: viewerGrant.version });
  memberSnapshot = await getSnapshot(member);
  assert.equal(memberSnapshot.projects.find((item) => item.id === project.id)?.accessRole, "editor");
});

test("a direct Team Task grant opens only the addressed Project Task", async () => {
  const owner = await getOrCreateUser(actor("TaskOwner"));
  const member = await getOrCreateUser(actor("TaskMember"));
  const outsider = await getOrCreateUser(actor("TaskOutsider"));
  await createProject(owner, { name: "Task-only route", taskCode: "TR" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Task-only route")!;
  await createTask(owner, { title: "Granted task", projectId: project.id });
  await createTask(owner, { title: "Sibling task", projectId: project.id });
  const ownerSnapshot = await getSnapshot(owner);
  const granted = ownerSnapshot.tasks.find((item) => item.title === "Granted task")!;
  const sibling = ownerSnapshot.tasks.find((item) => item.title === "Sibling task")!;
  const team = await createTeam(owner, { name: "Task Editors" });
  let catalog = await addTeamMember(owner, team.id, { email: member.email });
  const memberMembership = catalog.members.find((item) => item.userId === member.id)!;

  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "task",
    resourceId: granted.id,
    permission: "editor",
  });
  let snapshot = await getSnapshot(member);
  const directTask = snapshot.tasks.find((item) => item.id === granted.id)!;
  assert.equal(directTask.projectId, project.id);
  assert.equal(directTask.accessRole, "editor");
  assert.equal(snapshot.statuses.some((item) => item.id === directTask.statusId), true);
  assert.equal(snapshot.tasks.some((item) => item.id === sibling.id), false);
  assert.equal(snapshot.projects.some((item) => item.id === project.id), false);
  assert.equal((await getSnapshot(outsider)).tasks.some((item) => item.id === granted.id), false);
  await updateTask(member, directTask.id, { version: directTask.version, title: "Team edited" });

  catalog = await setTeamMemberStatus(owner, team.id, memberMembership.id, {
    version: memberMembership.version,
    status: "inactive",
  });
  assert.equal(catalog.members.find((item) => item.id === memberMembership.id)?.status, "inactive");
  snapshot = await getSnapshot(member);
  assert.equal(snapshot.tasks.some((item) => item.id === granted.id), false);
  await assert.rejects(listTeamGrants(member, "task", granted.id), NotFoundError);
});

test("Team grant roles are versioned and respect resource role ceilings", async () => {
  const owner = await getOrCreateUser(actor("RoleOwner"));
  await createProject(owner, { name: "Role matrix", taskCode: "RM" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Role matrix")!;
  await createTask(owner, { title: "Role task", projectId: project.id });
  const task = (await getSnapshot(owner)).tasks.find((item) => item.projectId === project.id)!;
  const team = await createTeam(owner, { name: "Role Team" });

  await assert.rejects(
    grantTeamAccess(owner, {
      teamId: team.id,
      resourceType: "task",
      resourceId: task.id,
      permission: "manager",
    }),
    PermissionError,
  );
  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  });
  let [grant] = (await listTeamGrants(owner, "project", project.id)).teamGrants;
  await updateTeamAccess(owner, grant!.id, {
    version: grant!.version,
    permission: "manager",
  });
  [grant] = (await listTeamGrants(owner, "project", project.id)).teamGrants;
  assert.equal(grant!.permission, "manager");
  assert.equal(grant!.version, 2);
});

test("global Saved Views support Team grants while Project-scoped views inherit only", async () => {
  const owner = await getOrCreateUser(actor("ViewOwner"));
  const member = await getOrCreateUser(actor("ViewMember"));
  await createProject(owner, { name: "View scope", taskCode: "VS" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "View scope")!;
  const globalView = await createSavedView(owner, { name: "Global Team View", query: {} });
  const scopedView = await createSavedView(owner, {
    name: "Inherited Team View",
    scopeProjectId: project.id,
    query: { projectId: project.id },
  });
  const team = await createTeam(owner, { name: "View Readers" });
  await addTeamMember(owner, team.id, { email: member.email });

  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "saved_view",
    resourceId: globalView.id,
    permission: "viewer",
  });
  let snapshot = await getSnapshot(member);
  assert.equal(snapshot.views.find((item) => item.id === globalView.id)?.accessRole, "viewer");
  assert.equal(snapshot.views.some((item) => item.id === scopedView.id), false);

  await assert.rejects(
    grantTeamAccess(owner, {
      teamId: team.id,
      resourceType: "saved_view",
      resourceId: scopedView.id,
      permission: "viewer",
    }),
    ValidationError,
  );

  const [grant] = (await listTeamGrants(owner, "saved_view", globalView.id)).teamGrants;
  await revokeTeamAccess(owner, grant!.id, { version: grant!.version });
  snapshot = await getSnapshot(member);
  assert.equal(snapshot.views.some((item) => item.id === globalView.id), false);
});
