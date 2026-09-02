import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import {
  DELETE as deleteTeamGrantRoute,
  GET as getTeamGrantsRoute,
  PATCH as patchTeamGrantRoute,
  POST as postTeamGrantRoute,
} from "../app/api/shares/teams/route";
import { configureActorResolverForTests, type Actor } from "../lib/auth";
import {
  listAgentLabelGroups,
  listAgentLabels,
  updateAgentTask,
} from "../lib/agent-api-repository";
import { createComment } from "../lib/comments";
import {
  deleteEntity,
  PERMANENT_DELETE_CONFIRMATION,
  purgeEntity,
} from "../lib/deletion";
import { NotFoundError, PermissionError } from "../lib/domain";
import {
  addTeamMember,
  createTeam,
  deleteTeamMembership,
  getTeamDetail,
  listTeamMembers,
  updateTeamMembership,
} from "../lib/teams";
import {
  createProject,
  createLabel,
  createLabelGroup,
  createRelease,
  createSavedView,
  createSubtask,
  createTask,
  bulkMoveTasks,
  bulkUpdateTasks,
  getOrCreateUser,
  getSnapshot,
  getTask,
  grantAccess,
  moveTask,
  queryTaskSummaries,
  revokeAccess,
  setTaskLabel,
  updateProject,
  updateLabel,
  updateLabelGroup,
  updateSavedView,
  updateTask,
} from "../lib/repository";
import {
  createTeamGrant,
  revokeTeamGrant,
  updateTeamGrant,
} from "../lib/team-grants";
import { createTaskRelation } from "../lib/task-relations";
import { getWorkspaceSync } from "../lib/workspace-sync";
import {
  decodeWorkspaceSyncCursorState,
  decodeWorkspaceSyncCursor,
  encodeVersionTwoWorkspaceSyncCursor,
  encodeWorkspaceSyncCursor,
  encodeLegacyWorkspaceSyncCursor,
  teamAccessFingerprintSql,
  WORKSPACE_SYNC_CURSOR_GENERATION_MS,
} from "../lib/workspace-sync-cursor";
import {
  archiveWorkflowStatus,
  createWorkflowStatus,
  moveWorkflowStatus,
  updateWorkflowStatus,
} from "../lib/workflow-statuses";
import { opaqueWorkspaceOwnerToken } from "../lib/workspace-scope";
import type {
  TeamDetail,
  TeamGrantList,
  UserRecord,
} from "../lib/types";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = actor("owner", "Team Grant Owner");
const memberActor = actor("member", "Team Grant Member");
const isolatedActor = actor("isolated", "Explicit Task Member");
const outsiderActor = actor("outsider", "Team Grant Outsider");

let harness: Awaited<ReturnType<typeof createD1TestHarness>> | null = null;

afterEach(async () => {
  configureActorResolverForTests(null);
  await harness?.dispose();
  harness = null;
});

test("Project managers can grant the Project but not an explicit Task-only Team route", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(actor("manager-ceiling-owner", "Manager Ceiling Owner"));
  const manager = await getOrCreateUser(actor("manager-ceiling-manager", "Manager Ceiling Manager"));
  await createProject(owner, { name: "Manager ceiling Project", taskCode: "MCP" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Manager ceiling Project",
  )!;
  const task = await createTask(owner, {
    title: "Manager ceiling Task",
    projectId: project.id,
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: manager.email,
    permission: "manager",
  });
  let team = await createTeam(owner, { name: "Manager selectable Team" });
  team = await addTeamMember(owner, team.team.id, {
    email: manager.email,
    teamVersion: team.team.version,
  });

  const projectRoute = await createTeamGrant(manager, {
    teamId: team.team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "editor",
  });
  assert.ok(projectRoute.grants.some((grant) => grant.resourceType === "project"));
  await assert.rejects(
    createTeamGrant(manager, {
      teamId: team.team.id,
      resourceType: "task",
      resourceId: task.id,
      permission: "editor",
    }),
    PermissionError,
  );
});

test("assignment cleanup keeps surviving routes and clears the final Team route", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(actor("cleanup-owner", "Cleanup Owner"));
  const member = await getOrCreateUser(actor("cleanup-member", "Cleanup Member"));
  await createProject(owner, { name: "Cleanup Project", taskCode: "CLN" });
  let project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Cleanup Project",
  )!;
  await createTask(owner, { title: "Cleanup Task", projectId: project.id });
  let task = (await getSnapshot(owner)).tasks.find((item) => item.title === "Cleanup Task")!;
  const team = await teamWithMember(owner, member);
  const teamRoutes = await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "editor",
  });
  const teamGrant = teamRoutes.grants.find(
    (grant) => grant.teamId === team.team.id && grant.resourceType === "project",
  )!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: member.email,
    permission: "editor",
  });
  project = await updateProject(owner, project.id, {
    version: project.version,
    leadUserId: member.id,
  });
  task = await updateTask(owner, task.id, {
    version: task.version,
    assigneeUserId: member.id,
  });
  const directGrant = (await getSnapshot(owner)).collaborators.find(
    (grant) => grant.resourceType === "project" && grant.resourceId === project.id
      && grant.userId === member.id,
  )!;

  await revokeAccess(owner, directGrant.grantId);
  let ownerSnapshot = await getSnapshot(owner);
  assert.equal(ownerSnapshot.projects.find((item) => item.id === project.id)?.leadUserId, member.id);
  assert.equal(ownerSnapshot.tasks.find((item) => item.id === task.id)?.assigneeUserId, member.id);

  await revokeTeamGrant(owner, {
    grantId: teamGrant.id,
    version: teamGrant.version,
  });
  ownerSnapshot = await getSnapshot(owner);
  assert.equal(ownerSnapshot.projects.find((item) => item.id === project.id)?.leadUserId, null);
  assert.equal(ownerSnapshot.tasks.find((item) => item.id === task.id)?.assigneeUserId, null);
});

test("deactivating a Team member clears assignments only after their last route disappears", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(actor("membership-cleanup-owner", "Membership Cleanup Owner"));
  const member = await getOrCreateUser(actor("membership-cleanup-member", "Membership Cleanup Member"));
  await createProject(owner, { name: "Membership cleanup Project", taskCode: "MCL" });
  let project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Membership cleanup Project",
  )!;
  await createTask(owner, { title: "Membership cleanup Task", projectId: project.id });
  let task = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Membership cleanup Task",
  )!;
  let team = await teamWithMember(owner, member);
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "editor",
  });
  project = await updateProject(owner, project.id, {
    version: project.version,
    leadUserId: member.id,
  });
  task = await updateTask(owner, task.id, {
    version: task.version,
    assigneeUserId: member.id,
  });
  const membership = team.members.find((item) => item.userId === member.id)!;
  team = await updateTeamMembership(owner, team.team.id, membership.id, {
    action: "deactivate",
    teamVersion: team.team.version,
    version: membership.version,
  });
  assert.ok(team.members.find((item) => item.userId === member.id)?.deactivatedAt);
  const ownerSnapshot = await getSnapshot(owner);
  assert.equal(ownerSnapshot.projects.find((item) => item.id === project.id)?.leadUserId, null);
  assert.equal(ownerSnapshot.tasks.find((item) => item.id === task.id)?.assigneeUserId, null);
});

test("Task-only Team projections mask Project hierarchy metadata on reads and bulk mutations", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(actor("task-mask-owner", "Task Mask Owner"));
  const member = await getOrCreateUser(actor("task-mask-member", "Task Mask Member"));
  await createProject(owner, { name: "Task Mask Project", taskCode: "TMP" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Task Mask Project",
  )!;
  const release = await createRelease(owner, {
    name: "Task Mask Release",
    projectId: project.id,
  });
  const parentIdentity = await createTask(owner, {
    title: "Hidden mask parent",
    projectId: project.id,
  });
  const parent = await getTask(owner, parentIdentity.id);
  const child = await createSubtask(owner, parent.id, {
    version: parent.version,
    title: "Visible mask child",
    releaseId: release.id,
  });
  const team = await teamWithMember(owner, member);
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "task",
    resourceId: child.id,
    permission: "editor",
  });

  const initial = await getTask(member, child.id);
  assert.equal(initial.projectId, "");
  assert.equal(initial.releaseId, null);
  assert.equal(initial.parentTaskId, null);
  const [changed] = await bulkUpdateTasks(member, {
    ids: [initial.id],
    field: "priority",
    value: "high",
    versions: { [initial.id]: initial.version },
  });
  assert.equal(changed?.projectId, "");
  assert.equal(changed?.releaseId, null);
  assert.equal(changed?.parentTaskId, null);
});

