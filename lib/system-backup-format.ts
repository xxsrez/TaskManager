import { ValidationError } from "./domain";
import type { SystemBackupCounts } from "./types";
import {
  validateAttachmentBackupObjects,
  type AttachmentBackupObject,
} from "./attachment-backup";
import {
  hasMalformedTaskAttachmentReference,
  parseTaskAttachmentReferences,
} from "./task-description-format";

export type BackupScalar = string | number | null;
export type BackupRow = Record<string, BackupScalar>;
export type BackupTableName = (typeof backupTableNames)[number];
export type BackupTables = Record<BackupTableName, BackupRow[]>;

type ColumnShape = {
  nullable?: boolean;
  number?: boolean;
  integer?: boolean;
};

export type TableDefinition = {
  name: BackupTableName;
  columns: readonly string[];
  orderBy: string;
  shapes?: Record<string, ColumnShape>;
};

export type SystemBackup = {
  format: "task-manager-system-backup";
  version: 1;
  schemaVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  siteOrigin: string | null;
  environmentScope: string | null;
  exportedAt: string;
  counts: SystemBackupCounts;
  tables: BackupTables;
  objects: AttachmentBackupObject[];
  sha256: string;
};

export const systemBackupFormat = "task-manager-system-backup" as const;
export const systemBackupVersion = 1 as const;
export const systemBackupSchemaVersion = 11 as const;
export const maxSystemBackupBytes = 10_000_000;
const maxSystemBackupRows = 5000;
const maxStagedRowBytes = 1_500_000;
const dateColumns = new Set(["start_date", "target_date", "due_date"]);
const timestampColumns = new Set([
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "canceled_at",
  "archived_at",
  "deleted_at",
  "resolved_at",
  "released_at",
  "imported_at",
  "revoked_at",
  "upload_expires_at",
  "code_locked_at",
  "historical_created_at",
  "historical_updated_at",
  "reconciled_at",
]);

export const backupTableNames = [
  "users",
  "user_identities",
  "workflow_statuses",
  "projects",
  "releases",
  "tasks",
  "task_identifier_aliases",
  "attachments",
  "attachment_migration_outcomes",
  "comments",
  "comment_migration_outcomes",
  "activity_events",
  "activity_migration_outcomes",
  "comment_reactions",
  "labels",
  "task_labels",
  "task_relations",
  "saved_views",
  "external_records",
  "access_grants",
] as const;

export const tableDefinitions = [
  definition("users", ["id", "display_name", "email", "timezone", "created_at", "updated_at"], "id"),
  definition("user_identities", ["user_id", "provider", "provider_account_key", "verified_email", "created_at"], "provider, provider_account_key"),
  definition("workflow_statuses", ["id", "owner_user_id", "name", "category", "color", "position", "is_default", "system_role", "archived_at", "version", "created_at", "updated_at"], "id", {
    position: { number: true, integer: true },
    is_default: { number: true, integer: true },
    system_role: { nullable: true },
    archived_at: { nullable: true },
    version: { number: true, integer: true },
  }),
  definition("projects", ["id", "public_id", "owner_user_id", "creator_user_id", "name", "task_code", "task_sequence", "code_locked_at", "summary", "description", "status", "lead_user_id", "start_date", "target_date", "icon", "color", "archived_at", "version", "created_at", "updated_at"], "id", {
    task_sequence: { number: true, integer: true }, code_locked_at: { nullable: true }, lead_user_id: { nullable: true }, start_date: { nullable: true }, target_date: { nullable: true }, archived_at: { nullable: true }, version: { number: true, integer: true },
  }),
  definition("releases", ["id", "public_id", "project_id", "owner_user_id", "creator_user_id", "name", "description", "status", "target_date", "released_at", "release_notes", "version", "created_at", "updated_at"], "id", {
    target_date: { nullable: true }, released_at: { nullable: true }, version: { number: true, integer: true },
  }),
  definition("tasks", ["id", "public_id", "owner_user_id", "creator_user_id", "identifier", "sequence_number", "title", "description", "status_id", "priority", "assignee_user_id", "project_id", "release_id", "estimate", "due_date", "parent_task_id", "rank", "started_at", "completed_at", "canceled_at", "archived_at", "comment_count", "version", "created_at", "updated_at"], "id", {
    sequence_number: { number: true, integer: true }, assignee_user_id: { nullable: true }, release_id: { nullable: true }, estimate: { nullable: true, number: true, integer: true }, due_date: { nullable: true }, parent_task_id: { nullable: true }, rank: { number: true }, started_at: { nullable: true }, completed_at: { nullable: true }, canceled_at: { nullable: true }, archived_at: { nullable: true }, comment_count: { number: true, integer: true }, version: { number: true, integer: true },
  }),
  definition("task_identifier_aliases", ["id", "task_id", "identifier", "created_at"], "task_id, identifier"),
  definition("attachments", ["id", "public_id", "task_id", "uploader_user_id", "original_filename", "display_name", "media_type", "byte_size", "checksum_sha256", "object_key", "kind", "state", "image_width", "image_height", "variant_metadata_json", "idempotency_key", "upload_expires_at", "failure_code", "version", "created_at", "updated_at", "deleted_at"], "task_id, created_at, id", {
    byte_size: { number: true, integer: true }, image_width: { nullable: true, number: true, integer: true }, image_height: { nullable: true, number: true, integer: true }, upload_expires_at: { nullable: true }, failure_code: { nullable: true }, version: { number: true, integer: true }, deleted_at: { nullable: true },
  }),
  definition("attachment_migration_outcomes", ["id", "task_id", "source", "source_record_id", "source_attachment_id", "source_index", "outcome", "reason", "attachment_id", "mapped_title", "mapped_url", "raw_json", "reconciled_at"], "task_id, source_record_id, source_index", {
    source_attachment_id: { nullable: true }, source_index: { number: true, integer: true },
    reason: { nullable: true }, attachment_id: { nullable: true },
    mapped_title: { nullable: true }, mapped_url: { nullable: true },
  }),
  definition("comments", ["id", "task_id", "author_user_id", "body", "source", "source_record_id", "source_comment_id", "source_parent_comment_id", "historical_author_name", "historical_created_at", "historical_updated_at", "historical_quoted_text", "parent_comment_id", "idempotency_key", "created_at", "updated_at", "deleted_at", "resolved_at", "resolved_by_user_id", "resolution_comment_id", "version"], "task_id, created_at, id", {
    author_user_id: { nullable: true }, source_record_id: { nullable: true }, source_comment_id: { nullable: true }, source_parent_comment_id: { nullable: true }, historical_author_name: { nullable: true }, historical_created_at: { nullable: true }, historical_updated_at: { nullable: true }, historical_quoted_text: { nullable: true }, parent_comment_id: { nullable: true }, deleted_at: { nullable: true }, resolved_at: { nullable: true }, resolved_by_user_id: { nullable: true }, resolution_comment_id: { nullable: true }, version: { number: true, integer: true },
  }),
  definition("comment_migration_outcomes", ["id", "task_id", "source", "source_record_id", "source_comment_id", "source_index", "outcome", "reason", "comment_id", "raw_json", "reconciled_at"], "task_id, source_record_id, source_index", {
    source_comment_id: { nullable: true }, source_index: { number: true, integer: true }, reason: { nullable: true }, comment_id: { nullable: true },
  }),
  definition("activity_events", ["id", "task_id", "schema_version", "event_type", "actor_kind", "actor_user_id", "actor_name", "payload_json", "source", "source_record_id", "source_event_id", "source_index", "created_at"], "task_id, created_at, id", {
    schema_version: { number: true, integer: true }, actor_user_id: { nullable: true }, source_record_id: { nullable: true }, source_event_id: { nullable: true }, source_index: { nullable: true, number: true, integer: true },
  }),
  definition("activity_migration_outcomes", ["id", "task_id", "source", "source_record_id", "source_event_id", "source_index", "outcome", "reason", "activity_event_id", "raw_json", "reconciled_at"], "task_id, source_record_id, source_index", {
    source_event_id: { nullable: true }, source_index: { number: true, integer: true }, reason: { nullable: true }, activity_event_id: { nullable: true },
  }),
  definition("comment_reactions", ["comment_id", "user_id", "emoji", "created_at"], "comment_id, emoji, user_id"),
  definition("labels", ["id", "owner_user_id", "name", "color", "description", "archived_at", "version", "created_at", "updated_at"], "id", {
    archived_at: { nullable: true }, version: { number: true, integer: true },
  }),
  definition("task_labels", ["task_id", "label_id"], "task_id, label_id"),
  definition("task_relations", ["id", "source_task_id", "target_task_id", "type", "creator_user_id", "idempotency_key", "version", "created_at", "updated_at"], "id", {
    version: { number: true, integer: true },
  }),
  definition("saved_views", ["id", "public_id", "owner_user_id", "name", "scope_project_id", "query_json", "display_json", "archived_at", "version", "created_at", "updated_at"], "id", {
    scope_project_id: { nullable: true }, archived_at: { nullable: true }, version: { number: true, integer: true },
  }),
  definition("external_records", ["id", "owner_user_id", "target_type", "target_id", "source", "source_id", "source_url", "metadata_json", "imported_at"], "id", {
    source_url: { nullable: true },
  }),
  definition("access_grants", ["id", "resource_type", "resource_id", "owner_user_id", "grantee_user_id", "granted_by_user_id", "permission", "revoked_at", "created_at"], "id", {
    revoked_at: { nullable: true },
  }),
] as const satisfies readonly TableDefinition[];

