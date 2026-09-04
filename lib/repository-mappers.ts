import { normalizeGrantRole, type AccessRole, type ShareableResourceType } from "./access";
import type { AdminUserAggregate } from "./admin";
import { ValidationError } from "./domain";
import type {
  CollaboratorRecord,
  LabelGroupRecord,
  LabelRecord,
  Priority,
  ProjectRecord,
  ProjectStatus,
  ReleaseRecord,
  ReleaseStatus,
  SavedViewRecord,
  SidebarPreference,
  StatusCategory,
  TaskLabelAssignment,
  TaskRecord,
  TaskRelationRecord,
  ThemePreference,
  UserIdentityRecord,
  UserProfile,
  WorkflowStatusRecord,
} from "./types";
import { parseStoredViewDisplay, parseStoredViewQuery } from "./view-contract";
import { getD1 } from "@/db";

export type DbRow = Record<string, unknown>;

export function finiteNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ValidationError(`${label} is invalid`);
  return number;
}

export function mapUser(row: DbRow): UserProfile["user"] {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    email: String(row.email),
    timezone: String(row.timezone),
    theme: String(row.theme ?? "system") as ThemePreference,
    sidebarPreference: String(row.sidebar_preference ?? "expanded") as SidebarPreference,
    version: Number(row.version ?? 1),
  };
}

export function mapUserIdentity(row: DbRow): UserIdentityRecord {
  const provider = String(row.provider);
  if (provider !== "chatgpt" && provider !== "google") {
    throw new ValidationError("Unknown identity provider");
  }
  return {
    provider,
    verifiedEmail: String(row.verified_email),
  };
}

export function mapAdminUserAggregate(row: DbRow): AdminUserAggregate {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    email: String(row.email),
    registeredAt: String(row.created_at),
    lastSeenAt: String(row.updated_at),
    taskCount: Number(row.task_count ?? 0),
    recentTaskCount: Number(row.recent_task_count ?? 0),
    projectCount: Number(row.project_count ?? 0),
    releaseCount: Number(row.release_count ?? 0),
    viewCount: Number(row.view_count ?? 0),
    lastTaskActivityAt: nullableString(row.last_task_activity_at),
    lastProjectActivityAt: nullableString(row.last_project_activity_at),
    lastReleaseActivityAt: nullableString(row.last_release_activity_at),
    lastViewActivityAt: nullableString(row.last_view_activity_at),
    attachmentCount: Number(row.attachment_count ?? 0),
    attachmentBytes: Number(row.attachment_bytes ?? 0),
    pendingAttachmentCount: Number(row.pending_attachment_count ?? 0),
    failedAttachmentCount: Number(row.failed_attachment_count ?? 0),
    deletedAttachmentCount: Number(row.deleted_attachment_count ?? 0),
  };
}

export function mapStatus(row: DbRow): WorkflowStatusRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    category: String(row.category) as StatusCategory,
    color: String(row.color),
    position: Number(row.position),
    isDefault: Boolean(row.is_default),
    systemRole: row.system_role === "duplicate" ? "duplicate" : null,
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version ?? 1),
  };
}

export function mapProject(row: DbRow): ProjectRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    creatorUserId: String(row.creator_user_id),
    name: String(row.name),
    taskCode: String(row.task_code),
    taskSequence: Number(row.task_sequence),
    codeLockedAt: nullableString(row.code_locked_at),
    summary: String(row.summary ?? ""),
    description: String(row.description ?? ""),
    status: String(row.status) as ProjectStatus,
    leadUserId: nullableString(row.lead_user_id),
    startDate: nullableString(row.start_date),
    targetDate: nullableString(row.target_date),
    icon: String(row.icon ?? "cube"),
    color: String(row.color),
    archivedAt: nullableString(row.archived_at),
    deletedAt: nullableString(row.deleted_at),
    deletedByUserId: nullableString(row.deleted_by_user_id),
    purgeAfter: nullableString(row.purge_after),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    accessRole: effectiveRole(row.access_role),
  };
}

export function mapRelease(row: DbRow): ReleaseRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    projectId: String(row.project_id),
    ownerUserId: String(row.owner_user_id),
    creatorUserId: String(row.creator_user_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    status: String(row.status) as ReleaseRecord["status"],
    targetDate: nullableString(row.target_date),
    releasedAt: nullableString(row.released_at),
    releaseNotes: String(row.release_notes ?? ""),
    deletedAt: nullableString(row.deleted_at),
    deletedByUserId: nullableString(row.deleted_by_user_id),
    purgeAfter: nullableString(row.purge_after),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    accessRole: effectiveRole(row.access_role),
  };
}

const internalTaskReferences = new WeakMap<
  TaskRecord,
  { releaseId: string | null; parentTaskId: string | null }
>();

