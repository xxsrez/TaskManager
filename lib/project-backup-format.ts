import { ValidationError } from "./domain";
import {
  tableDefinitions,
  type BackupRow,
  type TableDefinition,
} from "./system-backup-format";
import {
  validateAttachmentBackupObjects,
  type AttachmentBackupObject,
} from "./attachment-backup";
import {
  hasMalformedTaskImageReference,
  parseTaskImageReferences,
} from "./task-description-format";

export const projectBackupFormat = "task-manager-project-backup" as const;
export const projectBackupVersion = 1 as const;
export const projectBackupSchemaVersion = 3 as const;
export const maxProjectBackupBytes = 25_000_000;
const maxProjectBackupRows = 5_000;
const maxProjectBackupRowBytes = 1_500_000;

export const projectBackupTableNames = [
  "workflow_statuses",
  "projects",
  "releases",
  "tasks",
  "attachments",
  "comments",
  "comment_reactions",
  "labels",
  "task_labels",
  "task_relations",
  "saved_views",
  "external_records",
] as const;

export type ProjectBackupTableName = (typeof projectBackupTableNames)[number];
export type ProjectBackupTables = Record<ProjectBackupTableName, BackupRow[]>;
export type ProjectBackupCounts = Record<ProjectBackupTableName | "sharing", number>;

export type ProjectSharingDescriptor = {
  granteeUserId: string;
  email: string;
  displayName: string;
  permission: "manager" | "editor" | "viewer";
};

export type ProjectBackup = {
  format: typeof projectBackupFormat;
  version: typeof projectBackupVersion;
  schemaVersion: 2 | typeof projectBackupSchemaVersion;
  siteOrigin: string;
  exportedAt: string;
  projectId: string;
  projectPublicId: string;
  projectName: string;
  ownerUserId: string;
  counts: ProjectBackupCounts;
  warnings: { externalRelationsOmitted: number };
  tables: ProjectBackupTables;
  objects: AttachmentBackupObject[];
  sharing: ProjectSharingDescriptor[];
  sha256: string;
};

export const projectBackupTableDefinitions = tableDefinitions.filter(
  (table): table is TableDefinition & { name: ProjectBackupTableName } =>
    projectBackupTableNames.includes(table.name as ProjectBackupTableName),
);

export function projectRestoreInsertSql(table: TableDefinition, ignoreExistingId = false): string {
  const extracts = table.columns
    .map((column) => `json_extract(row_json, '$.${column}')`)
    .join(", ");
  return `INSERT INTO ${table.name} (${table.columns.join(", ")})
    SELECT ${extracts} FROM user_import_rows
    WHERE import_id = ? AND row_type = ? AND 1 = 1 ORDER BY ordinal${ignoreExistingId ? "\n    ON CONFLICT(id) DO NOTHING" : ""}`;
}

export async function createProjectBackup(input: {
  siteOrigin: string;
  tables: ProjectBackupTables;
  sharing: ProjectSharingDescriptor[];
  externalRelationsOmitted: number;
  exportedAt?: string;
  objects?: AttachmentBackupObject[];
}): Promise<ProjectBackup> {
  const project = input.tables.projects[0];
  if (!project || input.tables.projects.length !== 1) {
    throw new ValidationError("Project backup must contain exactly one project");
  }
  const body = {
    format: projectBackupFormat,
    version: projectBackupVersion,
    schemaVersion: projectBackupSchemaVersion,
    siteOrigin: normalizeOrigin(input.siteOrigin),
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    projectId: String(project.id),
    projectPublicId: String(project.public_id),
    projectName: String(project.name),
    ownerUserId: String(project.owner_user_id),
    counts: countProjectTables(input.tables, input.sharing),
    warnings: { externalRelationsOmitted: input.externalRelationsOmitted },
    tables: input.tables,
    objects: input.objects ?? [],
    sharing: [...input.sharing].sort((a, b) => a.granteeUserId.localeCompare(b.granteeUserId)),
  };
  validateProjectRelationships(body.tables, body.sharing, body);
  const backup = { ...body, sha256: await sha256(JSON.stringify(body)) };
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > maxProjectBackupBytes) {
    throw new ValidationError(
      "Project backup exceeds the 25 MB bounded package limit; use a smaller attachment set",
    );
  }
  return backup;
}

