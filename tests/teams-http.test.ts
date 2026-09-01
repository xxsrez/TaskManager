import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { GET as listTeamsRoute, POST as createTeamRoute } from "../app/api/teams/route";
import {
  GET as getMembershipsRoute,
  POST as addMembershipRoute,
} from "../app/api/teams/[id]/memberships/route";
import {
  PATCH as changeMembershipRoute,
} from "../app/api/teams/[id]/memberships/[membershipId]/route";
import {
  DELETE as revokeTeamGrantRoute,
  GET as listTeamGrantsRoute,
  PATCH as updateTeamGrantRoute,
  POST as createTeamGrantRoute,
} from "../app/api/team-grants/route";
import { configureActorResolverForTests, type Actor } from "../lib/auth";
import { NotFoundError } from "../lib/domain";
import {
  createProject,
  createTask,
  getOrCreateUser,
  getSnapshot,
  loadAccessibleTask,
} from "../lib/repository";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
});

afterEach(() => configureActorResolverForTests(null));
after(async () => dispose?.());

const actor = (key: string): Actor => ({
  provider: "chatgpt",
  providerAccountKey: `${key}-account`,
  displayName: key,
  email: `${key.toLowerCase()}@example.test`,
});

function jsonRequest(url: string, method: string, body: Record<string, unknown>) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("Teams HTTP routes preserve authentication, no-existence-leak, and membership read-back", async () => {
  configureActorResolverForTests(async () => null);
  assert.equal((await listTeamsRoute()).status, 401);

  const ownerActor = actor("HttpTeamOwner");
  const memberActor = actor("HttpTeamMember");
  const outsiderActor = actor("HttpTeamOutsider");
  await getOrCreateUser(memberActor);
  await getOrCreateUser(outsiderActor);

  configureActorResolverForTests(async () => ownerActor);
  const createdResponse = await createTeamRoute(jsonRequest(
    "https://example.test/api/teams",
    "POST",
    { name: "HTTP Platform" },
  ));
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as { team: { publicId: string; members: Array<{ id: string; userId: string; version: number }> } };
  assert.equal(created.team.members.length, 1);

  const context = { params: Promise.resolve({ id: created.team.publicId }) };
  const addedResponse = await addMembershipRoute(jsonRequest(
    `https://example.test/api/teams/${created.team.publicId}/memberships`,
    "POST",
    { email: memberActor.email },
  ), context);
  assert.equal(addedResponse.status, 200);
  let team = (await addedResponse.json() as { team: { members: Array<{ id: string; userId: string; version: number; status: string }> } }).team;
  const memberUser = await getOrCreateUser(memberActor);
  let membership = team.members.find((entry) => entry.userId === memberUser.id)!;

  configureActorResolverForTests(async () => memberActor);
  const memberRead = await getMembershipsRoute(
    new Request(`https://example.test/api/teams/${created.team.publicId}/memberships`),
    context,
  );
  assert.equal(memberRead.status, 200);
  assert.equal((await memberRead.json() as { team: { canManageMembers: boolean } }).team.canManageMembers, false);
  const denied = await addMembershipRoute(jsonRequest(
    `https://example.test/api/teams/${created.team.publicId}/memberships`,
    "POST",
    { email: outsiderActor.email },
  ), context);
  assert.equal(denied.status, 404);

  configureActorResolverForTests(async () => ownerActor);
  const inactiveResponse = await changeMembershipRoute(jsonRequest(
    `https://example.test/api/teams/${created.team.publicId}/memberships/${membership.id}`,
    "PATCH",
    { version: membership.version, status: "inactive" },
  ), { params: Promise.resolve({ id: created.team.publicId, membershipId: membership.id }) });
  assert.equal(inactiveResponse.status, 200);
  team = (await inactiveResponse.json() as { team: { members: typeof team.members } }).team;
  membership = team.members.find((entry) => entry.id === membership.id)!;
  assert.equal(membership.status, "inactive");

  configureActorResolverForTests(async () => memberActor);
  assert.equal((await getMembershipsRoute(
    new Request(`https://example.test/api/teams/${created.team.publicId}/memberships`),
    context,
  )).status, 404);
  configureActorResolverForTests(async () => outsiderActor);
  const outsiderCatalog = await listTeamsRoute();
  assert.deepEqual((await outsiderCatalog.json() as { teams: unknown[] }).teams, []);
});

test("Team grant HTTP route returns authoritative role changes and revocation", async () => {
  const ownerActor = actor("HttpGrantOwner");
  const memberActor = actor("HttpGrantMember");
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  await createProject(owner, { name: "HTTP Grant Project", taskCode: "HGP" });
  const project = (await getSnapshot(owner)).projects.find((entry) => entry.name === "HTTP Grant Project")!;
  const taskIdentity = await createTask(owner, { title: "HTTP routed Task", projectId: project.id });

  configureActorResolverForTests(async () => ownerActor);
  const teamResponse = await createTeamRoute(jsonRequest(
    "https://example.test/api/teams",
    "POST",
    { name: "HTTP Grant Team" },
  ));
  const team = (await teamResponse.json() as { team: { id: string; publicId: string } }).team;
  await addMembershipRoute(jsonRequest(
    `https://example.test/api/teams/${team.publicId}/memberships`,
    "POST",
    { email: memberActor.email },
  ), { params: Promise.resolve({ id: team.publicId }) });

  const grantResponse = await createTeamGrantRoute(jsonRequest(
    "https://example.test/api/team-grants",
    "POST",
    { teamId: team.id, resourceType: "task", resourceId: taskIdentity.id, permission: "viewer" },
  ));
  assert.equal(grantResponse.status, 200);
  let catalog = await grantResponse.json() as { grants: Array<{ id: string; version: number; permission: string }> };
  let grant = catalog.grants[0]!;
  assert.equal(grant.permission, "viewer");
  assert.equal((await listTeamGrantsRoute(new Request(
    `https://example.test/api/team-grants?resourceType=task&resourceId=${taskIdentity.id}`,
  ))).status, 200);

  configureActorResolverForTests(async () => memberActor);
  assert.equal((await loadAccessibleTask(member.id, taskIdentity.id)).accessRole, "viewer");
  assert.equal((await listTeamGrantsRoute(new Request(
    `https://example.test/api/team-grants?resourceType=task&resourceId=${taskIdentity.id}`,
  ))).status, 403);
  assert.equal((await createTeamGrantRoute(jsonRequest(
    "https://example.test/api/team-grants",
    "POST",
    { teamId: team.id, resourceType: "task", resourceId: taskIdentity.id, permission: "editor" },
  ))).status, 403);

  configureActorResolverForTests(async () => ownerActor);
  const updatedResponse = await updateTeamGrantRoute(jsonRequest(
    "https://example.test/api/team-grants",
    "PATCH",
    { grantId: grant.id, version: grant.version, permission: "editor" },
  ));
  catalog = await updatedResponse.json() as typeof catalog;
  grant = catalog.grants[0]!;
  assert.equal(grant.permission, "editor");
  assert.equal((await loadAccessibleTask(member.id, taskIdentity.id)).accessRole, "editor");

  const revokedResponse = await revokeTeamGrantRoute(jsonRequest(
    "https://example.test/api/team-grants",
    "DELETE",
    { grantId: grant.id, version: grant.version },
  ));
  assert.equal(revokedResponse.status, 200);
  assert.deepEqual((await revokedResponse.json() as typeof catalog).grants, []);
  await assert.rejects(loadAccessibleTask(member.id, taskIdentity.id), NotFoundError);
});
