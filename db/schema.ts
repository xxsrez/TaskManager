import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
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

export const apiCredentials = sqliteTable(
  "api_credentials",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_api_credentials_token_hash").on(table.tokenHash),
    index("idx_api_credentials_owner_active").on(
      table.ownerUserId,
      table.revokedAt,
    ),
  ],
);

export const oauthRegisteredClients = sqliteTable("oauth_registered_clients", {
  id: text("id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUrisJson: text("redirect_uris_json").notNull(),
  grantTypesJson: text("grant_types_json").notNull(),
  responseTypesJson: text("response_types_json").notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const oauthAuthorizationRequests = sqliteTable(
  "oauth_authorization_requests",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource").notNull(),
    scopesJson: text("scopes_json").notNull(),
    state: text("state"),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_oauth_auth_requests_expires").on(table.expiresAt)],
);

export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    resource: text("resource").notNull(),
    scopesJson: text("scopes_json").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_oauth_grants_owner_client_resource").on(
      table.ownerUserId,
      table.clientId,
      table.resource,
    ),
    index("idx_oauth_grants_owner_active").on(
      table.ownerUserId,
      table.revokedAt,
    ),
  ],
);

export const oauthAuthorizationCodes = sqliteTable(
  "oauth_authorization_codes",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    grantId: text("grant_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource").notNull(),
    scopesJson: text("scopes_json").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_oauth_auth_codes_hash").on(table.codeHash),
    index("idx_oauth_auth_codes_expires").on(table.expiresAt),
  ],
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    grantId: text("grant_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    clientId: text("client_id").notNull(),
    resource: text("resource").notNull(),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_oauth_access_tokens_hash").on(table.tokenHash),
    index("idx_oauth_access_tokens_grant_active").on(
      table.grantId,
      table.revokedAt,
    ),
  ],
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    grantId: text("grant_id").notNull(),
    familyId: text("family_id").notNull(),
    parentId: text("parent_id"),
    ownerUserId: text("owner_user_id").notNull(),
    clientId: text("client_id").notNull(),
    resource: text("resource").notNull(),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_oauth_refresh_tokens_hash").on(table.tokenHash),
    index("idx_oauth_refresh_tokens_family").on(table.familyId),
    index("idx_oauth_refresh_tokens_grant_active").on(
      table.grantId,
      table.revokedAt,
    ),
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
    systemRole: text("system_role"),
    archivedAt: text("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_workflow_statuses_owner_name").on(
      table.ownerUserId,
      table.name,
    ),
    uniqueIndex("idx_workflow_statuses_owner_system_role")
      .on(table.ownerUserId, table.systemRole),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull(),
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
    uniqueIndex("idx_projects_public_id").on(table.publicId),
    index("idx_projects_owner_archived").on(
      table.ownerUserId,
      table.archivedAt,
    ),
    index("idx_projects_name_search").on(sql`lower(${table.name})`),
    index("idx_projects_summary_search").on(sql`lower(${table.summary})`),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").notNull().references(() => users.id),
    body: text("body").notNull(),
    source: text("source").notNull().default("native"),
    parentCommentId: text("parent_comment_id").references(
      (): AnySQLiteColumn => comments.id,
      { onDelete: "cascade" },
    ),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
    resolvedAt: text("resolved_at"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id),
    resolutionCommentId: text("resolution_comment_id").references(
      (): AnySQLiteColumn => comments.id,
      { onDelete: "set null" },
    ),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("idx_comments_task_author_idempotency").on(
      table.taskId,
      table.authorUserId,
      table.idempotencyKey,
    ),
    index("idx_comments_task_created").on(
      table.taskId,
      table.createdAt,
      table.id,
    ),
    index("idx_comments_parent").on(table.parentCommentId, table.createdAt, table.id),
  ],
);

export const commentReactions = sqliteTable(
  "comment_reactions",
  {
    commentId: text("comment_id").notNull().references(() => comments.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.commentId, table.userId, table.emoji] }),
    index("idx_comment_reactions_lookup").on(table.commentId, table.emoji),
  ],
);

export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull(),
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
    uniqueIndex("idx_releases_public_id").on(table.publicId),
    index("idx_releases_project_status").on(table.projectId, table.status),
    index("idx_releases_name_search").on(sql`lower(${table.name})`),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull(),
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
    commentCount: integer("comment_count").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_tasks_public_id").on(table.publicId),
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
    index("idx_tasks_parent").on(table.parentTaskId),
    index("idx_tasks_release_archived").on(
      table.releaseId,
      table.archivedAt,
    ),
    index("idx_tasks_owner_updated").on(
      table.ownerUserId,
      table.updatedAt,
    ),
    index("idx_tasks_title_search").on(sql`lower(${table.title})`),
    index("idx_tasks_identifier_search").on(sql`lower(${table.identifier})`),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    uploaderUserId: text("uploader_user_id")
      .notNull()
      .references(() => users.id),
    originalFilename: text("original_filename").notNull(),
    displayName: text("display_name").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    objectKey: text("object_key").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("uploading"),
    imageWidth: integer("image_width"),
    imageHeight: integer("image_height"),
    variantMetadataJson: text("variant_metadata_json").notNull().default("{}"),
    idempotencyKey: text("idempotency_key").notNull(),
    uploadExpiresAt: text("upload_expires_at"),
    failureCode: text("failure_code"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("idx_attachments_public_id").on(table.publicId),
    uniqueIndex("idx_attachments_object_key").on(table.objectKey),
    uniqueIndex("idx_attachments_task_uploader_idempotency").on(
      table.taskId,
      table.uploaderUserId,
      table.idempotencyKey,
    ),
    index("idx_attachments_task_state_created").on(
      table.taskId,
      table.state,
      table.createdAt,
      table.id,
    ),
    index("idx_attachments_cleanup").on(
      table.state,
      table.deletedAt,
      table.uploadExpiresAt,
      table.updatedAt,
    ),
    check("attachments_kind_check", sql`${table.kind} IN ('file', 'image')`),
    check(
      "attachments_state_check",
      sql`${table.state} IN ('pending', 'uploading', 'ready', 'failed', 'deleted')`,
    ),
    check("attachments_byte_size_check", sql`${table.byteSize} >= 0`),
  ],
);

