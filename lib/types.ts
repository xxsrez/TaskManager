export type StatusCategory =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export type Priority = "urgent" | "high" | "medium" | "low" | "none";
export type AccessRole = "owner" | "manager" | "editor" | "viewer";
export type GrantRole = Exclude<AccessRole, "owner">;
export type ProjectStatus =
  | "planned"
  | "active"
  | "paused"
  | "completed"
  | "canceled";

export type UserRecord = {
  id: string;
  displayName: string;
  email: string;
  timezone: string;
};

export type WorkflowStatusRecord = {
  id: string;
  ownerUserId: string;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
  isDefault: boolean;
  systemRole: "duplicate" | null;
  archivedAt: string | null;
  version: number;
};

export type ProjectRecord = {
  id: string;
  publicId: string;
  ownerUserId: string;
  creatorUserId: string;
  name: string;
  taskCode: string;
  taskSequence: number;
  codeLockedAt: string | null;
  summary: string;
  description: string;
  status: ProjectStatus;
  leadUserId: string | null;
  startDate: string | null;
  targetDate: string | null;
  icon: string;
  color: string;
  archivedAt?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: AccessRole;
};

export type ReleaseStatus = "planned" | "active" | "released" | "canceled";

export type ReleaseRecord = {
  id: string;
  publicId: string;
  projectId: string;
  ownerUserId: string;
  creatorUserId: string;
  name: string;
  description: string;
  status: ReleaseStatus;
  targetDate: string | null;
  releasedAt: string | null;
  releaseNotes: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: AccessRole;
};

export type TaskRecord = {
  id: string;
  publicId: string;
  ownerUserId: string;
  creatorUserId: string;
  identifier: string;
  sequenceNumber: number;
  title: string;
  description: string | null;
  statusId: string;
  priority: Priority;
  assigneeUserId: string | null;
  projectId: string;
  releaseId: string | null;
  estimate: number | null;
  dueDate: string | null;
  parentTaskId: string | null;
  rank: number;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  archivedAt: string | null;
  commentCount: number;
  version: number;
  /** Client-only version of a loaded detail projection retained across a newer summary merge. */
  detailVersion?: number;
  /** Client-only marker for relation/label changes that do not increment Task.version. */
  detailStale?: boolean;
  /** Client-only cursors make repeated delivery idempotent for lazy consumers. */
  detailInvalidationCursor?: string;
  commentInvalidationCursor?: string;
  attachmentInvalidationCursor?: string;
  externalSourceInvalidationCursor?: string;
  createdAt: string;
  updatedAt: string;
  accessRole: AccessRole;
  hasExternalSource: boolean;
};

