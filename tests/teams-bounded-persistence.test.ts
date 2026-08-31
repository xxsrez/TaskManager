import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createProject,
  createRelease,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  loadAccessibleProject,
  loadAccessibleTask,
  moveTask,
} from "../lib/repository";
import {
  addTeamMember,
  createTeam,
  createTeamGrant,
  deleteTeamMembership,
  getTeamDetail,
  listTeamGrants,
  listTeamMembers,
  listTeams,
  revokeTeamGrant,
  updateTeamGrant,
  updateTeamMembership,
} from "../lib/teams";
import { createWorkflowStatus } from "../lib/workflow-statuses";
import { createD1TestHarness } from "./helpers/d1";

const teamTables = ["team_grants", "team_memberships", "teams"] as const;

type TableSnapshot = {
  count: number;
  digest: string;
  rows: string[];
};

test("Teams persist only Team rows across the complete membership and grant lifecycle", async () => {
  const harness = await createD1TestHarness();
  const database = harness.database;

  try {
    const owner = await getOrCreateUser({
      provider: "chatgpt",
      providerAccountKey: "teams-bounded-owner",
      displayName: "Teams Bounded Owner",
      email: "teams-bounded-owner@example.test",
    });
    const member = await getOrCreateUser({
      provider: "chatgpt",
      providerAccountKey: "teams-bounded-member",
      displayName: "Teams Bounded Member",
      email: "teams-bounded-member@example.test",
    });
    const removableMember = await getOrCreateUser({
      provider: "chatgpt",
      providerAccountKey: "teams-bounded-removable-member",
      displayName: "Teams Bounded Removable Member",
      email: "teams-bounded-removable-member@example.test",
    });

    await createWorkflowStatus(owner, {
      name: "Teams bounded started",
      category: "started",
      color: "#6750a4",
    });
    await createProject(owner, {
      name: "Teams bounded source",
      taskCode: "TBS",
    });
    await createProject(owner, {
      name: "Teams bounded target",
      taskCode: "TBT",
    });
    const fixtureSnapshot = await getSnapshot(owner);
    const sourceProject = fixtureSnapshot.projects.find(
      (project) => project.name === "Teams bounded source",
    );
    const targetProject = fixtureSnapshot.projects.find(
      (project) => project.name === "Teams bounded target",
    );
    assert.ok(sourceProject);
    assert.ok(targetProject);

    const release = await createRelease(owner, {
      name: "Teams bounded release",
      projectId: targetProject.id,
    });
    const movedIdentity = await createTask(owner, {
      title: "Teams bounded moved task",
      projectId: sourceProject.id,
    });
    const beforeMove = await loadAccessibleTask(owner.id, movedIdentity.id);
    const movedTask = await moveTask(owner, beforeMove.id, {
      version: beforeMove.version,
      targetProjectId: targetProject.id,
      releaseId: release.id,
    });
    await createTask(owner, {
      title: "Teams bounded resident task",
      projectId: targetProject.id,
      releaseId: release.id,
    });
    await createSavedView(owner, {
      name: "Teams bounded global view",
      query: {},
      display: { layout: "list" },
    });
    await createSavedView(owner, {
      name: "Teams bounded project view",
      scopeProjectId: targetProject.id,
      query: {},
      display: { layout: "board" },
    });
    await grantAccess(owner, {
      resourceType: "project",
      resourceId: targetProject.id,
      email: member.email,
      permission: "viewer",
    });

    const target = await loadAccessibleProject(owner.id, targetProject.id);
    assert.equal(target.id, targetProject.id);
    assert.equal(movedTask.projectId, targetProject.id);
    assert.equal(movedTask.releaseId, release.id);
    assert.notEqual(movedTask.identifier, beforeMove.identifier);

    const fixtureCounts = await counts(database, [
      "access_grants",
      "projects",
      "releases",
      "saved_views",
      "task_identifier_aliases",
      "tasks",
      "users",
      "workflow_statuses",
    ]);
    assert.deepEqual(fixtureCounts, {
      access_grants: 1,
      projects: 2,
      releases: 1,
      saved_views: 2,
      task_identifier_aliases: 1,
      tasks: 2,
      users: 3,
      workflow_statuses: 19,
    });

    const applicationTables = await listApplicationTables(database);
    for (const requiredTable of [...teamTables, ...Object.keys(fixtureCounts)]) {
      assert.ok(applicationTables.includes(requiredTable), `${requiredTable} is migrated`);
    }
    const before = await snapshotTables(database, applicationTables);
    assert.deepEqual(
      teamTables.map((table) => before[table]?.count),
      [0, 0, 0],
    );

    const created = await createTeam(owner, { name: "Bounded Persistence Team" });
    const createdDetail = await getTeamDetail(owner, created.team.publicId);
    assert.equal(createdDetail.team.id, created.team.id);
    assert.equal(createdDetail.members.length, 1);
    assert.equal((await listTeams(owner)).teams[0]?.id, created.team.id);

    const added = await addTeamMember(owner, created.team.publicId, {
      email: member.email,
    });
    const inactive = await updateTeamMembership(
      owner,
      created.team.publicId,
      added.membership.id,
      { status: "inactive", version: added.membership.version },
    );
    assert.equal(inactive.membership.status, "inactive");
    assert.equal(inactive.membership.version, 2);
    const reactivatedMember = await updateTeamMembership(
      owner,
      created.team.publicId,
      inactive.membership.id,
      { status: "active", version: inactive.membership.version },
    );
    assert.equal(reactivatedMember.membership.status, "active");
    assert.equal(reactivatedMember.membership.version, 3);

    const removableMembership = await addTeamMember(owner, created.team.publicId, {
      email: removableMember.email,
    });
    await assert.rejects(
      deleteTeamMembership(
        owner,
        created.team.publicId,
        removableMembership.membership.id,
        { version: removableMembership.membership.version + 1 },
      ),
      /Team membership was changed in another session/,
    );
    assert.ok(
      (await listTeamMembers(owner, created.team.publicId)).members.some(
        (membership) =>
          membership.id === removableMembership.membership.id
          && membership.version === removableMembership.membership.version,
      ),
    );
    const deletedMembership = await deleteTeamMembership(
      owner,
      created.team.publicId,
      removableMembership.membership.id,
      { version: removableMembership.membership.version },
    );
    assert.equal(deletedMembership.deleted, true);
    assert.deepEqual(deletedMembership.membership, removableMembership.membership);
    assert.ok(
      !(await listTeamMembers(owner, created.team.publicId)).members.some(
        (membership) => membership.id === removableMembership.membership.id,
      ),
    );

    const createdGrant = await createTeamGrant(owner, {
      teamId: created.team.publicId,
      resourceType: "project",
      resourceId: targetProject.id,
      permission: "viewer",
    });
    assert.equal(createdGrant.grant.version, 1);
    const updatedGrant = await updateTeamGrant(owner, createdGrant.grant.id, {
      permission: "editor",
      version: createdGrant.grant.version,
    });
    assert.equal(updatedGrant.grant.permission, "editor");
    assert.equal(updatedGrant.grant.version, 2);
    const revokedGrant = await revokeTeamGrant(owner, updatedGrant.grant.id, {
      version: updatedGrant.grant.version,
    });
    assert.equal(revokedGrant.grant.version, 3);
    assert.ok(revokedGrant.grant.revokedAt);
    const revokedReadBack = await listTeamGrants(
      owner,
      created.team.publicId,
      "project",
      targetProject.id,
      true,
    );
    assert.equal(revokedReadBack.grants[0]?.revokedAt, revokedGrant.grant.revokedAt);

    const reactivatedGrant = await createTeamGrant(owner, {
      teamId: created.team.publicId,
      resourceType: "project",
      resourceId: targetProject.id,
      permission: "manager",
      version: revokedGrant.grant.version,
    });
    assert.equal(reactivatedGrant.grant.id, createdGrant.grant.id);
    assert.equal(reactivatedGrant.grant.permission, "manager");
    assert.equal(reactivatedGrant.grant.revokedAt, null);
    assert.equal(reactivatedGrant.grant.version, 4);

    const finalDetail = await getTeamDetail(owner, created.team.publicId);
    const finalMembers = await listTeamMembers(owner, created.team.publicId);
    const finalGrants = await listTeamGrants(owner, created.team.publicId);
    assert.equal(finalDetail.team.version, 1);
    assert.deepEqual(
      finalMembers.members.map((membership) => ({
        id: membership.id,
        role: membership.role,
        status: membership.status,
        version: membership.version,
      })),
      [
        {
          id: added.membership.id,
          role: "member",
          status: "active",
          version: 3,
        },
        {
          id: created.membership.id,
          role: "owner",
          status: "active",
          version: 1,
        },
      ],
    );
    assert.deepEqual(finalGrants.grants, [reactivatedGrant.grant]);

    const persistedTeams = await database
      .prepare(
        `SELECT id, public_id, owner_user_id, name, archived_at, version
         FROM teams ORDER BY id`,
      )
      .all<Record<string, unknown>>();
    const persistedMemberships = await database
      .prepare(
        `SELECT id, team_id, user_id, role, status, deactivated_at, version
         FROM team_memberships ORDER BY role DESC, id`,
      )
      .all<Record<string, unknown>>();
    const persistedGrants = await database
      .prepare(
        `SELECT id, team_id, resource_type, resource_id, permission,
                granted_by_user_id, revoked_at, version
         FROM team_grants ORDER BY id`,
      )
      .all<Record<string, unknown>>();
    assert.deepEqual(persistedTeams.results, [{
      id: created.team.id,
      public_id: created.team.publicId,
      owner_user_id: owner.id,
      name: "Bounded Persistence Team",
      archived_at: null,
      version: 1,
    }]);
    assert.equal(persistedMemberships.results.length, 2);
    assert.deepEqual(persistedMemberships.results.map((row) => ({
      team_id: row.team_id,
      user_id: row.user_id,
      role: row.role,
      status: row.status,
      deactivated_at: row.deactivated_at,
      version: row.version,
    })), [
      {
        team_id: created.team.id,
        user_id: owner.id,
        role: "owner",
        status: "active",
        deactivated_at: null,
        version: 1,
      },
      {
        team_id: created.team.id,
        user_id: member.id,
        role: "member",
        status: "active",
        deactivated_at: null,
        version: 3,
      },
    ]);
    assert.deepEqual(persistedGrants.results, [{
      id: createdGrant.grant.id,
      team_id: created.team.id,
      resource_type: "project",
      resource_id: targetProject.id,
      permission: "manager",
      granted_by_user_id: owner.id,
      revoked_at: null,
      version: 4,
    }]);

    const after = await snapshotTables(database, applicationTables);
    const changedTables = applicationTables.filter(
      (table) => before[table]?.digest !== after[table]?.digest,
    );
    assert.deepEqual(changedTables, [...teamTables]);
    for (const table of applicationTables.filter(
      (name) => !(teamTables as readonly string[]).includes(name),
    )) {
      assert.deepEqual(after[table], before[table], `${table} stayed byte-logically stable`);
    }
    assert.deepEqual(
      teamTables.map((table) => after[table]?.count),
      [1, 2, 1],
    );
  } finally {
    await harness.dispose();
  }
});

async function listApplicationTables(database: D1Database): Promise<string[]> {
  const rows = await database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_cf_%'
       ORDER BY name`,
    )
    .all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

async function snapshotTables(
  database: D1Database,
  tables: readonly string[],
): Promise<Record<string, TableSnapshot>> {
  const snapshots: Record<string, TableSnapshot> = {};
  for (const table of tables) {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const result = await database.prepare(`SELECT * FROM ${quoted}`).all();
    const rows = result.results.map(stableStringify).sort();
    snapshots[table] = {
      count: rows.length,
      digest: createHash("sha256").update(rows.join("\n")).digest("hex"),
      rows,
    };
  }
  return snapshots;
}

async function counts(
  database: D1Database,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const entries = await Promise.all(tables.map(async (table) => {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const row = await database
      .prepare(`SELECT COUNT(*) AS count FROM ${quoted}`)
      .first<{ count: number }>();
    return [table, Number(row?.count ?? 0)] as const;
  }));
  return Object.fromEntries(entries);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
