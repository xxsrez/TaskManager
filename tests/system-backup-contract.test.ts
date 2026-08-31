import assert from "node:assert/strict";
import test from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  systemBackupD1TableContracts,
  systemBackupExactTableContracts,
  systemBackupR2ObjectClassContracts,
  systemBackupUnknownR2ObjectPolicy,
} from "../lib/system-backup-contract";
import {
  projectBackupTableDefinitions,
  projectBackupTableNames,
} from "../lib/project-backup-format";
import {
  authenticationCapabilityDeleteOrder,
  liveTableDeleteOrder,
} from "../lib/system-backup-format";

const dormantTeamsBaselineTables = new Set([
  "teams",
  "team_memberships",
  "team_grants",
]);

test("the system backup contract classifies every participating D1 table and column", () => {
  const liveTables = Object.values(schema)
    .flatMap((value) => {
      try {
        const columns = getTableColumns(value as never) as Record<
          string,
          { name: string }
        >;
        return [{
          name: getTableName(value as never) as string,
          columns: Object.values(columns)
            .map((column) => column.name)
            .sort(),
        }];
      } catch {
        return [];
      }
    })
    .filter((table) => !dormantTeamsBaselineTables.has(table.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const classifiedTables = systemBackupD1TableContracts
    .map((table) => ({ name: table.name, columns: [...table.columns].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));

  assert.deepEqual(classifiedTables, liveTables);
  for (const table of systemBackupD1TableContracts) {
    assert.equal(new Set(table.columns).size, table.columns.length, table.name);
    assert.ok(table.reason.length > 0, table.name);
    for (const column of table.columns) {
      assert.ok(
        table.columnPolicies[column] ?? table.policy,
        `${table.name}.${column} is not classified`,
      );
    }
  }
});

test("the current full snapshot has one explicit D1 policy for every table", () => {
  assert.deepEqual(
    systemBackupExactTableContracts.map((table) => table.name),
    [
      "users",
      "user_identities",
      "workflow_statuses",
      "projects",
      "releases",
      "tasks",
      "task_identifier_aliases",
      "stored_files",
      "attachments",
      "attachment_migration_outcomes",
      "comments",
      "comment_attachment_refs",
      "comment_migration_outcomes",
      "activity_events",
      "activity_migration_outcomes",
      "comment_reactions",
      "label_groups",
      "labels",
      "task_labels",
      "task_relations",
      "saved_views",
      "external_records",
      "access_grants",
      "task_sequences",
    ],
  );
  assert.equal(
    systemBackupExactTableContracts
      .find((table) => table.name === "attachments")
      ?.columns.includes("stored_file_id"),
    true,
  );
  assert.equal(
    systemBackupD1TableContracts
      .find((table) => table.name === "task_label_group_values")
      ?.policy,
    "rebuild",
  );
  assert.deepEqual(
    systemBackupD1TableContracts
      .filter((table) => table.policy === "reset")
      .map((table) => table.name),
    [
      "workspace_sync_sequences",
      "workspace_change_events",
      "workspace_sync_maintenance",
      "workspace_sync_invalidations",
      "entity_purge_jobs",
    ],
  );
  assert.deepEqual(
    systemBackupD1TableContracts
      .filter((table) => table.policy === "revoke")
      .map((table) => table.name),
    [
      "oauth_authorization_requests",
      "oauth_authorization_codes",
      "oauth_access_tokens",
      "oauth_refresh_tokens",
      "oauth_grants",
      "oauth_registered_clients",
      "api_credentials",
    ],
  );
  assert.deepEqual(
    systemBackupD1TableContracts
      .filter((table) => table.policy === "excluded")
      .map((table) => table.name),
    [
      "admin_import_sessions",
      "admin_import_rows",
      "system_backup_jobs",
      "system_backup_rows",
      "system_backup_parts",
      "system_backup_objects",
      "user_import_sessions",
      "user_import_rows",
    ],
  );
});

test("dormant Teams baseline stays outside current backup and restore behavior", () => {
  assert.deepEqual(
    systemBackupD1TableContracts
      .filter((table) => dormantTeamsBaselineTables.has(table.name))
      .map((table) => table.name),
    [],
  );
});

test("derived delete orders remain dependency-safe", () => {
  const position = (name: string) => liveTableDeleteOrder.indexOf(name as never);
  assert.ok(position("comment_attachment_refs") < position("comment_reactions"));
  assert.ok(position("comment_reactions") < position("comments"));
  assert.ok(position("attachments") < position("stored_files"));
  assert.ok(position("task_labels") < position("tasks"));
  assert.ok(position("tasks") < position("projects"));
  assert.ok(position("projects") < position("users"));
  assert.deepEqual(authenticationCapabilityDeleteOrder, [
    "oauth_authorization_requests",
    "oauth_authorization_codes",
    "oauth_access_tokens",
    "oauth_refresh_tokens",
    "oauth_grants",
    "oauth_registered_clients",
    "api_credentials",
  ]);
});

test("the R2 contract covers every managed namespace and rejects unknown keys", () => {
  assert.deepEqual(
    systemBackupR2ObjectClassContracts.map((entry) => ({
      binding: entry.binding,
      namespace: entry.namespace,
      policy: entry.policy,
      keyPolicy: entry.keyPolicy,
    })),
    [
      {
        binding: "ATTACHMENTS",
        namespace: "stored-files",
        policy: "exact",
        keyPolicy: "environment",
      },
      {
        binding: "ATTACHMENTS",
        namespace: "attachments",
        policy: "exact",
        keyPolicy: "environment",
      },
      {
        binding: "ATTACHMENTS",
        namespace: "backup-staging",
        policy: "reset",
        keyPolicy: "environment",
      },
    ],
  );
  assert.equal(systemBackupUnknownR2ObjectPolicy, "reject");
});

test("Project backup keeps its explicit scope when the system registry grows", () => {
  assert.deepEqual(
    projectBackupTableDefinitions.map((table) => table.name),
    [...projectBackupTableNames],
  );
  assert.equal(
    projectBackupTableDefinitions
      .find((table) => table.name === "attachments")
      ?.columns.includes("stored_file_id"),
    false,
  );
  assert.equal(
    projectBackupTableDefinitions.some((table) => String(table.name) === "stored_files"),
    false,
  );
  assert.equal(
    projectBackupTableDefinitions.some((table) => String(table.name) === "task_sequences"),
    false,
  );
});
