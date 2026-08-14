import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const userIdentities = sqliteTable(
  "user_identities",
  {
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    providerAccountKey: text("provider_account_key").notNull(),
    verifiedEmail: text("verified_email").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountKey] }),
  ],
);

export const workflowStatuses = sqliteTable(
  "workflow_statuses",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    color: text("color").notNull(),
    position: integer("position").notNull(),
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_workflow_statuses_owner_name").on(
      table.ownerUserId,
      table.name,
    ),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    creatorUserId: text("creator_user_id").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("planned"),
    leadUserId: text("lead_user_id"),
    startDate: text("start_date"),
    targetDate: text("target_date"),
    icon: text("icon").notNull().default("cube"),
    color: text("color").notNull().default("#8b7cf6"),
    archivedAt: text("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_projects_owner_archived").on(
      table.ownerUserId,
      table.archivedAt,
    ),
  ],
);

export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    creatorUserId: text("creator_user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("planned"),
    targetDate: text("target_date"),
    releasedAt: text("released_at"),
    releaseNotes: text("release_notes").notNull().default(""),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_releases_project_status").on(table.projectId, table.status),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    creatorUserId: text("creator_user_id").notNull(),
    identifier: text("identifier").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    statusId: text("status_id").notNull(),
    priority: text("priority").notNull().default("none"),
    assigneeUserId: text("assignee_user_id"),
    projectId: text("project_id"),
    releaseId: text("release_id"),
    estimate: integer("estimate"),
    dueDate: text("due_date"),
    parentTaskId: text("parent_task_id"),
    rank: real("rank").notNull().default(0),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    canceledAt: text("canceled_at"),
    archivedAt: text("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_tasks_owner_identifier").on(
      table.ownerUserId,
      table.identifier,
    ),
    uniqueIndex("idx_tasks_owner_sequence").on(
      table.ownerUserId,
      table.sequenceNumber,
    ),
    index("idx_tasks_owner_status_archived").on(
      table.ownerUserId,
      table.statusId,
      table.archivedAt,
    ),
    index("idx_tasks_project_release").on(table.projectId, table.releaseId),
    index("idx_tasks_owner_updated").on(
      table.ownerUserId,
      table.updatedAt,
    ),
  ],
);

export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6b7280"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_labels_owner_name").on(table.ownerUserId, table.name),
  ],
);

export const taskLabels = sqliteTable(
  "task_labels",
  {
    taskId: text("task_id").notNull(),
    labelId: text("label_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.labelId] })],
);

export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  scopeProjectId: text("scope_project_id"),
  queryJson: text("query_json").notNull().default("{}"),
  displayJson: text("display_json").notNull().default("{}"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const accessGrants = sqliteTable(
  "access_grants",
  {
    id: text("id").primaryKey(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    granteeUserId: text("grantee_user_id").notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    permission: text("permission").notNull().default("full_access"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_access_grants_resource_grantee").on(
      table.resourceType,
      table.resourceId,
      table.granteeUserId,
    ),
    index("idx_access_grants_grantee_active")
      .on(table.granteeUserId, table.resourceType, table.resourceId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);
