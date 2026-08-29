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
  theme: text("theme").notNull().default("system"),
  sidebarPreference: text("sidebar_preference").notNull().default("expanded"),
  version: integer("version").notNull().default(1),
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
    taskCode: text("task_code").notNull().default("PR"),
    taskSequence: integer("task_sequence").notNull().default(0),
    codeLockedAt: text("code_locked_at"),
    summary: text("summary").notNull().default(""),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("planned"),
    leadUserId: text("lead_user_id"),
    startDate: text("start_date"),
    targetDate: text("target_date"),
    icon: text("icon").notNull().default("cube"),
    color: text("color").notNull().default("#8b7cf6"),
    archivedAt: text("archived_at"),
    deletedAt: text("deleted_at"),
    deletedByUserId: text("deleted_by_user_id"),
    purgeAfter: text("purge_after"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_projects_public_id").on(table.publicId),
    uniqueIndex("idx_projects_owner_task_code_active")
      .on(table.ownerUserId, table.taskCode)
      .where(sql`${table.archivedAt} IS NULL`),
    index("idx_projects_owner_archived").on(
      table.ownerUserId,
      table.archivedAt,
    ),
    index("idx_projects_deleted_purge").on(table.deletedAt, table.purgeAfter),
    index("idx_projects_name_search").on(sql`lower(${table.name})`),
    index("idx_projects_summary_search").on(sql`lower(${table.summary})`),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => users.id),
    body: text("body").notNull(),
    source: text("source").notNull().default("native"),
    sourceRecordId: text("source_record_id"),
    sourceCommentId: text("source_comment_id"),
    sourceParentCommentId: text("source_parent_comment_id"),
    historicalAuthorName: text("historical_author_name"),
    historicalCreatedAt: text("historical_created_at"),
    historicalUpdatedAt: text("historical_updated_at"),
    historicalQuotedText: text("historical_quoted_text"),
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
    ).where(sql`${table.authorUserId} IS NOT NULL`),
    uniqueIndex("idx_comments_source_identity").on(
      table.taskId,
      table.source,
      table.sourceCommentId,
    ).where(sql`${table.sourceCommentId} IS NOT NULL`),
    index("idx_comments_task_created").on(
      table.taskId,
      table.createdAt,
      table.id,
    ),
    index("idx_comments_parent").on(table.parentCommentId, table.createdAt, table.id),
    check(
      "check_comment_source_shape",
      sql`(
        (${table.source} = 'native' AND ${table.authorUserId} IS NOT NULL
          AND ${table.sourceRecordId} IS NULL AND ${table.sourceCommentId} IS NULL
          AND ${table.sourceParentCommentId} IS NULL
          AND ${table.historicalAuthorName} IS NULL
          AND ${table.historicalCreatedAt} IS NULL
          AND ${table.historicalUpdatedAt} IS NULL
          AND ${table.historicalQuotedText} IS NULL)
        OR
        (${table.source} = 'linear' AND ${table.authorUserId} IS NULL
          AND ${table.sourceRecordId} IS NOT NULL
          AND ${table.sourceCommentId} IS NOT NULL
          AND ${table.historicalAuthorName} IS NOT NULL
          AND ${table.historicalCreatedAt} IS NOT NULL
          AND ${table.historicalUpdatedAt} IS NOT NULL)
      )`,
    ),
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
    deletedAt: text("deleted_at"),
    deletedByUserId: text("deleted_by_user_id"),
    purgeAfter: text("purge_after"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_releases_public_id").on(table.publicId),
    index("idx_releases_project_status").on(table.projectId, table.status),
    index("idx_releases_name_search").on(sql`lower(${table.name})`),
    index("idx_releases_deleted_purge").on(table.deletedAt, table.purgeAfter),
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
    projectId: text("project_id").notNull(),
    releaseId: text("release_id"),
    estimate: integer("estimate"),
    dueDate: text("due_date"),
    parentTaskId: text("parent_task_id"),
    rank: real("rank").notNull().default(0),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    canceledAt: text("canceled_at"),
    archivedAt: text("archived_at"),
    deletedAt: text("deleted_at"),
    deletedByUserId: text("deleted_by_user_id"),
    purgeAfter: text("purge_after"),
    commentCount: integer("comment_count").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_tasks_public_id").on(table.publicId),
    uniqueIndex("idx_tasks_project_sequence").on(
      table.projectId,
      table.sequenceNumber,
    ),
    index("idx_tasks_owner_status_archived").on(
      table.ownerUserId,
      table.statusId,
      table.archivedAt,
    ),
    index("idx_tasks_project_release").on(table.projectId, table.releaseId),
    index("idx_tasks_project_status_archived").on(
      table.projectId,
      table.statusId,
      table.archivedAt,
    ),
    index("idx_tasks_assignee_archived").on(
      table.assigneeUserId,
      table.archivedAt,
    ),
    index("idx_tasks_due_archived").on(table.dueDate, table.archivedAt),
    index("idx_tasks_parent").on(table.parentTaskId),
    index("idx_tasks_release_archived").on(
      table.releaseId,
      table.archivedAt,
    ),
    index("idx_tasks_owner_updated").on(
      table.ownerUserId,
      table.updatedAt,
    ),
    index("idx_tasks_updated_id").on(table.updatedAt, table.id),
    index("idx_tasks_title_search").on(sql`lower(${table.title})`),
    index("idx_tasks_identifier_search").on(sql`lower(${table.identifier})`),
    index("idx_tasks_deleted_purge").on(table.deletedAt, table.purgeAfter),
  ],
);