test("ordinary Team members see active rows and no peer email addresses", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(actor("directory-owner", "Directory Owner"));
  const member = await getOrCreateUser(actor("directory-member", "Directory Member"));
  const inactive = await getOrCreateUser(actor("directory-inactive", "Directory Inactive"));
  let team = await createTeam(owner, { name: "Private directory Team" });
  team = await addTeamMember(owner, team.team.id, {
    email: member.email,
    teamVersion: team.team.version,
  });
  team = await addTeamMember(owner, team.team.id, {
    email: inactive.email,
    teamVersion: team.team.version,
  });
  const inactiveMembership = team.members.find((item) => item.userId === inactive.id)!;
  team = await updateTeamMembership(owner, team.team.id, inactiveMembership.id, {
    action: "deactivate",
    teamVersion: team.team.version,
    version: inactiveMembership.version,
  });

  const ownerRead = await getTeamDetail(owner, team.team.id);
  assert.equal(ownerRead.members.find((item) => item.userId === inactive.id)?.email, inactive.email);
  const memberRead = await getTeamDetail(member, team.team.id);
  assert.deepEqual(
    memberRead.members.map((item) => item.userId).sort(),
    [owner.id, member.id].sort(),
  );
  assert.equal(memberRead.members.find((item) => item.userId === member.id)?.email, member.email);
  assert.equal(memberRead.members.find((item) => item.userId === owner.id)?.email, null);
  assert.deepEqual((await listTeamMembers(member, team.team.id)).members, memberRead.members);
});

test("Agent catalogs scope task-only Team access to labels used by visible Tasks", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(actor("catalog-owner", "Catalog Owner"));
  const taskMember = await getOrCreateUser(actor("catalog-task-member", "Catalog Task Member"));
  const projectMember = await getOrCreateUser(actor("catalog-project-member", "Catalog Project Member"));

  await createProject(owner, { name: "Catalog scope project", taskCode: "CSP" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Catalog scope project",
  )!;
  let groups = await createLabelGroup(owner, { name: "Visible task group" });
  groups = await createLabelGroup(owner, { name: "Hidden sibling group" });
  const visibleGroup = groups.find((group) => group.name === "Visible task group")!;
  const hiddenGroup = groups.find((group) => group.name === "Hidden sibling group")!;
  let labels = await createLabel(owner, {
    name: "Visible task label",
    groupId: visibleGroup.id,
  });
  labels = await createLabel(owner, {
    name: "Hidden same-group label",
    groupId: visibleGroup.id,
  });
  labels = await createLabel(owner, {
    name: "Hidden sibling label",
    groupId: hiddenGroup.id,
  });
  const visibleLabel = labels.find((label) => label.name === "Visible task label")!;
  const hiddenSameGroupLabel = labels.find(
    (label) => label.name === "Hidden same-group label",
  )!;
  const hiddenLabel = labels.find((label) => label.name === "Hidden sibling label")!;
  const visibleTask = await createTask(owner, {
    title: "Visible Team Task",
    projectId: project.id,
    labelIds: [visibleLabel.id],
  });
  await createTask(owner, {
    title: "Hidden sibling Task",
    projectId: project.id,
    labelIds: [hiddenSameGroupLabel.id, hiddenLabel.id],
  });

  const taskTeam = await teamWithMember(owner, taskMember);
  await createTeamGrant(owner, {
    teamId: taskTeam.team.id,
    resourceType: "task",
    resourceId: visibleTask.id,
    permission: "viewer",
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: projectMember.email,
    permission: "viewer",
  });

  assert.deepEqual(
    (await listAgentLabels(taskMember)).items.map((label) => label.name),
    ["Visible task label"],
  );
  assert.deepEqual(
    (await listAgentLabelGroups(taskMember)).items.map((group) => ({
      name: group.name,
      labelCount: group.labelCount,
      taskCount: group.taskCount,
    })),
    [{ name: "Visible task group", labelCount: 1, taskCount: 1 }],
  );

  for (const catalogReader of [owner, projectMember]) {
    assert.deepEqual(
      (await listAgentLabels(catalogReader)).items.map((label) => label.name).sort(),
      ["Hidden same-group label", "Hidden sibling label", "Visible task label"],
    );
    assert.deepEqual(
      (await listAgentLabelGroups(catalogReader)).items.map((group) => group.name).sort(),
      ["Hidden sibling group", "Visible task group"],
    );
  }
});

