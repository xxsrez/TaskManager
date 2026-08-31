import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureActorResolverForTests } from "../lib/auth";
import { getOrCreateUser } from "../lib/repository";
import { GET as getTeams, POST as createTeam } from "../app/api/teams/route";
import { GET as getTeam } from "../app/api/teams/[id]/route";
import {
  GET as getMembers,
  POST as addMember,
} from "../app/api/teams/[id]/members/route";
import {
  DELETE as deleteMember,
  PATCH as updateMember,
} from "../app/api/teams/[id]/members/[membershipId]/route";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "teams-runtime-owner",
  displayName: "Teams Runtime Owner",
  email: "teams-runtime-owner@example.test",
};
const memberActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "teams-runtime-member",
  displayName: "Teams Runtime Member",
  email: "teams-runtime-member@example.test",
};
const outsiderActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "teams-runtime-outsider",
  displayName: "Teams Runtime Outsider",
  email: "teams-runtime-outsider@example.test",
};
const concurrentActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "teams-runtime-concurrent",
  displayName: "Teams Runtime Concurrent",
  email: "teams-runtime-concurrent@example.test",
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

test("Team lifecycle enforces active visibility, owner membership protection, and CAS", async () => {
  configureActorResolverForTests(async () => ownerActor);
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  const outsider = await getOrCreateUser(outsiderActor);
  const concurrent = await getOrCreateUser(concurrentActor);

  const createdResponse = await createTeam(jsonRequest("POST", "/api/teams", {
    name: "  Runtime Team  ",
  }));
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as {
    team: { id: string; publicId: string; name: string; version: number };
    membership: {
      id: string;
      userId: string;
      role: string;
      status: string;
      version: number;
    };
  };
  assert.equal(created.team.name, "Runtime Team");
  assert.equal(created.team.version, 1);
  assert.equal(created.membership.userId, owner.id);
  assert.equal(created.membership.role, "owner");
  assert.equal(created.membership.status, "active");
  assert.equal(created.membership.version, 1);

  const ownerList = await getTeams();
  assert.equal(ownerList.status, 200);
  assert.equal((await ownerList.json() as { teams: unknown[] }).teams.length, 1);

  const missingMemberResponse = await addMember(
    jsonRequest("POST", "/api/teams/missing/members", { email: "none@example.test" }),
    params({ id: created.team.publicId }),
  );
  assert.equal(missingMemberResponse.status, 404);

  const addedResponse = await addMember(
    jsonRequest("POST", "/api/teams/members", { email: member.email }),
    params({ id: created.team.publicId }),
  );
  assert.equal(addedResponse.status, 200);
  const added = await addedResponse.json() as {
    membership: {
      id: string;
      userId: string;
      status: string;
      role: string;
      version: number;
    };
  };
  assert.equal(added.membership.userId, member.id);
  assert.equal(added.membership.status, "active");
  assert.equal(added.membership.role, "member");
  assert.equal(added.membership.version, 1);

  const duplicateResponse = await addMember(
    jsonRequest("POST", "/api/teams/members", { email: member.email.toUpperCase() }),
    params({ id: created.team.publicId }),
  );
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json() as typeof added;
  assert.deepEqual(duplicate, added);

  configureActorResolverForTests(async () => memberActor);
  const memberUnknown = await getTeam(
    new Request("https://example.test/api/teams/unknown"),
    params({ id: "unknown-team" }),
  );
  const memberUnknownError = (await memberUnknown.json() as { error: string }).error;
  assert.equal(memberUnknown.status, 404);
  const memberAdd = await addMember(
    jsonRequest("POST", "/api/teams/members", { email: concurrent.email }),
    params({ id: created.team.publicId }),
  );
  const memberPatch = await updateMember(
    jsonRequest("PATCH", "/api/teams/member", {
      status: "inactive",
      version: added.membership.version,
    }),
    params({ id: created.team.publicId, membershipId: added.membership.id }),
  );
  const memberDelete = await deleteMember(
    jsonRequest("DELETE", "/api/teams/member", { version: added.membership.version }),
    params({ id: created.team.publicId, membershipId: added.membership.id }),
  );
  for (const response of [memberAdd, memberPatch, memberDelete]) {
    assert.equal(response.status, memberUnknown.status);
    assert.equal((await response.json() as { error: string }).error, memberUnknownError);
  }

  configureActorResolverForTests(async () => ownerActor);
  const concurrentResponses = await Promise.all([
    addMember(
      jsonRequest("POST", "/api/teams/members", { email: concurrent.email }),
      params({ id: created.team.publicId }),
    ),
    addMember(
      jsonRequest("POST", "/api/teams/members", { email: concurrent.email }),
      params({ id: created.team.publicId }),
    ),
  ]);
  assert.deepEqual(concurrentResponses.map((response) => response.status), [200, 200]);
  const concurrentResults = await Promise.all(
    concurrentResponses.map(async (response) => await response.json() as {
      membership: { id: string; userId: string; status: string; version: number };
    }),
  );
  assert.equal(concurrentResults[0]!.membership.id, concurrentResults[1]!.membership.id);
  assert.equal(concurrentResults[0]!.membership.userId, concurrent.id);
  assert.equal(concurrentResults[0]!.membership.status, "active");
  assert.equal(concurrentResults[0]!.membership.version, 1);
  const concurrentReadBack = await getMembers(
    new Request("https://example.test/api/teams/detail/members"),
    params({ id: created.team.publicId }),
  );
  const concurrentMembers = (await concurrentReadBack.json() as {
    members: Array<{ id: string; userId: string }>;
  }).members.filter((item) => item.userId === concurrent.id);
  assert.equal(concurrentMembers.length, 1);
  assert.equal(concurrentMembers[0]!.id, concurrentResults[0]!.membership.id);

  configureActorResolverForTests(async () => memberActor);
  const memberDetail = await getTeam(
    new Request("https://example.test/api/teams/detail"),
    params({ id: created.team.publicId }),
  );
  assert.equal(memberDetail.status, 200);
  const detail = await memberDetail.json() as {
    team: { publicId: string };
    members: Array<{ id: string; status: string }>;
  };
  assert.equal(detail.team.publicId, created.team.publicId);
  assert.deepEqual(
    detail.members.map((item) => item.id).sort(),
    [created.membership.id, added.membership.id, concurrentResults[0]!.membership.id].sort(),
  );
  const memberList = await getMembers(
    new Request("https://example.test/api/teams/detail/members"),
    params({ id: created.team.publicId }),
  );
  assert.equal(memberList.status, 200);
  assert.equal((await memberList.json() as { members: unknown[] }).members.length, 3);

  configureActorResolverForTests(async () => outsiderActor);
  const outsiderDetail = await getTeam(
    new Request("https://example.test/api/teams/detail"),
    params({ id: created.team.publicId }),
  );
  assert.equal(outsiderDetail.status, 404);
  const unknownDetail = await getTeam(
    new Request("https://example.test/api/teams/detail"),
    params({ id: "unknown-team" }),
  );
  assert.equal(unknownDetail.status, 404);
  assert.equal(
    (await outsiderDetail.clone().json() as { error: string }).error,
    (await unknownDetail.json() as { error: string }).error,
  );
  const outsiderTeams = await getTeams();
  assert.equal(outsiderTeams.status, 200);
  assert.equal((await outsiderTeams.json() as { teams: unknown[] }).teams.length, 0);
  assert.equal(outsider.id.length > 0, true);

  configureActorResolverForTests(async () => ownerActor);
  const deactivatedResponse = await updateMember(
    jsonRequest("PATCH", "/api/teams/member", {
      status: "inactive",
      version: added.membership.version,
    }),
    params({ id: created.team.publicId, membershipId: added.membership.id }),
  );
  assert.equal(deactivatedResponse.status, 200);
  const deactivated = await deactivatedResponse.json() as {
    membership: { status: string; deactivatedAt: string | null; version: number };
  };
  assert.equal(deactivated.membership.status, "inactive");
  assert.equal(typeof deactivated.membership.deactivatedAt, "string");
  assert.equal(deactivated.membership.version, 2);

  configureActorResolverForTests(async () => memberActor);
  const deactivatedMemberDetail = await getTeam(
    new Request("https://example.test/api/teams/detail"),
    params({ id: created.team.publicId }),
  );
  assert.equal(deactivatedMemberDetail.status, 404);
  const deactivatedMemberList = await getTeams();
  assert.equal(deactivatedMemberList.status, 200);
  assert.equal((await deactivatedMemberList.json() as { teams: unknown[] }).teams.length, 0);

  configureActorResolverForTests(async () => ownerActor);
  const staleResponse = await updateMember(
    jsonRequest("PATCH", "/api/teams/member", {
      status: "active",
      version: added.membership.version,
    }),
    params({ id: created.team.publicId, membershipId: added.membership.id }),
  );
  assert.equal(staleResponse.status, 409);

  const reactivatedResponse = await updateMember(
    jsonRequest("PATCH", "/api/teams/member", {
      status: "active",
      version: deactivated.membership.version,
    }),
    params({ id: created.team.publicId, membershipId: added.membership.id }),
  );
  assert.equal(reactivatedResponse.status, 200);
  const reactivated = await reactivatedResponse.json() as {
    membership: { status: string; deactivatedAt: string | null; version: number };
  };
  assert.equal(reactivated.membership.status, "active");
  assert.equal(reactivated.membership.deactivatedAt, null);
  assert.equal(reactivated.membership.version, 3);

  const ownerPatch = await updateMember(
    jsonRequest("PATCH", "/api/teams/owner", {
      status: "inactive",
      version: created.membership.version,
    }),
    params({ id: created.team.publicId, membershipId: created.membership.id }),
  );
  assert.equal(ownerPatch.status, 409);
  const ownerDelete = await deleteMember(
    jsonRequest("DELETE", "/api/teams/owner", { version: created.membership.version }),
    params({ id: created.team.publicId, membershipId: created.membership.id }),
  );
  assert.equal(ownerDelete.status, 409);

  const staleDelete = await deleteMember(
    jsonRequest("DELETE", "/api/teams/member", { version: 2 }),
    params({ id: created.team.publicId, membershipId: added.membership.id }),
  );
  assert.equal(staleDelete.status, 409);
  const deletedResponse = await deleteMember(
    jsonRequest("DELETE", "/api/teams/member", { version: reactivated.membership.version }),
    params({ id: created.team.publicId, membershipId: added.membership.id }),
  );
  assert.equal(deletedResponse.status, 200);
  assert.equal((await deletedResponse.json() as { deleted: boolean }).deleted, true);

  const ownerAfterDelete = await getTeam(
    new Request("https://example.test/api/teams/detail"),
    params({ id: created.team.publicId }),
  );
  assert.equal(ownerAfterDelete.status, 200);
  assert.equal(
    (await ownerAfterDelete.json() as { members: unknown[] }).members.length,
    2,
  );

  configureActorResolverForTests(async () => memberActor);
  const removedMemberDetail = await getTeam(
    new Request("https://example.test/api/teams/detail"),
    params({ id: created.team.publicId }),
  );
  assert.equal(removedMemberDetail.status, 404);
});

function params<T extends Record<string, string>>(value: T) {
  return { params: Promise.resolve(value) };
}

function jsonRequest(method: string, path: string, body: Record<string, unknown>) {
  return new Request(`https://example.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
