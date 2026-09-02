import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { GET as getTeamsRoute, POST as createTeamRoute } from "../app/api/teams/route";
import {
  GET as getTeamRoute,
  PATCH as updateTeamRoute,
} from "../app/api/teams/[id]/route";
import {
  GET as getMembersRoute,
  POST as addMemberRoute,
} from "../app/api/teams/[id]/members/route";
import {
  DELETE as deleteMembershipRoute,
  PATCH as updateMembershipRoute,
} from "../app/api/teams/[id]/members/[membershipId]/route";
import { configureActorResolverForTests, type Actor } from "../lib/auth";
import { getOrCreateUser } from "../lib/repository";
import type { TeamDetail, TeamList } from "../lib/types";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt",
  providerAccountKey: "teams-runtime-owner",
  displayName: "Teams Owner",
  email: "owner@teams.example.test",
} satisfies Actor;

const memberActor = {
  provider: "chatgpt",
  providerAccountKey: "teams-runtime-member",
  displayName: "Teams Member",
  email: "Member@Teams.Example.Test",
} satisfies Actor;

const outsiderActor = {
  provider: "chatgpt",
  providerAccountKey: "teams-runtime-outsider",
  displayName: "Teams Outsider",
  email: "outsider@teams.example.test",
} satisfies Actor;

let harness: Awaited<ReturnType<typeof createD1TestHarness>> | null = null;

afterEach(async () => {
  configureActorResolverForTests(null);
  await harness?.dispose();
  harness = null;
});

