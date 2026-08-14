import { ValidationError } from "./domain";
import type { SystemBackupCounts } from "./types";

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
  schemaVersion: 1;
  exportedAt: string;
  counts: SystemBackupCounts;
  tables: BackupTables;
  sha256: string;
};

export const systemBackupFormat = "task-manager-system-backup" as const;
export const systemBackupVersion = 1 as const;
export const systemBackupSchemaVersion = 1 as const;
export const maxSystemBackupBytes = 10_000_000;
const maxSystemBackupRows = 1000;
const maxStagedRowBytes = 1_500_000;
const dateColumns = new Set(["start_date", "target_date", "due_date"]);
const timestampColumns = new Set([
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "canceled_at",
  "archived_at",
  "released_at",
  "imported_at",
  "revoked_at",
]);

export const backupTableNames = [
  "users",
  "user_identities",
  "workflow_statuses",
  "projects",
  "releases",
  "tasks",
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
  definition("workflow_statuses", ["id", "owner_user_id", "name", "category", "color", "position", "is_default", "created_at", "updated_at"], "id", {
    position: { number: true, integer: true },
    is_default: { number: true, integer: true },
  }),
  definition("projects", ["id", "public_id", "owner_user_id", "creator_user_id", "name", "summary", "description", "status", "lead_user_id", "start_date", "target_date", "icon", "color", "archived_at", "version", "created_at", "updated_at"], "id", {
    lead_user_id: { nullable: true }, start_date: { nullable: true }, target_date: { nullable: true }, archived_at: { nullable: true }, version: { number: true, integer: true },
  }),
  definition("releases", ["id", "public_id", "project_id", "owner_user_id", "creator_user_id", "name", "description", "status", "target_date", "released_at", "release_notes", "version", "created_at", "updated_at"], "id", {
    target_date: { nullable: true }, released_at: { nullable: true }, version: { number: true, integer: true },
  }),
  definition("tasks", ["id", "public_id", "owner_user_id", "creator_user_id", "identifier", "sequence_number", "title", "description", "status_id", "priority", "assignee_user_id", "project_id", "release_id", "estimate", "due_date", "parent_task_id", "rank", "started_at", "completed_at", "canceled_at", "archived_at", "version", "created_at", "updated_at"], "id", {
    sequence_number: { number: true, integer: true }, assignee_user_id: { nullable: true }, project_id: { nullable: true }, release_id: { nullable: true }, estimate: { nullable: true, number: true, integer: true }, due_date: { nullable: true }, parent_task_id: { nullable: true }, rank: { number: true }, started_at: { nullable: true }, completed_at: { nullable: true }, canceled_at: { nullable: true }, archived_at: { nullable: true }, version: { number: true, integer: true },
  }),
  definition("labels", ["id", "owner_user_id", "name", "color", "created_at"], "id"),
  definition("task_labels", ["task_id", "label_id"], "task_id, label_id"),
  definition("task_relations", ["source_task_id", "target_task_id", "type", "creator_user_id", "created_at"], "source_task_id, target_task_id, type"),
  definition("saved_views", ["id", "public_id", "owner_user_id", "name", "scope_project_id", "query_json", "display_json", "version", "created_at", "updated_at"], "id", {
    scope_project_id: { nullable: true }, version: { number: true, integer: true },
  }),
  definition("external_records", ["id", "owner_user_id", "target_type", "target_id", "source", "source_id", "source_url", "metadata_json", "imported_at"], "id", {
    source_url: { nullable: true },
  }),
  definition("access_grants", ["id", "resource_type", "resource_id", "owner_user_id", "grantee_user_id", "granted_by_user_id", "permission", "revoked_at", "created_at"], "id", {
    revoked_at: { nullable: true },
  }),
] as const satisfies readonly TableDefinition[];

