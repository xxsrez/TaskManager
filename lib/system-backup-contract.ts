export type BackupScalar = string | number | null;
export type BackupRow = Record<string, BackupScalar>;

export type SystemBackupStatePolicy =
  | "exact"
  | "rebuild"
  | "reset"
  | "revoke"
  | "environment"
  | "excluded";

export type BackupColumnShape = {
  nullable?: boolean;
  number?: boolean;
  integer?: boolean;
};

export type ExactTableContract<Name extends string> = {
  name: Name;
  columns: readonly string[];
  policy: "exact";
  columnPolicies: Readonly<Record<string, SystemBackupStatePolicy>>;
  reason: string;
  orderBy: string;
  restoreOrder: number;
  deleteOrder: number;
  shapes?: Record<string, BackupColumnShape>;
};

type ClassifiedTableContract<Name extends string> = {
  name: Name;
  columns: readonly string[];
  policy: Exclude<SystemBackupStatePolicy, "exact" | "environment">;
  columnPolicies: Readonly<Record<string, SystemBackupStatePolicy>>;
  reason: string;
};

const exact = <const Name extends string>(
  name: Name,
  columns: readonly string[],
  orderBy: string,
  restoreOrder: number,
  deleteOrder: number,
  shapes?: Record<string, BackupColumnShape>,
  columnPolicies: Readonly<Record<string, SystemBackupStatePolicy>> = {},
): ExactTableContract<Name> => ({
  name,
  columns,
  policy: "exact",
  columnPolicies,
  reason: "portable application state restored exactly",
  orderBy,
  restoreOrder,
  deleteOrder,
  ...(shapes ? { shapes } : {}),
});

const classified = <const Name extends string>(
  name: Name,
  columns: readonly string[],
  policy: ClassifiedTableContract<Name>["policy"],
  reason: string,
): ClassifiedTableContract<Name> => ({
  name,
  columns,
  policy,
  columnPolicies: {},
  reason,
});

export const systemBackupCurrentSchemaVersion = 15 as const;