const restoreTableOrder = [
  "users",
  "user_identities",
  "workflow_statuses",
  "projects",
  "releases",
  "tasks",
  "task_identifier_aliases",
  "attachments",
  "labels",
  "saved_views",
  "external_records",
  "attachment_migration_outcomes",
  "comments",
  "comment_migration_outcomes",
  "activity_events",
  "activity_migration_outcomes",
  "comment_reactions",
  "task_labels",
  "task_relations",
  "access_grants",
] as const satisfies readonly BackupTableName[];

export const restoreTableDefinitions = restoreTableOrder.map((name) =>
  tableDefinitions.find((table) => table.name === name)!,
);

const legacyWorkflowStatusDefinition = definition(
  "workflow_statuses",
  ["id", "owner_user_id", "name", "category", "color", "position", "is_default", "created_at", "updated_at"],
  "id",
  {
    position: { number: true, integer: true },
    is_default: { number: true, integer: true },
  },
);

const legacyTaskRelationDefinition = definition(
  "task_relations",
  ["source_task_id", "target_task_id", "type", "creator_user_id", "created_at"],
  "source_task_id, target_task_id, type",
);

const legacySavedViewDefinition = definition(
  "saved_views",
  ["id", "public_id", "owner_user_id", "name", "scope_project_id", "query_json", "display_json", "version", "created_at", "updated_at"],
  "id",
  { scope_project_id: { nullable: true }, version: { number: true, integer: true } },
);

const legacyProjectDefinition = definition(
  "projects",
  ["id", "public_id", "owner_user_id", "creator_user_id", "name", "summary", "description", "status", "lead_user_id", "start_date", "target_date", "icon", "color", "archived_at", "version", "created_at", "updated_at"],
  "id",
  {
    lead_user_id: { nullable: true }, start_date: { nullable: true },
    target_date: { nullable: true }, archived_at: { nullable: true },
    version: { number: true, integer: true },
  },
);

const legacyTaskDefinition = definition(
  "tasks",
  ["id", "public_id", "owner_user_id", "creator_user_id", "identifier", "sequence_number", "title", "description", "status_id", "priority", "assignee_user_id", "project_id", "release_id", "estimate", "due_date", "parent_task_id", "rank", "started_at", "completed_at", "canceled_at", "archived_at", "comment_count", "version", "created_at", "updated_at"],
  "id",
  {
    sequence_number: { number: true, integer: true }, assignee_user_id: { nullable: true },
    project_id: { nullable: true }, release_id: { nullable: true },
    estimate: { nullable: true, number: true, integer: true }, due_date: { nullable: true },
    parent_task_id: { nullable: true }, rank: { number: true }, started_at: { nullable: true },
    completed_at: { nullable: true }, canceled_at: { nullable: true }, archived_at: { nullable: true },
    comment_count: { number: true, integer: true }, version: { number: true, integer: true },
  },
);

const legacyLabelDefinition = definition(
  "labels",
  ["id", "owner_user_id", "name", "color", "created_at"],
  "id",
);

const legacyCommentDefinition = definition(
  "comments",
  ["id", "task_id", "author_user_id", "body", "source", "parent_comment_id", "idempotency_key", "created_at", "updated_at", "deleted_at", "resolved_at", "resolved_by_user_id", "resolution_comment_id", "version"],
  "task_id, created_at, id",
  { parent_comment_id: { nullable: true }, deleted_at: { nullable: true }, resolved_at: { nullable: true }, resolved_by_user_id: { nullable: true }, resolution_comment_id: { nullable: true }, version: { number: true, integer: true } },
);

export const liveTableDeleteOrder: BackupTableName[] = [
  "attachment_migration_outcomes",
  "activity_migration_outcomes",
  "activity_events",
  "comment_migration_outcomes",
  "comment_reactions",
  "comments",
  "task_labels",
  "task_relations",
  "access_grants",
  "external_records",
  "attachments",
  "task_identifier_aliases",
  "tasks",
  "releases",
  "saved_views",
  "projects",
  "labels",
  "workflow_statuses",
  "user_identities",
  "users",
];

// Authentication capabilities are intentionally outside logical backups.
// A full restore revokes them before replacing application data.
export const authenticationCapabilityDeleteOrder = [
  "oauth_authorization_requests",
  "oauth_authorization_codes",
  "oauth_access_tokens",
  "oauth_refresh_tokens",
  "oauth_grants",
  "api_credentials",
] as const;

export function restoreInsertSql(table: TableDefinition): string {
  const extracts = table.columns
    .map((column) => `json_extract(row_json, '$.${column}')`)
    .join(", ");
  return `INSERT INTO ${table.name} (${table.columns.join(", ")})
    SELECT ${extracts} FROM admin_import_rows
    WHERE import_id = ? AND table_name = ? ORDER BY ordinal`;
}

export async function createSystemBackup(
  tables: BackupTables,
  exportedAt = new Date().toISOString(),
  objects: AttachmentBackupObject[] = [],
  siteOrigin = "https://local.task-manager.invalid",
  environmentScope = "local",
): Promise<SystemBackup> {
  const counts = countTables(tables);
  const body = {
    format: systemBackupFormat,
    version: systemBackupVersion,
    schemaVersion: systemBackupSchemaVersion,
    siteOrigin: normalizeOrigin(siteOrigin),
    environmentScope: normalizeEnvironmentScope(environmentScope),
    exportedAt,
    counts,
    tables,
    objects,
  };
  const backup = { ...body, sha256: await sha256(canonicalBackupJson(body)) };
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > maxSystemBackupBytes) {
    throw new ValidationError(
      "System backup exceeds the 10 MB bounded package limit; use a smaller attachment set",
    );
  }
  return backup;
}