export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    eventType: text("event_type").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorName: text("actor_name").notNull(),
    payloadJson: text("payload_json").notNull(),
    source: text("source").notNull().default("native"),
    sourceRecordId: text("source_record_id"),
    sourceEventId: text("source_event_id"),
    sourceIndex: integer("source_index"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_activity_events_task_created").on(
      table.taskId,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("idx_activity_events_source_position")
      .on(table.sourceRecordId, table.sourceIndex)
      .where(sql`${table.sourceRecordId} IS NOT NULL AND ${table.sourceIndex} IS NOT NULL`),
    check(
      "check_activity_event_actor",
      sql`(
        (${table.actorKind} = 'user' AND ${table.actorUserId} IS NOT NULL)
        OR
        (${table.actorKind} IN ('historical', 'system') AND ${table.actorUserId} IS NULL)
      )`,
    ),
    check(
      "check_activity_event_source",
      sql`(
        (${table.source} = 'native' AND ${table.actorKind} IN ('user', 'system')
          AND ${table.sourceRecordId} IS NULL AND ${table.sourceEventId} IS NULL
          AND ${table.sourceIndex} IS NULL)
        OR
        (${table.source} = 'linear' AND ${table.sourceRecordId} IS NOT NULL
          AND ${table.sourceIndex} IS NOT NULL AND ${table.actorKind} = 'historical'
          AND ${table.actorUserId} IS NULL)
      )`,
    ),
  ],
);

export const activityMigrationOutcomes = sqliteTable(
  "activity_migration_outcomes",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceRecordId: text("source_record_id")
      .notNull()
      .references(() => externalRecords.id, { onDelete: "cascade" }),
    sourceEventId: text("source_event_id"),
    sourceIndex: integer("source_index").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    activityEventId: text("activity_event_id").references(
      () => activityEvents.id,
      { onDelete: "set null" },
    ),
    rawJson: text("raw_json").notNull(),
    reconciledAt: text("reconciled_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_activity_migration_source_position").on(
      table.sourceRecordId,
      table.sourceIndex,
    ),
    index("idx_activity_migration_task_outcome").on(
      table.taskId,
      table.outcome,
    ),
    check(
      "check_activity_migration_outcome",
      sql`${table.outcome} IN ('migrated', 'exception')`,
    ),
  ],
);

