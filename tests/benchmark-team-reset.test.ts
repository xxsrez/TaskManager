import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/admin/benchmark/teams/reset/route";
import { configureRuntimeEnvironment } from "../lib/runtime-environment";
import { createD1TestHarness } from "./helpers/d1";

const resetUrl = "https://task-manager-uat.example.test/api/admin/benchmark/teams/reset";
const resetToken = "benchmark-reset-test-token";

const enabledEnvironment = {
  TASK_MANAGER_ATTACHMENT_SCOPE: "uat",
  TASK_MANAGER_BENCHMARK_TEAM_RESET_ENABLED: "true",
  TASK_MANAGER_BENCHMARK_TEAM_RESET_TOKEN: resetToken,
};

for (const rejected of [
  {
    name: "non-UAT scope",
    environment: { ...enabledEnvironment, TASK_MANAGER_ATTACHMENT_SCOPE: "production" },
  },
  {
    name: "disabled feature flag",
    environment: {
      ...enabledEnvironment,
      TASK_MANAGER_BENCHMARK_TEAM_RESET_ENABLED: "false",
    },
  },
  {
    name: "missing configured token",
    environment: {
      TASK_MANAGER_ATTACHMENT_SCOPE: "uat",
      TASK_MANAGER_BENCHMARK_TEAM_RESET_ENABLED: "true",
    },
  },
  {
    name: "wrong bearer token",
    environment: enabledEnvironment,
    authorization: "Bearer wrong-token",
  },
] as const) {
  test(`benchmark Team reset rejects ${rejected.name} without touching D1`, async () => {
    const harness = await createD1TestHarness(rejected.environment);
    try {
      await seedTeamState(harness.database);
      const before = await teamCounts(harness.database);
      const response = await POST(
        resetRequest(rejected.authorization ?? `Bearer ${resetToken}`),
      );

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Not found" });
      assert.deepEqual(await teamCounts(harness.database), before);
      assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    } finally {
      await harness.dispose();
    }
  });
}

test("benchmark Team reset rejects a missing Authorization header", async () => {
  const harness = await createD1TestHarness(enabledEnvironment);
  try {
    await seedTeamState(harness.database);
    const response = await POST(new Request(resetUrl, { method: "POST" }));

    assert.equal(response.status, 404);
    assert.deepEqual(await teamCounts(harness.database), {
      teamGrants: 1,
      teamMemberships: 1,
      teams: 1,
    });
  } finally {
    await harness.dispose();
  }
});

test("benchmark Team reset deletes only the three Team tables in FK-safe order and is idempotent", async () => {
  const harness = await createD1TestHarness(enabledEnvironment);
  try {
    await seedTeamState(harness.database);
    const userBefore = await firstRow(
      harness.database,
      "SELECT * FROM users WHERE id = ?",
      "benchmark-owner",
    );
    const recordedSql: string[] = [];
    const database = new Proxy(harness.database, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            recordedSql.push(query.replace(/\s+/g, " ").trim());
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    configureRuntimeEnvironment({ DB: database, ...enabledEnvironment });

    const firstResponse = await POST(resetRequest(`Bearer ${resetToken}`));
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(await firstResponse.json(), {
      data: {
        deleted: { teamGrants: 1, teamMemberships: 1, teams: 1 },
        remaining: { teamGrants: 0, teamMemberships: 0, teams: 0 },
      },
    });
    assert.deepEqual(recordedSql, [
      "DELETE FROM team_grants",
      "DELETE FROM team_memberships",
      "DELETE FROM teams",
      "SELECT COUNT(*) AS count FROM team_grants",
      "SELECT COUNT(*) AS count FROM team_memberships",
      "SELECT COUNT(*) AS count FROM teams",
    ]);
    assert.deepEqual(
      await firstRow(
        harness.database,
        "SELECT * FROM users WHERE id = ?",
        "benchmark-owner",
      ),
      userBefore,
    );

    recordedSql.length = 0;
    const secondResponse = await POST(resetRequest(`Bearer ${resetToken}`));
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(await secondResponse.json(), {
      data: {
        deleted: { teamGrants: 0, teamMemberships: 0, teams: 0 },
        remaining: { teamGrants: 0, teamMemberships: 0, teams: 0 },
      },
    });
    assert.deepEqual(recordedSql, [
      "DELETE FROM team_grants",
      "DELETE FROM team_memberships",
      "DELETE FROM teams",
      "SELECT COUNT(*) AS count FROM team_grants",
      "SELECT COUNT(*) AS count FROM team_memberships",
      "SELECT COUNT(*) AS count FROM teams",
    ]);
  } finally {
    await harness.dispose();
  }
});

function resetRequest(authorization?: string) {
  return new Request(resetUrl, {
    method: "POST",
    headers: authorization ? { authorization } : undefined,
  });
}

async function seedTeamState(database: D1Database) {
  await database.batch([
    database.prepare(
      "INSERT INTO users (id, display_name, email) VALUES (?, ?, ?)",
    ).bind("benchmark-owner", "Benchmark Owner", "benchmark-owner@example.test"),
    database.prepare(
      "INSERT INTO teams (id, public_id, owner_user_id, name) VALUES (?, ?, ?, ?)",
    ).bind("benchmark-team", "benchmark-team-public", "benchmark-owner", "Benchmark Team"),
    database.prepare(
      "INSERT INTO team_memberships (id, team_id, user_id, role, status) VALUES (?, ?, ?, ?, ?)",
    ).bind("benchmark-membership", "benchmark-team", "benchmark-owner", "owner", "active"),
    database.prepare(
      "INSERT INTO team_grants (id, team_id, resource_type, resource_id, permission, granted_by_user_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      "benchmark-grant",
      "benchmark-team",
      "project",
      "benchmark-project",
      "manager",
      "benchmark-owner",
    ),
  ]);
}

async function teamCounts(database: D1Database) {
  const results = await database.batch([
    database.prepare("SELECT COUNT(*) AS count FROM team_grants"),
    database.prepare("SELECT COUNT(*) AS count FROM team_memberships"),
    database.prepare("SELECT COUNT(*) AS count FROM teams"),
  ]);
  const counts = results.map((result) =>
    Number((result.results[0] as { count?: unknown } | undefined)?.count),
  );
  return {
    teamGrants: counts[0],
    teamMemberships: counts[1],
    teams: counts[2],
  };
}

async function firstRow(
  database: D1Database,
  query: string,
  value: string,
) {
  return database.prepare(query).bind(value).first<Record<string, unknown>>();
}