export async function validateSystemBackup(value: unknown): Promise<SystemBackup> {
  const payload = object(value, "Backup payload");
  const schemaVersion = payload.schemaVersion;
  const withoutAttachments = schemaVersion === 2;
  const legacyWorkflow = schemaVersion === 2 || schemaVersion === 3;
  const legacyRelations = schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4;
  const legacyIdentifiers = schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5;
  const legacyLabels = schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6;
  const legacySavedViews = schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6 || schemaVersion === 7;
  const legacyHistoricalComments = schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6 || schemaVersion === 7 || schemaVersion === 8;
  const legacyActivity = typeof schemaVersion === "number" && schemaVersion <= 9;
  const legacyAttachmentMigration = typeof schemaVersion === "number" && schemaVersion <= 10;
  const supported = schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6 || schemaVersion === 7 || schemaVersion === 8 || schemaVersion === 9 || schemaVersion === 10 || schemaVersion === systemBackupSchemaVersion;
  assertOnlyKeys(
    payload,
    withoutAttachments
      ? ["format", "version", "schemaVersion", "exportedAt", "counts", "tables", "sha256"]
      : ["format", "version", "schemaVersion", "siteOrigin", "environmentScope", "exportedAt", "counts", "tables", "objects", "sha256"],
    "Backup payload",
  );
  if (payload.format !== systemBackupFormat || payload.version !== systemBackupVersion || !supported) {
    throw new ValidationError("Unsupported Task Manager backup format or version");
  }
  const exportedAt = timestamp(payload.exportedAt, "exportedAt");
  const sourceTables = object(payload.tables, "tables");
  const sourceTableNames = backupTableNames.filter((name) =>
    !(withoutAttachments && name === "attachments") &&
    !(legacyIdentifiers && name === "task_identifier_aliases") &&
    !(legacyHistoricalComments && name === "comment_migration_outcomes") &&
    !(legacyActivity && (name === "activity_events" || name === "activity_migration_outcomes")) &&
    !(legacyAttachmentMigration && name === "attachment_migration_outcomes"),
  );
  assertOnlyKeys(sourceTables, sourceTableNames, "tables");
  const sourceNormalizedTables = {} as BackupTables;
  let totalRows = 0;
  for (const table of tableDefinitions) {
    const sourceRows =
      (withoutAttachments && table.name === "attachments") ||
      (legacyIdentifiers && table.name === "task_identifier_aliases") ||
      (legacyHistoricalComments && table.name === "comment_migration_outcomes") ||
      (legacyActivity && (table.name === "activity_events" || table.name === "activity_migration_outcomes")) ||
      (legacyAttachmentMigration && table.name === "attachment_migration_outcomes")
        ? []
        : array(sourceTables[table.name], `tables.${table.name}`);
    totalRows += sourceRows.length;
    if (totalRows > maxSystemBackupRows) throw new ValidationError(`Backup contains more than ${maxSystemBackupRows} rows`);
    const sourceDefinition = legacyIdentifiers && table.name === "projects"
      ? legacyProjectDefinition
      : legacyIdentifiers && table.name === "tasks"
        ? legacyTaskDefinition
      : legacyWorkflow && table.name === "workflow_statuses"
      ? legacyWorkflowStatusDefinition
      : legacyRelations && table.name === "task_relations"
        ? legacyTaskRelationDefinition
      : legacyLabels && table.name === "labels"
        ? legacyLabelDefinition
      : legacyHistoricalComments && table.name === "comments"
        ? legacyCommentDefinition
      : legacySavedViews && table.name === "saved_views" &&
          !sourceRows.some((row) => Object.hasOwn(object(row, "saved view"), "archived_at"))
        ? legacySavedViewDefinition
        : table;
    sourceNormalizedTables[table.name] = sourceRows.map((row, index) =>
      normalizeBackupRow(sourceDefinition, row, index),
    );
  }
  const sourceCounts = countTables(sourceNormalizedTables);
  const claimedCounts = object(payload.counts, "counts");
  assertOnlyKeys(claimedCounts, sourceTableNames, "counts");
  for (const name of sourceTableNames) {
    if (claimedCounts[name] !== sourceCounts[name]) throw new ValidationError(`Count mismatch for ${name}`);
  }
  let tables = legacyWorkflow
    ? upgradeLegacySystemWorkflow(sourceNormalizedTables)
    : sourceNormalizedTables;
  if (legacyRelations) tables = upgradeLegacySystemRelations(tables);
  if (legacyIdentifiers) tables = upgradeLegacySystemIdentifiers(tables);
  if (legacyLabels) tables = upgradeLegacySystemLabels(tables);
  if (legacySavedViews) tables = upgradeLegacySystemSavedViews(tables);
  if (legacyHistoricalComments) tables = upgradeLegacySystemComments(tables);
  const counts = countTables(tables);
  validateRelationships(tables);
  const objects = withoutAttachments
    ? []
    : await validateAttachmentBackupObjects(tables.attachments, payload.objects);
  const body = {
    format: systemBackupFormat,
    version: systemBackupVersion,
    schemaVersion: schemaVersion as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11,
    ...(!withoutAttachments
      ? { siteOrigin: normalizeOrigin(requiredString(payload.siteOrigin, "siteOrigin")) }
      : {}),
    ...(!withoutAttachments
      ? {
          environmentScope: normalizeEnvironmentScope(
            requiredString(payload.environmentScope, "environmentScope"),
          ),
        }
      : {}),
    exportedAt,
    counts: withoutAttachments || legacyIdentifiers || legacyHistoricalComments || legacyActivity || legacyAttachmentMigration
      ? Object.fromEntries(sourceTableNames.map((name) => [name, sourceCounts[name]]))
      : sourceCounts,
    tables: withoutAttachments || legacyIdentifiers || legacyHistoricalComments || legacyActivity || legacyAttachmentMigration
      ? Object.fromEntries(
          sourceTableNames.map((name) => [name, sourceNormalizedTables[name]]),
        )
      : sourceNormalizedTables,
    ...(!withoutAttachments ? { objects } : {}),
  };
  const checksum = await sha256(JSON.stringify(body));
  if (payload.sha256 !== checksum) throw new ValidationError("Backup checksum does not match its content");
  return {
    format: systemBackupFormat,
    version: systemBackupVersion,
    schemaVersion: schemaVersion as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11,
    siteOrigin: withoutAttachments
      ? null
      : normalizeOrigin(requiredString(payload.siteOrigin, "siteOrigin")),
    environmentScope: withoutAttachments
      ? null
      : normalizeEnvironmentScope(
          requiredString(payload.environmentScope, "environmentScope"),
        ),
    exportedAt,
    counts,
    tables,
    objects,
    sha256: checksum,
  };
}

export function assertBackupContainsIdentity(
  backup: SystemBackup,
  currentIdentities: Array<{ provider: string; provider_account_key: string }>,
) {
  const imported = new Set(
    backup.tables.user_identities.map((row) => `${row.provider}\u0000${row.provider_account_key}`),
  );
  if (!currentIdentities.some((identity) => imported.has(`${identity.provider}\u0000${identity.provider_account_key}`))) {
    throw new ValidationError("Backup does not contain the current administrator identity");
  }
}

export function normalizeDbRow(table: TableDefinition, value: Record<string, unknown>): BackupRow {
  const row: BackupRow = {};
  for (const column of table.columns) {
    const cell = value[column];
    if (cell !== null && typeof cell !== "string" && typeof cell !== "number") {
      throw new ValidationError(`Database returned an unsupported value for ${table.name}.${column}`);
    }
    row[column] = cell;
  }
  return row;
}