test("strongest Team route, Project inheritance, explicit Task isolation, lifecycle, and global View intersection", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  const isolated = await getOrCreateUser(isolatedActor);
  const outsider = await getOrCreateUser(outsiderActor);

  await createProject(owner, { name: "Team ACL Project", taskCode: "TAP" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Team ACL Project",
  )!;
  await createRelease(owner, { name: "Team ACL Release", projectId: project.id });
  await createTask(owner, { title: "Explicit Team Task", projectId: project.id });
  await createTask(owner, { title: "Sibling Team Task", projectId: project.id });
  const ownerSnapshot = await getSnapshot(owner);
  const explicitTask = ownerSnapshot.tasks.find(
    (item) => item.title === "Explicit Team Task",
  )!;
  const siblingTask = ownerSnapshot.tasks.find(
    (item) => item.title === "Sibling Team Task",
  )!;
  const globalView = await createSavedView(owner, {
    name: "Team global view",
    query: {},
  });

  const viewerTeam = await teamWithMember(owner, member);
  const editorTeam = await teamWithMember(owner, member);
  let explicitTeam = await teamWithMember(owner, isolated);
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: member.email,
    permission: "viewer",
  });
  await createTeamGrant(owner, {
    teamId: viewerTeam.team.id,
    resourceType: "project",
    resourceId: project.publicId,
    permission: "viewer",
  });
  const editorList = await createTeamGrant(owner, {
    teamId: editorTeam.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "manager",
  });
  const editorGrant = editorList.grants.find(
    (grant) => grant.teamId === editorTeam.team.id,
  )!;

  let memberSnapshot = await getSnapshot(member);
  assert.equal(
    memberSnapshot.projects.find((item) => item.id === project.id)?.accessRole,
    "manager",
  );
  assert.equal(
    memberSnapshot.tasks.find((item) => item.id === siblingTask.id)?.accessRole,
    "manager",
  );
  assert.equal(
    memberSnapshot.releases.find((item) => item.projectId === project.id)?.accessRole,
    "manager",
  );

  await revokeTeamGrant(owner, {
    grantId: editorGrant.id,
    version: editorGrant.version,
  });
  memberSnapshot = await getSnapshot(member);
  assert.equal(
    memberSnapshot.projects.find((item) => item.id === project.id)?.accessRole,
    "viewer",
  );
  assert.equal(
    memberSnapshot.tasks.find((item) => item.id === siblingTask.id)?.accessRole,
    "viewer",
  );
  await assert.rejects(
    updateTask(member, siblingTask.id, {
      version: memberSnapshot.tasks.find((item) => item.id === siblingTask.id)!.version,
      title: "Viewer cannot mutate",
    }),
    PermissionError,
  );
  await assert.rejects(
    updateAgentTask(member, siblingTask.publicId, {
      version: memberSnapshot.tasks.find((item) => item.id === siblingTask.id)!.version,
      title: "Agent viewer cannot mutate",
    }),
    PermissionError,
  );

  await createTeamGrant(owner, {
    teamId: explicitTeam.team.id,
    resourceType: "task",
    resourceId: explicitTask.publicId,
    permission: "editor",
  });
  await createTeamGrant(owner, {
    teamId: explicitTeam.team.id,
    resourceType: "saved_view",
    resourceId: globalView.publicId,
    permission: "viewer",
  });
  let isolatedSnapshot = await getSnapshot(isolated);
  assert.equal(
    isolatedSnapshot.tasks.find((item) => item.id === explicitTask.id)?.accessRole,
    "editor",
  );
  assert.ok(!isolatedSnapshot.tasks.some((item) => item.id === siblingTask.id));
  assert.ok(!isolatedSnapshot.projects.some((item) => item.id === project.id));
  assert.ok(!isolatedSnapshot.releases.some((item) => item.projectId === project.id));
  assert.ok(isolatedSnapshot.views.some((item) => item.id === globalView.id));
  const isolatedTask = isolatedSnapshot.tasks.find((item) => item.id === explicitTask.id)!;
  await updateAgentTask(isolated, explicitTask.publicId, {
    version: isolatedTask.version,
    title: "Explicit Team Task via Agent",
  });
  assert.equal((await getTask(owner, explicitTask.id)).title, "Explicit Team Task via Agent");
  const intersected = await queryTaskSummaries(isolated, {
    surface: `view:${globalView.id}`,
    query: {},
    limit: 20,
  });
  assert.deepEqual(intersected.taskIds, [explicitTask.id]);
  await createTeamGrant(owner, {
    teamId: explicitTeam.team.id,
    resourceType: "task",
    resourceId: siblingTask.id,
    permission: "editor",
  });
  const relation = await createTaskRelation(isolated, explicitTask.id, {
    targetTaskId: siblingTask.id,
    type: "related",
    direction: "outgoing",
    idempotencyKey: "team-grant-relation-guard",
  });
  assert.equal(relation.type, "related");

  const activeCursor = isolatedSnapshot.syncCursor!;
  const firstReset = await getWorkspaceSync(isolated, activeCursor);
  assert.equal(firstReset.resetRequired, true);
  const convergedPoll = await getWorkspaceSync(isolated, firstReset.cursor);
  assert.equal(convergedPoll.resetRequired, false);
  assert.equal(convergedPoll.cursor, firstReset.cursor);
  const isolatedMembership = explicitTeam.members.find(
    (membership) => membership.userId === isolated.id,
  )!;
  explicitTeam = await updateTeamMembership(
    owner,
    explicitTeam.team.id,
    isolatedMembership.id,
    {
      action: "deactivate",
      teamVersion: explicitTeam.team.version,
      version: isolatedMembership.version,
    },
  );
  isolatedSnapshot = await getSnapshot(isolated);
  assert.ok(!isolatedSnapshot.tasks.some((item) => item.id === explicitTask.id));
  assert.ok(!isolatedSnapshot.views.some((item) => item.id === globalView.id));
  const deactivatedReset = await getWorkspaceSync(isolated, convergedPoll.cursor);
  assert.equal(deactivatedReset.resetRequired, true);
  assert.equal(
    (await getWorkspaceSync(isolated, deactivatedReset.cursor)).resetRequired,
    false,
  );

  const inactiveMembership = explicitTeam.members.find(
    (membership) => membership.id === isolatedMembership.id,
  )!;
  explicitTeam = await updateTeamMembership(
    owner,
    explicitTeam.team.id,
    inactiveMembership.id,
    {
      action: "reactivate",
      teamVersion: explicitTeam.team.version,
      version: inactiveMembership.version,
    },
  );
  const reactivatedReset = await getWorkspaceSync(isolated, deactivatedReset.cursor);
  assert.equal(reactivatedReset.resetRequired, true);
  assert.equal(
    (await getWorkspaceSync(isolated, reactivatedReset.cursor)).resetRequired,
    false,
  );
  await harness.database.prepare(
    "UPDATE teams SET archived_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(explicitTeam.team.id).run();
  isolatedSnapshot = await getSnapshot(isolated);
  assert.ok(!isolatedSnapshot.tasks.some((item) => item.id === explicitTask.id));
  await harness.database.prepare(
    "UPDATE teams SET archived_at = NULL WHERE id = ?",
  ).bind(explicitTeam.team.id).run();
  const activeMembership = explicitTeam.members.find(
    (membership) => membership.id === isolatedMembership.id,
  )!;
  await deleteTeamMembership(
    owner,
    explicitTeam.team.id,
    activeMembership.id,
    {
      teamVersion: explicitTeam.team.version,
      version: activeMembership.version,
    },
  );
  const deletedReset = await getWorkspaceSync(isolated, reactivatedReset.cursor);
  assert.equal(deletedReset.resetRequired, true);
  assert.equal((await getWorkspaceSync(isolated, deletedReset.cursor)).resetRequired, false);
  assert.ok(!(await getSnapshot(isolated)).tasks.some(
    (item) => item.id === explicitTask.id,
  ));

  await assert.rejects(getTask(outsider, explicitTask.id), NotFoundError);
});

test("Team grant API returns authoritative versioned read-back and leaks no raw target or grant lookup", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await getOrCreateUser(outsiderActor);
  await createProject(owner, { name: "Team Grant API", taskCode: "TGA" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Team Grant API",
  )!;
  const projectView = await createSavedView(owner, {
    name: "Inherited Project View",
    scopeProjectId: project.id,
    query: {},
  });
  const firstTeam = await teamWithMember(owner, member);
  const secondTeam = await teamWithMember(owner, member);
  configureActorResolverForTests(async () => ownerActor);

  let response = await postTeamGrantRoute(jsonRequest("POST", {
    teamId: firstTeam.team.publicId,
    resourceType: "project",
    resourceId: project.publicId,
    permission: "viewer",
  }));
  assert.equal(response.status, 200);
  assertPrivateNoStore(response);
  let list = await json<TeamGrantList>(response);
  assert.equal(list.target.resourceId, project.id);
  assert.equal(list.grants.length, 1);
  assert.equal(list.grants[0]!.version, 1);

  response = await postTeamGrantRoute(jsonRequest("POST", {
    teamId: secondTeam.team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "editor",
  }));
  list = await json<TeamGrantList>(response);
  assert.equal(list.grants.length, 2);
  let secondGrant = list.grants.find((grant) => grant.teamId === secondTeam.team.id)!;

  response = await deleteTeamGrantRoute(jsonRequest("DELETE", {
    grantId: secondGrant.id,
    version: secondGrant.version,
  }));
  list = await json<TeamGrantList>(response);
  assert.equal(list.grants.length, 2);
  assert.equal(
    list.grants.find((grant) => grant.teamId === firstTeam.team.id)?.revokedAt,
    null,
  );
  secondGrant = list.grants.find((grant) => grant.id === secondGrant.id)!;
  assert.ok(secondGrant.revokedAt);
  assert.equal(secondGrant.version, 2);
  assert.equal(
    (await getSnapshot(member)).projects.find((item) => item.id === project.id)?.accessRole,
    "viewer",
  );

  response = await patchTeamGrantRoute(jsonRequest("PATCH", {
    grantId: secondGrant.id,
    version: secondGrant.version,
    action: "reactivate",
    permission: "editor",
  }));
  list = await json<TeamGrantList>(response);
  secondGrant = list.grants.find((grant) => grant.id === secondGrant.id)!;
  assert.equal(secondGrant.revokedAt, null);
  assert.equal(secondGrant.version, 3);
  assert.equal(
    (await getSnapshot(member)).projects.find((item) => item.id === project.id)?.accessRole,
    "editor",
  );

  response = await patchTeamGrantRoute(jsonRequest("PATCH", {
    grantId: secondGrant.id,
    version: secondGrant.version,
    action: "role",
    permission: "viewer",
  }));
  list = await json<TeamGrantList>(response);
  secondGrant = list.grants.find((grant) => grant.id === secondGrant.id)!;
  assert.equal(secondGrant.version, 4);
  assert.equal(secondGrant.permission, "viewer");
  assert.equal((await deleteTeamGrantRoute(jsonRequest("DELETE", {
    grantId: secondGrant.id,
    version: 3,
  }))).status, 409);

  response = await getTeamGrantsRoute(new Request(
    `https://example.test/api/shares/teams?resource_type=project&resource_id=${project.publicId}`,
  ));
  assert.equal(response.status, 200);
  assert.equal((await json<TeamGrantList>(response)).grants.length, 2);
  const firstGrant = list.grants.find(
    (grant) => grant.teamId === firstTeam.team.id,
  )!;
  response = await deleteTeamGrantRoute(jsonRequest("DELETE", {
    grantId: firstGrant.id,
    version: firstGrant.version,
  }));
  list = await json<TeamGrantList>(response);
  const revokedFirst = list.grants.find((grant) => grant.id === firstGrant.id)!;
  response = await postTeamGrantRoute(jsonRequest("POST", {
    teamId: firstTeam.team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
    version: revokedFirst.version,
  }));
  list = await json<TeamGrantList>(response);
  const regrantedFirst = list.grants.find((grant) => grant.id === firstGrant.id)!;
  assert.equal(regrantedFirst.id, firstGrant.id);
  assert.equal(regrantedFirst.version, revokedFirst.version + 1);
  assert.equal(regrantedFirst.revokedAt, null);
  assert.equal((await postTeamGrantRoute(jsonRequest("POST", {
    teamId: firstTeam.team.id,
    resourceType: "saved_view",
    resourceId: projectView.id,
    permission: "viewer",
  }))).status, 400);

  configureActorResolverForTests(async () => memberActor);
  assert.equal((await getTeamGrantsRoute(new Request(
    `https://example.test/api/shares/teams?resource_type=project&resource_id=${project.id}`,
  ))).status, 404);
  assert.equal((await deleteTeamGrantRoute(jsonRequest("DELETE", {
    grantId: secondGrant.id,
    version: secondGrant.version,
  }))).status, 404);

  configureActorResolverForTests(async () => outsiderActor);
  assert.equal((await getTeamGrantsRoute(new Request(
    `https://example.test/api/shares/teams?resource_type=project&resource_id=${project.id}`,
  ))).status, 404);
  assert.equal((await patchTeamGrantRoute(jsonRequest("PATCH", {
    grantId: secondGrant.id,
    version: secondGrant.version,
    action: "role",
    permission: "viewer",
  }))).status, 404);
});

