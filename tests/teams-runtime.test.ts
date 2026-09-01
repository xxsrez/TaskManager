import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ConflictError, NotFoundError } from "../lib/domain";
import { getOrCreateUser } from "../lib/repository";
import {
  addTeamMembership,
  createTeam,
  deleteTeamMembership,
  getTeam,
  listTeams,
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

test("Team creation atomically creates the active owner membership", async () => {
  const owner = await getOrCreateUser(actor("TeamOwner"));
  const team = await createTeam(owner, { name: " Platform " });
  assert.equal(team.name, "Platform");
  assert.equal(team.ownerUserId, owner.id);
  assert.equal(team.currentMembership.role, "owner");
  assert.equal(team.currentMembership.status, "active");
  assert.equal(team.activeMemberCount, 1);
  assert.equal(team.canManageMembers, true);

  const counts = await database.batch<{ count: number }>([
    database.prepare("SELECT COUNT(*) AS count FROM teams WHERE id = ?").bind(team.id),
    database.prepare("SELECT COUNT(*) AS count FROM team_memberships WHERE team_id = ?").bind(team.id),
    database.prepare("SELECT COUNT(*) AS count FROM team_grants WHERE team_id = ?").bind(team.id),
  ]);
  assert.deepEqual(counts.map((result) => Number(result.results[0]?.count)), [1, 1, 0]);
});

test("Team reads hide existence from non-members and members cannot manage composition", async () => {
  const owner = await getOrCreateUser(actor("AclOwner"));
  const member = await getOrCreateUser(actor("AclMember"));
  const outsider = await getOrCreateUser(actor("AclOutsider"));
  const team = await createTeam(owner, { name: "ACL Team" });
  await addTeamMembership(owner, team.id, { email: member.email });

  const memberTeam = await getTeam(member, team.publicId);
  assert.equal(memberTeam.currentMembership.role, "member");
  assert.equal(memberTeam.canManageMembers, false);
  assert.equal(memberTeam.members.every((entry) => entry.status === "active"), true);
  assert.equal((await listTeams(outsider)).teams.length, 0);
  await assert.rejects(getTeam(outsider, team.id), NotFoundError);
  await assert.rejects(
    addTeamMembership(member, team.id, { email: outsider.email }),
    NotFoundError,
  );
});

test("membership lifecycle is duplicate-safe, versioned, reactivatable, and deletable", async () => {
  const owner = await getOrCreateUser(actor("LifecycleOwner"));
  const member = await getOrCreateUser(actor("LifecycleMember"));
  let team = await createTeam(owner, { name: "Lifecycle" });
  team = await addTeamMembership(owner, team.id, { email: member.email });
  let membership = team.members.find((entry) => entry.userId === member.id)!;
  assert.equal(membership.status, "active");
  await assert.rejects(
    addTeamMembership(owner, team.id, { email: member.email }),
    ConflictError,
  );

  team = await setTeamMembershipStatus(owner, team.id, membership.id, {
    version: membership.version,
    status: "inactive",
  });
  membership = team.members.find((entry) => entry.id === membership.id)!;
  assert.equal(membership.status, "inactive");
  assert.ok(membership.deactivatedAt);
  assert.equal((await listTeams(member)).teams.length, 0);
  await assert.rejects(
    setTeamMembershipStatus(owner, team.id, membership.id, {
      version: membership.version - 1,
      status: "active",
    }),
    ConflictError,
  );

  team = await setTeamMembershipStatus(owner, team.id, membership.id, {
    version: membership.version,
    status: "active",
  });
  membership = team.members.find((entry) => entry.id === membership.id)!;
  assert.equal(membership.status, "active");
  assert.equal(membership.deactivatedAt, null);

  team = await deleteTeamMembership(owner, team.id, membership.id, {
    version: membership.version,
  });
  assert.equal(team.members.some((entry) => entry.id === membership.id), false);
  await assert.rejects(
    deleteTeamMembership(owner, team.id, membership.id, { version: membership.version }),
    NotFoundError,
  );
  team = await addTeamMembership(owner, team.id, { email: member.email });
  assert.equal(team.members.filter((entry) => entry.userId === member.id).length, 1);
});