function validateRelationships(tables: BackupTables) {
  const users = uniqueIndex(tables.users, ["id"], "users");
  uniqueIndex(tables.user_identities, ["provider", "provider_account_key"], "user identities");
  for (const user of tables.users) {
    nonEmpty(user.id, "User id");
    nonEmpty(user.display_name, "User display name");
    nonEmpty(user.email, "User email");
    validTimeZone(user.timezone);
  }
  for (const identity of tables.user_identities) requireReference(users, identity.user_id, "Identity user");

  const activeGrants = new Set(
    tables.access_grants
      .filter((grant) => grant.revoked_at === null)
      .map((grant) => `${grant.resource_type}\u0000${grant.resource_id}\u0000${grant.grantee_user_id}`),
  );

  const statuses = uniqueIndex(tables.workflow_statuses, ["id"], "workflow statuses");
  uniqueIndex(tables.workflow_statuses, ["owner_user_id", "name"], "workflow status owner/name");
  uniqueIndex(
    tables.workflow_statuses.filter((status) => status.system_role !== null),
    ["owner_user_id", "system_role"],
    "workflow status owner/system role",
  );
  const duplicateOwners = new Set<string>();
  const defaultOwners = new Set<string>();
  for (const status of tables.workflow_statuses) {
    requireReference(users, status.owner_user_id, "Workflow status owner");
    nonEmpty(status.name, "Workflow status name");
    oneOf(status.category, ["backlog", "unstarted", "started", "completed", "canceled"], "Workflow category");
    if (status.is_default !== 0 && status.is_default !== 1) throw new ValidationError("Workflow is_default must be 0 or 1");
    if (status.system_role !== null && status.system_role !== "duplicate") {
      throw new ValidationError("Workflow system role is invalid");
    }
    positiveVersion(status.version, "Workflow status version");
    if (status.system_role === "duplicate") {
      if (status.name !== "Duplicate" || status.category !== "canceled" || status.archived_at !== null || status.is_default !== 0) {
        throw new ValidationError("Reserved Duplicate workflow status is invalid");
      }
      duplicateOwners.add(String(status.owner_user_id));
    }
    if (status.is_default === 1) {
      if (status.archived_at !== null || !["backlog", "unstarted"].includes(String(status.category))) {
        throw new ValidationError("Workflow default must be an active Backlog or Unstarted status");
      }
      if (defaultOwners.has(String(status.owner_user_id))) {
        throw new ValidationError("Workflow catalog must have one default status");
      }
      defaultOwners.add(String(status.owner_user_id));
    }
  }
  for (const user of tables.users) {
    if (!duplicateOwners.has(String(user.id))) throw new ValidationError("Workflow catalog is missing its reserved Duplicate status");
    if (!defaultOwners.has(String(user.id))) throw new ValidationError("Workflow catalog is missing its default status");
  }

  const projects = uniqueIndex(tables.projects, ["id"], "projects");
  uniqueIndex(tables.projects, ["public_id"], "project public IDs");
  uniqueIndex(
    tables.projects.filter((project) => project.archived_at === null),
    ["owner_user_id", "task_code"],
    "active project owner/task code",
  );
  for (const project of tables.projects) {
    requireReference(users, project.owner_user_id, "Project owner");
    requireReference(users, project.creator_user_id, "Project creator");
    publicId(project.public_id, "Project public ID");
    boundedTitle(project.name, "Project name");
    if (!/^[A-Z]{2,3}$/.test(String(project.task_code))) {
      throw new ValidationError("Project task code must contain 2-3 uppercase Latin letters");
    }
    if (!Number.isSafeInteger(project.task_sequence) || Number(project.task_sequence) < 0) {
      throw new ValidationError("Project task sequence must be a non-negative integer");
    }
    if (project.lead_user_id !== null) {
      requireReference(users, project.lead_user_id, "Project lead");
      if (!hasAccess(activeGrants, project.lead_user_id, project.owner_user_id, "project", project.id)) {
        throw new ValidationError("Project lead must have access to the project");
      }
    }
    oneOf(project.status, ["planned", "active", "paused", "completed", "canceled"], "Project status");
    positiveVersion(project.version, "Project version");
  }

  const releases = uniqueIndex(tables.releases, ["id"], "releases");
  uniqueIndex(tables.releases, ["public_id"], "release public IDs");
  for (const release of tables.releases) {
    requireReference(projects, release.project_id, "Release project");
    requireReference(users, release.owner_user_id, "Release catalog owner");
    requireReference(users, release.creator_user_id, "Release creator");
    publicId(release.public_id, "Release public ID");
    boundedTitle(release.name, "Release name");
    oneOf(release.status, ["planned", "active", "released", "canceled"], "Release status");
    positiveVersion(release.version, "Release version");
  }

  const tasks = uniqueIndex(tables.tasks, ["id"], "tasks");
  uniqueIndex(tables.tasks, ["public_id"], "task public IDs");
  uniqueIndex(tables.tasks, ["project_id", "sequence_number"], "task project/sequence");
  const projectMaxSequence = new Map<string, number>();
  for (const task of tables.tasks) {
    requireReference(users, task.owner_user_id, "Task owner");
    requireReference(users, task.creator_user_id, "Task creator");
    publicId(task.public_id, "Task public ID");
    nonEmpty(task.identifier, "Task identifier");
    boundedTitle(task.title, "Task title");
    if (typeof task.sequence_number !== "number" || task.sequence_number < 1) throw new ValidationError("Task sequence must be a positive integer");
    if (typeof task.estimate === "number" && (task.estimate < 0 || task.estimate > 100)) throw new ValidationError("Task estimate must be between 0 and 100");
    const status = requireReference(statuses, task.status_id, "Task status");
    if (status.owner_user_id !== task.owner_user_id) throw new ValidationError("Task status must belong to the task owner");
    if (task.project_id === null) {
      throw new ValidationError("Legacy backup Tasks without Project require an explicit Project mapping");
    }
    const project = requireReference(projects, task.project_id, "Task project");
    if (task.identifier !== `${String(project.task_code)}-${String(task.sequence_number)}`) {
      throw new ValidationError("Task identifier must use its Project code and sequence");
    }
    projectMaxSequence.set(
      String(project.id),
      Math.max(projectMaxSequence.get(String(project.id)) ?? 0, Number(task.sequence_number)),
    );
    if (task.release_id !== null) {
      const release = requireReference(releases, task.release_id, "Task release");
      if (release.project_id !== task.project_id) throw new ValidationError("Task release must belong to its project");
    }
    if (task.assignee_user_id !== null) {
      requireReference(users, task.assignee_user_id, "Task assignee");
      if (!hasAccess(activeGrants, task.assignee_user_id, project.owner_user_id, "project", project.id)) {
        throw new ValidationError("Task assignee must have access to the task");
      }
    }
    if (task.parent_task_id !== null) {
      const parent = requireReference(tasks, task.parent_task_id, "Task parent");
      if (parent.owner_user_id !== task.owner_user_id || parent.id === task.id) throw new ValidationError("Task parent must be a different task in the same owner scope");
    }
    oneOf(task.priority, ["urgent", "high", "medium", "low", "none"], "Task priority");
    validateTerminalState(task, status.category);
    positiveVersion(task.version, "Task version");
  }
  for (const project of tables.projects) {
    const maximum = projectMaxSequence.get(String(project.id)) ?? 0;
    if (Number(project.task_sequence) < maximum) {
      throw new ValidationError("Project task sequence is behind its Tasks");
    }
    if ((Number(project.task_sequence) > 0) !== (project.code_locked_at !== null)) {
      throw new ValidationError("Project code lock must match whether Tasks exist");
    }
  }
  validateParentCycles(tables.tasks, tasks);

  uniqueIndex(tables.task_identifier_aliases, ["id"], "task identifier alias IDs");
  uniqueIndex(
    tables.task_identifier_aliases,
    ["task_id", "identifier"],
    "task identifier aliases",
  );
  for (const alias of tables.task_identifier_aliases) {
    requireReference(tasks, alias.task_id, "Task identifier alias Task");
    nonEmpty(alias.identifier, "Task identifier alias");
  }

  const attachments = uniqueIndex(tables.attachments, ["id"], "attachments");
  uniqueIndex(tables.attachments, ["public_id"], "attachment public IDs");
  uniqueIndex(
    tables.attachments,
    ["task_id", "uploader_user_id", "idempotency_key"],
    "attachment idempotency keys",
  );
  const attachmentsByPublicId = new Map<string, BackupRow>();
  for (const attachment of tables.attachments) {
    const task = requireReference(tasks, attachment.task_id, "Attachment task");
    requireReference(users, attachment.uploader_user_id, "Attachment uploader");
    publicId(attachment.public_id, "Attachment public ID");
    nonEmpty(attachment.original_filename, "Attachment original filename");
    nonEmpty(attachment.display_name, "Attachment display name");
    nonEmpty(attachment.media_type, "Attachment media type");
    nonEmpty(attachment.checksum_sha256, "Attachment checksum");
    if (!/^[a-f0-9]{64}$/.test(String(attachment.checksum_sha256))) {
      throw new ValidationError("Attachment checksum must be SHA-256");
    }
    if (typeof attachment.byte_size !== "number" || attachment.byte_size < 0) {
      throw new ValidationError("Attachment byte size must be non-negative");
    }
    oneOf(attachment.kind, ["file", "image"], "Attachment kind");
    oneOf(
      attachment.state,
      ["pending", "uploading", "ready", "failed", "deleted"],
      "Attachment state",
    );
    if (attachment.state === "deleted" && attachment.deleted_at === null) {
      throw new ValidationError("Deleted attachment requires deleted_at");
    }
    if (attachment.state !== "deleted" && attachment.deleted_at !== null) {
      throw new ValidationError("Only deleted attachment can carry deleted_at");
    }
    if (
      (attachment.state === "pending" || attachment.state === "uploading") &&
      attachment.upload_expires_at === null
    ) {
      throw new ValidationError("Unsettled attachment requires upload expiry");
    }
    jsonObject(attachment.variant_metadata_json, "Attachment variant metadata");
    positiveVersion(attachment.version, "Attachment version");
    attachmentsByPublicId.set(String(attachment.public_id), attachment);
    if (String(task.id) !== String(attachment.task_id)) {
      throw new ValidationError("Attachment task is invalid");
    }
  }
  void attachments;
  for (const task of tables.tasks) {
    const description = String(task.description ?? "");
    if (hasMalformedTaskAttachmentReference(description)) {
      throw new ValidationError("Task description contains a malformed attachment reference");
    }
    for (const reference of parseTaskAttachmentReferences(description)) {
      const attachment = attachmentsByPublicId.get(reference.ref);
      if (
        !attachment ||
        attachment.task_id !== task.id ||
        (reference.kind === "image" && attachment.kind !== "image") ||
        attachment.state !== "ready"
      ) {
        throw new ValidationError(
          "Task description references a missing or unavailable attachment",
        );
      }
    }
  }

  const comments = uniqueIndex(tables.comments, ["id"], "comments");
  uniqueIndex(
    tables.comments.filter((comment) => comment.author_user_id !== null),
    ["task_id", "author_user_id", "idempotency_key"],
    "comment idempotency keys",
  );
  uniqueIndex(
    tables.comments.filter((comment) => comment.source_comment_id !== null),
    ["task_id", "source", "source_comment_id"],
    "historical comment source identities",
  );
  const activeCommentsByTask = new Map<string, number>();
  for (const comment of tables.comments) {
    const task = requireReference(tasks, comment.task_id, "Comment task");
    nonEmpty(comment.idempotency_key, "Comment idempotency key");
    oneOf(comment.source, ["native", "linear"], "Comment source");
    if (comment.source === "native") {
      requireReference(users, comment.author_user_id, "Comment author");
      for (const value of [comment.source_record_id, comment.source_comment_id,
        comment.source_parent_comment_id, comment.historical_author_name,
        comment.historical_created_at, comment.historical_updated_at,
        comment.historical_quoted_text]) {
        if (value !== null) throw new ValidationError("Native comments cannot carry historical facts");
      }
    } else {
      if (comment.author_user_id !== null) {
        throw new ValidationError("Historical comments cannot impersonate a User");
      }
      for (const [value, label] of [
        [comment.source_record_id, "source record"],
        [comment.source_comment_id, "source comment"],
        [comment.historical_author_name, "author snapshot"],
        [comment.historical_created_at, "source created timestamp"],
        [comment.historical_updated_at, "source updated timestamp"],
      ] as const) nonEmpty(value, `Historical comment ${label}`);
    }
    if (comment.deleted_at === null) {
      nonEmpty(comment.body, "Comment body");
      activeCommentsByTask.set(task.id as string, (activeCommentsByTask.get(task.id as string) ?? 0) + 1);
    }
    if (comment.parent_comment_id !== null) {
      const parent = requireReference(comments, comment.parent_comment_id, "Comment parent");
      if (parent.task_id !== comment.task_id || parent.parent_comment_id !== null) {
        throw new ValidationError("Comment replies must use one root in the same task");
      }
      if (comment.resolved_at !== null || comment.resolved_by_user_id !== null || comment.resolution_comment_id !== null) {
        throw new ValidationError("Only root comments can carry thread resolution");
      }
    }
    if (comment.resolved_at === null) {
      if (comment.resolved_by_user_id !== null || comment.resolution_comment_id !== null) {
        throw new ValidationError("Open comment threads cannot carry resolution metadata");
      }
    } else {
      requireReference(users, comment.resolved_by_user_id, "Comment resolver");
      if (comment.resolution_comment_id !== null) {
        const resolution = requireReference(comments, comment.resolution_comment_id, "Resolution comment");
        if (resolution.id !== comment.id && resolution.parent_comment_id !== comment.id) {
          throw new ValidationError("Resolution comment must belong to its thread");
        }
      }
    }
    positiveVersion(comment.version, "Comment version");
  }
  for (const task of tables.tasks) {
    const actual = activeCommentsByTask.get(String(task.id)) ?? 0;
    if (task.comment_count !== actual) {
      throw new ValidationError("Task comment_count does not match unified comments");
    }
  }
  uniqueIndex(
    tables.comment_reactions,
    ["comment_id", "user_id", "emoji"],
    "comment reactions",
  );
  for (const reaction of tables.comment_reactions) {
    requireReference(comments, reaction.comment_id, "Reaction comment");
    requireReference(users, reaction.user_id, "Reaction user");
    nonEmpty(reaction.emoji, "Reaction emoji");
  }

  const labels = uniqueIndex(tables.labels, ["id"], "labels");
  uniqueIndex(
    tables.labels.filter((label) => label.archived_at === null),
    ["owner_user_id", "name"],
    "active label owner/name",
  );
  for (const label of tables.labels) {
    requireReference(users, label.owner_user_id, "Label owner");
    boundedTitle(label.name, "Label name");
    positiveVersion(label.version, "Label version");
  }
  uniqueIndex(tables.task_labels, ["task_id", "label_id"], "task labels");
  for (const assignment of tables.task_labels) {
    const task = requireReference(tasks, assignment.task_id, "Task label task");
    const label = requireReference(labels, assignment.label_id, "Task label label");
    if (task.owner_user_id !== label.owner_user_id) throw new ValidationError("Task and label owners must match");
  }

  uniqueIndex(tables.task_relations, ["id"], "task relation IDs");
  uniqueIndex(tables.task_relations, ["source_task_id", "target_task_id", "type"], "task relations");
  uniqueIndex(tables.task_relations, ["creator_user_id", "idempotency_key"], "task relation idempotency keys");
  const relatedPairs = new Set<string>();
  const blockPairs = new Set<string>();
  const duplicateSources = new Set<string>();
  for (const relation of tables.task_relations) {
    const source = requireReference(tasks, relation.source_task_id, "Relation source");
    const target = requireReference(tasks, relation.target_task_id, "Relation target");
    requireReference(users, relation.creator_user_id, "Relation creator");
    nonEmpty(relation.id, "Relation ID");
    nonEmpty(relation.idempotency_key, "Relation idempotency key");
    positiveVersion(relation.version, "Relation version");
    if (source.id === target.id || source.project_id === null || target.project_id === null) {
      throw new ValidationError("Relations require different project tasks");
    }
    oneOf(relation.type, ["blocks", "related", "duplicate_of"], "Relation type");
    if (relation.type === "related") {
      const key = [source.id, target.id].sort().join("\u0000");
      if (relatedPairs.has(key)) throw new ValidationError("Duplicate symmetric related relation");
      if (String(source.id) > String(target.id)) throw new ValidationError("Related task pairs must use canonical order");
      relatedPairs.add(key);
    } else if (relation.type === "blocks") {
      const key = [source.id, target.id].sort().join("\u0000");
      if (blockPairs.has(key)) throw new ValidationError("Duplicate logical block relation");
      blockPairs.add(key);
    } else {
      const sourceId = String(source.id);
      if (duplicateSources.has(sourceId)) {
        throw new ValidationError("A duplicate task has more than one canonical target");
      }
      duplicateSources.add(sourceId);
    }
  }

  const views = uniqueIndex(tables.saved_views, ["id"], "saved views");
  uniqueIndex(tables.saved_views, ["public_id"], "saved view public IDs");
  for (const view of tables.saved_views) {
    requireReference(users, view.owner_user_id, "Saved view owner");
    publicId(view.public_id, "Saved view public ID");
    boundedTitle(view.name, "Saved view name");
    if (view.scope_project_id !== null) {
      requireReference(projects, view.scope_project_id, "Saved view project");
    }
    jsonObject(view.query_json, "Saved view query");
    jsonObject(view.display_json, "Saved view display");
    positiveVersion(view.version, "Saved view version");
  }

  const externalRecords = uniqueIndex(tables.external_records, ["id"], "external records");
  uniqueIndex(tables.external_records, ["owner_user_id", "source", "source_id"], "external source IDs");
  const targets: Record<string, Map<string, BackupRow>> = { task: tasks, project: projects, release: releases, saved_view: views, label: labels, workflow_status: statuses };
  for (const record of tables.external_records) {
    requireReference(users, record.owner_user_id, "External record owner");
    const targetMap = targets[String(record.target_type)];
    if (!targetMap) throw new ValidationError("Unsupported external record target type");
    const target = requireReference(targetMap, record.target_id, "External record target");
    if (target.owner_user_id !== record.owner_user_id) throw new ValidationError("External record owner must match target owner");
    jsonObject(record.metadata_json, "External metadata");
  }
  uniqueIndex(
    tables.attachment_migration_outcomes,
    ["id"],
    "attachment migration outcome IDs",
  );
  uniqueIndex(
    tables.attachment_migration_outcomes,
    ["source_record_id", "source_index"],
    "attachment migration source rows",
  );
  for (const outcome of tables.attachment_migration_outcomes) {
    requireReference(tasks, outcome.task_id, "Attachment migration Task");
    const sourceRecord = requireReference(
      externalRecords,
      outcome.source_record_id,
      "Attachment migration source record",
    );
    if (!Number.isSafeInteger(outcome.source_index) || Number(outcome.source_index) < -1) {
      throw new ValidationError("Attachment migration source index is invalid");
    }
    oneOf(outcome.source, ["linear"], "Attachment migration source");
    oneOf(
      outcome.outcome,
      ["migrated", "non_binary_mapped", "skipped", "blocked"],
      "Attachment migration outcome",
    );
    if (
      sourceRecord.source !== outcome.source ||
      sourceRecord.target_type !== "task" ||
      sourceRecord.target_id !== outcome.task_id
    ) {
      throw new ValidationError(
        "Attachment migration outcome references an incompatible source record",
      );
    }
    jsonValue(outcome.raw_json, "Attachment migration raw source");
    if (outcome.outcome === "migrated") {
      const attachment = requireReference(
        attachments,
        outcome.attachment_id,
        "Migrated attachment",
      );
      if (
        attachment.task_id !== outcome.task_id ||
        attachment.state !== "ready" ||
        outcome.mapped_title !== null ||
        outcome.mapped_url !== null
      ) {
        throw new ValidationError(
          "Attachment migration outcome does not match its native Attachment",
        );
      }
    } else if (outcome.outcome === "non_binary_mapped") {
      if (
        outcome.attachment_id !== null ||
        !String(outcome.mapped_title ?? "").trim() ||
        !isSafeHttpsUrl(outcome.mapped_url)
      ) {
        throw new ValidationError("Non-binary attachment mapping is invalid");
      }
    } else if (
      outcome.attachment_id !== null ||
      outcome.mapped_title !== null ||
      outcome.mapped_url !== null
    ) {
      throw new ValidationError(
        "Skipped or blocked attachment migration cannot reference a target",
      );
    }
  }
  for (const comment of tables.comments) {
    if (comment.source !== "linear") continue;
    const sourceRecord = requireReference(
      externalRecords,
      comment.source_record_id,
      "Historical comment source record",
    );
    if (
      sourceRecord.source !== comment.source ||
      sourceRecord.target_type !== "task" ||
      sourceRecord.target_id !== comment.task_id
    ) {
      throw new ValidationError("Historical comment references an incompatible source record");
    }
  }

  uniqueIndex(tables.comment_migration_outcomes, ["id"], "comment migration outcomes");
  uniqueIndex(
    tables.comment_migration_outcomes,
    ["source_record_id", "source_index"],
    "comment migration source rows",
  );
  for (const outcome of tables.comment_migration_outcomes) {
    requireReference(tasks, outcome.task_id, "Comment migration task");
    const sourceRecord = requireReference(
      externalRecords,
      outcome.source_record_id,
      "Comment migration source record",
    );
    oneOf(outcome.source, ["linear"], "Comment migration source");
    oneOf(outcome.outcome, ["migrated", "exception"], "Comment migration outcome");
    if (
      sourceRecord.source !== outcome.source ||
      sourceRecord.target_type !== "task" ||
      sourceRecord.target_id !== outcome.task_id
    ) {
      throw new ValidationError("Comment migration outcome references an incompatible source record");
    }
    jsonValue(outcome.raw_json, "Comment migration raw source");
    if (outcome.outcome === "migrated") {
      const comment = requireReference(comments, outcome.comment_id, "Migrated comment");
      if (
        comment.task_id !== outcome.task_id ||
        comment.source_record_id !== outcome.source_record_id ||
        comment.source_comment_id !== outcome.source_comment_id
      ) throw new ValidationError("Comment migration outcome does not match its historical comment");
    } else if (outcome.comment_id !== null) {
      throw new ValidationError("Comment migration exception cannot reference a migrated comment");
    }
  }

  const activityEvents = uniqueIndex(tables.activity_events, ["id"], "activity events");
  uniqueIndex(
    tables.activity_events.filter((event) => event.source_record_id !== null),
    ["source_record_id", "source_index"],
    "activity source rows",
  );
  for (const event of tables.activity_events) {
    requireReference(tasks, event.task_id, "Activity Task");
    if (event.schema_version !== 1) throw new ValidationError("Unsupported activity schema version");
    oneOf(event.actor_kind, ["user", "historical", "system"], "Activity actor kind");
    if (event.actor_kind === "user") requireReference(users, event.actor_user_id, "Activity actor");
    else if (event.actor_user_id !== null) throw new ValidationError("Historical activity actor cannot reference a User");
    jsonObject(event.payload_json, "Activity payload");
    oneOf(event.source, ["native", "linear"], "Activity source");
    if (event.source === "linear") {
      const sourceRecord = requireReference(externalRecords, event.source_record_id, "Activity source record");
      if (
        event.actor_kind !== "historical" || event.actor_user_id !== null ||
        sourceRecord.source !== event.source || sourceRecord.target_type !== "task" ||
        sourceRecord.target_id !== event.task_id
      ) {
        throw new ValidationError("Historical activity references an incompatible source record");
      }
      if (!Number.isSafeInteger(event.source_index) || Number(event.source_index) < 0) {
        throw new ValidationError("Historical activity source index is invalid");
      }
    } else if (
      !["user", "system"].includes(String(event.actor_kind)) ||
      event.source_record_id !== null || event.source_event_id !== null ||
      event.source_index !== null
    ) {
      throw new ValidationError("Native activity cannot reference migration provenance");
    }
  }
  uniqueIndex(tables.activity_migration_outcomes, ["id"], "activity migration outcomes");
  uniqueIndex(tables.activity_migration_outcomes, ["source_record_id", "source_index"], "activity migration source rows");
  for (const outcome of tables.activity_migration_outcomes) {
    requireReference(tasks, outcome.task_id, "Activity migration Task");
    if (!Number.isSafeInteger(outcome.source_index) || Number(outcome.source_index) < -1) {
      throw new ValidationError("Activity migration source index is invalid");
    }
    const sourceRecord = requireReference(externalRecords, outcome.source_record_id, "Activity migration source record");
    oneOf(outcome.source, ["linear"], "Activity migration source");
    oneOf(outcome.outcome, ["migrated", "exception"], "Activity migration outcome");
    if (
      sourceRecord.source !== outcome.source || sourceRecord.target_type !== "task" ||
      sourceRecord.target_id !== outcome.task_id
    ) {
      throw new ValidationError("Activity migration outcome references an incompatible source record");
    }
    jsonValue(outcome.raw_json, "Activity migration raw source");
    if (outcome.outcome === "migrated") {
      const event = requireReference(activityEvents, outcome.activity_event_id, "Migrated activity event");
      if (event.task_id !== outcome.task_id || event.source_record_id !== outcome.source_record_id || event.source_index !== outcome.source_index) {
        throw new ValidationError("Activity migration outcome does not match its event");
      }
    } else if (outcome.activity_event_id !== null) {
      throw new ValidationError("Activity migration exception cannot reference an event");
    }
  }

  uniqueIndex(tables.access_grants, ["id"], "access grants");
  uniqueIndex(tables.access_grants, ["resource_type", "resource_id", "grantee_user_id"], "resource grants");
  const grantTargets: Record<string, Map<string, BackupRow>> = { project: projects, task: tasks, saved_view: views };
  for (const grant of tables.access_grants) {
    const targetMap = grantTargets[String(grant.resource_type)];
    if (!targetMap) throw new ValidationError("Unsupported grant resource type");
    const target = requireReference(targetMap, grant.resource_id, "Grant resource");
    requireReference(users, grant.owner_user_id, "Grant owner");
    requireReference(users, grant.grantee_user_id, "Grant recipient");
    requireReference(users, grant.granted_by_user_id, "Grant author");
    const effectiveOwnerId = target.owner_user_id;
    if (effectiveOwnerId !== grant.owner_user_id || grant.grantee_user_id === effectiveOwnerId) throw new ValidationError("Grant owner/recipient is invalid");
    if (grant.revoked_at === null && grant.resource_type === "task" && target.project_id !== null) throw new ValidationError("Only standalone tasks can have direct grants");
    if (grant.revoked_at === null && grant.resource_type === "saved_view" && target.scope_project_id !== null) throw new ValidationError("Project-scoped views inherit project access");
    const allowedPermissions =
      grant.resource_type === "project"
        ? ["manager", "editor", "viewer", "full_access"]
        : ["editor", "viewer", "full_access"];
    if (!allowedPermissions.includes(String(grant.permission))) throw new ValidationError("Unsupported grant permission");
  }
}

