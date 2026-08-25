import { ValidationError } from "./domain";
import {
  restoreTableDefinitions,
  tableDefinitions,
  type BackupRow,
  type TableDefinition,
} from "./system-backup-format";
import {
  validateAttachmentBackupObjects,
  type AttachmentBackupObject,
} from "./attachment-backup";
import {
  hasMalformedTaskAttachmentReference,
  parseTaskAttachmentReferences,
} from "./task-description-format";
import { isProjectTaskCode, PROJECT_TASK_CODE_ERROR } from "./project-task-code";

export const projectBackupFormat = "task-manager-project-backup" as const;
export const projectBackupVersion = 1 as const;
export const projectBackupSchemaVersion = 13 as const;
export const maxProjectBackupBytes = 25_000_000;
const maxProjectBackupRows = 5_000;
const maxProjectBackupRowBytes = 1_500_000;

export const projectBackupTableNames = [
  "workflow_statuses",
  "projects",
  "releases",
  "tasks",
  "task_identifier_aliases",
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
  schemaVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | typeof projectBackupSchemaVersion;
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

export const projectBackupRestoreTableDefinitions = restoreTableDefinitions.filter(
  (table): table is TableDefinition & { name: ProjectBackupTableName } =>
    projectBackupTableNames.includes(table.name as ProjectBackupTableName),
);

const legacyWorkflowStatusDefinition: TableDefinition = {
  name: "workflow_statuses",
  columns: ["id", "owner_user_id", "name", "category", "color", "position", "is_default", "created_at", "updated_at"],
  orderBy: "id",
  shapes: {
    position: { number: true, integer: true },
    is_default: { number: true, integer: true },
  },
};

const legacyTaskRelationDefinition: TableDefinition = {
  name: "task_relations",
  columns: ["source_task_id", "target_task_id", "type", "creator_user_id", "created_at"],
  orderBy: "source_task_id, target_task_id, type",
};

const legacyProjectDefinition: TableDefinition = {
  name: "projects",
  columns: ["id", "public_id", "owner_user_id", "creator_user_id", "name", "summary", "description", "status", "lead_user_id", "start_date", "target_date", "icon", "color", "archived_at", "version", "created_at", "updated_at"],
  orderBy: "id",
  shapes: {
    lead_user_id: { nullable: true }, start_date: { nullable: true },
    target_date: { nullable: true }, archived_at: { nullable: true },
    version: { number: true, integer: true },
  },
};

const legacyTaskDefinition: TableDefinition = {
  name: "tasks",
  columns: ["id", "public_id", "owner_user_id", "creator_user_id", "identifier", "sequence_number", "title", "description", "status_id", "priority", "assignee_user_id", "project_id", "release_id", "estimate", "due_date", "parent_task_id", "rank", "started_at", "completed_at", "canceled_at", "archived_at", "comment_count", "version", "created_at", "updated_at"],
  orderBy: "id",
  shapes: {
    sequence_number: { number: true, integer: true }, assignee_user_id: { nullable: true },
    project_id: { nullable: true }, release_id: { nullable: true },
    estimate: { nullable: true, number: true, integer: true }, due_date: { nullable: true },
    parent_task_id: { nullable: true }, rank: { number: true }, started_at: { nullable: true },
    completed_at: { nullable: true }, canceled_at: { nullable: true }, archived_at: { nullable: true },
    comment_count: { number: true, integer: true }, version: { number: true, integer: true },
  },
};

const legacyLabelDefinition: TableDefinition = {
  name: "labels",
  columns: ["id", "owner_user_id", "name", "color", "created_at"],
  orderBy: "id",
};

const flatLabelDefinition: TableDefinition = {
  name: "labels",
  columns: ["id", "owner_user_id", "name", "color", "description", "archived_at", "version", "created_at", "updated_at"],
  orderBy: "id",
  shapes: { archived_at: { nullable: true }, version: { number: true, integer: true } },
};

const legacySavedViewDefinition: TableDefinition = {
  name: "saved_views",
  columns: ["id", "public_id", "owner_user_id", "name", "scope_project_id", "query_json", "display_json", "version", "created_at", "updated_at"],
  orderBy: "id",
  shapes: {
    scope_project_id: { nullable: true },
    version: { number: true, integer: true },
  },
};

const legacyCommentDefinition: TableDefinition = {
  name: "comments",
  columns: ["id", "task_id", "author_user_id", "body", "source", "parent_comment_id", "idempotency_key", "created_at", "updated_at", "deleted_at", "resolved_at", "resolved_by_user_id", "resolution_comment_id", "version"],
  orderBy: "task_id, created_at, id",
  shapes: {
    parent_comment_id: { nullable: true }, deleted_at: { nullable: true },
    resolved_at: { nullable: true }, resolved_by_user_id: { nullable: true },
    resolution_comment_id: { nullable: true }, version: { number: true, integer: true },
  },
};

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
  const withoutAttachments = payload.schemaVersion === 2;
  const legacyWorkflow = payload.schemaVersion === 2 || payload.schemaVersion === 3;
  const legacyRelations = payload.schemaVersion === 2 || payload.schemaVersion === 3 || payload.schemaVersion === 4;
  const legacyIdentifiers = payload.schemaVersion === 2 || payload.schemaVersion === 3 || payload.schemaVersion === 4 || payload.schemaVersion === 5;
  const legacyLabels = payload.schemaVersion === 2 || payload.schemaVersion === 3 || payload.schemaVersion === 4 || payload.schemaVersion === 5 || payload.schemaVersion === 6;
  const legacySavedViews = payload.schemaVersion === 2 || payload.schemaVersion === 3 || payload.schemaVersion === 4 || payload.schemaVersion === 5 || payload.schemaVersion === 6 || payload.schemaVersion === 7;
  const legacyHistoricalComments = payload.schemaVersion === 2 || payload.schemaVersion === 3 || payload.schemaVersion === 4 || payload.schemaVersion === 5 || payload.schemaVersion === 6 || payload.schemaVersion === 7 || payload.schemaVersion === 8;
  const legacyActivity = typeof payload.schemaVersion === "number" && payload.schemaVersion <= 9;
  const legacyAttachmentMigration = typeof payload.schemaVersion === "number" && payload.schemaVersion <= 10;
  const legacyLabelGroups = typeof payload.schemaVersion === "number" && payload.schemaVersion <= 11;
  const legacyCommentAttachmentRefs = typeof payload.schemaVersion === "number" && payload.schemaVersion <= 12;
  const supported = payload.schemaVersion === 2 || payload.schemaVersion === 3 || payload.schemaVersion === 4 || payload.schemaVersion === 5 || payload.schemaVersion === 6 || payload.schemaVersion === 7 || payload.schemaVersion === 8 || payload.schemaVersion === 9 || payload.schemaVersion === 10 || payload.schemaVersion === 11 || payload.schemaVersion === 12 || payload.schemaVersion === projectBackupSchemaVersion;
  exactKeys(payload, withoutAttachments ? [
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
    !supported
  ) {
    throw new ValidationError("Unsupported Task Manager project backup format or version");
  }
  const sourceTables = object(payload.tables, "tables");
  const legacyLabelGroupsMissing = legacyLabelGroups && !Object.hasOwn(sourceTables, "label_groups");
  const sourceTableNames = projectBackupTableNames.filter((name) =>
    !(withoutAttachments && name === "attachments") &&
    !(legacyIdentifiers && name === "task_identifier_aliases") &&
    !(legacyHistoricalComments && name === "comment_migration_outcomes") &&
    !(legacyActivity && (name === "activity_events" || name === "activity_migration_outcomes")) &&
    !(legacyAttachmentMigration && name === "attachment_migration_outcomes") &&
    !(legacyLabelGroupsMissing && name === "label_groups") &&
    !(legacyCommentAttachmentRefs && name === "comment_attachment_refs"),
  );
  exactKeys(sourceTables, sourceTableNames, "tables");
  const sourceNormalizedTables = {} as ProjectBackupTables;
  let totalRows = 0;
  for (const table of projectBackupTableDefinitions) {
    const values = (withoutAttachments && table.name === "attachments") ||
      (legacyIdentifiers && table.name === "task_identifier_aliases") ||
      (legacyHistoricalComments && table.name === "comment_migration_outcomes") ||
      (legacyActivity && (table.name === "activity_events" || table.name === "activity_migration_outcomes")) ||
      (legacyAttachmentMigration && table.name === "attachment_migration_outcomes") ||
      (legacyLabelGroupsMissing && table.name === "label_groups") ||
      (legacyCommentAttachmentRefs && table.name === "comment_attachment_refs")
      ? []
      : array(sourceTables[table.name], `tables.${table.name}`);
    totalRows += values.length;
    if (totalRows > maxProjectBackupRows) {
      throw new ValidationError(`Project backup contains more than ${maxProjectBackupRows} rows`);
    }
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
      : legacyLabelGroups && table.name === "labels" &&
          !values.some((row) => Object.hasOwn(object(row, "label"), "group_id"))
        ? flatLabelDefinition
      : legacyHistoricalComments && table.name === "comments"
        ? legacyCommentDefinition
      : legacySavedViews && table.name === "saved_views" &&
          !values.some((row) => Object.hasOwn(object(row, "saved view"), "archived_at"))
        ? legacySavedViewDefinition
        : table;
    sourceNormalizedTables[table.name] = values.map((row, index) =>
      normalizeRow(sourceDefinition, row, index),
    );
  }
  const sharing = array(payload.sharing, "sharing").map(normalizeSharing);
  const warnings = object(payload.warnings, "warnings");
  exactKeys(warnings, ["externalRelationsOmitted"], "warnings");
  const externalRelationsOmitted = nonNegativeInteger(
    warnings.externalRelationsOmitted,
    "externalRelationsOmitted",
  );
  let tables = legacyWorkflow
    ? upgradeLegacyProjectWorkflow(sourceNormalizedTables)
    : sourceNormalizedTables;
  if (legacyRelations) tables = upgradeLegacyProjectRelations(tables);
  if (legacyIdentifiers) tables = upgradeLegacyProjectIdentifiers(tables);
  if (legacyLabels) tables = upgradeLegacyProjectLabels(tables);
  if (legacyLabelGroups) tables = upgradeLegacyProjectLabelGroups(tables);
  if (legacySavedViews) tables = upgradeLegacyProjectSavedViews(tables);
  if (legacyHistoricalComments) tables = upgradeLegacyProjectComments(tables);
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
    counts: countProjectTables(sourceNormalizedTables, sharing),
    warnings: { externalRelationsOmitted },
    tables,
    sharing,
  };
  const claimedCounts = object(payload.counts, "counts");
  exactKeys(claimedCounts, [...sourceTableNames, "sharing"], "counts");
  for (const [name, count] of Object.entries(body.counts)) {
    if (withoutAttachments && name === "attachments") continue;
    if (legacyIdentifiers && name === "task_identifier_aliases") continue;
    if (legacyHistoricalComments && name === "comment_migration_outcomes") continue;
    if (legacyActivity && (name === "activity_events" || name === "activity_migration_outcomes")) continue;
    if (legacyAttachmentMigration && name === "attachment_migration_outcomes") continue;
    if (legacyLabelGroupsMissing && name === "label_groups") continue;
    if (legacyCommentAttachmentRefs && name === "comment_attachment_refs") continue;
    if (claimedCounts[name] !== count) throw new ValidationError(`Count mismatch for ${name}`);
  }
  validateProjectRelationships(tables, sharing, body, !legacyCommentAttachmentRefs);
  const objects = withoutAttachments
    ? []
    : await validateAttachmentBackupObjects(tables.attachments, payload.objects);
  const baseChecksumBody = {
    format: body.format,
    version: body.version,
    schemaVersion: payload.schemaVersion as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13,
    siteOrigin: body.siteOrigin,
    exportedAt: body.exportedAt,
    projectId: body.projectId,
    projectPublicId: body.projectPublicId,
    projectName: body.projectName,
    ownerUserId: body.ownerUserId,
    counts: withoutAttachments || legacyIdentifiers || legacyHistoricalComments || legacyActivity || legacyAttachmentMigration || legacyLabelGroupsMissing || legacyCommentAttachmentRefs
      ? Object.fromEntries(
          Object.entries(body.counts).filter(([name]) =>
            !(withoutAttachments && name === "attachments") &&
            !(legacyIdentifiers && name === "task_identifier_aliases") &&
            !(legacyHistoricalComments && name === "comment_migration_outcomes") &&
            !(legacyActivity && (name === "activity_events" || name === "activity_migration_outcomes")) &&
            !(legacyAttachmentMigration && name === "attachment_migration_outcomes") &&
            !(legacyLabelGroupsMissing && name === "label_groups") &&
            !(legacyCommentAttachmentRefs && name === "comment_attachment_refs"),
          ),
        )
      : body.counts,
    warnings: body.warnings,
    tables: withoutAttachments || legacyIdentifiers || legacyHistoricalComments || legacyActivity || legacyAttachmentMigration || legacyLabelGroupsMissing || legacyCommentAttachmentRefs
      ? Object.fromEntries(
          Object.entries(sourceNormalizedTables).filter(([name]) =>
            !(withoutAttachments && name === "attachments") &&
            !(legacyIdentifiers && name === "task_identifier_aliases") &&
            !(legacyHistoricalComments && name === "comment_migration_outcomes") &&
            !(legacyActivity && (name === "activity_events" || name === "activity_migration_outcomes")) &&
            !(legacyAttachmentMigration && name === "attachment_migration_outcomes") &&
            !(legacyLabelGroupsMissing && name === "label_groups") &&
            !(legacyCommentAttachmentRefs && name === "comment_attachment_refs"),
          ),
        )
      : sourceNormalizedTables,
  };
  const checksumBody = withoutAttachments
    ? { ...baseChecksumBody, sharing }
    : { ...baseChecksumBody, objects, sharing };
  const checksum = await sha256(JSON.stringify(checksumBody));
  if (payload.sha256 !== checksum) {
    throw new ValidationError("Project backup checksum does not match its content");
  }
  return {
    ...body,
    schemaVersion: payload.schemaVersion as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13,
    objects,
    sha256: checksum,
  } as ProjectBackup;
}

