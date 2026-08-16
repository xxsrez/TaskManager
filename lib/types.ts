export type StatusCategory =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export type Priority = "urgent" | "high" | "medium" | "low" | "none";
export type AccessRole = "owner" | "manager" | "editor" | "viewer";
export type GrantRole = Exclude<AccessRole, "owner">;

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
};

export type ProjectRecord = {
  id: string;
  publicId: string;
  ownerUserId: string;
  creatorUserId: string;
  name: string;
  summary: string;
  description: string;
  status: string;
  leadUserId: string | null;
  startDate: string | null;
  targetDate: string | null;
  color: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: AccessRole;
};

export type ReleaseRecord = {
  id: string;
  publicId: string;
  projectId: string;
  ownerUserId: string;
  creatorUserId: string;
  name: string;
  description: string;
  status: "planned" | "active" | "released" | "canceled";
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
  projectId: string | null;
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
};

export type TaskLabelAssignment = {
  taskId: string;
  labelId: string;
};

export type TaskRelationRecord = {
  sourceTaskId: string;
  targetTaskId: string;
  type: "blocks" | "related" | "duplicate_of";
};

export type TaskDetailRecord = {
  task: TaskRecord;
  relatedTasks: TaskRecord[];
  labels: LabelRecord[];
  taskLabels: TaskLabelAssignment[];
  relations: TaskRelationRecord[];
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
  version: number;
  accessRole: AccessRole;
};

export type ViewQuery = {
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
  users: AdminUserActivityRecord[];
};

export type SystemBackupCounts = Record<
  | "users"
  | "user_identities"
  | "workflow_statuses"
  | "projects"
  | "releases"
  | "tasks"
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
};
