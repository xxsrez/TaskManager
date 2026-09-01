import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  DELETE as deleteTeamGrantRoute,
  GET as getTeamGrantsRoute,
  PATCH as patchTeamGrantRoute,
  POST as postTeamGrantRoute,
} from "../app/api/shares/teams/route";
import { configureActorResolverForTests, type Actor } from "../lib/auth";
import { updateAgentTask } from "../lib/agent-api-repository";
import { NotFoundError, PermissionError } from "../lib/domain";
import {
  addTeamMember,
  createTeam,
  deleteTeamMembership,
  updateTeamMembership,
} from "../lib/teams";
import {
  createProject,
  createRelease,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTask,
  grantAccess,
  queryTaskSummaries,
  updateTask,
} from "../lib/repository";
import {
  createTeamGrant,
  revokeTeamGrant,
} from "../lib/team-grants";
import { createTaskRelation } from "../lib/task-relations";
import { getWorkspaceSync } from "../lib/workspace-sync";
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
  assert.equal((await getWorkspaceSync(isolated, activeCursor)).resetRequired, true);
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
  assert.equal(await membershipResetCount(isolated.id, isolatedMembership.id), 1);
  assert.equal((await getWorkspaceSync(isolated, activeCursor)).resetRequired, true);

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
  assert.equal(await membershipResetCount(isolated.id, isolatedMembership.id), 2);
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
  ))).status, 403);

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

async function membershipResetCount(userId: string, membershipId: string) {
  const row = await harness!.database.prepare(
    `SELECT COUNT(*) AS count FROM workspace_change_events
     WHERE audience_user_id = ? AND entity_type = 'workspace'
       AND entity_id = ? AND operation = 'reset'`,
  ).bind(userId, `team-membership:${membershipId}`).first<{ count: number }>();
  return Number(row?.count ?? 0);
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
