import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NotFoundError, PermissionError } from "../lib/domain";
import {
  getAgentTaskDetail,
  getAgentWorkspace,
} from "../lib/agent-api-repository";
import {
  deleteEntity,
  PERMANENT_DELETE_CONFIRMATION,
  purgeEntity,
} from "../lib/deletion";
import {
  createProject,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  loadAccessibleProject,
  loadAccessibleTask,
  loadAccessibleView,
  searchWorkspace,
  updateProject,
  updateTask,
  updateSavedView,
} from "../lib/repository";
import {
  createTeamGrant,
  listTeamGrants,
  revokeTeamGrant,
  updateTeamGrant,
} from "../lib/team-grants";
import {
  addTeamMembership,
  createTeam,
  getTeam,
  setTeamMembershipStatus,
} from "../lib/teams";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;

before(async () => {
  const harness = await createD1TestHarness();
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => dispose?.());

const actor = (key: string) => ({
  provider: "chatgpt" as const,
  providerAccountKey: `${key}-account`,
  displayName: key,
  email: `${key.toLowerCase()}@example.test`,
});

async function projectFixture(prefix: string) {
  const owner = await getOrCreateUser(actor(`${prefix}Owner`));
  const member = await getOrCreateUser(actor(`${prefix}Member`));
  await createProject(owner, { name: `${prefix} Project`, taskCode: prefix.slice(0, 3).toUpperCase() });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === `${prefix} Project`)!;
  const firstIdentity = await createTask(owner, { title: `${prefix} First`, projectId: project.id });
  const siblingIdentity = await createTask(owner, { title: `${prefix} Sibling`, projectId: project.id });
  const first = await loadAccessibleTask(owner.id, firstIdentity.id);
  const sibling = await loadAccessibleTask(owner.id, siblingIdentity.id);
  const team = await createTeam(owner, { name: `${prefix} Team` });
  await addTeamMembership(owner, team.id, { email: member.email });
  return { owner, member, project, first, sibling, team };
}

test("a direct Team Task route exposes only that Project Task", async () => {
  const fixture = await projectFixture("TaskRoute");
  let catalog = await createTeamGrant(fixture.owner, {
    teamId: fixture.team.id,
    resourceType: "task",
    resourceId: fixture.first.id,
    permission: "viewer",
  });
  assert.equal(catalog.grants.length, 1);
  assert.equal(catalog.inheritedGrants.length, 0);
  assert.equal(catalog.grants[0]!.route, "direct");

  const visibleTask = await loadAccessibleTask(fixture.member.id, fixture.first.id);
  assert.equal(visibleTask.projectId, fixture.project.id);
  assert.equal(visibleTask.accessRole, "viewer");
  await assert.rejects(loadAccessibleProject(fixture.member.id, fixture.project.id), NotFoundError);
  await assert.rejects(loadAccessibleTask(fixture.member.id, fixture.sibling.id), NotFoundError);
  const memberSnapshot = await getSnapshot(fixture.member);
  assert.equal(memberSnapshot.tasks.some((task) => task.id === fixture.first.id), true);
  assert.equal(memberSnapshot.tasks.some((task) => task.id === fixture.sibling.id), false);
  assert.equal(memberSnapshot.projects.some((project) => project.id === fixture.project.id), false);
  assert.equal(memberSnapshot.users.some((user) => user.id === fixture.owner.id), true);
  const search = await searchWorkspace(fixture.member, { query: "TaskRoute First" });
  assert.equal(search.groups.tasks[0]?.id, fixture.first.id);
  const agentTask = await getAgentTaskDetail(fixture.member, fixture.first.publicId);
  assert.equal(agentTask.ref, fixture.first.publicId);
  const agentWorkspace = await getAgentWorkspace({
    authorizationId: "team-route-test",
    authorizationType: "personal_token",
    clientId: "team-route-test",
    scopes: ["api:read"],
    user: fixture.member,
    expiresAt: null,
    resource: null,
  });
  assert.equal(agentWorkspace.counts.tasks.total, 1);
  assert.equal(agentWorkspace.counts.projects, 0);
  await assert.rejects(
    updateTask(fixture.member, visibleTask.id, { version: visibleTask.version, title: "Denied" }),
    PermissionError,
  );

  const grant = catalog.grants[0]!;
  catalog = await updateTeamGrant(fixture.owner, grant.id, {
    version: grant.version,
    permission: "editor",
  });
  const editable = await loadAccessibleTask(fixture.member.id, fixture.first.id);
  assert.equal(editable.accessRole, "editor");
  await updateTask(fixture.member, editable.id, {
    version: editable.version,
    title: "Edited through Team",
  });
  assert.equal((await loadAccessibleTask(fixture.owner.id, editable.id)).title, "Edited through Team");

  await revokeTeamGrant(fixture.owner, catalog.grants[0]!.id, {
    version: catalog.grants[0]!.version,
  });
  await assert.rejects(loadAccessibleTask(fixture.member.id, fixture.first.id), NotFoundError);
});