test("a non-owner active Team member can select it, while resource authority alone can revoke a stale route", async () => {
  harness = await createD1TestHarness();
  const resourceOwner = await getOrCreateUser(ownerActor);
  const teamOwner = await getOrCreateUser(outsiderActor);
  const recipient = await getOrCreateUser(memberActor);
  await createProject(resourceOwner, { name: "Foreign managed Team", taskCode: "FMT" });
  const project = (await getSnapshot(resourceOwner)).projects.find(
    (item) => item.name === "Foreign managed Team",
  )!;

  let team = await createTeam(teamOwner, { name: "Externally owned Team" });
  team = await addTeamMember(teamOwner, team.team.id, {
    email: resourceOwner.email,
    teamVersion: team.team.version,
  });
  team = await addTeamMember(teamOwner, team.team.id, {
    email: recipient.email,
    teamVersion: team.team.version,
  });
  const recipientCursor = (await getSnapshot(recipient)).syncCursor!;

  const list = await createTeamGrant(resourceOwner, {
    teamId: team.team.publicId,
    resourceType: "project",
    resourceId: project.publicId,
    permission: "viewer",
  });
  let grant = list.grants.find((item) => item.teamId === team.team.id)!;
  assert.equal(
    (await getSnapshot(recipient)).projects.find((item) => item.id === project.id)?.accessRole,
    "viewer",
  );
  const reset = await getWorkspaceSync(recipient, recipientCursor);
  assert.equal(reset.resetRequired, true);
  assert.equal((await getWorkspaceSync(recipient, reset.cursor)).resetRequired, false);

  const legacySequence = decodeWorkspaceSyncCursor(reset.cursor)!;
  const legacyReset = await getWorkspaceSync(
    recipient,
    encodeLegacyWorkspaceSyncCursor(legacySequence),
  );
  assert.equal(legacyReset.resetRequired, true);
  assert.equal((await getWorkspaceSync(recipient, legacyReset.cursor)).resetRequired, false);

  const roleList = await updateTeamGrant(resourceOwner, {
    grantId: grant.id,
    version: grant.version,
    action: "role",
    permission: "editor",
  });
  grant = roleList.grants.find((item) => item.id === grant.id)!;
  const roleReset = await getWorkspaceSync(recipient, legacyReset.cursor);
  assert.equal(roleReset.resetRequired, true);
  const roleConverged = await getWorkspaceSync(recipient, roleReset.cursor);
  assert.equal(roleConverged.resetRequired, false);

  configureActorResolverForTests(async () => ownerActor);
  assert.equal((await deleteTeamGrantRoute(jsonRequest("DELETE", {
    grantId: grant.id,
    version: grant.version + 1,
  }))).status, 409);
  const afterStale = await getWorkspaceSync(recipient, roleConverged.cursor);
  assert.equal(afterStale.resetRequired, false);
  assert.equal(afterStale.cursor, roleConverged.cursor);

  const ownerMembership = team.members.find(
    (membership) => membership.userId === resourceOwner.id,
  )!;
  team = await updateTeamMembership(teamOwner, team.team.id, ownerMembership.id, {
    action: "deactivate",
    teamVersion: team.team.version,
    version: ownerMembership.version,
  });
  await harness.database.prepare(
    "UPDATE teams SET archived_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(team.team.id).run();
  assert.equal((await patchTeamGrantRoute(jsonRequest("PATCH", {
    grantId: grant.id,
    version: grant.version,
    action: "role",
    permission: "editor",
  }))).status, 409);
  const revoked = await deleteTeamGrantRoute(jsonRequest("DELETE", {
    grantId: grant.id,
    version: grant.version,
  }));
  assert.equal(revoked.status, 200);
  assert.ok((await json<TeamGrantList>(revoked)).grants.find(
    (item) => item.id === grant.id,
  )?.revokedAt);
});

test("legacy, expired, and future cursors reset once into the safe generation", async () => {
  harness = await createD1TestHarness();
  const outsider = await getOrCreateUser(outsiderActor);
  await createTeam(outsider, { name: "Membership without grants" });
  const snapshot = await getSnapshot(outsider);
  const snapshotState = decodeWorkspaceSyncCursorState(snapshot.syncCursor!)!;
  const legacy = encodeLegacyWorkspaceSyncCursor(
    snapshotState.sequence,
  );
  const legacyReset = await getWorkspaceSync(outsider, legacy);
  assert.equal(legacyReset.resetRequired, true);
  assert.notEqual(legacyReset.cursor, legacy);
  assert.equal(
    (await getWorkspaceSync(outsider, legacyReset.cursor)).resetRequired,
    false,
  );

  const versionTwo = encodeVersionTwoWorkspaceSyncCursor(
    snapshotState.sequence,
    snapshotState.teamAccessFingerprint!,
  );
  const versionTwoReset = await getWorkspaceSync(outsider, versionTwo);
  assert.equal(versionTwoReset.resetRequired, true);
  assert.equal(
    (await getWorkspaceSync(outsider, versionTwoReset.cursor)).resetRequired,
    false,
  );

  const future = encodeWorkspaceSyncCursor(
    snapshotState.sequence,
    snapshotState.teamAccessFingerprint!,
    Date.now() + (WORKSPACE_SYNC_CURSOR_GENERATION_MS * 2),
  );
  const futureReset = await getWorkspaceSync(outsider, future);
  assert.equal(futureReset.resetRequired, true);
  assert.equal(
    (await getWorkspaceSync(outsider, futureReset.cursor)).resetRequired,
    false,
  );
});

test("Team archive and unarchive cannot ABA an active-route sync fingerprint", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "Team fingerprint ABA", taskCode: "ABA" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Team fingerprint ABA",
  )!;
  await createTask(owner, { title: "Before hidden mutation", projectId: project.id });
  const task = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Before hidden mutation",
  )!;
  const team = await teamWithMember(owner, member);
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  });
  const baseline = await getSnapshot(member);
  assert.ok(baseline.tasks.some((item) => item.id === task.id));

  // There is no Team archive API yet. These versioned raw writes model the
  // canonical server CAS contract; unversioned external D1 writes are unsupported.
  const archivedAt = "2026-09-01T05:35:00.000Z";
  const archived = await harness.database.prepare(
    `UPDATE teams SET archived_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ?`,
  ).bind(archivedAt, archivedAt, team.team.id, team.team.version).run();
  assert.equal(archived.meta.changes, 1);
  await updateTask(owner, task.id, {
    version: task.version,
    title: "Changed while Team access was absent",
  });
  const unarchivedAt = "2026-09-01T05:36:00.000Z";
  const unarchived = await harness.database.prepare(
    `UPDATE teams SET archived_at = NULL, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ?`,
  ).bind(unarchivedAt, team.team.id, team.team.version + 1).run();
  assert.equal(unarchived.meta.changes, 1);

  const reset = await getWorkspaceSync(member, baseline.syncCursor!);
  assert.equal(reset.resetRequired, true);
  assert.equal((await getWorkspaceSync(member, reset.cursor)).resetRequired, false);
  assert.equal(
    (await getSnapshot(member)).tasks.find((item) => item.id === task.id)?.title,
    "Changed while Team access was absent",
  );
});

