import assert from "node:assert/strict";
import test from "node:test";
import {
  addTeamMember,
  createTeam,
  deleteTeamMembership,
  getTeam,
  listTeams,
  setTeamMembershipStatus,
} from "../lib/teams";
import type { UserRecord } from "../lib/types";
import { createD1TestHarness } from "./helpers/d1";

const owner: UserRecord = {
  id: "user-owner",
  displayName: "Owner",
  email: "owner@example.test",
  timezone: "UTC",
};
const member: UserRecord = {
  id: "user-member",
  displayName: "Member",
  email: "member@example.test",
  timezone: "UTC",
};
const outsider: UserRecord = {
  id: "user-outsider",
  displayName: "Outsider",
  email: "outsider@example.test",
  timezone: "UTC",
};

async function setup() {
  const harness = await createD1TestHarness();
  await harness.database.prepare(
    `INSERT INTO users (id, display_name, email, timezone) VALUES
      (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
  ).bind(
    owner.id, owner.displayName, owner.email, owner.timezone,
    member.id, member.displayName, member.email, member.timezone,
    outsider.id, outsider.displayName, outsider.email, outsider.timezone,
  ).run();
  return harness;
}

test("Team creation atomically creates the active owner membership and catalog read-back", async () => {
  const harness = await setup();
  try {
    const team = await createTeam(owner, { name: " Platform " });
    assert.equal(team.name, "Platform");
    assert.equal(team.activeMemberCount, 1);
    assert.equal(team.currentMembership.role, "owner");
    assert.equal(team.currentMembership.status, "active");
    assert.equal(team.members.length, 1);
    assert.equal(team.members[0].userId, owner.id);
    assert.deepEqual((await listTeams(owner)).map((item) => item.id), [team.id]);
    const counts = await harness.database.prepare(
      `SELECT
        (SELECT COUNT(*) FROM teams) AS teams,
        (SELECT COUNT(*) FROM team_memberships) AS memberships,
        (SELECT COUNT(*) FROM team_grants) AS grants`,
    ).first<{ teams: number; memberships: number; grants: number }>();
    assert.deepEqual(counts, { teams: 1, memberships: 1, grants: 0 });
  } finally {
    await harness.dispose();
  }
});

test("Team membership lifecycle is owner-controlled, versioned, and authoritative", async () => {
  const harness = await setup();
  try {
    let team = await createTeam(owner, { name: "Runtime" });
    team = await addTeamMember(owner, team.publicId, { email: member.email.toUpperCase() });
    const membership = team.members.find((item) => item.userId === member.id)!;
    assert.equal(membership.status, "active");
    await assert.rejects(
      () => addTeamMember(owner, team.id, { email: member.email }),
      (error: Error & { status?: number }) => error.status === 409,
    );
    team = await setTeamMembershipStatus(owner, team.id, membership.id, {
      version: membership.version,
      status: "inactive",
    });
    const inactive = team.members.find((item) => item.id === membership.id)!;
    assert.equal(inactive.status, "inactive");
    assert.ok(inactive.deactivatedAt);
    await assert.rejects(
      () => getTeam(member, team.publicId),
      (error: Error & { status?: number }) => error.status === 404,
    );
    await assert.rejects(
      () => setTeamMembershipStatus(owner, team.id, membership.id, {
        version: membership.version,
        status: "active",
      }),
      (error: Error & { status?: number }) => error.status === 409,
    );
    team = await setTeamMembershipStatus(owner, team.id, membership.id, {
      version: inactive.version,
      status: "active",
    });
    const active = team.members.find((item) => item.id === membership.id)!;
    assert.equal(active.status, "active");
    assert.equal((await getTeam(member, team.publicId)).id, team.id);
    team = await deleteTeamMembership(owner, team.id, membership.id, {
      version: active.version,
    });
    assert.equal(team.members.some((item) => item.userId === member.id), false);
  } finally {
    await harness.dispose();
  }
});

test("Team ACL does not leak existence and members cannot mutate membership", async () => {
  const harness = await setup();
  try {
    let team = await createTeam(owner, { name: "Security" });
    team = await addTeamMember(owner, team.id, { email: member.email });
    const membership = team.members.find((item) => item.userId === member.id)!;
    await assert.rejects(
      () => getTeam(outsider, team.id),
      (error: Error & { status?: number }) => error.status === 404,
    );
    await assert.rejects(
      () => getTeam(outsider, "unknown-team"),
      (error: Error & { status?: number }) => error.status === 404,
    );
    await assert.rejects(
      () => setTeamMembershipStatus(member, team.id, membership.id, {
        version: membership.version,
        status: "inactive",
      }),
      (error: Error & { status?: number }) => error.status === 403,
    );
    await assert.rejects(
      () => deleteTeamMembership(owner, team.id, team.currentMembership.id, {
        version: team.currentMembership.version,
      }),
      (error: Error & { status?: number }) => error.status === 400,
    );
  } finally {
    await harness.dispose();
  }
});