export async function validateProjectBackup(value: unknown): Promise<ProjectBackup> {
  const payload = object(value, "Project backup");
  const legacy = payload.schemaVersion === 2;
  exactKeys(payload, legacy ? [
    "format", "version", "schemaVersion", "siteOrigin", "exportedAt",
    "projectId", "projectPublicId", "projectName", "ownerUserId", "counts",
    "warnings", "tables", "sharing", "sha256",
  ] : [
    "format", "version", "schemaVersion", "siteOrigin", "exportedAt",
    "projectId", "projectPublicId", "projectName", "ownerUserId", "counts",
    "warnings", "tables", "objects", "sharing", "sha256",
  ], "Project backup");
  if (
    payload.format !== projectBackupFormat ||
    payload.version !== projectBackupVersion ||
    (!legacy && payload.schemaVersion !== projectBackupSchemaVersion)
  ) {
    throw new ValidationError("Unsupported Task Manager project backup format or version");
  }
  const sourceTables = object(payload.tables, "tables");
  const sourceTableNames = legacy
    ? projectBackupTableNames.filter((name) => name !== "attachments")
    : projectBackupTableNames;
  exactKeys(sourceTables, sourceTableNames, "tables");
  const tables = {} as ProjectBackupTables;
  let totalRows = 0;
  for (const table of projectBackupTableDefinitions) {
    const values = legacy && table.name === "attachments"
      ? []
      : array(sourceTables[table.name], `tables.${table.name}`);
    totalRows += values.length;
    if (totalRows > maxProjectBackupRows) {
      throw new ValidationError(`Project backup contains more than ${maxProjectBackupRows} rows`);
    }
    tables[table.name] = values.map((row, index) => normalizeRow(table, row, index));
  }
  const sharing = array(payload.sharing, "sharing").map(normalizeSharing);
  const warnings = object(payload.warnings, "warnings");
  exactKeys(warnings, ["externalRelationsOmitted"], "warnings");
  const externalRelationsOmitted = nonNegativeInteger(
    warnings.externalRelationsOmitted,
    "externalRelationsOmitted",
  );
  const body = {
    format: projectBackupFormat,
    version: projectBackupVersion,
    schemaVersion: projectBackupSchemaVersion,
    siteOrigin: normalizeOrigin(requiredString(payload.siteOrigin, "siteOrigin")),
    exportedAt: instant(payload.exportedAt, "exportedAt"),
    projectId: requiredString(payload.projectId, "projectId"),
    projectPublicId: requiredString(payload.projectPublicId, "projectPublicId"),
    projectName: requiredString(payload.projectName, "projectName"),
    ownerUserId: requiredString(payload.ownerUserId, "ownerUserId"),
    counts: countProjectTables(tables, sharing),
    warnings: { externalRelationsOmitted },
    tables,
    sharing,
  };
  const claimedCounts = object(payload.counts, "counts");
  exactKeys(claimedCounts, [...sourceTableNames, "sharing"], "counts");
  for (const [name, count] of Object.entries(body.counts)) {
    if (legacy && name === "attachments") continue;
    if (claimedCounts[name] !== count) throw new ValidationError(`Count mismatch for ${name}`);
  }
  validateProjectRelationships(tables, sharing, body);
  const objects = legacy
    ? []
    : await validateAttachmentBackupObjects(tables.attachments, payload.objects);
  const baseChecksumBody = {
    format: body.format,
    version: body.version,
    schemaVersion: legacy ? 2 : projectBackupSchemaVersion,
    siteOrigin: body.siteOrigin,
    exportedAt: body.exportedAt,
    projectId: body.projectId,
    projectPublicId: body.projectPublicId,
    projectName: body.projectName,
    ownerUserId: body.ownerUserId,
    counts: legacy
      ? Object.fromEntries(
          Object.entries(body.counts).filter(([name]) => name !== "attachments"),
        )
      : body.counts,
    warnings: body.warnings,
    tables: legacy
      ? Object.fromEntries(
          Object.entries(body.tables).filter(([name]) => name !== "attachments"),
        )
      : body.tables,
  };
  const checksumBody = legacy
    ? { ...baseChecksumBody, sharing }
    : { ...baseChecksumBody, objects, sharing };
  const checksum = await sha256(JSON.stringify(checksumBody));
  if (payload.sha256 !== checksum) {
    throw new ValidationError("Project backup checksum does not match its content");
  }
  return {
    ...body,
    schemaVersion: payload.schemaVersion as 2 | 3,
    objects,
    sha256: checksum,
  } as ProjectBackup;
}

