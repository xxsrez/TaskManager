import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationNames = readdirSync(new URL("../drizzle", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();

function migrationSql(name: string) {
  return readFileSync(
    new URL(`../drizzle/${name}`, import.meta.url),
    "utf8",
  ).replaceAll("--> statement-breakpoint", "");
}

function applyMigrations(
  database: DatabaseSync,
  predicate: (name: string) => boolean = () => true,
) {
  for (const migration of migrationNames.filter(predicate)) {
    database.exec(migrationSql(migration));
  }
}

test("Teams baseline migration preserves existing state and creates empty tables", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, (name) => name < "0038_purple_the_call.sql");
  database.exec(`
    INSERT INTO users (id, display_name, email)
    VALUES ('owner-1', 'Owner One', 'owner@example.test');
    INSERT INTO projects
      (id, public_id, owner_user_id, creator_user_id, name, task_code)
    VALUES ('project-1', 'project-public-1', 'owner-1', 'owner-1', 'Existing', 'EX');
    INSERT INTO access_grants
      (id, resource_type, resource_id, owner_user_id, grantee_user_id,
       granted_by_user_id, permission)
    VALUES ('grant-1', 'project', 'project-1', 'owner-1', 'owner-1',
      'owner-1', 'viewer');
  `);

  applyMigrations(database, (name) => name === "0038_purple_the_call.sql");

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get()!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM projects").get()!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM access_grants").get()!.count, 1);
  for (const table of ["teams", "team_memberships", "team_grants"]) {
    assert.equal(
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count,
      0,
      table,
    );
  }

  assert.deepEqual(
    database.prepare("PRAGMA table_info(teams)").all().map((row) => row.name),
    [
      "id",
      "public_id",
      "owner_user_id",
      "name",
      "archived_at",
      "version",
      "created_at",
      "updated_at",
    ],
  );
  assert.ok(
    database.prepare("PRAGMA index_list(team_memberships)").all()
      .some((row) => row.name === "idx_team_memberships_team_user" && row.unique === 1),
  );
  assert.ok(
    database.prepare("PRAGMA index_list(team_grants)").all()
      .some((row) => row.name === "idx_team_grants_resource_active"),
  );
  database.close();
});

test("Teams baseline enforces membership and grant lifecycle domains", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.exec(`
    INSERT INTO users (id, display_name, email) VALUES
      ('owner-1', 'Owner One', 'owner@example.test'),
      ('member-1', 'Member One', 'member@example.test');
  `);

  assert.throws(
    () => database.exec(`INSERT INTO teams
      (id, public_id, owner_user_id, name)
      VALUES ('team-empty', 'team-public-empty', 'owner-1', '   ')`),
    /CHECK constraint failed: teams_name_check/,
  );
  database.exec(`INSERT INTO teams
    (id, public_id, owner_user_id, name)
    VALUES ('team-1', 'team-public-1', 'owner-1', 'Platform')`);
  database.exec(`INSERT INTO team_memberships
    (id, team_id, user_id, role, status)
    VALUES ('membership-owner', 'team-1', 'owner-1', 'owner', 'active')`);
  assert.throws(
    () => database.exec(`INSERT INTO team_memberships
      (id, team_id, user_id, role, status)
      VALUES ('membership-owner-duplicate', 'team-1', 'owner-1', 'member', 'active')`),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => database.exec(`INSERT INTO team_memberships
      (id, team_id, user_id, role, status)
      VALUES ('membership-invalid-role', 'team-1', 'member-1', 'manager', 'active')`),
    /CHECK constraint failed: team_memberships_role_check/,
  );
  assert.throws(
    () => database.exec(`INSERT INTO team_memberships
      (id, team_id, user_id, role, status)
      VALUES ('membership-invalid-lifecycle', 'team-1', 'member-1', 'member', 'inactive')`),
    /CHECK constraint failed: team_memberships_lifecycle_check/,
  );
  database.exec(`INSERT INTO team_memberships
    (id, team_id, user_id, role, status, deactivated_at)
    VALUES ('membership-member', 'team-1', 'member-1', 'member', 'inactive', CURRENT_TIMESTAMP)`);

  database.exec(`INSERT INTO team_grants
    (id, team_id, resource_type, resource_id, permission, granted_by_user_id)
    VALUES ('grant-project', 'team-1', 'project', 'project-1', 'manager', 'owner-1')`);
  assert.throws(
    () => database.exec(`INSERT INTO team_grants
      (id, team_id, resource_type, resource_id, permission, granted_by_user_id)
      VALUES ('grant-task-invalid', 'team-1', 'task', 'task-1', 'manager', 'owner-1')`),
    /CHECK constraint failed: team_grants_resource_permission_check/,
  );
  database.exec(`INSERT INTO team_grants
    (id, team_id, resource_type, resource_id, permission, granted_by_user_id)
    VALUES ('grant-task', 'team-1', 'task', 'task-1', 'editor', 'owner-1')`);

  database.exec("DELETE FROM teams WHERE id = 'team-1'");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM team_memberships").get()!.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM team_grants").get()!.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get()!.count, 2);
  database.close();
});