export type LabelRecord = {
  id: string;
  ownerUserId: string;
  name: string;
  color: string;
  description: string;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type TaskLabelAssignment = {
  taskId: string;
  labelId: string;
};

export type TaskRelationRecord = {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  type: "blocks" | "related" | "duplicate_of";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type TaskDetailRecord = {
  task: TaskRecord;
  relatedTasks: TaskRecord[];
  labels: LabelRecord[];
  taskLabels: TaskLabelAssignment[];
  relations: TaskRelationRecord[];
};

export type AttachmentKind = "file" | "image";
export type AttachmentState =
  | "pending"
  | "uploading"
  | "ready"
  | "failed"
  | "deleted";

export type AttachmentRecord = {
  id: string;
  publicId: string;
  taskId: string;
  uploaderUserId: string;
  originalFilename: string;
  displayName: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string;
  objectKey: string;
  kind: AttachmentKind;
  state: AttachmentState;
  imageWidth: number | null;
  imageHeight: number | null;
  variants: Record<string, unknown>;
  uploadExpiresAt: string | null;
  failureCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type CommentReactionSummary = {
  emoji: string;
  count: number;
  reactedByCurrentUser: boolean;
};

export type CommentRecord = {
  id: string;
  taskId: string;
  author: Pick<UserRecord, "id" | "displayName">;
  body: string;
  source: "native";
  parentCommentId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  resolvedAt: string | null;
  resolutionCommentId: string | null;
  version: number;
  reactions: CommentReactionSummary[];
  permissions: {
    canEdit: boolean;
    canDelete: boolean;
    canReact: boolean;
    canResolve: boolean;
  };
};

export type CommentThreadRecord = {
  root: CommentRecord;
  replies: CommentRecord[];
};

export type CommentPage = {
  threads: CommentThreadRecord[];
  totalCount: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export type ExternalSourceRecord = {
  targetType: "task" | "project" | "release" | "saved_view" | "label" | "workflow_status";
  targetId: string;
  source: "linear";
  sourceId: string;
  sourceUrl: string | null;
  gitBranchName: string | null;
  attachments: Array<{
    title: string;
    subtitle: string | null;
    url: string;
  }>;
  stateHistoryEntries: number;
  commentEntries: number;
  comments: Array<{
    id: string;
    body: string;
    authorName: string;
    createdAt: string;
    updatedAt: string;
    parentId: string | null;
    quotedText: string | null;
  }>;
};

export type SavedViewRecord = {
  id: string;
  publicId: string;
  ownerUserId: string;
  name: string;
  scopeProjectId: string | null;
  query: ViewQuery;
  display: ViewDisplay;
  archivedAt?: string | null;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  accessRole: AccessRole;
};

export type ViewFilterField =
  | "status"
  | "status_category"
  | "priority"
  | "assignee"
  | "project"
  | "release"
  | "label"
  | "estimate"
  | "due_date"
  | "parent"
  | "subtasks"
  | "relation"
  | "created_at"
  | "updated_at"
  | "started_at"
  | "completed_at"
  | "canceled_at"
  | "archived";

export type ViewFilterOperator =
  | "is"
  | "is_not"
  | "in"
  | "not_in"
  | "is_empty"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "on"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after"
  | "overdue"
  | "next_7_days"
  | "recent";

export type ViewFilterRelationValue = {
  type: TaskRelationRecord["type"] | "any";
  direction: "outgoing" | "incoming" | "either";
};

export type ViewFilterValue =
  | string
  | number
  | boolean
  | string[]
  | ViewFilterRelationValue;

export type ViewFilterCondition = {
  field: ViewFilterField;
  operator: ViewFilterOperator;
  value?: ViewFilterValue;
};

export type CanonicalViewQuery = {
  version: 1;
  op: "all";
  conditions: ViewFilterCondition[];
  search?: string;
};

/**
 * Legacy keys remain optional in the public TypeScript shape so older backup
 * fixtures and callers can still be accepted. validateViewQuery always returns
 * the canonical versioned representation and new writes never persist them.
 */
export type ViewQuery = Partial<CanonicalViewQuery> & {
  search?: string;
  statusIds?: string[];
  priorities?: Priority[];
  projectId?: string | null;
  releaseId?: string | null;
  archived?: boolean;
  updatedWithinHours?: number;
};

export type ViewDisplay = {
  layout: "list" | "board";
  groupBy: "status" | "priority" | "assignee" | "project" | "release" | "none";
  orderBy: "manual" | "priority" | "created" | "updated" | "due" | "title";
  direction: "asc" | "desc";
  showEmptyGroups: boolean;
  visibleFields: Array<"priority" | "project" | "release" | "dueDate" | "assignee">;
};

export type CollaboratorRecord = {
  grantId: string;
  resourceType: "project" | "task" | "saved_view";
  resourceId: string;
  userId: string;
  displayName: string;
  email: string;
  permission: GrantRole;
};

export type AdminUserActivityRecord = {
  id: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  registeredAt: string;
  lastSeenAt: string;
  lastContentActivityAt: string | null;
  taskCount: number;
  recentTaskCount: number;
  projectCount: number;
  releaseCount: number;
  viewCount: number;
};

export type AdminOverview = {
  registeredUserCount: number;
  activeUserCount: number;
  taskCount: number;
  projectCount: number;
  releaseCount: number;
  viewCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  attachmentObjectCount: number;
  attachmentObjectBytes: number;
  stagingAttachmentObjectCount: number;
  orphanAttachmentObjectCount: number | null;
  attachmentStorageTruncated: boolean;
  pendingAttachmentCount: number;
  failedAttachmentCount: number;
  deletedAttachmentCount: number;
  users: AdminUserActivityRecord[];
};

export type SystemBackupCounts = Record<
  | "users"
  | "user_identities"
  | "workflow_statuses"
  | "projects"
  | "releases"
  | "tasks"
  | "task_identifier_aliases"
  | "attachments"
  | "comments"
  | "comment_reactions"
  | "labels"
  | "task_labels"
  | "task_relations"
  | "saved_views"
  | "external_records"
  | "access_grants",
  number
>;

export type StagedSystemBackup = {
  importId: string;
  exportedAt: string;
  schemaVersion: number;
  sha256: string;
  counts: SystemBackupCounts;
};

export type AppliedSystemBackup = {
  applied: true;
  exportedAt: string;
  counts: SystemBackupCounts;
};

export type ProjectBackupPreview = {
  importId: string;
  sha256: string;
  exportedAt: string;
  projectId: string;
  projectName: string;
  projectExists: boolean;
  counts: Record<string, number>;
  currentCounts: Record<string, number>;
  changes: Record<string, { create: number; update: number; delete: number }>;
  sharing: Array<{
    granteeUserId: string;
    email: string;
    displayName: string;
    permission: "manager" | "editor" | "viewer";
  }>;
  warnings: string[];
};

export type AppliedProjectBackup = {
  applied: true;
  projectId: string;
  projectName: string;
  counts: Record<string, number>;
  sharingRestored: boolean;
};

export type AppSnapshot = {
  user: UserRecord;
  isAdmin: boolean;
  admin: AdminOverview | null;
  users: UserRecord[];
  statuses: WorkflowStatusRecord[];
  projects: ProjectRecord[];
  releases: ReleaseRecord[];
  tasks: TaskRecord[];
  taskWindow?: { limit: number; truncated: boolean };
  labels: LabelRecord[];
  taskLabels: TaskLabelAssignment[];
  relations: TaskRelationRecord[];
  views: SavedViewRecord[];
  collaborators: CollaboratorRecord[];
  /** Opaque checkpoint for the authenticated principal's incremental UI feed. */
  syncCursor?: string;
};

export type WorkspaceSyncCollection<T> = {
  upsert: T[];
  remove: string[];
};

export type WorkspaceSyncChanges = {
  tasks: WorkspaceSyncCollection<TaskRecord>;
  projects: WorkspaceSyncCollection<ProjectRecord>;
  releases: WorkspaceSyncCollection<ReleaseRecord>;
  views: WorkspaceSyncCollection<SavedViewRecord>;
  invalidations: {
    taskDetails: string[];
    taskComments: string[];
    taskAttachments: string[];
    taskExternalSources: string[];
  };
  /** @deprecated Compatibility fields; lazy task context is invalidated by ID. */
  labels: LabelRecord[];
  /** @deprecated Compatibility fields; lazy task context is invalidated by ID. */
  taskLabels: TaskLabelAssignment[];
  /** Tasks whose Label assignments are authoritatively replaced by taskLabels. */
  labelContextTaskIds?: string[];
  /** @deprecated Compatibility fields; lazy task context is invalidated by ID. */
  relations: TaskRelationRecord[];
};

export type WorkspaceSyncResponse = {
  cursor: string;
  resetRequired: boolean;
  hasMore: boolean;
  changes: WorkspaceSyncChanges;
};