function upgradeLegacySystemWorkflow(source: BackupTables): BackupTables {
  const statuses: BackupRow[] = source.workflow_statuses.map((status): BackupRow => ({
    ...status,
    system_role: null,
    archived_at: null,
    version: 1,
  }));
  for (const user of source.users) {
    const ownerId = String(user.id);
    const owned = statuses
      .filter((status) => status.owner_user_id === ownerId)
      .sort((left, right) => Number(left.position) - Number(right.position) || String(left.id).localeCompare(String(right.id)));
    const duplicate = owned.find((status) => status.name === "Duplicate")
      ?? owned.find((status) => String(status.name).toLocaleLowerCase() === "duplicate");
    if (duplicate) {
      duplicate.name = "Duplicate";
      duplicate.category = "canceled";
      duplicate.is_default = 0;
      duplicate.system_role = "duplicate";
    } else {
      const maxPosition = owned.reduce((maximum, status) => Math.max(maximum, Number(status.position)), -1);
      statuses.push({
        id: `status:${ownerId}:duplicate`,
        owner_user_id: ownerId,
        name: "Duplicate",
        category: "canceled",
        color: "#9ca3af",
        position: maxPosition + 1,
        is_default: 0,
        system_role: "duplicate",
        archived_at: null,
        version: 1,
        created_at: user.created_at,
        updated_at: user.updated_at,
      });
    }
    if (!owned.some((status) => status.is_default === 1)) {
      const fallback = owned.find((status) => status.category === "unstarted")
        ?? owned.find((status) => status.category === "backlog");
      if (fallback) fallback.is_default = 1;
    }
  }
  return { ...source, workflow_statuses: statuses };
}