test("Teams routes create, list, read, rename, and commit membership lifecycle changes", async () => {
  harness = await createD1TestHarness();
  const member = await getOrCreateUser(memberActor);
  configureActorResolverForTests(async () => ownerActor);

  const createdResponse = await createTeamRoute(jsonRequest(
    "https://example.test/api/teams",
    "POST",
    { name: "  Platform Team  " },
  ));
  assert.equal(createdResponse.status, 200);
  assertPrivateNoStore(createdResponse);
  let detail = await json<TeamDetail>(createdResponse);
  assert.equal(detail.team.name, "Platform Team");
  assert.equal(detail.team.version, 1);
  assert.equal(detail.members.length, 1);
  const ownerMembership = detail.members[0]!;
  assert.equal(ownerMembership.userId, detail.team.ownerUserId);
  assert.equal(ownerMembership.role, "owner");
  assert.equal(ownerMembership.status, "active");
  assert.equal(detail.currentMembership.id, ownerMembership.id);

  const listResponse = await getTeamsRoute();
  assertPrivateNoStore(listResponse);
  const listed = await json<TeamList>(listResponse);
  assert.equal(listed.teams.length, 1);
  assert.equal(listed.teams[0]!.team.id, detail.team.id);
  assert.equal(listed.teams[0]!.activeMemberCount, 1);

  for (const ref of [detail.team.id, detail.team.publicId]) {
    const response = await getTeamRoute(
      new Request(`https://example.test/api/teams/${ref}`),
      teamContext(ref),
    );
    assert.equal(response.status, 200);
    assertPrivateNoStore(response);
    assert.equal((await json<TeamDetail>(response)).team.id, detail.team.id);
  }

  const renamedResponse = await updateTeamRoute(
    jsonRequest(`https://example.test/api/teams/${detail.team.publicId}`, "PATCH", {
      name: "Runtime Team",
      version: detail.team.version,
    }),
    teamContext(detail.team.publicId),
  );
  assert.equal(renamedResponse.status, 200);
  detail = await json<TeamDetail>(renamedResponse);
  assert.equal(detail.team.name, "Runtime Team");
  assert.equal(detail.team.version, 2);

  const staleRenameResponse = await updateTeamRoute(
    jsonRequest(`https://example.test/api/teams/${detail.team.id}`, "PATCH", {
      name: "Stale rename",
      version: detail.team.version - 1,
    }),
    teamContext(detail.team.id),
  );
  assert.equal(staleRenameResponse.status, 409);
  assert.equal(await rawTeamVersion(detail.team.id), detail.team.version);

  const initialAddTeamVersion = detail.team.version;
  const firstAddResponse = await addMemberRoute(
    jsonRequest(`https://example.test/api/teams/${detail.team.id}/members`, "POST", {
      email: "  MEMBER@TEAMS.EXAMPLE.TEST ",
      teamVersion: initialAddTeamVersion,
    }),
    teamContext(detail.team.id),
  );
  assert.equal(firstAddResponse.status, 200);
  detail = await json<TeamDetail>(firstAddResponse);
  let membership = detail.members.find((item) => item.userId === member.id)!;
  assert.equal(detail.team.version, initialAddTeamVersion + 1);
  assert.equal(membership.role, "member");
  assert.equal(membership.status, "active");
  assert.equal(membership.version, 1);

  const duplicateAddResponse = await addMemberRoute(
    jsonRequest(`https://example.test/api/teams/${detail.team.publicId}/members`, "POST", {
      email: memberActor.email,
      teamVersion: initialAddTeamVersion,
    }),
    teamContext(detail.team.publicId),
  );
  assert.equal(duplicateAddResponse.status, 200);
  const duplicateDetail = await json<TeamDetail>(duplicateAddResponse);
  assert.equal(
    duplicateDetail.members.find((item) => item.userId === member.id)?.id,
    membership.id,
  );
  assert.equal(duplicateDetail.team.version, detail.team.version);
  assert.equal(await rawTeamVersion(detail.team.id), detail.team.version);
  assert.equal(await membershipCount(detail.team.id, member.id), 1);

  const membersResponse = await getMembersRoute(
    new Request(`https://example.test/api/teams/${detail.team.id}/members`),
    teamContext(detail.team.id),
  );
  assert.equal(membersResponse.status, 200);
  assert.equal((await json<{ members: TeamDetail["members"] }>(membersResponse)).members.length, 2);

  const deactivatedResponse = await updateMembershipRoute(
    jsonRequest(
      `https://example.test/api/teams/${detail.team.id}/members/${membership.id}`,
      "PATCH",
      {
        action: "deactivate",
        teamVersion: detail.team.version,
        version: membership.version,
      },
    ),
    membershipContext(detail.team.id, membership.id),
  );
  assert.equal(deactivatedResponse.status, 200);
  detail = await json<TeamDetail>(deactivatedResponse);
  membership = detail.members.find((item) => item.id === membership.id)!;
  assert.equal(membership.status, "inactive");
  assert.equal(membership.version, 2);
  assert.ok(membership.deactivatedAt);
  assert.deepEqual(await rawMembership(membership.id), {
    status: "inactive",
    deactivated_at: membership.deactivatedAt,
    version: 2,
  });

  configureActorResolverForTests(async () => memberActor);
  const inactiveList = await json<TeamList>(await getTeamsRoute());
  assert.deepEqual(inactiveList.teams, []);
  assert.equal((await getTeamRoute(
    new Request(`https://example.test/api/teams/${detail.team.publicId}`),
    teamContext(detail.team.publicId),
  )).status, 404);

  configureActorResolverForTests(async () => ownerActor);
  const implicitReactivation = await addMemberRoute(
    jsonRequest(`https://example.test/api/teams/${detail.team.id}/members`, "POST", {
      email: memberActor.email,
      teamVersion: detail.team.version,
    }),
    teamContext(detail.team.id),
  );
  assert.equal(implicitReactivation.status, 409);

  const reactivatedResponse = await updateMembershipRoute(
    jsonRequest(
      `https://example.test/api/teams/${detail.team.id}/members/${membership.id}`,
      "PATCH",
      {
        action: "reactivate",
        teamVersion: detail.team.version,
        version: membership.version,
      },
    ),
    membershipContext(detail.team.id, membership.id),
  );
  assert.equal(reactivatedResponse.status, 200);
  detail = await json<TeamDetail>(reactivatedResponse);
  membership = detail.members.find((item) => item.id === membership.id)!;
  assert.equal(membership.status, "active");
  assert.equal(membership.version, 3);
  assert.equal(membership.deactivatedAt, null);
  assert.deepEqual(await rawMembership(membership.id), {
    status: "active",
    deactivated_at: null,
    version: 3,
  });

  configureActorResolverForTests(async () => memberActor);
  assert.equal((await getTeamRoute(
    new Request(`https://example.test/api/teams/${detail.team.publicId}`),
    teamContext(detail.team.publicId),
  )).status, 200);

  configureActorResolverForTests(async () => ownerActor);
  const staleDeleteResponse = await deleteMembershipRoute(
    jsonRequest(
      `https://example.test/api/teams/${detail.team.id}/members/${membership.id}`,
      "DELETE",
      { teamVersion: detail.team.version - 1, version: membership.version },
    ),
    membershipContext(detail.team.id, membership.id),
  );
  assert.equal(staleDeleteResponse.status, 409);
  assert.equal(await membershipCount(detail.team.id, member.id), 1);
  assert.equal(await rawTeamVersion(detail.team.id), detail.team.version);

  const deletedResponse = await deleteMembershipRoute(
    jsonRequest(
      `https://example.test/api/teams/${detail.team.id}/members/${membership.id}`,
      "DELETE",
      { teamVersion: detail.team.version, version: membership.version },
    ),
    membershipContext(detail.team.id, membership.id),
  );
  assert.equal(deletedResponse.status, 200);
  detail = await json<TeamDetail>(deletedResponse);
  assert.equal(detail.members.some((item) => item.id === membership.id), false);
  assert.equal(await membershipCount(detail.team.id, member.id), 0);
});

