import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import {
  createProject,
  getOrCreateUser,
  getSnapshot,
} from "../lib/repository";
import {
  grantTeamAccess,
  revokeTeamAccess,
  updateTeamAccess,
} from "../lib/team-grants";
import {
  addTeamMember,
  createTeam,
  deleteTeamMember,
  setTeamMemberStatus,
} from "../lib/teams";
import { createD1TestHarness } from "./helpers/d1";

const teamTables = new Set(["teams", "team_memberships", "team_grants"]);
let database: D1Database;
let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => {
  await dispose?.();
});

const actor = (name: string) => ({
  provider: "chatgpt" as const,
  providerAccountKey: `${name}-persistence-account`,
  displayName: name,
  email: `${name.toLocaleLowerCase()}-persistence@example.test`,
});

test("Team lifecycle changes persistent state only in the three baseline Team tables", async () => {
  const owner = await getOrCreateUser(actor("BoundaryOwner"));
  const member = await getOrCreateUser(actor("BoundaryMember"));
  await createProject(owner, { name: "Boundary Project", taskCode: "BP" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Boundary Project")!;
  const beforeState = await nonTeamTableState(database);

  const team = await createTeam(owner, { name: "Boundary Team" });
  let current = await addTeamMember(owner, team.id, { email: member.email });
  let membership = current.members.find((item) => item.userId === member.id)!;
  current = await setTeamMemberStatus(owner, team.id, membership.id, {
    version: membership.version,
    status: "inactive",
  });
  membership = current.members.find((item) => item.id === membership.id)!;
  current = await setTeamMemberStatus(owner, team.id, membership.id, {
    version: membership.version,
    status: "active",
  });
  membership = current.members.find((item) => item.id === membership.id)!;

  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  });
  let grant = (await database.prepare(
    "SELECT id, version FROM team_grants WHERE team_id = ? AND revoked_at IS NULL",
  ).bind(team.id).first<{ id: string; version: number }>())!;
  await updateTeamAccess(owner, grant.id, {
    version: grant.version,
    permission: "editor",
  });
  grant = (await database.prepare(
    "SELECT id, version FROM team_grants WHERE id = ?",
  ).bind(grant.id).first<{ id: string; version: number }>())!;
  await revokeTeamAccess(owner, grant.id, { version: grant.version });
  await deleteTeamMember(owner, team.id, membership.id, { version: membership.version });

  const afterState = await nonTeamTableState(database);
  assert.deepEqual(afterState, beforeState);
  assert.deepEqual(await teamTableCounts(database), {
    team_grants: 1,
    team_memberships: 1,
    teams: 1,
  });
});

test("Team runtime source contains no persistence target outside the baseline tables", () => {
  for (const relativePath of ["../lib/teams.ts", "../lib/team-grants.ts"]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const targets = [...source.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi)]
      .map((match) => match[1]!.toLocaleLowerCase())
      .filter((target) => target !== "set");
    assert.ok(targets.length > 0, `${relativePath} must contain its explicit D1 mutations`);
    assert.deepEqual([...new Set(targets)].sort(),
      relativePath.endsWith("teams.ts")
        ? ["team_memberships", "teams"]
        : ["team_grants"]);
    assert.doesNotMatch(source, /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER)\b/i);
  }
});

async function nonTeamTableState(db: D1Database) {
  const tables = await db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       AND lower(name) NOT LIKE '\\_cf\\_%' ESCAPE '\\'
     ORDER BY name`,
  ).all<{ name: string }>();
  const state: Record<string, string[]> = {};
  for (const { name } of tables.results) {
    if (teamTables.has(name)) continue;
    const safeName = name.replaceAll('"', '""');
    const rows = await db.prepare(`SELECT * FROM "${safeName}"`).all<Record<string, unknown>>();
    state[name] = rows.results.map(stableRow).sort();
  }
  return state;
}

async function teamTableCounts(db: D1Database) {
  const counts: Record<string, number> = {};
  for (const name of [...teamTables].sort()) {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).first<{ count: number }>();
    counts[name] = Number(row?.count ?? 0);
  }
  return counts;
}

function stableRow(row: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(
    Object.entries(row).sort(([left], [right]) => left.localeCompare(right)),
  ));
}