function validateProjectRelationships(
  tables: ProjectBackupTables,
  sharing: ProjectSharingDescriptor[],
  identity: { projectId: string; projectPublicId: string; projectName: string; ownerUserId: string },
) {
  if (tables.projects.length !== 1) throw new ValidationError("Project backup must contain exactly one project");
  const project = tables.projects[0]!;
  if (
    project.id !== identity.projectId || project.public_id !== identity.projectPublicId ||
    project.name !== identity.projectName || project.owner_user_id !== identity.ownerUserId
  ) throw new ValidationError("Project backup identity does not match its project row");

  const tasks = unique(tables.tasks, "id", "task");
  const comments = unique(tables.comments, "id", "comment");
  const releases = unique(tables.releases, "id", "release");
  const statuses = unique(tables.workflow_statuses, "id", "workflow status");
  const labels = unique(tables.labels, "id", "label");
  const views = unique(tables.saved_views, "id", "saved view");
  for (const release of tables.releases) {
    if (release.project_id !== identity.projectId) throw new ValidationError("Release is outside the backed-up project");
  }
  for (const task of tables.tasks) {
    if (task.project_id !== identity.projectId) throw new ValidationError("Task is outside the backed-up project");
    if (!statuses.has(String(task.status_id))) throw new ValidationError("Task references a missing workflow status dependency");
    if (task.release_id !== null && !releases.has(String(task.release_id))) throw new ValidationError("Task references a missing release");
    if (task.parent_task_id !== null && !tasks.has(String(task.parent_task_id))) throw new ValidationError("Task parent is outside the project bundle");
  }
  assertNoParentCycle(tables.tasks, tasks);
  const attachments = unique(tables.attachments, "id", "attachment");
  const attachmentPublicIds = unique(
    tables.attachments,
    "public_id",
    "attachment public ID",
  );
  const attachmentIdempotency = new Set<string>();
  for (const attachment of tables.attachments) {
    if (!tasks.has(String(attachment.task_id))) {
      throw new ValidationError("Attachment is outside the project bundle");
    }
    if (!String(attachment.uploader_user_id).trim()) {
      throw new ValidationError("Attachment uploader is required");
    }
    if (!/^[a-f0-9]{64}$/.test(String(attachment.checksum_sha256))) {
      throw new ValidationError("Attachment checksum must be SHA-256");
    }
    if (
      !Number.isSafeInteger(attachment.byte_size) ||
      Number(attachment.byte_size) < 0
    ) {
      throw new ValidationError("Attachment byte size must be non-negative");
    }
    if (attachment.kind !== "file" && attachment.kind !== "image") {
      throw new ValidationError("Attachment kind is invalid");
    }
    if (
      !["pending", "uploading", "ready", "failed", "deleted"].includes(
        String(attachment.state),
      )
    ) {
      throw new ValidationError("Attachment state is invalid");
    }
    if (attachment.state === "deleted" && attachment.deleted_at === null) {
      throw new ValidationError("Deleted attachment requires deleted_at");
    }
    const idempotency = `${attachment.task_id}\u0000${attachment.uploader_user_id}\u0000${attachment.idempotency_key}`;
    if (attachmentIdempotency.has(idempotency)) {
      throw new ValidationError("Duplicate attachment idempotency key");
    }
    attachmentIdempotency.add(idempotency);
    parseJsonObject(
      attachment.variant_metadata_json,
      "Attachment variant metadata",
    );
  }
  void attachments;
  for (const task of tables.tasks) {
    const description = String(task.description ?? "");
    if (hasMalformedTaskImageReference(description)) {
      throw new ValidationError(
        "Task description contains a malformed attachment reference",
      );
    }
    for (const reference of parseTaskImageReferences(description)) {
      const attachment = attachmentPublicIds.get(reference.ref);
      if (
        !attachment ||
        attachment.task_id !== task.id ||
        attachment.kind !== "image" ||
        attachment.state !== "ready"
      ) {
        throw new ValidationError(
          "Task description references a missing or unavailable attachment",
        );
      }
    }
  }
  const commentKeys = new Set<string>();
  const activeComments = new Map<string, number>();
  for (const comment of tables.comments) {
    if (!tasks.has(String(comment.task_id))) throw new ValidationError("Comment is outside the project bundle");
    if (!String(comment.author_user_id).trim()) throw new ValidationError("Comment author is required");
    if (!String(comment.idempotency_key).trim()) throw new ValidationError("Comment idempotency key is required");
    if (comment.source !== "native") throw new ValidationError("Project backup contains a non-native comment");
    if (!Number.isInteger(comment.version) || Number(comment.version) < 1) {
      throw new ValidationError("Comment version must be a positive integer");
    }
    const key = `${comment.task_id}\u0000${comment.author_user_id}\u0000${comment.idempotency_key}`;
    if (commentKeys.has(key)) throw new ValidationError("Duplicate comment idempotency key");
    commentKeys.add(key);
    if (comment.deleted_at === null) {
      if (!String(comment.body).trim()) throw new ValidationError("Active comment body cannot be empty");
      activeComments.set(String(comment.task_id), (activeComments.get(String(comment.task_id)) ?? 0) + 1);
    }
    if (comment.parent_comment_id !== null) {
      const parent = comments.get(String(comment.parent_comment_id));
      if (!parent || parent.task_id !== comment.task_id || parent.parent_comment_id !== null) {
        throw new ValidationError("Comment reply must use a root in the same project task");
      }
      if (
        comment.resolved_at !== null ||
        comment.resolved_by_user_id !== null ||
        comment.resolution_comment_id !== null
      ) {
        throw new ValidationError("Only root comments can carry thread resolution");
      }
    }
    if (comment.resolved_at === null) {
      if (comment.resolved_by_user_id !== null || comment.resolution_comment_id !== null) {
        throw new ValidationError("Open comment threads cannot carry resolution metadata");
      }
    } else if (comment.resolved_by_user_id === null) {
      throw new ValidationError("Resolved comment thread requires a resolver");
    }
    if (comment.resolution_comment_id !== null) {
      const resolution = comments.get(String(comment.resolution_comment_id));
      if (!resolution || (resolution.id !== comment.id && resolution.parent_comment_id !== comment.id)) {
        throw new ValidationError("Resolution comment must belong to the root thread");
      }
    }
  }
  for (const task of tables.tasks) {
    if (task.comment_count !== (activeComments.get(String(task.id)) ?? 0)) {
      throw new ValidationError("Task comment_count does not match project comments");
    }
  }
  const reactionKeys = new Set<string>();
  for (const reaction of tables.comment_reactions) {
    if (!comments.has(String(reaction.comment_id))) throw new ValidationError("Reaction references a missing project comment");
    if (!String(reaction.user_id).trim()) throw new ValidationError("Reaction user is required");
    if (!String(reaction.emoji).trim()) throw new ValidationError("Reaction emoji is required");
    const key = `${reaction.comment_id}\u0000${reaction.user_id}\u0000${reaction.emoji}`;
    if (reactionKeys.has(key)) throw new ValidationError("Duplicate project comment reaction");
    reactionKeys.add(key);
  }
  for (const view of tables.saved_views) {
    if (view.scope_project_id !== identity.projectId) throw new ValidationError("Saved view is outside the backed-up project");
    parseJsonObject(view.query_json, "Saved view query");
    parseJsonObject(view.display_json, "Saved view display");
  }
  for (const assignment of tables.task_labels) {
    if (!tasks.has(String(assignment.task_id)) || !labels.has(String(assignment.label_id))) {
      throw new ValidationError("Task label references a missing bundle record");
    }
  }
  const relationKeys = new Set<string>();
  for (const relation of tables.task_relations) {
    if (!tasks.has(String(relation.source_task_id)) || !tasks.has(String(relation.target_task_id))) {
      throw new ValidationError("Task relation crosses the project bundle boundary");
    }
    if (relation.source_task_id === relation.target_task_id) throw new ValidationError("Task cannot relate to itself");
    const key = `${relation.source_task_id}\u0000${relation.target_task_id}\u0000${relation.type}`;
    if (relationKeys.has(key)) throw new ValidationError("Duplicate task relation");
    relationKeys.add(key);
  }
  const targets = new Map<string, Set<string>>([
    ["project", new Set([identity.projectId])],
    ["release", new Set(releases.keys())],
    ["task", new Set(tasks.keys())],
    ["saved_view", new Set(views.keys())],
    ["label", new Set(labels.keys())],
    ["workflow_status", new Set(statuses.keys())],
  ]);
  for (const record of tables.external_records) {
    const target = targets.get(String(record.target_type));
    if (!target?.has(String(record.target_id))) throw new ValidationError("External provenance references a missing bundle record");
    parseJsonObject(record.metadata_json, "External metadata");
  }
  const grantees = new Set<string>();
  for (const descriptor of sharing) {
    if (descriptor.granteeUserId === identity.ownerUserId) throw new ValidationError("Project owner cannot be a sharing descriptor");
    if (grantees.has(descriptor.granteeUserId)) throw new ValidationError("Duplicate project sharing descriptor");
    grantees.add(descriptor.granteeUserId);
  }
}