test("Teams routes protect the owner, reject stale writes, and conceal Teams from outsiders", async () => {
  harness = await createD1TestHarness();
  const member = await getOrCreateUser(memberActor);
  await getOrCreateUser(outsiderActor);
  configureActorResolverForTests(async () => ownerActor);

  let detail = await json<TeamDetail>(await createTeamRoute(jsonRequest(
    "https://example.test/api/teams",
    "POST",
    { name: "Access Team" },
  )));
  const ownerMembership = detail.currentMembership;

  const missingUserResponse = await addMemberRoute(
    jsonRequest(`https://example.test/api/teams/${detail.team.id}/members`, "POST", {
      email: "never-registered@example.test",
      teamVersion: detail.team.version,
    }),
    teamContext(detail.team.id),
  );
  assert.equal(missingUserResponse.status, 404);

  for (const [method, call] of [
    ["PATCH", () => updateMembershipRoute(
      jsonRequest("https://example.test/owner", "PATCH", {
        action: "deactivate",
        teamVersion: detail.team.version,
        version: ownerMembership.version,
      }),
      membershipContext(detail.team.id, ownerMembership.id),
    )],
    ["DELETE", () => deleteMembershipRoute(
      jsonRequest("https://example.test/owner", "DELETE", {
        teamVersion: detail.team.version,
        version: ownerMembership.version,
      }),
      membershipContext(detail.team.id, ownerMembership.id),
    )],
  ] as const) {
    const response = await call();
    assert.equal(response.status, 400, method);
  }

  detail = await json<TeamDetail>(await addMemberRoute(
    jsonRequest(`https://example.test/api/teams/${detail.team.id}/members`, "POST", {
      email: memberActor.email,
      teamVersion: detail.team.version,
    }),
    teamContext(detail.team.id),
  ));
  let membership = detail.members.find((item) => item.userId === member.id)!;
  detail = await json<TeamDetail>(await updateMembershipRoute(
    jsonRequest("https://example.test/membership", "PATCH", {
      action: "deactivate",
      teamVersion: detail.team.version,
      version: membership.version,
    }),
    membershipContext(detail.team.id, membership.id),
  ));
  membership = detail.members.find((item) => item.id === membership.id)!;
  const staleResponse = await updateMembershipRoute(
    jsonRequest("https://example.test/membership", "PATCH", {
      action: "reactivate",
      teamVersion: detail.team.version,
      version: membership.version - 1,
    }),
    membershipContext(detail.team.id, membership.id),
  );
  assert.equal(staleResponse.status, 409);
  assert.deepEqual(await rawMembership(membership.id), {
    status: "inactive",
    deactivated_at: membership.deactivatedAt,
    version: membership.version,
  });

  detail = await json<TeamDetail>(await updateMembershipRoute(
    jsonRequest("https://example.test/membership", "PATCH", {
      action: "reactivate",
      teamVersion: detail.team.version,
      version: membership.version,
    }),
    membershipContext(detail.team.id, membership.id),
  ));
  membership = detail.members.find((item) => item.id === membership.id)!;

  configureActorResolverForTests(async () => memberActor);
  const readableByMember = await getTeamRoute(
    new Request(`https://example.test/api/teams/${detail.team.publicId}`),
    teamContext(detail.team.publicId),
  );
  assert.equal(readableByMember.status, 200);
  const memberRename = await updateTeamRoute(
    jsonRequest("https://example.test/team", "PATCH", {
      name: "Denied rename",
      version: detail.team.version,
    }),
    teamContext(detail.team.id),
  );
  assert.equal(memberRename.status, 403);
  const memberComposition = await addMemberRoute(
    jsonRequest("https://example.test/members", "POST", {
      email: outsiderActor.email,
      teamVersion: detail.team.version,
    }),
    teamContext(detail.team.id),
  );
  assert.equal(memberComposition.status, 403);

  configureActorResolverForTests(async () => outsiderActor);
  const knownRead = await getTeamRoute(
    new Request(`https://example.test/api/teams/${detail.team.publicId}`),
    teamContext(detail.team.publicId),
  );
  const unknownRead = await getTeamRoute(
    new Request("https://example.test/api/teams/unknown-team"),
    teamContext("unknown-team"),
  );
  assert.equal(knownRead.status, 404);
  assert.equal(unknownRead.status, 404);
  assert.deepEqual(await json(knownRead), await json(unknownRead));

  const outsiderRename = await updateTeamRoute(
    jsonRequest("https://example.test/team", "PATCH", {
      name: "Outsider rename",
      version: detail.team.version,
    }),
    teamContext(detail.team.id),
  );
  assert.equal(outsiderRename.status, 404);
  assertPrivateNoStore(outsiderRename);
  const outsiderComposition = await updateMembershipRoute(
    jsonRequest("https://example.test/membership", "PATCH", {
      action: "deactivate",
      teamVersion: detail.team.version,
      version: membership.version,
    }),
    membershipContext(detail.team.id, membership.id),
  );
  assert.equal(outsiderComposition.status, 404);
  assert.equal((await getMembersRoute(
    new Request("https://example.test/members"),
    teamContext(detail.team.id),
  )).status, 404);
});