test("Team route content markers converge shared mutations without observing private owner activity", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "Marker shared Project", taskCode: "MKS" });
  await createProject(owner, { name: "Marker private Project", taskCode: "MKP" });
  const ownerSnapshot = await getSnapshot(owner);
  let sharedProject = ownerSnapshot.projects.find(
    (item) => item.name === "Marker shared Project",
  )!;
  const privateProject = ownerSnapshot.projects.find(
    (item) => item.name === "Marker private Project",
  )!;
  await createTask(owner, { title: "Marker shared Task", projectId: sharedProject.id });
  await createTask(owner, { title: "Marker private Task", projectId: privateProject.id });
  const tasks = (await getSnapshot(owner)).tasks;
  let sharedTask = tasks.find((item) => item.title === "Marker shared Task")!;
  let privateTask = tasks.find((item) => item.title === "Marker private Task")!;
  let globalView = await createSavedView(owner, {
    name: "Marker global View",
    query: {},
  });
  const team = await teamWithMember(owner, member);
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "project",
    resourceId: sharedProject.id,
    permission: "viewer",
  });
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "saved_view",
    resourceId: globalView.id,
    permission: "viewer",
  });
  const compactRows = await harness.database
    .prepare(teamAccessFingerprintSql())
    .bind(member.id)
    .all();
  assert.equal(compactRows.results.length, 2);
  let cursor = (await getSnapshot(member)).syncCursor!;

  sharedTask = await updateTask(owner, sharedTask.id, {
    version: sharedTask.version,
    title: "Marker shared Task changed",
  });
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  await createComment(owner, sharedTask.id, {
    body: "Detail invalidation visible through the Team route",
    idempotencyKey: "team-route-marker-comment",
  });
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  sharedProject = await updateProject(owner, sharedProject.id, {
    version: sharedProject.version,
    name: "Marker shared Project changed",
  });
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  globalView = await updateSavedView(owner, globalView.id, {
    version: globalView.version,
    name: "Marker global View changed",
  });
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  privateTask = await updateTask(owner, privateTask.id, {
    version: privateTask.version,
    title: "Unrelated private mutation",
  });
  assert.equal(privateTask.title, "Unrelated private mutation");
  const privatePoll = await getWorkspaceSync(member, cursor);
  assert.equal(privatePoll.resetRequired, false);
  assert.equal(privatePoll.cursor, cursor);
});

test("public Task and scoped View moves invalidate old and new Project routes", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const oldMember = await getOrCreateUser(memberActor);
  const newMember = await getOrCreateUser(isolatedActor);
  await createProject(owner, { name: "Move source one", taskCode: "MSO" });
  await createProject(owner, { name: "Move source two", taskCode: "MST" });
  await createProject(owner, { name: "Move target", taskCode: "MTG" });
  const projects = (await getSnapshot(owner)).projects;
  const sourceOne = projects.find((item) => item.name === "Move source one")!;
  const sourceTwo = projects.find((item) => item.name === "Move source two")!;
  const target = projects.find((item) => item.name === "Move target")!;
  await createTask(owner, { title: "Single move marker", projectId: sourceOne.id });
  await createTask(owner, { title: "Bulk move marker one", projectId: sourceOne.id });
  await createTask(owner, { title: "Bulk move marker two", projectId: sourceTwo.id });
  await createSavedView(owner, {
    name: "Scoped move marker",
    query: {},
    scopeProjectId: sourceOne.id,
  });
  const moveOwnerSnapshot = await getSnapshot(owner);
  const tasks = moveOwnerSnapshot.tasks;
  const single = tasks.find((item) => item.title === "Single move marker")!;
  const bulkOne = tasks.find((item) => item.title === "Bulk move marker one")!;
  const bulkTwo = tasks.find((item) => item.title === "Bulk move marker two")!;
  const scopedView = moveOwnerSnapshot.views.find(
    (item) => item.name === "Scoped move marker",
  )!;

  const oldTeam = await teamWithMember(owner, oldMember);
  await createTeamGrant(owner, {
    teamId: oldTeam.team.id,
    resourceType: "project",
    resourceId: sourceOne.id,
    permission: "viewer",
  });
  await createTeamGrant(owner, {
    teamId: oldTeam.team.id,
    resourceType: "project",
    resourceId: sourceTwo.id,
    permission: "viewer",
  });
  const newTeam = await teamWithMember(owner, newMember);
  await createTeamGrant(owner, {
    teamId: newTeam.team.id,
    resourceType: "project",
    resourceId: target.id,
    permission: "viewer",
  });

  let sourceOneConcurrent = await simulateConcurrentProjectEdit(
    owner,
    sourceOne.id,
    "Move source one concurrent single",
    "2099-01-01T00:00:01.000Z",
  );
  const oldBeforeSingle = await getSnapshot(oldMember);
  const newBeforeSingle = await getSnapshot(newMember);
  const movedSingle = await moveTask(owner, single.id, {
    version: single.version,
    targetProjectId: target.id,
  });
  assert.equal(movedSingle.projectId, target.id);
  const oldAfterSingle = await getWorkspaceSync(oldMember, oldBeforeSingle.syncCursor!);
  const newAfterSingle = await getWorkspaceSync(newMember, newBeforeSingle.syncCursor!);
  assert.equal(oldAfterSingle.resetRequired, true);
  assert.equal(newAfterSingle.resetRequired, true);
  assert.ok(!(await getSnapshot(oldMember)).tasks.some((item) => item.id === single.id));
  assert.equal(
    (await getSnapshot(newMember)).tasks.find((item) => item.id === single.id)?.projectId,
    target.id,
  );
  let sourceAfterTouch = (await getSnapshot(owner)).projects.find(
    (item) => item.id === sourceOne.id,
  )!;
  assert.equal(sourceAfterTouch.name, sourceOneConcurrent.name);
  assert.equal(sourceAfterTouch.version, sourceOneConcurrent.version);
  assert.equal(sourceAfterTouch.updatedAt, sourceOneConcurrent.updatedAt);

  sourceOneConcurrent = await simulateConcurrentProjectEdit(
    owner,
    sourceOne.id,
    "Move source one concurrent bulk",
    "2099-01-01T00:00:02.000Z",
  );
  const sourceTwoConcurrent = await simulateConcurrentProjectEdit(
    owner,
    sourceTwo.id,
    "Move source two concurrent bulk",
    "2099-01-01T00:00:03.000Z",
  );
  const oldBeforeBulk = await getSnapshot(oldMember);
  const newBeforeBulk = await getSnapshot(newMember);
  const movedBulk = await bulkMoveTasks(owner, {
    ids: [bulkOne.id, bulkTwo.id],
    versions: {
      [bulkOne.id]: bulkOne.version,
      [bulkTwo.id]: bulkTwo.version,
    },
    targetProjectId: target.id,
  });
  assert.deepEqual(
    movedBulk.filter((item) => item.id === bulkOne.id || item.id === bulkTwo.id)
      .map((item) => item.projectId),
    [target.id, target.id],
  );
  assert.equal(
    (await getWorkspaceSync(oldMember, oldBeforeBulk.syncCursor!)).resetRequired,
    true,
  );
  assert.equal(
    (await getWorkspaceSync(newMember, newBeforeBulk.syncCursor!)).resetRequired,
    true,
  );
  const oldAfterBulk = await getSnapshot(oldMember);
  assert.ok(!oldAfterBulk.tasks.some(
    (item) => item.id === bulkOne.id || item.id === bulkTwo.id,
  ));
  const newAfterBulk = await getSnapshot(newMember);
  assert.ok(newAfterBulk.tasks.some((item) => item.id === bulkOne.id));
  assert.ok(newAfterBulk.tasks.some((item) => item.id === bulkTwo.id));
  const sourcesAfterBulk = (await getSnapshot(owner)).projects;
  for (const expected of [sourceOneConcurrent, sourceTwoConcurrent]) {
    const actual = sourcesAfterBulk.find((item) => item.id === expected.id)!;
    assert.equal(actual.name, expected.name);
    assert.equal(actual.version, expected.version);
    assert.equal(actual.updatedAt, expected.updatedAt);
  }

  sourceOneConcurrent = await simulateConcurrentProjectEdit(
    owner,
    sourceOne.id,
    "Move source one concurrent view",
    "2099-01-01T00:00:04.000Z",
  );
  const oldBeforeViewMove = await getSnapshot(oldMember);
  const newBeforeViewMove = await getSnapshot(newMember);
  const movedView = await updateSavedView(owner, scopedView.id, {
    version: scopedView.version,
    scopeProjectId: target.id,
  });
  assert.equal(movedView.scopeProjectId, target.id);
  assert.equal(
    (await getWorkspaceSync(oldMember, oldBeforeViewMove.syncCursor!)).resetRequired,
    true,
  );
  assert.equal(
    (await getWorkspaceSync(newMember, newBeforeViewMove.syncCursor!)).resetRequired,
    true,
  );
  assert.ok(!(await getSnapshot(oldMember)).views.some(
    (item) => item.id === scopedView.id,
  ));
  assert.equal(
    (await getSnapshot(newMember)).views.find((item) => item.id === scopedView.id)
      ?.scopeProjectId,
    target.id,
  );
  sourceAfterTouch = (await getSnapshot(owner)).projects.find(
    (item) => item.id === sourceOne.id,
  )!;
  assert.equal(sourceAfterTouch.name, sourceOneConcurrent.name);
  assert.equal(sourceAfterTouch.version, sourceOneConcurrent.version);
  assert.equal(sourceAfterTouch.updatedAt, sourceOneConcurrent.updatedAt);

  const sourceAfterMoves = (await getSnapshot(owner)).projects;
  assert.equal(
    sourceAfterMoves.find((item) => item.id === sourceOne.id)?.version,
    sourceOneConcurrent.version,
  );
  assert.equal(
    sourceAfterMoves.find((item) => item.id === sourceTwo.id)?.version,
    sourceTwoConcurrent.version,
  );
});

