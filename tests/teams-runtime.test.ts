import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ConflictError, NotFoundError, ValidationError } from "../lib/domain";
import { getOrCreateUser } from "../lib/repository";
import {
  addTeamMember,
  createTeam,
  deleteTeamMember,
  getTeam,
  listTeams,
  setTeamMemberStatus,
} from "../lib/teams";
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
  providerAccountKey: `${name}-account`,
  displayName: name,
  email: `${name.toLocaleLowerCase()}@example.test`,
});

test("Team owner creates a catalog entry and manages the membership lifecycle", async () => {
  const owner = await getOrCreateUser(actor("TeamOwner"));
  const member = await getOrCreateUser(actor("TeamMember"));
  const team = await createTeam(owner, { name: "Platform" });

  assert.equal(team.currentMembership.role, "owner");
  assert.equal(team.activeMemberCount, 1);
  assert.equal((await listTeams(owner)).teams[0]?.id, team.id);

  let updated = await addTeamMember(owner, team.id, { email: member.email });
  const membership = updated.members.find((item) => item.userId === member.id)!;
  assert.equal(updated.activeMemberCount, 2);
  assert.equal((await listTeams(member)).teams[0]?.id, team.id);

  updated = await addTeamMember(owner, team.id, { email: member.email });
  assert.equal(
    updated.members.filter((item) => item.userId === member.id).length,
    1,
  );

  updated = await setTeamMemberStatus(owner, team.id, membership.id, {
    version: membership.version,
    status: "inactive",
  });
  const inactive = updated.members.find((item) => item.id === membership.id)!;
  assert.equal(inactive.status, "inactive");
  assert.equal(inactive.deactivatedAt === null, false);
  assert.equal((await listTeams(member)).teams.length, 0);
  await assert.rejects(getTeam(member, team.id), NotFoundError);

  await assert.rejects(
    setTeamMemberStatus(owner, team.id, membership.id, {
      version: membership.version,
      status: "active",
    }),
    ConflictError,
  );
  updated = await setTeamMemberStatus(owner, team.id, membership.id, {
    version: inactive.version,
    status: "active",
  });
  const active = updated.members.find((item) => item.id === membership.id)!;
  assert.equal(active.status, "active");

  updated = await deleteTeamMember(owner, team.id, membership.id, {
    version: active.version,
  });
  assert.equal(updated.members.some((item) => item.userId === member.id), false);
});

test("Team membership management is owner-only and hides Team existence", async () => {
  const owner = await getOrCreateUser(actor("AclOwner"));
  const member = await getOrCreateUser(actor("AclMember"));
  const outsider = await getOrCreateUser(actor("AclOutsider"));
  const team = await createTeam(owner, { name: "Security" });
  await addTeamMember(owner, team.id, { email: member.email });

  await assert.rejects(
    addTeamMember(member, team.id, { email: outsider.email }),
    NotFoundError,
  );
  await assert.rejects(getTeam(outsider, team.id), NotFoundError);
  await assert.rejects(
    setTeamMemberStatus(owner, team.id, team.currentMembership.id, {
      version: team.currentMembership.version,
      status: "inactive",
    }),
    ValidationError,
  );
});