export const taskIdentifierAliases = sqliteTable(
  "task_identifier_aliases",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_task_identifier_aliases_task_identifier").on(
      table.taskId,
      table.identifier,
    ),
    index("idx_task_identifier_aliases_lookup").on(sql`lower(${table.identifier})`),
  ],
);

export const storedFiles = sqliteTable(
  "stored_files",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull(),
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
    readyExpiresAt: text("ready_expires_at"),
    failureCode: text("failure_code"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("idx_stored_files_public_id").on(table.publicId),
    uniqueIndex("idx_stored_files_object_key").on(table.objectKey),
    uniqueIndex("idx_stored_files_uploader_idempotency").on(
      table.uploaderUserId,
      table.idempotencyKey,
    ),
    index("idx_stored_files_uploader_state_created").on(
      table.uploaderUserId,
      table.state,
      table.createdAt,
      table.id,
    ),
    index("idx_stored_files_cleanup").on(
      table.state,
      table.deletedAt,
      table.uploadExpiresAt,
      table.readyExpiresAt,
      table.updatedAt,
    ),
    check("stored_files_kind_check", sql`${table.kind} IN ('file', 'image')`),
    check(
      "stored_files_state_check",
      sql`${table.state} IN ('uploading', 'ready', 'failed', 'expired', 'deleted')`,
    ),
    check("stored_files_byte_size_check", sql`${table.byteSize} >= 0`),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull(),
    storedFileId: text("stored_file_id").references(() => storedFiles.id),
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
    uniqueIndex("idx_attachments_stored_file_id").on(table.storedFileId),
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

export const commentAttachmentRefs = sqliteTable(
  "comment_attachment_refs",
  {
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.commentId, table.attachmentId] }),
    index("idx_comment_attachment_refs_task_attachment").on(
      table.taskId,
      table.attachmentId,
      table.commentId,
    ),
  ],
);