function validateProjectRelationships(
  tables: ProjectBackupTables,
  sharing: ProjectSharingDescriptor[],
  identity: { projectId: string; projectPublicId: string; projectName: string; ownerUserId: string },
  validateCommentAttachmentRefs = true,
) {
  if (tables.projects.length !== 1) throw new ValidationError("Project backup must contain exactly one project");
  const project = tables.projects[0]!;
  if (
    project.id !== identity.projectId || project.public_id !== identity.projectPublicId ||
    project.name !== identity.projectName || project.owner_user_id !== identity.ownerUserId
  ) throw new ValidationError("Project backup identity does not match its project row");
  if (!isProjectTaskCode(project.task_code)) {
    throw new ValidationError(PROJECT_TASK_CODE_ERROR);
  }
  if (!Number.isSafeInteger(project.task_sequence) || Number(project.task_sequence) < 0) {
    throw new ValidationError("Project task sequence must be a non-negative integer");
  }

  const tasks = unique(tables.tasks, "id", "task");
  const comments = unique(tables.comments, "id", "comment");
  const releases = unique(tables.releases, "id", "release");
  const statuses = unique(tables.workflow_statuses, "id", "workflow status");
  const labelGroups = unique(tables.label_groups, "id", "label group");
  const activeLabelGroupNames = new Set<string>();
  for (const group of tables.label_groups) {
    if (group.owner_user_id !== identity.ownerUserId) {
      throw new ValidationError("Label Group is outside the Project owner catalog");
    }
    if (!String(group.name).trim()) throw new ValidationError("Label Group name is required");
    if (!Number.isSafeInteger(group.position) || Number(group.position) < 0) {
      throw new ValidationError("Label Group position is invalid");
    }
    if (!Number.isSafeInteger(group.version) || Number(group.version) < 1) {
      throw new ValidationError("Label Group version is invalid");
    }
    if (group.archived_at === null) {
      const key = String(group.name).toLocaleLowerCase();
      if (activeLabelGroupNames.has(key)) throw new ValidationError("Duplicate active Label Group name");
      activeLabelGroupNames.add(key);
    }
  }
  const labels = unique(tables.labels, "id", "label");
  const activeLabelNames = new Set<string>();
  for (const label of tables.labels) {
    if (label.owner_user_id !== identity.ownerUserId) {
      throw new ValidationError("Label is outside the Project owner catalog");
    }
    if (label.group_id !== null) {
      const group = labelGroups.get(String(label.group_id));
      if (!group || group.owner_user_id !== label.owner_user_id) {
        throw new ValidationError("Label references an incompatible Label Group");
      }
    }
    if (!String(label.name).trim()) throw new ValidationError("Label name is required");
    if (!Number.isSafeInteger(label.version) || Number(label.version) < 1) {
      throw new ValidationError("Label version is invalid");
    }
    if (label.archived_at === null) {
      const key = String(label.name).toLocaleLowerCase();
      if (activeLabelNames.has(key)) throw new ValidationError("Duplicate active Label name");
      activeLabelNames.add(key);
    }
  }
  const views = unique(tables.saved_views, "id", "saved view");
  for (const status of tables.workflow_statuses) {
    if (!categories.includes(String(status.category))) {
      throw new ValidationError("Workflow category is invalid");
    }
    if (!Number.isSafeInteger(status.version) || Number(status.version) < 1) {
      throw new ValidationError("Workflow status version is invalid");
    }
    if (status.system_role !== null && status.system_role !== "duplicate") {
      throw new ValidationError("Workflow system role is invalid");
    }
    if (status.system_role === "duplicate" && (
      status.name !== "Duplicate" || status.category !== "canceled" ||
      status.archived_at !== null || status.is_default !== 0
    )) {
      throw new ValidationError("Reserved Duplicate workflow status is invalid");
    }
  }
  for (const release of tables.releases) {
    if (release.project_id !== identity.projectId) throw new ValidationError("Release is outside the backed-up project");
  }
  for (const task of tables.tasks) {
    if (task.project_id !== identity.projectId) throw new ValidationError("Task is outside the backed-up project");
    if (task.identifier !== `${String(project.task_code)}-${String(task.sequence_number)}`) {
      throw new ValidationError("Task identifier must use its Project code and sequence");
    }
    if (!statuses.has(String(task.status_id))) throw new ValidationError("Task references a missing workflow status dependency");
    if (task.release_id !== null && !releases.has(String(task.release_id))) throw new ValidationError("Task references a missing release");
    if (task.parent_task_id !== null && !tasks.has(String(task.parent_task_id))) throw new ValidationError("Task parent is outside the project bundle");
  }
  const maximumTaskSequence = tables.tasks.reduce(
    (maximum, task) => Math.max(maximum, Number(task.sequence_number)),
    0,
  );
  if (Number(project.task_sequence) < maximumTaskSequence) {
    throw new ValidationError("Project task sequence is behind its Tasks");
  }
  if ((Number(project.task_sequence) > 0) !== (project.code_locked_at !== null)) {
    throw new ValidationError("Project code lock must match whether Tasks exist");
  }
  const aliases = unique(tables.task_identifier_aliases, "id", "task identifier alias");
  const aliasPairs = new Set<string>();
  for (const alias of tables.task_identifier_aliases) {
    if (!tasks.has(String(alias.task_id))) {
      throw new ValidationError("Task identifier alias is outside the project bundle");
    }
    if (!String(alias.identifier).trim()) {
      throw new ValidationError("Task identifier alias is required");
    }
    const pair = `${String(alias.task_id)}\u0000${String(alias.identifier)}`;
    if (aliasPairs.has(pair)) throw new ValidationError("Duplicate Task identifier alias");
    aliasPairs.add(pair);
  }
  void aliases;
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
    if (hasMalformedTaskAttachmentReference(description)) {
      throw new ValidationError(
        "Task description contains a malformed attachment reference",
      );
    }
    for (const reference of parseTaskAttachmentReferences(description)) {
      const attachment = attachmentPublicIds.get(reference.ref);
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
  const commentKeys = new Set<string>();
  const historicalCommentKeys = new Set<string>();
  const activeComments = new Map<string, number>();
  for (const comment of tables.comments) {
    if (!tasks.has(String(comment.task_id))) throw new ValidationError("Comment is outside the project bundle");
    if (!String(comment.idempotency_key).trim()) throw new ValidationError("Comment idempotency key is required");
    if (comment.source !== "native" && comment.source !== "linear") {
      throw new ValidationError("Project backup contains an unsupported comment source");
    }
    if (comment.source === "native") {
      if (!String(comment.author_user_id).trim()) throw new ValidationError("Comment author is required");
      for (const value of [
        comment.source_record_id, comment.source_comment_id,
        comment.source_parent_comment_id, comment.historical_author_name,
        comment.historical_created_at, comment.historical_updated_at,
        comment.historical_quoted_text,
      ]) {
        if (value !== null) throw new ValidationError("Native comments cannot carry historical facts");
      }
      const key = `${comment.task_id}\u0000${comment.author_user_id}\u0000${comment.idempotency_key}`;
      if (commentKeys.has(key)) throw new ValidationError("Duplicate comment idempotency key");
      commentKeys.add(key);
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
      ] as const) {
        if (!String(value ?? "").trim()) throw new ValidationError(`Historical comment ${label} is required`);
      }
      instant(comment.historical_created_at, "Historical comment created timestamp");
      instant(comment.historical_updated_at, "Historical comment updated timestamp");
      const sourceKey = `${comment.task_id}\u0000${comment.source}\u0000${comment.source_comment_id}`;
      if (historicalCommentKeys.has(sourceKey)) {
        throw new ValidationError("Duplicate historical comment source identity");
      }
      historicalCommentKeys.add(sourceKey);
    }
    if (!Number.isInteger(comment.version) || Number(comment.version) < 1) {
      throw new ValidationError("Comment version must be a positive integer");
    }
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
  const commentAttachmentPairs = new Set<string>();
  const commentAttachmentCounts = new Map<string, number>();
  for (const ref of tables.comment_attachment_refs) {
    const comment = comments.get(String(ref.comment_id));
    const task = tasks.get(String(ref.task_id));
    const attachment = attachments.get(String(ref.attachment_id));
    const pair = `${String(ref.comment_id)}\u0000${String(ref.attachment_id)}`;
    if (commentAttachmentPairs.has(pair)) {
      throw new ValidationError("Duplicate project comment attachment ref");
    }
    if (
      !comment ||
      !task ||
      !attachment ||
      comment.task_id !== task.id ||
      attachment.task_id !== task.id ||
      comment.source !== "native" ||
      comment.deleted_at !== null ||
      attachment.state !== "ready"
    ) {
      throw new ValidationError("Project comment attachment ref violates its live Task scope");
    }
    const count = (commentAttachmentCounts.get(String(comment.id)) ?? 0) + 1;
    if (count > 100) {
      throw new ValidationError("Project comment contains more than 100 attachment refs");
    }
    commentAttachmentCounts.set(String(comment.id), count);
    commentAttachmentPairs.add(pair);
  }
  if (validateCommentAttachmentRefs) {
    const expectedPairs = new Set<string>();
    for (const comment of tables.comments) {
      if (comment.source !== "native" || comment.deleted_at !== null) continue;
      const body = String(comment.body);
      if (hasMalformedTaskAttachmentReference(body)) {
        throw new ValidationError("Project comment contains a malformed attachment reference");
      }
      for (const reference of parseTaskAttachmentReferences(body)) {
        const attachment = attachmentPublicIds.get(reference.ref);
        if (
          !attachment ||
          attachment.task_id !== comment.task_id ||
          attachment.state !== "ready" ||
          (reference.kind === "image" && attachment.kind !== "image")
        ) {
          throw new ValidationError("Project comment references an unavailable attachment");
        }
        expectedPairs.add(`${String(comment.id)}\u0000${String(attachment.id)}`);
      }
    }
    if (
      expectedPairs.size !== commentAttachmentPairs.size ||
      [...expectedPairs].some((pair) => !commentAttachmentPairs.has(pair))
    ) {
      throw new ValidationError("Project comment attachment body/index mismatch");
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
  const assignedGroups = new Set<string>();
  for (const assignment of tables.task_labels) {
    if (!tasks.has(String(assignment.task_id)) || !labels.has(String(assignment.label_id))) {
      throw new ValidationError("Task label references a missing bundle record");
    }
    const label = labels.get(String(assignment.label_id))!;
    if (label.group_id !== null) {
      const key = `${String(assignment.task_id)}\u0000${String(label.group_id)}`;
      if (assignedGroups.has(key)) {
        throw new ValidationError("A Task can have at most one Label from each Label Group");
      }
      assignedGroups.add(key);
    }
  }
  const relationKeys = new Set<string>();
  const relationIds = new Set<string>();
  const relationIdempotency = new Set<string>();
  const relatedPairs = new Set<string>();
  const blockPairs = new Set<string>();
  const duplicateSources = new Set<string>();
  for (const relation of tables.task_relations) {
    if (!tasks.has(String(relation.source_task_id)) || !tasks.has(String(relation.target_task_id))) {
      throw new ValidationError("Task relation crosses the project bundle boundary");
    }
    if (relation.source_task_id === relation.target_task_id) throw new ValidationError("Task cannot relate to itself");
    if (!String(relation.id).trim()) throw new ValidationError("Task relation ID is required");
    if (relationIds.has(String(relation.id))) throw new ValidationError("Duplicate task relation ID");
    relationIds.add(String(relation.id));
    const idempotency = `${relation.creator_user_id}\u0000${relation.idempotency_key}`;
    if (!String(relation.idempotency_key).trim() || relationIdempotency.has(idempotency)) {
      throw new ValidationError("Duplicate task relation idempotency key");
    }
    relationIdempotency.add(idempotency);
    if (!Number.isSafeInteger(relation.version) || Number(relation.version) < 1) {
      throw new ValidationError("Task relation version is invalid");
    }
    if (!["blocks", "related", "duplicate_of"].includes(String(relation.type))) {
      throw new ValidationError("Task relation type is invalid");
    }
    const key = `${relation.source_task_id}\u0000${relation.target_task_id}\u0000${relation.type}`;
    if (relationKeys.has(key)) throw new ValidationError("Duplicate task relation");
    relationKeys.add(key);
    const pair = [String(relation.source_task_id), String(relation.target_task_id)].sort().join("\u0000");
    if (relation.type === "related") {
      if (relatedPairs.has(pair) || String(relation.source_task_id) > String(relation.target_task_id)) {
        throw new ValidationError("Related task pair is not canonical");
      }
      relatedPairs.add(pair);
    } else if (relation.type === "blocks") {
      if (blockPairs.has(pair)) throw new ValidationError("Duplicate logical block relation");
      blockPairs.add(pair);
    } else if (relation.type === "duplicate_of") {
      const sourceId = String(relation.source_task_id);
      if (duplicateSources.has(sourceId)) {
        throw new ValidationError("A duplicate task has more than one canonical target");
      }
      duplicateSources.add(sourceId);
    }
  }
  const targets = new Map<string, Set<string>>([
    ["project", new Set([identity.projectId])],
    ["release", new Set(releases.keys())],
    ["task", new Set(tasks.keys())],
    ["saved_view", new Set(views.keys())],
    ["label", new Set(labels.keys())],
    ["workflow_status", new Set(statuses.keys())],
  ]);
  const externalRecords = unique(tables.external_records, "id", "external record");
  for (const record of tables.external_records) {
    const target = targets.get(String(record.target_type));
    if (!target?.has(String(record.target_id))) throw new ValidationError("External provenance references a missing bundle record");
    parseJsonObject(record.metadata_json, "External metadata");
  }
  const attachmentMigrationIds = new Set<string>();
  const attachmentMigrationRows = new Set<string>();
  for (const outcome of tables.attachment_migration_outcomes) {
    if (!String(outcome.id).trim() || attachmentMigrationIds.has(String(outcome.id))) {
      throw new ValidationError("Duplicate attachment migration outcome ID");
    }
    attachmentMigrationIds.add(String(outcome.id));
    const rowKey = `${outcome.source_record_id}\u0000${outcome.source_index}`;
    if (attachmentMigrationRows.has(rowKey)) {
      throw new ValidationError("Duplicate attachment migration source row");
    }
    attachmentMigrationRows.add(rowKey);
    if (!Number.isSafeInteger(outcome.source_index) || Number(outcome.source_index) < -1) {
      throw new ValidationError("Attachment migration source index is invalid");
    }
    if (
      !tasks.has(String(outcome.task_id)) ||
      outcome.source !== "linear" ||
      !["migrated", "non_binary_mapped", "skipped", "blocked"].includes(String(outcome.outcome))
    ) {
      throw new ValidationError("Attachment migration outcome is invalid");
    }
    const sourceRecord = externalRecords.get(String(outcome.source_record_id));
    if (
      !sourceRecord || sourceRecord.source !== outcome.source ||
      sourceRecord.target_type !== "task" || sourceRecord.target_id !== outcome.task_id
    ) {
      throw new ValidationError(
        "Attachment migration outcome references an incompatible source record",
      );
    }
    parseJsonValue(outcome.raw_json, "Attachment migration raw source");
    if (outcome.outcome === "migrated") {
      const attachment = attachments.get(String(outcome.attachment_id));
      if (
        !attachment || attachment.task_id !== outcome.task_id ||
        attachment.state !== "ready" || outcome.mapped_title !== null ||
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
      outcome.attachment_id !== null || outcome.mapped_title !== null ||
      outcome.mapped_url !== null
    ) {
      throw new ValidationError(
        "Skipped or blocked attachment migration cannot reference a target",
      );
    }
  }
  for (const comment of tables.comments) {
    if (comment.source !== "linear") continue;
    const sourceRecord = externalRecords.get(String(comment.source_record_id));
    if (
      !sourceRecord || sourceRecord.source !== comment.source ||
      sourceRecord.target_type !== "task" || sourceRecord.target_id !== comment.task_id
    ) {
      throw new ValidationError("Historical comment references an incompatible source record");
    }
  }
  const outcomeIds = new Set<string>();
  const outcomeRows = new Set<string>();
  for (const outcome of tables.comment_migration_outcomes) {
    if (!String(outcome.id).trim() || outcomeIds.has(String(outcome.id))) {
      throw new ValidationError("Duplicate comment migration outcome ID");
    }
    outcomeIds.add(String(outcome.id));
    const rowKey = `${outcome.source_record_id}\u0000${outcome.source_index}`;
    if (outcomeRows.has(rowKey)) throw new ValidationError("Duplicate comment migration source row");
    outcomeRows.add(rowKey);
    if (!Number.isSafeInteger(outcome.source_index) || Number(outcome.source_index) < 0) {
      throw new ValidationError("Comment migration source index is invalid");
    }
    if (outcome.source !== "linear" || (outcome.outcome !== "migrated" && outcome.outcome !== "exception")) {
      throw new ValidationError("Comment migration outcome is invalid");
    }
    if (!tasks.has(String(outcome.task_id))) {
      throw new ValidationError("Comment migration outcome is outside the project bundle");
    }
    const sourceRecord = externalRecords.get(String(outcome.source_record_id));
    if (
      !sourceRecord || sourceRecord.source !== outcome.source ||
      sourceRecord.target_type !== "task" || sourceRecord.target_id !== outcome.task_id
    ) {
      throw new ValidationError("Comment migration outcome references an incompatible source record");
    }
    parseJsonValue(outcome.raw_json, "Comment migration raw source");
    if (outcome.outcome === "migrated") {
      const comment = comments.get(String(outcome.comment_id));
      if (
        !comment || comment.task_id !== outcome.task_id ||
        comment.source_record_id !== outcome.source_record_id ||
        comment.source_comment_id !== outcome.source_comment_id
      ) {
        throw new ValidationError("Comment migration outcome does not match its historical comment");
      }
    } else if (outcome.comment_id !== null) {
      throw new ValidationError("Comment migration exception cannot reference a migrated comment");
    }
  }
  const activityEvents = unique(tables.activity_events, "id", "activity event");
  const activitySourceRows = new Set<string>();
  for (const event of tables.activity_events) {
    if (!tasks.has(String(event.task_id))) throw new ValidationError("Activity event is outside the project bundle");
    if (event.schema_version !== 1 || (event.actor_kind !== "user" && event.actor_kind !== "historical" && event.actor_kind !== "system")) {
      throw new ValidationError("Activity event contract is invalid");
    }
    if (event.actor_kind === "user") {
      if (!String(event.actor_user_id ?? "").trim()) throw new ValidationError("Native activity actor is required");
    } else if (event.actor_user_id !== null) {
      throw new ValidationError("Historical activity cannot impersonate a User");
    }
    parseJsonObject(event.payload_json, "Activity payload");
    if (event.source === "linear") {
      const sourceRecord = externalRecords.get(String(event.source_record_id));
      if (
        event.actor_kind !== "historical" || event.actor_user_id !== null ||
        !sourceRecord || sourceRecord.source !== "linear" ||
        sourceRecord.target_type !== "task" || sourceRecord.target_id !== event.task_id
      ) {
        throw new ValidationError("Historical activity references an incompatible source record");
      }
      if (!Number.isSafeInteger(event.source_index) || Number(event.source_index) < 0) {
        throw new ValidationError("Historical activity source index is invalid");
      }
      const key = `${event.source_record_id}\u0000${event.source_index}`;
      if (activitySourceRows.has(key)) throw new ValidationError("Duplicate activity source row");
      activitySourceRows.add(key);
    } else if (event.source !== "native") {
      throw new ValidationError("Activity source is invalid");
    } else if (
      !["user", "system"].includes(String(event.actor_kind)) ||
      event.source_record_id !== null || event.source_event_id !== null ||
      event.source_index !== null
    ) {
      throw new ValidationError("Native activity cannot carry migration provenance");
    }
  }
  const activityOutcomeRows = new Set<string>();
  for (const outcome of tables.activity_migration_outcomes) {
    const key = `${outcome.source_record_id}\u0000${outcome.source_index}`;
    if (activityOutcomeRows.has(key)) throw new ValidationError("Duplicate activity migration source row");
    activityOutcomeRows.add(key);
    if (!Number.isSafeInteger(outcome.source_index) || Number(outcome.source_index) < -1) {
      throw new ValidationError("Activity migration source index is invalid");
    }
    if (!tasks.has(String(outcome.task_id)) || outcome.source !== "linear" || (outcome.outcome !== "migrated" && outcome.outcome !== "exception")) {
      throw new ValidationError("Activity migration outcome is invalid");
    }
    const sourceRecord = externalRecords.get(String(outcome.source_record_id));
    if (
      !sourceRecord || sourceRecord.source !== outcome.source ||
      sourceRecord.target_type !== "task" || sourceRecord.target_id !== outcome.task_id
    ) {
      throw new ValidationError("Activity migration outcome references an incompatible source record");
    }
    parseJsonValue(outcome.raw_json, "Activity migration raw source");
    if (outcome.outcome === "migrated") {
      const event = activityEvents.get(String(outcome.activity_event_id));
      if (!event || event.task_id !== outcome.task_id || event.source_record_id !== outcome.source_record_id || event.source_index !== outcome.source_index) {
        throw new ValidationError("Activity migration outcome does not match its event");
      }
    } else if (outcome.activity_event_id !== null) {
      throw new ValidationError("Activity migration exception cannot reference an event");
    }
  }
  const grantees = new Set<string>();
  for (const descriptor of sharing) {
    if (descriptor.granteeUserId === identity.ownerUserId) throw new ValidationError("Project owner cannot be a sharing descriptor");
    if (grantees.has(descriptor.granteeUserId)) throw new ValidationError("Duplicate project sharing descriptor");
    grantees.add(descriptor.granteeUserId);
  }
}

function upgradeLegacyProjectWorkflow(source: ProjectBackupTables): ProjectBackupTables {
  const statuses: BackupRow[] = source.workflow_statuses.map((status): BackupRow => ({
    ...status,
    system_role: String(status.name).toLocaleLowerCase() === "duplicate" && status.category === "canceled"
      ? "duplicate"
      : null,
    archived_at: null,
    version: 1,
  }));
  const duplicateOwners = new Set<string>();
  for (const status of statuses) {
    if (status.system_role !== "duplicate") continue;
    const ownerId = String(status.owner_user_id);
    if (duplicateOwners.has(ownerId)) status.system_role = null;
    else {
      status.name = "Duplicate";
      status.is_default = 0;
      duplicateOwners.add(ownerId);
    }
  }
  return { ...source, workflow_statuses: statuses };
}

function upgradeLegacyProjectRelations(source: ProjectBackupTables): ProjectBackupTables {
  return {
    ...source,
    task_relations: source.task_relations.map((relation): BackupRow => ({
      id: `relation_legacy:${relation.source_task_id}:${relation.target_task_id}:${relation.type}`,
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

function upgradeLegacyProjectLabels(source: ProjectBackupTables): ProjectBackupTables {
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

function upgradeLegacyProjectLabelGroups(source: ProjectBackupTables): ProjectBackupTables {
  return {
    ...source,
    label_groups: [],
    labels: source.labels.map((label): BackupRow => ({ ...label, group_id: null })),
  };
}

function upgradeLegacyProjectSavedViews(source: ProjectBackupTables): ProjectBackupTables {
  return {
    ...source,
    saved_views: source.saved_views.map((view): BackupRow => ({
      ...view,
      archived_at: null,
    })),
  };
}

function upgradeLegacyProjectComments(source: ProjectBackupTables): ProjectBackupTables {
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

function upgradeLegacyProjectIdentifiers(source: ProjectBackupTables): ProjectBackupTables {
  const project = source.projects[0];
  if (!project) return source;
  const known: Record<string, string> = {
    "task manager": "TM",
    "mind diary": "MD",
    "scorched earth": "SE",
    homeostat: "HO",
  };
  const letters = String(project.name).toUpperCase().replace(/[^A-Z]/g, "");
  const taskCode = known[String(project.name).trim().toLowerCase()]
    ?? (letters.slice(0, 3) || "PR").padEnd(2, "X");
  const taskSequence = source.tasks.reduce(
    (maximum, task) => Math.max(maximum, Number(task.sequence_number)),
    0,
  );
  const codeLockedAt = source.tasks.map((task) => String(task.created_at)).sort()[0] ?? null;
  const tasks = source.tasks.map((task): BackupRow => {
    if (task.project_id === null) {
      throw new ValidationError(
        "Legacy backup Tasks without Project require an explicit Project mapping",
      );
    }
    return {
      ...task,
      identifier: `${taskCode}-${String(task.sequence_number)}`,
    };
  });
  return {
    ...source,
    projects: [{
      ...project,
      task_code: taskCode,
      task_sequence: taskSequence,
      code_locked_at: codeLockedAt,
    }],
    tasks,
    task_identifier_aliases: source.tasks.map((task): BackupRow => ({
      id: `task_alias_legacy_${String(task.id)}`,
      task_id: task.id,
      identifier: task.identifier,
      created_at: task.created_at,
    })),
  };
}

const categories = ["backlog", "unstarted", "started", "completed", "canceled"];

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

function parseJsonValue(value: string | number | null, label: string) {
  if (typeof value !== "string") throw new ValidationError(`${label} must be JSON`);
  try {
    JSON.parse(value);
  } catch {
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

function isSafeHttpsUrl(value: string | number | null) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
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