export const systemBackupExactTableContracts = [
  exact("users", ["id", "display_name", "email", "timezone", "theme", "sidebar_preference", "version", "created_at", "updated_at"], "id", 10, 240, { version: { number: true, integer: true } }),
  exact("user_identities", ["user_id", "provider", "provider_account_key", "verified_email", "created_at"], "provider, provider_account_key", 20, 230),
  exact("workflow_statuses", ["id", "owner_user_id", "name", "category", "color", "position", "is_default", "system_role", "archived_at", "version", "created_at", "updated_at"], "id", 30, 220, { position: { number: true, integer: true }, is_default: { number: true, integer: true }, system_role: { nullable: true }, archived_at: { nullable: true }, version: { number: true, integer: true } }),
  exact("projects", ["id", "public_id", "owner_user_id", "creator_user_id", "name", "task_code", "task_sequence", "code_locked_at", "summary", "description", "status", "lead_user_id", "start_date", "target_date", "icon", "color", "archived_at", "deleted_at", "deleted_by_user_id", "purge_after", "version", "created_at", "updated_at"], "id", 40, 190, { task_sequence: { number: true, integer: true }, code_locked_at: { nullable: true }, lead_user_id: { nullable: true }, start_date: { nullable: true }, target_date: { nullable: true }, archived_at: { nullable: true }, deleted_at: { nullable: true }, deleted_by_user_id: { nullable: true }, purge_after: { nullable: true }, version: { number: true, integer: true } }),
  exact("releases", ["id", "public_id", "project_id", "owner_user_id", "creator_user_id", "name", "description", "status", "target_date", "released_at", "release_notes", "deleted_at", "deleted_by_user_id", "purge_after", "version", "created_at", "updated_at"], "id", 50, 180, { target_date: { nullable: true }, released_at: { nullable: true }, deleted_at: { nullable: true }, deleted_by_user_id: { nullable: true }, purge_after: { nullable: true }, version: { number: true, integer: true } }),
  exact("tasks", ["id", "public_id", "owner_user_id", "creator_user_id", "identifier", "sequence_number", "title", "description", "status_id", "priority", "assignee_user_id", "project_id", "release_id", "estimate", "due_date", "parent_task_id", "rank", "started_at", "completed_at", "canceled_at", "archived_at", "deleted_at", "deleted_by_user_id", "purge_after", "comment_count", "version", "created_at", "updated_at"], "id", 60, 170, { sequence_number: { number: true, integer: true }, assignee_user_id: { nullable: true }, release_id: { nullable: true }, estimate: { nullable: true, number: true, integer: true }, due_date: { nullable: true }, parent_task_id: { nullable: true }, rank: { number: true }, started_at: { nullable: true }, completed_at: { nullable: true }, canceled_at: { nullable: true }, archived_at: { nullable: true }, deleted_at: { nullable: true }, deleted_by_user_id: { nullable: true }, purge_after: { nullable: true }, comment_count: { number: true, integer: true }, version: { number: true, integer: true } }),
  exact("task_identifier_aliases", ["id", "task_id", "identifier", "created_at"], "task_id, identifier", 70, 160),
  exact("stored_files", ["id", "public_id", "uploader_user_id", "original_filename", "display_name", "media_type", "byte_size", "checksum_sha256", "object_key", "kind", "state", "image_width", "image_height", "variant_metadata_json", "idempotency_key", "upload_expires_at", "ready_expires_at", "failure_code", "version", "created_at", "updated_at", "deleted_at"], "id", 80, 150, { byte_size: { number: true, integer: true }, image_width: { nullable: true, number: true, integer: true }, image_height: { nullable: true, number: true, integer: true }, upload_expires_at: { nullable: true }, ready_expires_at: { nullable: true }, failure_code: { nullable: true }, version: { number: true, integer: true }, deleted_at: { nullable: true } }, { object_key: "environment" }),
  exact("attachments", ["id", "public_id", "stored_file_id", "task_id", "uploader_user_id", "original_filename", "display_name", "media_type", "byte_size", "checksum_sha256", "object_key", "kind", "state", "image_width", "image_height", "variant_metadata_json", "idempotency_key", "upload_expires_at", "failure_code", "version", "created_at", "updated_at", "deleted_at"], "task_id, created_at, id", 90, 140, { stored_file_id: { nullable: true }, byte_size: { number: true, integer: true }, image_width: { nullable: true, number: true, integer: true }, image_height: { nullable: true, number: true, integer: true }, upload_expires_at: { nullable: true }, failure_code: { nullable: true }, version: { number: true, integer: true }, deleted_at: { nullable: true } }, { object_key: "environment" }),
  exact("attachment_migration_outcomes", ["id", "task_id", "source", "source_record_id", "source_attachment_id", "source_index", "outcome", "reason", "attachment_id", "mapped_title", "mapped_url", "raw_json", "reconciled_at"], "task_id, source_record_id, source_index", 150, 20, { source_attachment_id: { nullable: true }, source_index: { number: true, integer: true }, reason: { nullable: true }, attachment_id: { nullable: true }, mapped_title: { nullable: true }, mapped_url: { nullable: true } }),
  exact("comments", ["id", "task_id", "author_user_id", "body", "source", "source_record_id", "source_comment_id", "source_parent_comment_id", "historical_author_name", "historical_created_at", "historical_updated_at", "historical_quoted_text", "parent_comment_id", "idempotency_key", "created_at", "updated_at", "deleted_at", "resolved_at", "resolved_by_user_id", "resolution_comment_id", "version"], "task_id, created_at, id", 130, 70, { author_user_id: { nullable: true }, source_record_id: { nullable: true }, source_comment_id: { nullable: true }, source_parent_comment_id: { nullable: true }, historical_author_name: { nullable: true }, historical_created_at: { nullable: true }, historical_updated_at: { nullable: true }, historical_quoted_text: { nullable: true }, parent_comment_id: { nullable: true }, deleted_at: { nullable: true }, resolved_at: { nullable: true }, resolved_by_user_id: { nullable: true }, resolution_comment_id: { nullable: true }, version: { number: true, integer: true } }),
  exact("comment_attachment_refs", ["comment_id", "task_id", "attachment_id", "created_at"], "comment_id, attachment_id", 140, 10),
  exact("comment_migration_outcomes", ["id", "task_id", "source", "source_record_id", "source_comment_id", "source_index", "outcome", "reason", "comment_id", "raw_json", "reconciled_at"], "task_id, source_record_id, source_index", 160, 50, { source_comment_id: { nullable: true }, source_index: { number: true, integer: true }, reason: { nullable: true }, comment_id: { nullable: true } }),
  exact("activity_events", ["id", "task_id", "schema_version", "event_type", "actor_kind", "actor_user_id", "actor_name", "payload_json", "source", "source_record_id", "source_event_id", "source_index", "created_at"], "task_id, created_at, id", 170, 40, { schema_version: { number: true, integer: true }, actor_user_id: { nullable: true }, source_record_id: { nullable: true }, source_event_id: { nullable: true }, source_index: { nullable: true, number: true, integer: true } }),
  exact("activity_migration_outcomes", ["id", "task_id", "source", "source_record_id", "source_event_id", "source_index", "outcome", "reason", "activity_event_id", "raw_json", "reconciled_at"], "task_id, source_record_id, source_index", 180, 30, { source_event_id: { nullable: true }, source_index: { number: true, integer: true }, reason: { nullable: true }, activity_event_id: { nullable: true } }),
  exact("comment_reactions", ["comment_id", "user_id", "emoji", "created_at"], "comment_id, emoji, user_id", 190, 60),
  exact("label_groups", ["id", "owner_user_id", "name", "description", "position", "archived_at", "version", "created_at", "updated_at"], "id", 100, 210, { position: { number: true, integer: true }, archived_at: { nullable: true }, version: { number: true, integer: true } }),
  exact("labels", ["id", "owner_user_id", "group_id", "name", "color", "description", "archived_at", "version", "created_at", "updated_at"], "id", 110, 200, { group_id: { nullable: true }, archived_at: { nullable: true }, version: { number: true, integer: true } }),
  exact("task_labels", ["task_id", "label_id"], "task_id, label_id", 200, 80),
  exact("task_relations", ["id", "source_task_id", "target_task_id", "type", "creator_user_id", "idempotency_key", "version", "created_at", "updated_at"], "id", 210, 90, { version: { number: true, integer: true } }),
  exact("saved_views", ["id", "public_id", "owner_user_id", "name", "scope_project_id", "query_json", "display_json", "archived_at", "deleted_at", "deleted_by_user_id", "purge_after", "version", "created_at", "updated_at"], "id", 120, 110, { scope_project_id: { nullable: true }, archived_at: { nullable: true }, deleted_at: { nullable: true }, deleted_by_user_id: { nullable: true }, purge_after: { nullable: true }, version: { number: true, integer: true } }),
  exact("external_records", ["id", "owner_user_id", "target_type", "target_id", "source", "source_id", "source_url", "metadata_json", "imported_at"], "id", 125, 100, { source_url: { nullable: true } }),
  exact("access_grants", ["id", "resource_type", "resource_id", "owner_user_id", "grantee_user_id", "granted_by_user_id", "permission", "revoked_at", "created_at"], "id", 220, 120, { revoked_at: { nullable: true } }),
  exact("task_sequences", ["owner_user_id", "last_value"], "owner_user_id", 230, 130, { last_value: { number: true, integer: true } }),
] as const;