export const taskSequences = sqliteTable("task_sequences", {
  ownerUserId: text("owner_user_id").primaryKey(),
  lastValue: integer("last_value").notNull(),
});

export const workspaceSyncSequences = sqliteTable("workspace_sync_sequences", {
  audienceUserId: text("audience_user_id").primaryKey(),
  lastSequence: integer("last_sequence").notNull(),
});

export const workspaceChangeEvents = sqliteTable(
  "workspace_change_events",
  {
    audienceUserId: text("audience_user_id").notNull(),
    sequence: integer("sequence").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    operation: text("operation").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.audienceUserId, table.sequence] }),
    index("idx_workspace_change_events_created").on(table.createdAt),
  ],
);

export const workspaceSyncMaintenance = sqliteTable("workspace_sync_maintenance", {
  key: text("key").primaryKey(),
  lastRunAt: text("last_run_at").notNull(),
});

// Ephemeral trigger queue. An AFTER INSERT trigger fans each row out to the
// current task audience and removes it in the same transaction.
export const workspaceSyncInvalidations = sqliteTable("workspace_sync_invalidations", {
  taskId: text("task_id").notNull(),
  invalidationType: text("invalidation_type").notNull(),
});

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

export const taskRelations = sqliteTable(
  "task_relations",
  {
    sourceTaskId: text("source_task_id").notNull(),
    targetTaskId: text("target_task_id").notNull(),
    type: text("type").notNull(),
    creatorUserId: text("creator_user_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({
      columns: [table.sourceTaskId, table.targetTaskId, table.type],
    }),
    index("idx_task_relations_target").on(table.targetTaskId, table.type),
  ],
);

export const savedViews = sqliteTable(
  "saved_views",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    scopeProjectId: text("scope_project_id"),
    queryJson: text("query_json").notNull().default("{}"),
    displayJson: text("display_json").notNull().default("{}"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_saved_views_public_id").on(table.publicId),
    index("idx_saved_views_scope_project").on(table.scopeProjectId),
  ],
);

export const externalRecords = sqliteTable(
  "external_records",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    sourceUrl: text("source_url"),
    metadataJson: text("metadata_json").notNull(),
    importedAt: text("imported_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_external_records_owner_source").on(
      table.ownerUserId,
      table.source,
      table.sourceId,
    ),
    index("idx_external_records_target").on(
      table.targetType,
      table.targetId,
    ),
  ],
);

export const accessGrants = sqliteTable(
  "access_grants",
  {
    id: text("id").primaryKey(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    granteeUserId: text("grantee_user_id").notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    permission: text("permission").notNull().default("viewer"),
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
    index("idx_access_grants_owner_resource_active")
      .on(table.ownerUserId, table.resourceType, table.resourceId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const adminImportSessions = sqliteTable(
  "admin_import_sessions",
  {
    id: text("id").primaryKey(),
    createdByUserId: text("created_by_user_id").notNull(),
    sourceExportedAt: text("source_exported_at").notNull(),
    sourceSchemaVersion: integer("source_schema_version").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    countsJson: text("counts_json").notNull(),
    status: text("status").notNull().default("staged"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    appliedAt: text("applied_at"),
  },
  (table) => [
    index("idx_admin_import_sessions_status_created").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const adminImportRows = sqliteTable(
  "admin_import_rows",
  {
    importId: text("import_id").notNull(),
    tableName: text("table_name").notNull(),
    ordinal: integer("ordinal").notNull(),
    rowJson: text("row_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.importId, table.tableName, table.ordinal] }),
    index("idx_admin_import_rows_import_table").on(
      table.importId,
      table.tableName,
    ),
  ],
);

export const userImportSessions = sqliteTable(
  "user_import_sessions",
  {
    id: text("id").primaryKey(),
    createdByUserId: text("created_by_user_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    sourceJson: text("source_json").notNull().default("{}"),
    previewJson: text("preview_json").notNull().default("{}"),
    payloadSha256: text("payload_sha256"),
    sourceExportedAt: text("source_exported_at"),
    projectId: text("project_id"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    appliedAt: text("applied_at"),
  },
  (table) => [
    index("idx_user_import_sessions_owner_status").on(
      table.createdByUserId,
      table.kind,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const userImportRows = sqliteTable(
  "user_import_rows",
  {
    importId: text("import_id").notNull(),
    rowType: text("row_type").notNull(),
    ordinal: integer("ordinal").notNull(),
    rowJson: text("row_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.importId, table.rowType, table.ordinal] }),
    index("idx_user_import_rows_import_type").on(
      table.importId,
      table.rowType,
    ),
  ],
);