export function mapTask(row: DbRow): TaskRecord {
  const maskProjectMetadata = row.project_id != null
    && Object.hasOwn(row, "project_access_role")
    && row.project_access_role == null;
  const task: TaskRecord = {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    creatorUserId: String(row.creator_user_id),
    identifier: String(row.identifier),
    sequenceNumber: Number(row.sequence_number),
    title: String(row.title),
    description: row.description == null ? null : String(row.description),
    statusId: String(row.status_id),
    priority: String(row.priority) as Priority,
    assigneeUserId: nullableString(row.assignee_user_id),
    projectId: maskProjectMetadata ? "" : String(row.project_id),
    releaseId: maskProjectMetadata ? null : Object.hasOwn(row, "visible_release_id")
      ? nullableString(row.visible_release_id)
      : nullableString(row.release_id),
    estimate: row.estimate == null ? null : Number(row.estimate),
    dueDate: nullableString(row.due_date),
    parentTaskId: maskProjectMetadata ? null : Object.hasOwn(row, "visible_parent_task_id")
      ? nullableString(row.visible_parent_task_id)
      : nullableString(row.parent_task_id),
    rank: Number(row.rank),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    canceledAt: nullableString(row.canceled_at),
    archivedAt: nullableString(row.archived_at),
    deletedAt: nullableString(row.deleted_at),
    deletedByUserId: nullableString(row.deleted_by_user_id),
    purgeAfter: nullableString(row.purge_after),
    commentCount: Number(row.comment_count ?? 0),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    accessRole: effectiveRole(row.access_role),
  };
  internalTaskReferences.set(task, {
    releaseId: nullableString(row.release_id),
    parentTaskId: nullableString(row.parent_task_id),
  });
  return task;
}

export function internalTaskReleaseId(task: TaskRecord) {
  return internalTaskReferences.get(task)?.releaseId ?? task.releaseId;
}

export function internalTaskParentId(task: TaskRecord) {
  return internalTaskReferences.get(task)?.parentTaskId ?? task.parentTaskId;
}

export function mapLabel(row: DbRow): LabelRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    groupId: nullableString(row.group_id),
    name: String(row.name),
    color: String(row.color),
    description: String(row.description ?? ""),
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at ?? row.created_at),
  };
}

export function mapLabelGroup(row: DbRow): LabelGroupRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    position: Number(row.position ?? 0),
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at ?? row.created_at),
  };
}

export async function loadLabelGroupsForLabels(
  rows: readonly DbRow[],
): Promise<LabelGroupRecord[]> {
  const ids = [...new Set(rows
    .map((row) => nullableString(row.group_id))
    .filter((id): id is string => Boolean(id)))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await getD1().prepare(
    `SELECT * FROM label_groups WHERE id IN (${placeholders})
     ORDER BY position, lower(name), id`,
  ).bind(...ids).all<DbRow>();
  return result.results.map(mapLabelGroup);
}

export function mapTaskLabel(row: DbRow): TaskLabelAssignment {
  return {
    taskId: String(row.task_id),
    labelId: String(row.label_id),
  };
}

export function mapRelation(row: DbRow): TaskRelationRecord {
  return {
    id: String(row.id),
    sourceTaskId: String(row.source_task_id),
    targetTaskId: String(row.target_task_id),
    type: String(row.type) as TaskRelationRecord["type"],
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapView(row: DbRow): SavedViewRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    scopeProjectId: nullableString(row.scope_project_id),
    query: parseStoredViewQuery(row.query_json),
    display: parseStoredViewDisplay(row.display_json),
    archivedAt: nullableString(row.archived_at),
    deletedAt: nullableString(row.deleted_at),
    deletedByUserId: nullableString(row.deleted_by_user_id),
    purgeAfter: nullableString(row.purge_after),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    accessRole: effectiveRole(row.access_role),
  };
}

export function mapCollaborator(row: DbRow): CollaboratorRecord {
  return {
    grantId: String(row.id),
    resourceType: String(row.resource_type) as CollaboratorRecord["resourceType"],
    resourceId: String(row.resource_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    email: String(row.email),
    permission:
      normalizeGrantRole(
        String(row.resource_type) as ShareableResourceType,
        row.permission,
      ) ?? "viewer",
  };
}

export function effectiveRole(value: unknown): AccessRole {
  if (
    value === "owner" ||
    value === "manager" ||
    value === "editor" ||
    value === "viewer"
  ) {
    return value;
  }
  return "viewer";
}

export function projectStatus(value: unknown): ProjectStatus {
  if (
    value !== "planned"
    && value !== "active"
    && value !== "paused"
    && value !== "completed"
    && value !== "canceled"
  ) {
    throw new ValidationError("Unknown Project status");
  }
  return value;
}

export function releaseStatus(value: unknown): ReleaseStatus {
  if (
    value !== "planned"
    && value !== "active"
    && value !== "released"
    && value !== "canceled"
  ) {
    throw new ValidationError("Unknown Release status");
  }
  return value;
}

export function projectIcon(value: unknown): string {
  if (value !== "cube" && value !== "folder" && value !== "target" && value !== "rocket") {
    throw new ValidationError("Unknown Project icon");
  }
  return value;
}

export function projectColor(value: unknown): string {
  const color = String(value ?? "").trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) {
    throw new ValidationError("Project color must be a six-digit hex color");
  }
  return color;
}

export function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