export const systemBackupD1TableContracts = [
  ...systemBackupExactTableContracts,
  classified("task_label_group_values", ["task_id", "group_id", "label_id"], "rebuild", "derived exclusivity guard rebuilt from task_labels and label group membership"),
  classified("workspace_sync_sequences", ["audience_user_id", "last_sequence"], "reset", "environment-local sync cursor"),
  classified("workspace_change_events", ["audience_user_id", "sequence", "entity_type", "entity_id", "operation", "created_at"], "reset", "environment-local sync journal"),
  classified("workspace_sync_maintenance", ["key", "last_run_at"], "reset", "environment-local maintenance checkpoint"),
  classified("workspace_sync_invalidations", ["task_id", "invalidation_type"], "reset", "ephemeral trigger queue"),
  classified("entity_purge_jobs", ["entity_type", "entity_id", "entity_public_id", "actor_user_id", "source_version", "started_at", "updated_at", "attempt_count", "completed_at", "receipt_expires_at"], "reset", "operational irreversible-cleanup coordination"),
  classified("oauth_authorization_requests", ["id", "owner_user_id", "client_id", "client_name", "redirect_uri", "resource", "scopes_json", "state", "code_challenge", "expires_at", "created_at"], "revoke", "short-lived authorization capability"),
  classified("oauth_authorization_codes", ["id", "code_hash", "grant_id", "owner_user_id", "client_id", "redirect_uri", "resource", "scopes_json", "code_challenge", "expires_at", "consumed_at", "created_at"], "revoke", "short-lived authorization capability"),
  classified("oauth_access_tokens", ["id", "token_hash", "grant_id", "owner_user_id", "client_id", "resource", "scopes_json", "expires_at", "last_used_at", "revoked_at", "created_at"], "revoke", "bearer capability"),
  classified("oauth_refresh_tokens", ["id", "token_hash", "grant_id", "family_id", "parent_id", "owner_user_id", "client_id", "resource", "scopes_json", "expires_at", "used_at", "revoked_at", "created_at"], "revoke", "rotating bearer capability"),
  classified("oauth_grants", ["id", "owner_user_id", "client_id", "client_name", "resource", "scopes_json", "last_used_at", "revoked_at", "created_at", "updated_at"], "revoke", "OAuth authorization capability"),
  classified("oauth_registered_clients", ["id", "client_name", "redirect_uris_json", "grant_types_json", "response_types_json", "token_endpoint_auth_method", "last_used_at", "created_at"], "revoke", "OAuth client registration is capability metadata and must be registered again"),
  classified("api_credentials", ["id", "owner_user_id", "name", "token_prefix", "token_hash", "scopes_json", "expires_at", "last_used_at", "revoked_at", "created_at"], "revoke", "authentication capability must be reissued after restore"),
  classified("admin_import_sessions", ["id", "created_by_user_id", "source_exported_at", "source_schema_version", "payload_sha256", "counts_json", "status", "created_at", "applied_at"], "excluded", "system import staging and audit receipt"),
  classified("admin_import_rows", ["import_id", "table_name", "ordinal", "row_json"], "excluded", "system import staging payload"),
  classified("user_import_sessions", ["id", "created_by_user_id", "kind", "status", "source_json", "preview_json", "payload_sha256", "source_exported_at", "project_id", "expires_at", "created_at", "applied_at"], "excluded", "Project import staging and audit receipt"),
  classified("user_import_rows", ["import_id", "row_type", "ordinal", "row_json"], "excluded", "Project import staging payload"),
] as const;