export const attachmentMigrationOutcomes = sqliteTable(
  "attachment_migration_outcomes",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceRecordId: text("source_record_id")
      .notNull()
      .references(() => externalRecords.id, { onDelete: "cascade" }),
    sourceAttachmentId: text("source_attachment_id"),
    sourceIndex: integer("source_index").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    attachmentId: text("attachment_id").references(() => attachments.id, {
      onDelete: "set null",
    }),
    mappedTitle: text("mapped_title"),
    mappedUrl: text("mapped_url"),
    rawJson: text("raw_json").notNull(),
    reconciledAt: text("reconciled_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_attachment_migration_source_position").on(
      table.sourceRecordId,
      table.sourceIndex,
    ),
    index("idx_attachment_migration_task_outcome").on(
      table.taskId,
      table.outcome,
    ),
    check(
      "check_attachment_migration_outcome",
      sql`${table.outcome} IN ('migrated', 'non_binary_mapped', 'skipped', 'blocked')`,
    ),
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

// Operational durable claim for irreversible entity cleanup. The row is
// created before any R2 object is removed, which closes restore while a
// partially completed purge remains retryable.
export const entityPurgeJobs = sqliteTable(
  "entity_purge_jobs",
  {
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    entityPublicId: text("entity_public_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    attemptCount: integer("attempt_count").notNull().default(1),
    completedAt: text("completed_at"),
    receiptExpiresAt: text("receipt_expires_at"),
  },
  (table) => [
    primaryKey({ columns: [table.entityType, table.entityId] }),
    index("idx_entity_purge_jobs_updated").on(table.updatedAt),
    index("idx_entity_purge_jobs_receipt_expiry").on(table.receiptExpiresAt),
  ],
);

// Ephemeral trigger queue. An AFTER INSERT trigger fans each row out to the
// current task audience and removes it in the same transaction.
export const workspaceSyncInvalidations = sqliteTable("workspace_sync_invalidations", {
  taskId: text("task_id").notNull(),
  invalidationType: text("invalidation_type").notNull(),
});

export const labelGroups = sqliteTable(
  "label_groups",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    position: integer("position").notNull().default(0),
    archivedAt: text("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default("1970-01-01T00:00:00.000Z"),
  },
  (table) => [
    uniqueIndex("idx_label_groups_owner_name_active")
      .on(table.ownerUserId, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} IS NULL`),
    index("idx_label_groups_owner_position").on(table.ownerUserId, table.position),
  ],
);

export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    groupId: text("group_id").references(() => labelGroups.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6b7280"),
    description: text("description").notNull().default(""),
    archivedAt: text("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default("1970-01-01T00:00:00.000Z"),
  },
  (table) => [
    uniqueIndex("idx_labels_owner_name_active")
      .on(table.ownerUserId, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} IS NULL`),
  ],
);

export const taskLabels = sqliteTable(
  "task_labels",
  {
    taskId: text("task_id").notNull(),
    labelId: text("label_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.labelId] }),
    index("idx_task_labels_label_task").on(table.labelId, table.taskId),
  ],
);

// Denormalized exclusivity guard for the task_labels join. SQL triggers keep
// it synchronized, so every write path (including restore/import) is protected
// by UNIQUE(task_id, group_id), not only by application validation.
export const taskLabelGroupValues = sqliteTable(
  "task_label_group_values",
  {
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    groupId: text("group_id").notNull().references(() => labelGroups.id, { onDelete: "cascade" }),
    labelId: text("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.groupId] }),
    uniqueIndex("idx_task_label_group_values_task_label").on(table.taskId, table.labelId),
    index("idx_task_label_group_values_label").on(table.labelId, table.taskId),
  ],
);

export const taskRelations = sqliteTable(
  "task_relations",
  {
    id: text("id").primaryKey(),
    sourceTaskId: text("source_task_id").notNull(),
    targetTaskId: text("target_task_id").notNull(),
    type: text("type").notNull(),
    creatorUserId: text("creator_user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_task_relations_semantic").on(
      table.sourceTaskId,
      table.targetTaskId,
      table.type,
    ),
    uniqueIndex("idx_task_relations_idempotency").on(
      table.creatorUserId,
      table.idempotencyKey,
    ),
    uniqueIndex("idx_task_relations_duplicate_source")
      .on(table.sourceTaskId)
      .where(sql`${table.type} = 'duplicate_of'`),
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
    archivedAt: text("archived_at"),
    deletedAt: text("deleted_at"),
    deletedByUserId: text("deleted_by_user_id"),
    purgeAfter: text("purge_after"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_saved_views_public_id").on(table.publicId),
    index("idx_saved_views_scope_project").on(table.scopeProjectId),
    index("idx_saved_views_archive_updated").on(table.archivedAt, table.updatedAt),
    index("idx_saved_views_deleted_purge").on(table.deletedAt, table.purgeAfter),
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

export const commentMigrationOutcomes = sqliteTable(
  "comment_migration_outcomes",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    sourceCommentId: text("source_comment_id"),
    sourceIndex: integer("source_index").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    commentId: text("comment_id").references(() => comments.id, { onDelete: "set null" }),
    rawJson: text("raw_json").notNull(),
    reconciledAt: text("reconciled_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_comment_migration_source_index").on(
      table.sourceRecordId,
      table.sourceIndex,
    ),
    index("idx_comment_migration_task_outcome").on(
      table.taskId,
      table.outcome,
    ),
    check(
      "check_comment_migration_outcome",
      sql`${table.outcome} IN ('migrated', 'exception')`,
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

// Durable orchestration for full-system backup/export and exact-replace
// restore. These rows are operational state: a backup captures product state,
// never another in-flight backup or restore.
export const systemBackupJobs = sqliteTable(
  "system_backup_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    parentJobId: text("parent_job_id"),
    rollbackJobId: text("rollback_job_id"),
    createdByUserId: text("created_by_user_id").notNull(),
    status: text("status").notNull(),
    phase: text("phase").notNull(),
    siteOrigin: text("site_origin").notNull(),
    environmentScope: text("environment_scope").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    schemaFingerprint: text("schema_fingerprint").notNull(),
    exportedAt: text("exported_at"),
    rootSha256: text("root_sha256"),
    stateSha256: text("state_sha256"),
    manifestJson: text("manifest_json"),
    countsJson: text("counts_json").notNull().default("{}"),
    totalRows: integer("total_rows").notNull().default(0),
    totalBytes: integer("total_bytes").notNull().default(0),
    partCount: integer("part_count").notNull().default(0),
    nextPartIndex: integer("next_part_index").notNull().default(0),
    phaseCursor: text("phase_cursor"),
    hashStateJson: text("hash_state_json"),
    attemptCount: integer("attempt_count").notNull().default(0),
    errorCode: text("error_code"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
    d1CommittedAt: text("d1_committed_at"),
    appliedAt: text("applied_at"),
  },
  (table) => [
    index("idx_system_backup_jobs_actor_status").on(
      table.createdByUserId,
      table.status,
      table.updatedAt,
    ),
    uniqueIndex("idx_system_backup_jobs_current_export_scope")
      .on(table.createdByUserId, table.siteOrigin, table.environmentScope)
      .where(sql`kind = 'export' AND status IN ('running', 'ready')`),
    index("idx_system_backup_jobs_expiry").on(table.expiresAt),
    index("idx_system_backup_jobs_parent").on(table.parentJobId),
  ],
);

export const systemBackupRows = sqliteTable(
  "system_backup_rows",
  {
    jobId: text("job_id").notNull(),
    tableName: text("table_name").notNull(),
    ordinal: integer("ordinal").notNull(),
    rowJson: text("row_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.tableName, table.ordinal] }),
    index("idx_system_backup_rows_job_table").on(
      table.jobId,
      table.tableName,
      table.ordinal,
    ),
  ],
);

export const systemBackupParts = sqliteTable(
  "system_backup_parts",
  {
    jobId: text("job_id").notNull(),
    partIndex: integer("part_index").notNull(),
    partType: text("part_type").notNull(),
    tableName: text("table_name"),
    ordinalStart: integer("ordinal_start"),
    rowCount: integer("row_count").notNull().default(0),
    logicalRef: text("logical_ref"),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.partIndex] }),
    index("idx_system_backup_parts_job_type").on(
      table.jobId,
      table.partType,
      table.partIndex,
    ),
    uniqueIndex("idx_system_backup_parts_object_key").on(table.objectKey),
  ],
);

export const systemBackupObjects = sqliteTable(
  "system_backup_objects",
  {
    jobId: text("job_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    logicalRef: text("logical_ref").notNull(),
    namespace: text("namespace").notNull(),
    sourceObjectKey: text("source_object_key"),
    stagedObjectKey: text("staged_object_key"),
    materializedObjectKey: text("materialized_object_key"),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    etag: text("etag"),
    boundKind: text("bound_kind"),
    isOrphan: integer("is_orphan", { mode: "boolean" }).notNull().default(false),
    processedBytes: integer("processed_bytes").notNull().default(0),
    nextChunkIndex: integer("next_chunk_index").notNull().default(0),
    hashStateJson: text("hash_state_json"),
    firstPartIndex: integer("first_part_index"),
    partCount: integer("part_count").notNull().default(0),
    multipartUploadId: text("multipart_upload_id"),
    multipartPartsJson: text("multipart_parts_json").notNull().default("[]"),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.ordinal] }),
    uniqueIndex("idx_system_backup_objects_job_ref").on(
      table.jobId,
      table.logicalRef,
    ),
    index("idx_system_backup_objects_job_state").on(
      table.jobId,
      table.state,
      table.ordinal,
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