test("Team composition CAS prevents concurrent partial writes and delayed-add ABA", async () => {
  harness = await createD1TestHarness();
  const member = await getOrCreateUser(memberActor);
  const outsider = await getOrCreateUser(outsiderActor);
  configureActorResolverForTests(async () => ownerActor);

  let detail = await json<TeamDetail>(await createTeamRoute(jsonRequest(
    "https://example.test/api/teams",
    "POST",
    { name: "CAS Team" },
  )));
  const originalTeamVersion = detail.team.version;
  const concurrentResponses = await Promise.all([
    addMemberRoute(
      jsonRequest("https://example.test/member", "POST", {
        email: memberActor.email,
        teamVersion: originalTeamVersion,
      }),
      teamContext(detail.team.id),
    ),
    addMemberRoute(
      jsonRequest("https://example.test/outsider", "POST", {
        email: outsiderActor.email,
        teamVersion: originalTeamVersion,
      }),
      teamContext(detail.team.id),
    ),
  ]);
  assert.deepEqual(
    concurrentResponses.map((response) => response.status).sort(),
    [200, 409],
  );

  detail = await json<TeamDetail>(await getTeamRoute(
    new Request("https://example.test/team"),
    teamContext(detail.team.id),
  ));
  assert.equal(detail.team.version, originalTeamVersion + 1);
  const candidates = detail.members.filter((item) => item.role === "member");
  assert.equal(candidates.length, 1);
  const winner = candidates[0]!;
  const winnerActor = winner.userId === member.id ? memberActor : outsiderActor;
  const loser = winner.userId === member.id ? outsider : member;
  const loserActor = winner.userId === member.id ? outsiderActor : memberActor;
  assert.equal(await membershipCount(detail.team.id, loser.id), 0);

  const staleLoserAdd = await addMemberRoute(
    jsonRequest("https://example.test/stale-loser", "POST", {
      email: loserActor.email,
      teamVersion: originalTeamVersion,
    }),
    teamContext(detail.team.id),
  );
  assert.equal(staleLoserAdd.status, 409);
  assert.equal(await membershipCount(detail.team.id, loser.id), 0);
  assert.equal(await rawTeamVersion(detail.team.id), detail.team.version);

  detail = await json<TeamDetail>(await deleteMembershipRoute(
    jsonRequest("https://example.test/delete-winner", "DELETE", {
      teamVersion: detail.team.version,
      version: winner.version,
    }),
    membershipContext(detail.team.id, winner.id),
  ));
  assert.equal(await membershipCount(detail.team.id, winner.userId), 0);
  const afterDeleteVersion = detail.team.version;

  const delayedOriginalAdd = await addMemberRoute(
    jsonRequest("https://example.test/delayed-original-add", "POST", {
      email: winnerActor.email,
      teamVersion: originalTeamVersion,
    }),
    teamContext(detail.team.id),
  );
  assert.equal(delayedOriginalAdd.status, 409);
  assert.equal(await membershipCount(detail.team.id, winner.userId), 0);
  assert.equal(await rawTeamVersion(detail.team.id), afterDeleteVersion);

  detail = await json<TeamDetail>(await addMemberRoute(
    jsonRequest("https://example.test/add-loser", "POST", {
      email: loserActor.email,
      teamVersion: detail.team.version,
    }),
    teamContext(detail.team.id),
  ));
  let loserMembership = detail.members.find((item) => item.userId === loser.id)!;
  const beforeStaleLifecycleVersion = detail.team.version;
  const staleLifecycle = await updateMembershipRoute(
    jsonRequest("https://example.test/stale-lifecycle", "PATCH", {
      action: "deactivate",
      teamVersion: beforeStaleLifecycleVersion - 1,
      version: loserMembership.version,
    }),
    membershipContext(detail.team.id, loserMembership.id),
  );
  assert.equal(staleLifecycle.status, 409);
  assert.equal(await rawTeamVersion(detail.team.id), beforeStaleLifecycleVersion);
  assert.equal((await rawMembership(loserMembership.id))?.status, "active");

  detail = await json<TeamDetail>(await updateMembershipRoute(
    jsonRequest("https://example.test/deactivate-loser", "PATCH", {
      action: "deactivate",
      teamVersion: detail.team.version,
      version: loserMembership.version,
    }),
    membershipContext(detail.team.id, loserMembership.id),
  ));
  loserMembership = detail.members.find((item) => item.id === loserMembership.id)!;
  const beforeStaleDeleteVersion = detail.team.version;
  const staleMembershipDelete = await deleteMembershipRoute(
    jsonRequest("https://example.test/stale-delete", "DELETE", {
      teamVersion: beforeStaleDeleteVersion,
      version: loserMembership.version - 1,
    }),
    membershipContext(detail.team.id, loserMembership.id),
  );
  assert.equal(staleMembershipDelete.status, 409);
  assert.equal(await rawTeamVersion(detail.team.id), beforeStaleDeleteVersion);
  assert.deepEqual(await rawMembership(loserMembership.id), {
    status: "inactive",
    deactivated_at: loserMembership.deactivatedAt,
    version: loserMembership.version,
  });
});

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function teamContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function membershipContext(id: string, membershipId: string) {
  return { params: Promise.resolve({ id, membershipId }) };
}

async function json<T = unknown>(response: Response): Promise<T> {
  return await response.json() as T;
}

function assertPrivateNoStore(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
}

async function membershipCount(teamId: string, userId: string) {
  const row = await harness!.database.prepare(
    "SELECT COUNT(*) AS count FROM team_memberships WHERE team_id = ? AND user_id = ?",
  ).bind(teamId, userId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function rawMembership(membershipId: string) {
  return await harness!.database.prepare(
    `SELECT status, deactivated_at, version
     FROM team_memberships WHERE id = ?`,
  ).bind(membershipId).first<{
    status: string;
    deactivated_at: string | null;
    version: number;
  }>();
}

async function rawTeamVersion(teamId: string) {
  const row = await harness!.database.prepare(
    "SELECT version FROM teams WHERE id = ?",
  ).bind(teamId).first<{ version: number }>();
  return Number(row?.version ?? 0);
}
