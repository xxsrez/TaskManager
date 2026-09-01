import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Actor } from "../lib/auth";
import {
  createProject,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
} from "../lib/repository";
import {
  createTeamGrant,
  listTeamGrants,
  revokeTeamGrant,
  updateTeamGrant,
} from "../lib/team-grants";
import {
  addTeamMember,
  createTeam,
  getTeamDetail,
  listTeamMembers,
  listTeams,
  updateTeam,
  updateTeamMembership,
} from "../lib/teams";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = actor("owner", "Persistence Owner");
const memberActor = actor("member", "Persistence Member");
const directActor = actor("direct", "Direct Collaborator");
const allowedTeamTables = new Set(["teams", "team_memberships", "team_grants"]);

let harness: Awaited<ReturnType<typeof createD1TestHarness>> | null = null;

afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

test("the complete Team flow persists only in the three baseline Team tables", async () => {
  harness = await createD1TestHarness();
  const owner = await getOrCreateUser(ownerActor);
  const member = await getOrCreateUser(memberActor);
  const direct = await getOrCreateUser(directActor);
  await createProject(owner, { name: "Persistence Boundary", taskCode: "PB" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Persistence Boundary",
  )!;
  await createTask(owner, { title: "Team-only task", projectId: project.id });
  const task = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Team-only task",
  )!;
  const view = await createSavedView(owner, {
    name: "Team global view",
    query: {},
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: direct.email,
    permission: "viewer",
  });
  const externalBefore = await snapshotTablesOutsideTeamBoundary(harness.database);

  let team = await createTeam(owner, { name: "Persistence Team" });
  team = await addTeamMember(owner, team.team.id, {
    email: member.email,
    teamVersion: team.team.version,
  });
  team = await updateTeam(owner, team.team.publicId, {
    name: "Persistent Team",
    version: team.team.version,
  });
  let memberRow = team.members.find((item) => item.userId === member.id)!;
  team = await updateTeamMembership(owner, team.team.id, memberRow.id, {
    action: "deactivate",
    teamVersion: team.team.version,
    version: memberRow.version,
  });
  memberRow = team.members.find((item) => item.id === memberRow.id)!;
  team = await updateTeamMembership(owner, team.team.id, memberRow.id, {
    action: "reactivate",
    teamVersion: team.team.version,
    version: memberRow.version,
  });

  let projectGrants = await createTeamGrant(owner, {
    teamId: team.team.publicId,
    resourceType: "project",
    resourceId: project.publicId,
    permission: "viewer",
  });
  let projectGrant = projectGrants.grants.find(
    (item) => item.teamId === team.team.id,
  )!;
  projectGrants = await updateTeamGrant(owner, {
    grantId: projectGrant.id,
    version: projectGrant.version,
    action: "role",
    permission: "editor",
  });
  projectGrant = projectGrants.grants.find((item) => item.id === projectGrant.id)!;

  let taskGrants = await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "task",
    resourceId: task.publicId,
    permission: "viewer",
  });
  let taskGrant = taskGrants.grants.find((item) => item.teamId === team.team.id)!;
  taskGrants = await revokeTeamGrant(owner, {
    grantId: taskGrant.id,
    version: taskGrant.version,
  });
  taskGrant = taskGrants.grants.find((item) => item.id === taskGrant.id)!;

  const viewGrants = await createTeamGrant(owner, {
    teamId: team.team.id,
    resourceType: "saved_view",
    resourceId: view.publicId,
    permission: "viewer",
  });
  const viewGrant = viewGrants.grants.find((item) => item.teamId === team.team.id)!;

  assert.equal((await listTeams(owner)).teams.length, 1);
  assert.equal((await listTeams(member)).teams.length, 1);
  assert.equal((await getTeamDetail(owner, team.team.id)).team.name, "Persistent Team");
  assert.equal((await listTeamMembers(owner, team.team.id)).members.length, 2);
  assert.equal(
    (await listTeamGrants(owner, {
      resourceType: "project",
      resourceId: project.id,
    })).grants.find((item) => item.id === projectGrant.id)?.permission,
    "editor",
  );

  const teamRows = await harness.database.prepare(
    `SELECT id, public_id, owner_user_id, name, archived_at, version
     FROM teams`,
  ).all<Record<string, unknown>>();
  const membershipRows = await harness.database.prepare(
    `SELECT id, team_id, user_id, role, status, deactivated_at, version
     FROM team_memberships ORDER BY role, user_id`,
  ).all<Record<string, unknown>>();
  const grantRows = await harness.database.prepare(
    `SELECT id, team_id, resource_type, resource_id, permission,
       granted_by_user_id, revoked_at, version
     FROM team_grants ORDER BY resource_type, resource_id`,
  ).all<Record<string, unknown>>();

  assert.equal(teamRows.results.length, 1);
  assert.equal(teamRows.results[0]!.id, team.team.id);
  assert.equal(teamRows.results[0]!.name, "Persistent Team");
  assert.equal(membershipRows.results.length, 2);
  assert.ok(membershipRows.results.every(
    (row) => row.team_id === team.team.id && row.status === "active",
  ));
  assert.equal(grantRows.results.length, 3);
  assert.equal(
    grantRows.results.find((row) => row.id === projectGrant.id)?.permission,
    "editor",
  );
  assert.equal(
    grantRows.results.find((row) => row.id === taskGrant.id)?.revoked_at,
    taskGrant.revokedAt,
  );
  assert.equal(
    grantRows.results.find((row) => row.id === viewGrant.id)?.revoked_at,
    null,
  );

  assert.deepEqual(
    await snapshotTablesOutsideTeamBoundary(harness.database),
    externalBefore,
  );
});

async function snapshotTablesOutsideTeamBoundary(db: D1Database) {
  const tableList = await db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).all<{ name: string }>();
  const snapshot: Record<string, string[]> = {};
  for (const { name } of tableList.results) {
    if (name.startsWith("_cf_") || allowedTeamTables.has(name)) continue;
    const quotedName = `"${name.replaceAll('"', '""')}"`;
    const rows = await db.prepare(`SELECT * FROM ${quotedName}`).all<Record<string, unknown>>();
    snapshot[name] = rows.results.map(canonicalRow).sort();
  }
  return snapshot;
}

function canonicalRow(row: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(
    Object.entries(row).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function actor(key: string, displayName: string): Actor {
  return {
    provider: "chatgpt",
    providerAccountKey: `team-persistence-${key}`,
    displayName,
    email: `${key}@team-persistence.example.test`,
  };
}