test("Project Team routes inherit to Tasks and active membership controls the route", async () => {
  const fixture = await projectFixture("Inheritance");
  const catalog = await createTeamGrant(fixture.owner, {
    teamId: fixture.team.id,
    resourceType: "project",
    resourceId: fixture.project.id,
    permission: "viewer",
  });
  assert.equal((await loadAccessibleProject(fixture.member.id, fixture.project.id)).accessRole, "viewer");
  assert.equal((await loadAccessibleTask(fixture.member.id, fixture.sibling.id)).accessRole, "viewer");
  const updatedProject = await updateProject(fixture.owner, fixture.project.id, {
    version: fixture.project.version,
    leadUserId: fixture.member.id,
  });
  assert.equal(updatedProject.leadUserId, fixture.member.id);
  const taskRoutes = await listTeamGrants(fixture.owner, "task", fixture.first.id);
  assert.equal(taskRoutes.grants.length, 0);
  assert.equal(taskRoutes.inheritedGrants[0]?.id, catalog.grants[0]?.id);

  let team = await getTeam(fixture.owner, fixture.team.id);
  let membership = team.members.find((entry) => entry.userId === fixture.member.id)!;
  team = await setTeamMembershipStatus(fixture.owner, team.id, membership.id, {
    version: membership.version,
    status: "inactive",
  });
  await assert.rejects(loadAccessibleProject(fixture.member.id, fixture.project.id), NotFoundError);
  membership = team.members.find((entry) => entry.id === membership.id)!;
  await setTeamMembershipStatus(fixture.owner, team.id, membership.id, {
    version: membership.version,
    status: "active",
  });
  assert.equal((await loadAccessibleProject(fixture.member.id, fixture.project.id)).accessRole, "viewer");
  await updateTeamGrant(fixture.owner, catalog.grants[0]!.id, {
    version: catalog.grants[0]!.version,
    permission: "editor",
  });
  const created = await createTask(fixture.member, {
    title: "Created through Project Team route",
    projectId: fixture.project.id,
  });
  assert.equal((await loadAccessibleTask(fixture.member.id, created.id)).accessRole, "editor");
});

test("strongest effective role wins and revoking Team access preserves direct access", async () => {
  const fixture = await projectFixture("Strongest");
  await grantAccess(fixture.owner, {
    resourceType: "project",
    resourceId: fixture.project.id,
    email: fixture.member.email,
    permission: "editor",
  });
  let catalog = await createTeamGrant(fixture.owner, {
    teamId: fixture.team.id,
    resourceType: "project",
    resourceId: fixture.project.id,
    permission: "viewer",
  });
  assert.equal((await loadAccessibleProject(fixture.member.id, fixture.project.id)).accessRole, "editor");
  catalog = await revokeTeamGrant(fixture.owner, catalog.grants[0]!.id, {
    version: catalog.grants[0]!.version,
  });
  assert.equal(catalog.grants.length, 0);
  assert.equal((await loadAccessibleProject(fixture.member.id, fixture.project.id)).accessRole, "editor");
});

