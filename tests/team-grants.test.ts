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
  updateTeamGrant,
} from "../lib/team-grants";
import { createTaskRelation } from "../lib/task-relations";
import { getWorkspaceSync } from "../lib/workspace-sync";
import {
  decodeWorkspaceSyncCursor,
  encodeLegacyWorkspaceSyncCursor,
} from "../lib/workspace-sync-cursor";
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

test("a legacy v1 cursor with no Team routes upgrades without a reset", async () => {
  harness = await createD1TestHarness();
  const outsider = await getOrCreateUser(outsiderActor);
  await createTeam(outsider, { name: "Membership without grants" });
  const snapshot = await getSnapshot(outsider);
  const legacy = encodeLegacyWorkspaceSyncCursor(
    decodeWorkspaceSyncCursor(snapshot.syncCursor!)!,
  );
  const response = await getWorkspaceSync(outsider, legacy);
  assert.equal(response.resetRequired, false);
  assert.notEqual(response.cursor, legacy);
  assert.equal((await getWorkspaceSync(outsider, response.cursor)).resetRequired, false);
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

test("Team runtime and Team grant CRUD never write the workspace sync journal", () => {
  for (const file of ["../lib/teams.ts", "../lib/team-grants.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /workspace_sync_sequences|workspace_change_events/);
  }
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