function upgradeLegacySystemRelations(source: BackupTables): BackupTables {
  return {
    ...source,
    task_relations: source.task_relations.map((relation): BackupRow => ({
      id: legacyRelationId(relation),
      source_task_id: relation.source_task_id,
      target_task_id: relation.target_task_id,
      type: relation.type,
      creator_user_id: relation.creator_user_id,
      idempotency_key: `legacy:${relation.source_task_id}:${relation.target_task_id}:${relation.type}`,
      version: 1,
      created_at: relation.created_at,
      updated_at: relation.created_at,
    })),
  };
}

function upgradeLegacySystemLabels(source: BackupTables): BackupTables {
  return {
    ...source,
    labels: source.labels.map((label): BackupRow => ({
      ...label,
      description: "",
      archived_at: null,
      version: 1,
      updated_at: label.created_at,
    })),
  };
}

function upgradeLegacySystemSavedViews(source: BackupTables): BackupTables {
  return {
    ...source,
    saved_views: source.saved_views.map((view): BackupRow => ({
      ...view,
      archived_at: null,
    })),
  };
}

function upgradeLegacySystemComments(source: BackupTables): BackupTables {
  return {
    ...source,
    comments: source.comments.map((comment): BackupRow => ({
      ...comment,
      source: "native",
      source_record_id: null,
      source_comment_id: null,
      source_parent_comment_id: null,
      historical_author_name: null,
      historical_created_at: null,
      historical_updated_at: null,
      historical_quoted_text: null,
    })),
    comment_migration_outcomes: [],
  };
}