export const liveTableDeleteOrder: BackupTableName[] = [
  "task_labels",
  "task_relations",
  "access_grants",
  "external_records",
  "tasks",
  "releases",
  "saved_views",
  "projects",
  "labels",
  "workflow_statuses",
  "user_identities",
  "users",
];

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
): Promise<SystemBackup> {
  const counts = countTables(tables);
  const body = {
    format: systemBackupFormat,
    version: systemBackupVersion,
    schemaVersion: systemBackupSchemaVersion,
    exportedAt,
    counts,
    tables,
  };
  return { ...body, sha256: await sha256(canonicalBackupJson(body)) };
}

export async function validateSystemBackup(value: unknown): Promise<SystemBackup> {
  const payload = object(value, "Backup payload");
  assertOnlyKeys(payload, ["format", "version", "schemaVersion", "exportedAt", "counts", "tables", "sha256"], "Backup payload");
  if (payload.format !== systemBackupFormat || payload.version !== systemBackupVersion || payload.schemaVersion !== systemBackupSchemaVersion) {
    throw new ValidationError("Unsupported Task Manager backup format or version");
  }
  const exportedAt = timestamp(payload.exportedAt, "exportedAt");
  const sourceTables = object(payload.tables, "tables");
  assertOnlyKeys(sourceTables, backupTableNames, "tables");
  const tables = {} as BackupTables;
  let totalRows = 0;
  for (const table of tableDefinitions) {
    const sourceRows = array(sourceTables[table.name], `tables.${table.name}`);
    totalRows += sourceRows.length;
    if (totalRows > maxSystemBackupRows) throw new ValidationError(`Backup contains more than ${maxSystemBackupRows} rows`);
    tables[table.name] = sourceRows.map((row, index) => normalizeBackupRow(table, row, index));
  }
  const counts = countTables(tables);
  const claimedCounts = object(payload.counts, "counts");
  assertOnlyKeys(claimedCounts, backupTableNames, "counts");
  for (const name of backupTableNames) {
    if (claimedCounts[name] !== counts[name]) throw new ValidationError(`Count mismatch for ${name}`);
  }
  validateRelationships(tables);
  const body = {
    format: systemBackupFormat,
    version: systemBackupVersion,
    schemaVersion: systemBackupSchemaVersion,
    exportedAt,
    counts,
    tables,
  };
  const checksum = await sha256(canonicalBackupJson(body));
  if (payload.sha256 !== checksum) throw new ValidationError("Backup checksum does not match its content");
  return { ...body, sha256: checksum };
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
  for (const status of tables.workflow_statuses) {
    requireReference(users, status.owner_user_id, "Workflow status owner");
    nonEmpty(status.name, "Workflow status name");
    oneOf(status.category, ["backlog", "unstarted", "started", "completed", "canceled"], "Workflow category");
    if (status.is_default !== 0 && status.is_default !== 1) throw new ValidationError("Workflow is_default must be 0 or 1");
  }

  const projects = uniqueIndex(tables.projects, ["id"], "projects");
  uniqueIndex(tables.projects, ["public_id"], "project public IDs");
  for (const project of tables.projects) {
    requireReference(users, project.owner_user_id, "Project owner");
    requireReference(users, project.creator_user_id, "Project creator");
    publicId(project.public_id, "Project public ID");
    boundedTitle(project.name, "Project name");
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
    const project = requireReference(projects, release.project_id, "Release project");
    requireReference(users, release.creator_user_id, "Release creator");
    publicId(release.public_id, "Release public ID");
    boundedTitle(release.name, "Release name");
    if (release.owner_user_id !== project.owner_user_id) throw new ValidationError("Release owner must match its project owner");
    oneOf(release.status, ["planned", "active", "released", "canceled"], "Release status");
    positiveVersion(release.version, "Release version");
  }

  const tasks = uniqueIndex(tables.tasks, ["id"], "tasks");
  uniqueIndex(tables.tasks, ["public_id"], "task public IDs");
  uniqueIndex(tables.tasks, ["owner_user_id", "identifier"], "task owner/identifier");
  uniqueIndex(tables.tasks, ["owner_user_id", "sequence_number"], "task owner/sequence");
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
    const project = task.project_id === null ? null : requireReference(projects, task.project_id, "Task project");
    if (project && project.owner_user_id !== task.owner_user_id) throw new ValidationError("Task project must belong to the task owner");
    if (task.release_id !== null) {
      const release = requireReference(releases, task.release_id, "Task release");
      if (release.project_id !== task.project_id || release.owner_user_id !== task.owner_user_id) throw new ValidationError("Task release must belong to its project and owner");
    }
    if (task.assignee_user_id !== null) {
      requireReference(users, task.assignee_user_id, "Task assignee");
      const accessType = project ? "project" : "task";
      const accessId = project ? project.id : task.id;
      if (!hasAccess(activeGrants, task.assignee_user_id, task.owner_user_id, accessType, accessId)) {
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
  validateParentCycles(tables.tasks, tasks);

  const labels = uniqueIndex(tables.labels, ["id"], "labels");
  uniqueIndex(tables.labels, ["owner_user_id", "name"], "label owner/name");
  for (const label of tables.labels) {
    requireReference(users, label.owner_user_id, "Label owner");
    boundedTitle(label.name, "Label name");
  }
  uniqueIndex(tables.task_labels, ["task_id", "label_id"], "task labels");
  for (const assignment of tables.task_labels) {
    const task = requireReference(tasks, assignment.task_id, "Task label task");
    const label = requireReference(labels, assignment.label_id, "Task label label");
    if (task.owner_user_id !== label.owner_user_id) throw new ValidationError("Task and label owners must match");
  }

  uniqueIndex(tables.task_relations, ["source_task_id", "target_task_id", "type"], "task relations");
  const relatedPairs = new Set<string>();
  for (const relation of tables.task_relations) {
    const source = requireReference(tasks, relation.source_task_id, "Relation source");
    const target = requireReference(tasks, relation.target_task_id, "Relation target");
    requireReference(users, relation.creator_user_id, "Relation creator");
    if (source.id === target.id || source.owner_user_id !== target.owner_user_id) throw new ValidationError("Relations require different tasks in one owner scope");
    oneOf(relation.type, ["blocks", "related", "duplicate_of"], "Relation type");
    if (relation.type === "related") {
      const key = [source.id, target.id].sort().join("\u0000");
      if (relatedPairs.has(key)) throw new ValidationError("Duplicate symmetric related relation");
      relatedPairs.add(key);
    }
  }

  const views = uniqueIndex(tables.saved_views, ["id"], "saved views");
  uniqueIndex(tables.saved_views, ["public_id"], "saved view public IDs");
  for (const view of tables.saved_views) {
    requireReference(users, view.owner_user_id, "Saved view owner");
    publicId(view.public_id, "Saved view public ID");
    boundedTitle(view.name, "Saved view name");
    if (view.scope_project_id !== null) {
      const project = requireReference(projects, view.scope_project_id, "Saved view project");
      if (project.owner_user_id !== view.owner_user_id) throw new ValidationError("Saved view project must belong to its owner");
    }
    jsonObject(view.query_json, "Saved view query");
    jsonObject(view.display_json, "Saved view display");
    positiveVersion(view.version, "Saved view version");
  }

  uniqueIndex(tables.external_records, ["id"], "external records");
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
    if (target.owner_user_id !== grant.owner_user_id || grant.grantee_user_id === grant.owner_user_id) throw new ValidationError("Grant owner/recipient is invalid");
    if (grant.resource_type === "task" && target.project_id !== null) throw new ValidationError("Only standalone tasks can have direct grants");
    if (grant.permission !== "full_access") throw new ValidationError("Unsupported grant permission");
  }
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

function jsonObject(value: BackupScalar, label: string) {
  if (typeof value !== "string") throw new ValidationError(`${label} must be JSON text`);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  } catch {
    throw new ValidationError(`${label} must contain a JSON object`);
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ValidationError(`${label} must be a valid timestamp`);
  return value;
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