test("immediate child purges invalidate a Team Project route without changing Project CAS", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "Purge marker Project", taskCode: "PMP" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Purge marker Project",
  )!;
  await createTask(owner, { title: "Purge marker Task", projectId: project.id });
  await createRelease(owner, { name: "Purge marker Release", projectId: project.id });
  await createSavedView(owner, {
    name: "Purge marker View",
    query: {},
    scopeProjectId: project.id,
  });
  const ownerSnapshot = await getSnapshot(owner);
  const task = ownerSnapshot.tasks.find((item) => item.title === "Purge marker Task")!;
  const release = ownerSnapshot.releases.find(
    (item) => item.name === "Purge marker Release",
  )!;
  const view = ownerSnapshot.views.find((item) => item.name === "Purge marker View")!;
  const team = await teamWithMember(owner, member);
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  });

  let concurrentProject = await simulateConcurrentProjectEdit(
    owner,
    project.id,
    "Purge marker concurrent Task",
    "2099-02-01T00:00:01.000Z",
  );
  let cursor = (await getSnapshot(member)).syncCursor!;
  const deletedTask = await deleteEntity(owner, "task", task.id, task.version);
  await purgeEntity(
    owner,
    "task",
    task.id,
    deletedTask.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  cursor = await expectOneTeamFingerprintReset(member, cursor);
  assert.ok(!(await getSnapshot(member)).tasks.some((item) => item.id === task.id));
  let projectAfterPurge = (await getSnapshot(owner)).projects.find(
    (item) => item.id === project.id,
  )!;
  assert.equal(projectAfterPurge.name, concurrentProject.name);
  assert.equal(projectAfterPurge.version, concurrentProject.version);
  assert.equal(projectAfterPurge.updatedAt, concurrentProject.updatedAt);

  concurrentProject = await simulateConcurrentProjectEdit(
    owner,
    project.id,
    "Purge marker concurrent Release",
    "2099-02-01T00:00:02.000Z",
  );
  cursor = (await getSnapshot(member)).syncCursor!;
  const deletedRelease = await deleteEntity(
    owner,
    "release",
    release.id,
    release.version,
  );
  await purgeEntity(
    owner,
    "release",
    release.id,
    deletedRelease.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  cursor = await expectOneTeamFingerprintReset(member, cursor);
  assert.ok(!(await getSnapshot(member)).releases.some((item) => item.id === release.id));
  projectAfterPurge = (await getSnapshot(owner)).projects.find(
    (item) => item.id === project.id,
  )!;
  assert.equal(projectAfterPurge.name, concurrentProject.name);
  assert.equal(projectAfterPurge.version, concurrentProject.version);
  assert.equal(projectAfterPurge.updatedAt, concurrentProject.updatedAt);

  concurrentProject = await simulateConcurrentProjectEdit(
    owner,
    project.id,
    "Purge marker concurrent View",
    "2099-02-01T00:00:03.000Z",
  );
  cursor = (await getSnapshot(member)).syncCursor!;
  const deletedView = await deleteEntity(owner, "saved_view", view.id, view.version);
  await purgeEntity(
    owner,
    "saved_view",
    view.id,
    deletedView.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  await expectOneTeamFingerprintReset(member, cursor);
  assert.ok(!(await getSnapshot(member)).views.some((item) => item.id === view.id));
  projectAfterPurge = (await getSnapshot(owner)).projects.find(
    (item) => item.id === project.id,
  )!;
  assert.equal(projectAfterPurge.name, concurrentProject.name);
  assert.equal(projectAfterPurge.version, concurrentProject.version);
  assert.equal(projectAfterPurge.updatedAt, concurrentProject.updatedAt);
});

test("a Project Team route tracks the visible workflow catalog but not another owner's statuses", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  const privateOwner = await getOrCreateUser(outsiderActor);
  await createProject(owner, { name: "Status marker Project", taskCode: "SMP" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Status marker Project",
  )!;
  await createTask(owner, { title: "Status marker Task", projectId: project.id });
  const team = await teamWithMember(owner, member);
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  });
  let cursor = (await getSnapshot(member)).syncCursor!;

  let statuses = (await getSnapshot(owner)).statuses.filter(
    (status) => status.ownerUserId === owner.id,
  );
  let assigned = statuses.find((status) => status.name === "Todo")!;
  statuses = await updateWorkflowStatus(owner, assigned.id, {
    version: assigned.version,
    name: "Todo shared",
    color: "#334455",
  });
  assigned = statuses.find((status) => status.id === assigned.id)!;
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  statuses = await createWorkflowStatus(owner, {
    name: "Team queued",
    category: "unstarted",
    color: "#556677",
  });
  let custom = statuses.find((status) => status.name === "Team queued")!;
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  const peer = statuses
    .filter((status) =>
      status.category === custom.category &&
      !status.archivedAt &&
      status.position < custom.position
    )
    .sort((left, right) => right.position - left.position)[0]!;
  statuses = await moveWorkflowStatus(owner, custom.id, {
    direction: "up",
    version: custom.version,
    peerVersion: peer.version,
  });
  custom = statuses.find((status) => status.id === custom.id)!;
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  statuses = await archiveWorkflowStatus(owner, custom.id, {
    version: custom.version,
  });
  assert.ok(statuses.find((status) => status.id === custom.id)?.archivedAt);
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  const privateTodo = (await getSnapshot(privateOwner)).statuses.find(
    (status) => status.ownerUserId === privateOwner.id && status.name === "Todo",
  )!;
  await updateWorkflowStatus(privateOwner, privateTodo.id, {
    version: privateTodo.version,
    name: "Private Todo changed",
  });
  const privatePoll = await getWorkspaceSync(member, cursor);
  assert.equal(privatePoll.resetRequired, false);
  assert.equal(privatePoll.cursor, cursor);
});