function legacyRelationId(relation: BackupRow) {
  return `relation_legacy:${relation.source_task_id}:${relation.target_task_id}:${relation.type}`;
}

function upgradeLegacySystemIdentifiers(source: BackupTables): BackupTables {
  const usedByOwner = new Map<string, Set<string>>();
  const projects = [...source.projects]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((project): BackupRow => {
      const ownerId = String(project.owner_user_id);
      const used = usedByOwner.get(ownerId) ?? new Set<string>();
      usedByOwner.set(ownerId, used);
      const taskCode = allocateLegacyProjectCode(String(project.name), used);
      used.add(taskCode);
      const projectTasks = source.tasks.filter((task) => task.project_id === project.id);
      const taskSequence = projectTasks.reduce(
        (maximum, task) => Math.max(maximum, Number(task.sequence_number)),
        0,
      );
      const codeLockedAt = projectTasks
        .map((task) => String(task.created_at))
        .sort()[0] ?? null;
      return { ...project, task_code: taskCode, task_sequence: taskSequence, code_locked_at: codeLockedAt };
    });
  const projectsById = new Map(projects.map((project) => [String(project.id), project]));
  const aliases: BackupRow[] = [];
  const tasks = source.tasks.map((task): BackupRow => {
    if (task.project_id === null) {
      throw new ValidationError(
        "Legacy backup Tasks without Project require an explicit Project mapping",
      );
    }
    const project = projectsById.get(String(task.project_id));
    if (!project) throw new ValidationError("Task references a missing Project");
    aliases.push({
      id: `task_alias_legacy_${String(task.id)}`,
      task_id: task.id,
      identifier: task.identifier,
      created_at: task.created_at,
    });
    return {
      ...task,
      identifier: `${String(project.task_code)}-${String(task.sequence_number)}`,
    };
  });
  return { ...source, projects, tasks, task_identifier_aliases: aliases };
}