function normalizeRow(table: TableDefinition, value: unknown, index: number): BackupRow {
  const source = object(value, `${table.name}[${index}]`);
  exactKeys(source, table.columns, `${table.name}[${index}]`);
  const row: BackupRow = {};
  for (const column of table.columns) {
    const cell = source[column];
    const shape = table.shapes?.[column];
    if (cell === null) {
      if (!shape?.nullable) throw new ValidationError(`${table.name}.${column} cannot be null`);
    } else if (shape?.number) {
      if (typeof cell !== "number" || !Number.isFinite(cell) || (shape.integer && !Number.isInteger(cell))) {
        throw new ValidationError(`${table.name}.${column} has an invalid number`);
      }
    } else if (typeof cell !== "string") {
      throw new ValidationError(`${table.name}.${column} must be a string`);
    }
    row[column] = cell as string | number | null;
  }
  if (new TextEncoder().encode(JSON.stringify(row)).byteLength > maxProjectBackupRowBytes) {
    throw new ValidationError(`${table.name}[${index}] is too large`);
  }
  return row;
}

function normalizeSharing(value: unknown, index: number): ProjectSharingDescriptor {
  const row = object(value, `sharing[${index}]`);
  exactKeys(row, ["granteeUserId", "email", "displayName", "permission"], `sharing[${index}]`);
  const permission = row.permission;
  if (permission !== "manager" && permission !== "editor" && permission !== "viewer") {
    throw new ValidationError("Unsupported project sharing role");
  }
  return {
    granteeUserId: requiredString(row.granteeUserId, "granteeUserId"),
    email: requiredString(row.email, "email").trim().toLowerCase(),
    displayName: requiredString(row.displayName, "displayName"),
    permission,
  };
}