test("a global View Team route tracks its selectable owner's Label catalog only", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  const privateOwner = await getOrCreateUser(outsiderActor);
  const view = await createSavedView(owner, {
    name: "Label catalog View",
    query: {},
  });
  const team = await teamWithMember(owner, member);
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "saved_view",
    resourceId: view.id,
    permission: "viewer",
  });
  let cursor = (await getSnapshot(member)).syncCursor!;

  let groups = await createLabelGroup(owner, {
    name: "Team catalog Group",
    position: 40,
  });
  let group = groups.find((item) => item.name === "Team catalog Group")!;
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  groups = await updateLabelGroup(owner, group.id, {
    version: group.version,
    name: "Team catalog Group moved",
    position: 2,
  });
  group = groups.find((item) => item.id === group.id)!;
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  let labels = await createLabel(owner, {
    name: "Team catalog Label",
    color: "#778899",
    groupId: group.id,
  });
  let label = labels.find((item) => item.name === "Team catalog Label")!;
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  const ownerScope = await opaqueWorkspaceOwnerToken(owner.id);
  const scoped = await getSnapshot(member, { workspaceScope: ownerScope });
  assert.ok(scoped.labels.some((item) => item.id === label.id));
  assert.ok(scoped.labelGroups?.some((item) => item.id === group.id));

  labels = await updateLabel(owner, label.id, {
    version: label.version,
    name: "Team catalog Label renamed",
  });
  label = labels.find((item) => item.id === label.id)!;
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  labels = await updateLabel(owner, label.id, {
    action: "archive",
    version: label.version,
  });
  label = labels.find((item) => item.id === label.id)!;
  assert.ok(label.archivedAt);
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  labels = await updateLabel(owner, label.id, {
    action: "restore",
    version: label.version,
  });
  label = labels.find((item) => item.id === label.id)!;
  assert.equal(label.archivedAt, null);
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  await createLabel(privateOwner, {
    name: "Unrelated private Label",
    color: "#112233",
  });
  const privatePoll = await getWorkspaceSync(member, cursor);
  assert.equal(privatePoll.resetRequired, false);
  assert.equal(privatePoll.cursor, cursor);
});

test("an expired Team cursor resets safely after owner journal retention pruning", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "Pruned marker Project", taskCode: "PMP" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Pruned marker Project",
  )!;
  await createTask(owner, { title: "Pruned marker Task", projectId: project.id });
  const task = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Pruned marker Task",
  )!;
  const team = await teamWithMember(owner, member);
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "task",
    resourceId: task.id,
    permission: "viewer",
  });
  await harness.database.prepare(
    `DELETE FROM workspace_change_events
     WHERE audience_user_id = ? AND entity_id = ?`,
  ).bind(owner.id, task.id).run();
  const baseline = await getSnapshot(member);
  const baselineState = decodeWorkspaceSyncCursorState(baseline.syncCursor!)!;
  const expiredCursor = encodeWorkspaceSyncCursor(
    baselineState.sequence,
    baselineState.teamAccessFingerprint!,
    Date.now() - (WORKSPACE_SYNC_CURSOR_GENERATION_MS * 2),
  );

  await createComment(owner, task.id, {
    body: "This durable detail outlives its retained journal marker",
    idempotencyKey: "team-pruned-marker-comment",
  });
  await harness.database.prepare(
    `UPDATE workspace_change_events
     SET created_at = datetime('now', '-31 days')
     WHERE audience_user_id = ? AND entity_id = ?`,
  ).bind(owner.id, task.id).run();
  await harness.database.prepare(
    `INSERT INTO workspace_sync_maintenance (key, last_run_at)
     VALUES ('event-retention', datetime('now', '-25 hours'))
     ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at`,
  ).run();

  await expectOneTeamFingerprintReset(member, expiredCursor);
  const retained = await harness.database.prepare(
    `SELECT COUNT(*) AS count FROM workspace_change_events
     WHERE audience_user_id = ? AND entity_id = ?`,
  ).bind(owner.id, task.id).first<{ count: number }>();
  assert.equal(Number(retained?.count), 0);
});

test("an explicit Task route observes the Task but not its inaccessible Project version", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "Task marker parent", taskCode: "TMP" });
  let project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Task marker parent",
  )!;
  await createTask(owner, { title: "Task marker exact", projectId: project.id });
  let task = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Task marker exact",
  )!;
  const team = await teamWithMember(owner, member);
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "task",
    resourceId: task.id,
    permission: "viewer",
  });
  const baseline = await getSnapshot(member);
  assert.ok(baseline.tasks.some((item) => item.id === task.id));
  assert.ok(!baseline.projects.some((item) => item.id === project.id));

  const ownerStatuses = (await getSnapshot(owner)).statuses.filter(
    (status) => status.ownerUserId === owner.id,
  );
  const assignedStatus = ownerStatuses.find(
    (status) => status.id === task.statusId,
  )!;
  const unrelatedStatus = ownerStatuses.find(
    (status) => status.id !== task.statusId && !status.archivedAt,
  )!;
  await updateWorkflowStatus(owner, unrelatedStatus.id, {
    version: unrelatedStatus.version,
    color: "#246810",
  });
  const unrelatedStatusPoll = await getWorkspaceSync(member, baseline.syncCursor!);
  assert.equal(unrelatedStatusPoll.resetRequired, false);

  await updateWorkflowStatus(owner, assignedStatus.id, {
    version: assignedStatus.version,
    color: "#135790",
  });
  const afterAssignedStatus = await expectOneTeamFingerprintReset(
    member,
    unrelatedStatusPoll.cursor,
  );

  project = await updateProject(owner, project.id, {
    version: project.version,
    name: "Task marker parent changed",
  });
  assert.equal(project.name, "Task marker parent changed");
  const parentPoll = await getWorkspaceSync(member, afterAssignedStatus);
  assert.equal(parentPoll.resetRequired, false);

  task = await updateTask(owner, task.id, {
    version: task.version,
    title: "Task marker exact changed",
  });
  assert.equal(task.title, "Task marker exact changed");
  await expectOneTeamFingerprintReset(member, parentPoll.cursor);
});

test("an explicit Task route tracks only labels and groups attached to that Task", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "Task label parent", taskCode: "TLP" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Task label parent",
  )!;
  await createTask(owner, { title: "Task label exact", projectId: project.id });
  const task = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Task label exact",
  )!;
  const team = await teamWithMember(owner, member);
  await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "task",
    resourceId: task.id,
    permission: "viewer",
  });
  const baseline = await getSnapshot(member);
  assert.deepEqual(baseline.labels, []);
  assert.deepEqual(baseline.labelGroups, []);

  let groups = await createLabelGroup(owner, {
    name: "Task label exact group",
    position: 50,
  });
  let group = groups.find((item) => item.name === "Task label exact group")!;
  let labels = await createLabel(owner, {
    name: "Task label exact label",
    color: "#123456",
    groupId: group.id,
  });
  let label = labels.find((item) => item.name === "Task label exact label")!;
  let cursor = baseline.syncCursor!;
  let poll = await getWorkspaceSync(member, cursor);
  assert.equal(poll.resetRequired, false);
  assert.equal(poll.cursor, cursor);

  labels = await updateLabel(owner, label.id, {
    version: label.version,
    name: "Task label still unrelated",
  });
  label = labels.find((item) => item.id === label.id)!;
  groups = await updateLabelGroup(owner, group.id, {
    version: group.version,
    name: "Task group still unrelated",
  });
  group = groups.find((item) => item.id === group.id)!;
  poll = await getWorkspaceSync(member, cursor);
  assert.equal(poll.resetRequired, false);
  assert.equal(poll.cursor, cursor);

  await setTaskLabel(owner, task.id, { labelId: label.id, active: true });
  cursor = await expectOneTeamFingerprintReset(member, cursor);
  let memberSnapshot = await getSnapshot(member);
  assert.ok(memberSnapshot.labels.some((item) => item.id === label.id));
  assert.ok(memberSnapshot.labelGroups?.some((item) => item.id === group.id));

  labels = await updateLabel(owner, label.id, {
    version: label.version,
    name: "Task label visible rename",
  });
  label = labels.find((item) => item.id === label.id)!;
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  groups = await updateLabelGroup(owner, group.id, {
    version: group.version,
    name: "Task group visible rename",
  });
  group = groups.find((item) => item.id === group.id)!;
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  labels = await updateLabel(owner, label.id, {
    action: "archive",
    version: label.version,
  });
  label = labels.find((item) => item.id === label.id)!;
  cursor = await expectOneTeamFingerprintReset(member, cursor);

  await setTaskLabel(owner, task.id, { labelId: label.id, active: false });
  cursor = await expectOneTeamFingerprintReset(member, cursor);
  memberSnapshot = await getSnapshot(member);
  assert.ok(!memberSnapshot.labels.some((item) => item.id === label.id));
  assert.ok(!memberSnapshot.labelGroups?.some((item) => item.id === group.id));

  labels = await updateLabel(owner, label.id, {
    action: "restore",
    version: label.version,
  });
  label = labels.find((item) => item.id === label.id)!;
  groups = await updateLabelGroup(owner, group.id, {
    version: group.version,
    name: "Task group unrelated again",
  });
  poll = await getWorkspaceSync(member, cursor);
  assert.equal(poll.resetRequired, false);
  assert.equal(poll.cursor, cursor);
});