function allocateLegacyProjectCode(name: string, used: Set<string>) {
  const known: Record<string, string> = {
    "task manager": "TM",
    "mind diary": "MD",
    "scorched earth": "SE",
    homeostat: "HO",
  };
  const knownCode = known[name.trim().toLowerCase()];
  if (knownCode && !used.has(knownCode)) return knownCode;
  const letters = name.toUpperCase().replace(/[^A-Z]/g, "");
  const suggested = (letters.slice(0, 3) || "PR").padEnd(2, "X");
  if (!used.has(suggested)) return suggested;
  for (let index = 0; index < 26 * 26; index += 1) {
    const candidate = `Z${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new ValidationError("Could not allocate a unique legacy Project code");
}

function normalizeBackupRow(table: TableDefinition, value: unknown, index: number): BackupRow {
  const source = object(value, `tables.${table.name}[${index}]`);
  assertOnlyKeys(source, table.columns, `tables.${table.name}[${index}]`);
  const row: BackupRow = {};
  for (const column of table.columns) {
    const shape = table.shapes?.[column] ?? {};
    const cell = source[column];
    if (cell === null) {
      if (!shape.nullable) throw new ValidationError(`${table.name}.${column} cannot be null`);
    } else if (shape.number) {
      if (typeof cell !== "number" || !Number.isFinite(cell) || (shape.integer && !Number.isInteger(cell))) {
        throw new ValidationError(`${table.name}.${column} must be ${shape.integer ? "an integer" : "a number"}`);
      }
    } else if (typeof cell !== "string") {
      throw new ValidationError(`${table.name}.${column} must be a string`);
    }
    if (typeof cell === "string" && dateColumns.has(column) && !/^\d{4}-\d{2}-\d{2}$/.test(cell)) {
      throw new ValidationError(`${table.name}.${column} must use YYYY-MM-DD`);
    }
    if (typeof cell === "string" && timestampColumns.has(column) && Number.isNaN(Date.parse(cell))) {
      throw new ValidationError(`${table.name}.${column} must be a valid timestamp`);
    }
    row[column] = cell as BackupScalar;
  }
  if (new TextEncoder().encode(JSON.stringify(row)).byteLength > maxStagedRowBytes) {
    throw new ValidationError(`${table.name}[${index}] is too large`);
  }
  return row;
}

function definition(name: BackupTableName, columns: readonly string[], orderBy: string, shapes?: Record<string, ColumnShape>): TableDefinition {
  return { name, columns, orderBy, shapes };
}

function countTables(tables: BackupTables): SystemBackupCounts {
  return Object.fromEntries(backupTableNames.map((name) => [name, tables[name].length])) as SystemBackupCounts;
}

function canonicalBackupJson(value: Omit<SystemBackup, "sha256">): string {
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uniqueIndex(rows: BackupRow[], fields: string[], label: string): Map<string, BackupRow> {
  const result = new Map<string, BackupRow>();
  for (const row of rows) {
    const key = fields.map((field) => String(row[field])).join("\u0000");
    if (result.has(key)) throw new ValidationError(`Duplicate ${label}: ${key.replaceAll("\u0000", "/")}`);
    result.set(key, row);
  }
  return result;
}

function requireReference(index: Map<string, BackupRow>, value: BackupScalar, label: string): BackupRow {
  const row = index.get(String(value));
  if (!row) throw new ValidationError(`${label} references a missing record`);
  return row;
}

function validateParentCycles(rows: BackupRow[], tasks: Map<string, BackupRow>) {
  for (const row of rows) {
    const seen = new Set<string>();
    let current: BackupRow | undefined = row;
    while (current) {
      if (current.parent_task_id === null) break;
      const id = String(current.id);
      if (seen.has(id)) throw new ValidationError("Task parent hierarchy contains a cycle");
      seen.add(id);
      current = tasks.get(String(current.parent_task_id));
    }
  }
}

function validateTerminalState(task: BackupRow, category: BackupScalar) {
  if (category === "completed") {
    if (task.completed_at === null || task.canceled_at !== null) throw new ValidationError("Completed task timestamps are inconsistent");
  } else if (category === "canceled") {
    if (task.canceled_at === null || task.completed_at !== null) throw new ValidationError("Canceled task timestamps are inconsistent");
  } else if (task.completed_at !== null || task.canceled_at !== null) {
    throw new ValidationError("Non-terminal task has a terminal timestamp");
  }
}

function positiveVersion(value: BackupScalar, label: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ValidationError(`${label} must be a positive integer`);
}

function nonEmpty(value: BackupScalar, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${label} cannot be empty`);
}

function boundedTitle(value: BackupScalar, label: string) {
  nonEmpty(value, label);
  if (typeof value === "string" && value.length > 500) throw new ValidationError(`${label} must be 500 characters or fewer`);
}

function publicId(value: BackupScalar, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError(`${label} must be a UUID`);
  }
}

function validTimeZone(value: BackupScalar) {
  if (typeof value !== "string" || !value) throw new ValidationError("User timezone cannot be empty");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    throw new ValidationError("User timezone is invalid");
  }
}

function hasAccess(
  activeGrants: Set<string>,
  userId: BackupScalar,
  ownerUserId: BackupScalar,
  resourceType: "project" | "task",
  resourceId: BackupScalar,
) {
  return userId === ownerUserId || activeGrants.has(`${resourceType}\u0000${resourceId}\u0000${userId}`);
}

function oneOf(value: BackupScalar, allowed: string[], label: string) {
  if (typeof value !== "string" || !allowed.includes(value)) throw new ValidationError(`${label} is invalid`);
}

function isSafeHttpsUrl(value: BackupScalar) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function jsonObject(value: BackupScalar, label: string) {
  if (typeof value !== "string") throw new ValidationError(`${label} must be JSON text`);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  } catch {
    throw new ValidationError(`${label} must contain a JSON object`);
  }
}

function jsonValue(value: BackupScalar, label: string) {
  if (typeof value !== "string") throw new ValidationError(`${label} must be JSON text`);
  try {
    JSON.parse(value);
  } catch {
    throw new ValidationError(`${label} must contain valid JSON`);
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ValidationError(`${label} must be a valid timestamp`);
  return value;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${label} is required`);
  }
  return value;
}

function normalizeOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("System backup site origin is invalid");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new ValidationError("System backup site origin must use HTTPS");
  }
  return url.origin;
}

function normalizeEnvironmentScope(value: string) {
  const scope = value.trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,100}$/.test(scope)) {
    throw new ValidationError("System backup environment scope is invalid");
  }
  return scope;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ValidationError(`Unexpected field ${label}.${key}`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new ValidationError(`Missing field ${label}.${key}`);
  }
}