function countProjectTables(tables: ProjectBackupTables, sharing: ProjectSharingDescriptor[]): ProjectBackupCounts {
  return Object.fromEntries([
    ...projectBackupTableNames.map((name) => [name, tables[name].length]),
    ["sharing", sharing.length],
  ]) as ProjectBackupCounts;
}

function unique(rows: BackupRow[], field: string, label: string) {
  const result = new Map<string, BackupRow>();
  for (const row of rows) {
    const key = String(row[field]);
    if (result.has(key)) throw new ValidationError(`Duplicate ${label} ${key}`);
    result.set(key, row);
  }
  return result;
}

function assertNoParentCycle(rows: BackupRow[], tasks: Map<string, BackupRow>) {
  for (const task of rows) {
    const seen = new Set<string>();
    let current: BackupRow | undefined = task;
    while (current && current.parent_task_id !== null) {
      const id = String(current.id);
      if (seen.has(id)) throw new ValidationError("Task parent hierarchy contains a cycle");
      seen.add(id);
      current = tasks.get(String(current.parent_task_id));
    }
  }
}

function parseJsonObject(value: string | number | null, label: string) {
  if (typeof value !== "string") throw new ValidationError(`${label} must be JSON`);
  try {
    object(JSON.parse(value), label);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`${label} must be valid JSON`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new ValidationError(`${label} contains unsupported field ${key}`);
  for (const key of allowed) if (!(key in value)) throw new ValidationError(`${label} is missing ${key}`);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${label} is required`);
  return value;
}

function instant(value: unknown, label: string) {
  const result = requiredString(value, label);
  if (Number.isNaN(Date.parse(result))) throw new ValidationError(`${label} must be an ISO timestamp`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string) {
  if (!Number.isInteger(value) || Number(value) < 0) throw new ValidationError(`${label} must be a non-negative integer`);
  return Number(value);
}

function normalizeOrigin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError("Project backup site origin is invalid"); }
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new ValidationError("Project backup site origin must use HTTPS");
  return url.origin;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