test("a large Project fingerprint stays route-sized and uses event-first entity lookups", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "Bounded fingerprint Project", taskCode: "BFP" });
  for (let index = 0; index < 5; index += 1) {
    await createProject(owner, {
      name: `Bounded route ${index}`,
      taskCode: `B${String.fromCharCode(65 + index)}X`,
    });
  }
  const ownerSnapshot = await getSnapshot(owner);
  const project = ownerSnapshot.projects.find(
    (item) => item.name === "Bounded fingerprint Project",
  )!;
  const status = ownerSnapshot.statuses.find(
    (item) => item.ownerUserId === owner.id && item.name === "Todo",
  )!;
  const team = await teamWithMember(owner, member);
  const routeProjects = ownerSnapshot.projects.filter(
    (item) => item.id === project.id || item.name.startsWith("Bounded route "),
  );
  for (const routeProject of routeProjects) {
    await createTeamGrant(owner, {
      teamId: team.team.id,
      resourceType: "project",
      resourceId: routeProject.id,
      permission: "viewer",
    });
  }

  await harness.database.prepare(
    `WITH RECURSIVE generated(value) AS (
       VALUES (1)
       UNION ALL SELECT value + 1 FROM generated WHERE value < 2000
     )
     INSERT INTO tasks
       (id, public_id, owner_user_id, creator_user_id, identifier,
        sequence_number, title, description, status_id, priority, project_id,
        rank, comment_count, version, created_at, updated_at)
     SELECT 'bounded-task-' || value, 'T-bounded-' || value, ?, ?,
       'BFP-' || (10000 + value), 10000 + value,
       'Bounded Task ' || value, '', ?, 'none', ?, value, 0, 1,
       '2026-09-01T06:00:00.000Z', '2026-09-01T06:00:00.000Z'
     FROM generated`,
  ).bind(owner.id, owner.id, status.id, project.id).run();

  const fingerprintSql = teamAccessFingerprintSql();
  const rows = await harness.database.prepare(fingerprintSql)
    .bind(member.id)
    .all<{ current_state: string; marker_sequence: number }>();
  assert.equal(rows.results.length, routeProjects.length);
  assert.ok(rows.results.every((row) => row.current_state.length < 1_000));
  assert.ok(rows.results.every((row) => Number(row.marker_sequence) > 0));

  const plan = await harness.database
    .prepare(`EXPLAIN QUERY PLAN ${fingerprintSql}`)
    .bind(member.id)
    .all<{ detail: string }>();
  const details = plan.results.map((row) => String(row.detail)).join("\n");
  assert.doesNotMatch(details, /CORRELATED/i);
  assert.doesNotMatch(details, /SCAN (?:event_task|event_release|event_view)/i);
  assert.match(details, /idx_labels_owner_name_active/i);
  assert.match(details, /MATERIALIZE routed_resource_event_max/i);
  assert.match(details, /MATERIALIZE route_event_max/i);
  const routeMarkerPlan = details.slice(
    details.indexOf("MATERIALIZE route_event_max"),
    details.indexOf("SCAN state"),
  );
  assert.ok(routeMarkerPlan.lastIndexOf("SCAN event") >= 0);
  assert.ok(
    routeMarkerPlan.lastIndexOf("SCAN event") <
      routeMarkerPlan.indexOf("idx_team_grants_resource_active"),
  );
  assert.doesNotMatch(fingerprintSql, /group_concat|OVER\s*\(/i);
  assert.doesNotMatch(fingerprintSql, /project_tasks|route_tasks|visible_task_ids/i);
  assert.match(fingerprintSql, /route\.resource_type = event\.resource_type/);
});

test("Team runtime and Team grant CRUD never write the workspace sync journal", () => {
  for (const file of ["../lib/teams.ts", "../lib/team-grants.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /workspace_sync_sequences|workspace_change_events/);
  }
  const fingerprintSql = teamAccessFingerprintSql();
  assert.equal(
    fingerprintSql.match(/FROM workspace_change_events/g)?.length,
    1,
  );
  assert.match(fingerprintSql, /route_owner_events AS MATERIALIZED/);
  assert.match(fingerprintSql, /routed_resource_event_max AS MATERIALIZED/);
  assert.match(fingerprintSql, /route_event_max AS MATERIALIZED/);
  assert.match(fingerprintSql, /catalog_owner_ids AS MATERIALIZED/);
  assert.equal(
    fingerprintSql.match(/catalog_owner_ids owner/g)?.length,
    2,
  );
  assert.equal(fingerprintSql.match(/JOIN labels label/g)?.length, 1);
  assert.match(fingerprintSql, /label_catalog_state AS MATERIALIZED/);
  assert.doesNotMatch(fingerprintSql, /project_tasks|route_tasks|visible_task_ids/);
  assert.doesNotMatch(fingerprintSql, /group_concat/);
  assert.doesNotMatch(fingerprintSql, /OVER\s*\(/);
  assert.doesNotMatch(fingerprintSql, /metadata_json|source_url|payload_json|comment\.body/);
});

async function teamWithMember(
  owner: UserRecord,
  member: UserRecord,
): Promise<TeamDetail> {
  let detail = await createTeam(owner, {
    name: `Team ${crypto.randomUUID().slice(0, 8)}`,
  });
  detail = await addTeamMember(owner, detail.team.id, {
    email: member.email,
    teamVersion: detail.team.version,
  });
  return detail;
}

async function simulateConcurrentProjectEdit(
  owner: UserRecord,
  projectId: string,
  name: string,
  updatedAt: string,
) {
  assert.ok(harness);
  // Public writes never accept caller timestamps. This raw D1 update models a
  // Project edit that committed after a scope-changing request captured its
  // timestamp, without adding a production-only test hook.
  await harness.database.prepare(
    `UPDATE projects SET name = ?, version = version + 1, updated_at = ?
     WHERE id = ?`,
  ).bind(name, updatedAt, projectId).run();
  return (await getSnapshot(owner)).projects.find((item) => item.id === projectId)!;
}

async function expectOneTeamFingerprintReset(user: UserRecord, cursor: string) {
  const reset = await getWorkspaceSync(user, cursor);
  assert.equal(reset.resetRequired, true);
  const converged = await getWorkspaceSync(user, reset.cursor);
  assert.equal(converged.resetRequired, false);
  assert.equal(converged.cursor, reset.cursor);
  return converged.cursor;
}

function actor(key: string, displayName: string): Actor {
  return {
    provider: "chatgpt",
    providerAccountKey: `team-grant-${key}`,
    displayName,
    email: `${key}@team-grants.example.test`,
  };
}

function jsonRequest(method: string, body: Record<string, unknown>): Request {
  return new Request("https://example.test/api/shares/teams", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function assertPrivateNoStore(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
}