test("multiple Team routes combine by strongest role and revoke independently", async () => {
  const fixture = await projectFixture("MultiTeam");
  const secondTeam = await createTeam(fixture.owner, { name: "MultiTeam Editors" });
  await addTeamMembership(fixture.owner, secondTeam.id, { email: fixture.member.email });
  let viewerCatalog = await createTeamGrant(fixture.owner, {
    teamId: fixture.team.id,
    resourceType: "project",
    resourceId: fixture.project.id,
    permission: "viewer",
  });
  let editorCatalog = await createTeamGrant(fixture.owner, {
    teamId: secondTeam.id,
    resourceType: "project",
    resourceId: fixture.project.id,
    permission: "editor",
  });
  assert.equal((await loadAccessibleProject(fixture.member.id, fixture.project.id)).accessRole, "editor");
  editorCatalog = await revokeTeamGrant(fixture.owner, editorCatalog.grants.find((grant) => grant.teamId === secondTeam.id)!.id, {
    version: editorCatalog.grants.find((grant) => grant.teamId === secondTeam.id)!.version,
  });
  assert.equal(editorCatalog.grants.length, 1);
  assert.equal((await loadAccessibleProject(fixture.member.id, fixture.project.id)).accessRole, "viewer");
  viewerCatalog = await revokeTeamGrant(fixture.owner, viewerCatalog.grants[0]!.id, {
    version: viewerCatalog.grants[0]!.version,
  });
  assert.equal(viewerCatalog.grants.length, 0);
  await assert.rejects(loadAccessibleProject(fixture.member.id, fixture.project.id), NotFoundError);
});

test("global Saved Views support Team routes without broadening their data intersection", async () => {
  const owner = await getOrCreateUser(actor("ViewRouteOwner"));
  const member = await getOrCreateUser(actor("ViewRouteMember"));
  const outsider = await getOrCreateUser(actor("ViewRouteOutsider"));
  const view = await createSavedView(owner, {
    name: "Team View",
    query: { version: 1, op: "all", conditions: [] },
    display: {
      layout: "list",
      groupBy: "status",
      orderBy: "updated",
      direction: "desc",
      showEmptyGroups: false,
      visibleFields: ["priority"],
    },
  });
  const team = await createTeam(owner, { name: "View Team" });
  await addTeamMembership(owner, team.id, { email: member.email });
  const catalog = await createTeamGrant(owner, {
    teamId: team.id,
    resourceType: "saved_view",
    resourceId: view.id,
    permission: "viewer",
  });
  assert.equal((await loadAccessibleView(member.id, view.id)).accessRole, "viewer");
  await assert.rejects(
    updateSavedView(member, view.id, { version: view.version, name: "Denied" }),
    PermissionError,
  );
  await assert.rejects(listTeamGrants(outsider, "saved_view", view.id), NotFoundError);
  await assert.rejects(
    createTeamGrant(member, {
      teamId: team.id,
      resourceType: "saved_view",
      resourceId: view.id,
      permission: "editor",
    }),
    PermissionError,
  );
  await updateTeamGrant(owner, catalog.grants[0]!.id, {
    version: catalog.grants[0]!.version,
    permission: "editor",
  });
  const editable = await loadAccessibleView(member.id, view.id);
  await updateSavedView(member, view.id, { version: editable.version, name: "Edited Team View" });
  assert.equal((await loadAccessibleView(owner.id, view.id)).name, "Edited Team View");
});

test("permanent resource deletion removes only its polymorphic Team route", async () => {
  const fixture = await projectFixture("TeamPurge");
  await createTeamGrant(fixture.owner, {
    teamId: fixture.team.id,
    resourceType: "task",
    resourceId: fixture.first.id,
    permission: "viewer",
  });
  const deleted = await deleteEntity(
    fixture.owner,
    "task",
    fixture.first.id,
    fixture.first.version,
  );
  await purgeEntity(
    fixture.owner,
    "task",
    fixture.first.id,
    deleted.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  const counts = await database.batch<{ count: number }>([
    database.prepare(
      "SELECT COUNT(*) AS count FROM team_grants WHERE resource_type = 'task' AND resource_id = ?",
    ).bind(fixture.first.id),
    database.prepare("SELECT COUNT(*) AS count FROM teams WHERE id = ?").bind(fixture.team.id),
    database.prepare("SELECT COUNT(*) AS count FROM team_memberships WHERE team_id = ?").bind(fixture.team.id),
  ]);
  assert.deepEqual(counts.map((result) => Number(result.results[0]?.count)), [0, 1, 2]);
});