export const systemBackupR2ObjectClassContracts = [
  { binding: "ATTACHMENTS", namespace: "stored-files", policy: "exact", keyPolicy: "environment", reason: "live StoredFile originals are byte-exact while keys are rematerialized" },
  { binding: "ATTACHMENTS", namespace: "attachments", policy: "exact", keyPolicy: "environment", reason: "legacy live Attachment originals are byte-exact while keys are rematerialized" },
  { binding: "ATTACHMENTS", namespace: "backup-staging", policy: "reset", keyPolicy: "environment", reason: "temporary import materialization never belongs to a snapshot" },
] as const;

export const systemBackupUnknownR2ObjectPolicy = "reject" as const;

// Purge claims and idempotency receipts are operational state, not logical
// backup content. Restore must discard claims that could otherwise act on
// records re-created from a snapshot.
export const systemRestoreOperationalResetSql =
  "DELETE FROM entity_purge_jobs";

export const projectRestorePurgeJobCleanupSql = `DELETE FROM entity_purge_jobs
WHERE
  (entity_type = 'project' AND (
    entity_id = ? OR entity_id IN (
      SELECT json_extract(row_json, '$.id') FROM user_import_rows
      WHERE import_id = ? AND row_type = 'projects'
    )
  )) OR
  (entity_type = 'release' AND (
    entity_id IN (SELECT id FROM releases WHERE project_id = ?) OR
    entity_id IN (
      SELECT json_extract(row_json, '$.id') FROM user_import_rows
      WHERE import_id = ? AND row_type = 'releases'
    )
  )) OR
  (entity_type = 'task' AND (
    entity_id IN (SELECT id FROM tasks WHERE project_id = ?) OR
    entity_id IN (
      SELECT json_extract(row_json, '$.id') FROM user_import_rows
      WHERE import_id = ? AND row_type = 'tasks'
    )
  )) OR
  (entity_type = 'saved_view' AND (
    entity_id IN (SELECT id FROM saved_views WHERE scope_project_id = ?) OR
    entity_id IN (
      SELECT json_extract(row_json, '$.id') FROM user_import_rows
      WHERE import_id = ? AND row_type = 'saved_views'
    )
  ))`;

export function projectRestorePurgeJobCleanupParameters(
  projectId: string,
  importId: string,
) {
  return [
    projectId,
    importId,
    projectId,
    importId,
    projectId,
    importId,
    projectId,
    importId,
  ];
}
