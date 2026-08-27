CREATE TABLE `system_backup_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`parent_job_id` text,
	`rollback_job_id` text,
	`created_by_user_id` text NOT NULL,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`site_origin` text NOT NULL,
	`environment_scope` text NOT NULL,
	`schema_version` integer NOT NULL,
	`schema_fingerprint` text NOT NULL,
	`exported_at` text,
	`root_sha256` text,
	`state_sha256` text,
	`manifest_json` text,
	`counts_json` text DEFAULT '{}' NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`part_count` integer DEFAULT 0 NOT NULL,
	`next_part_index` integer DEFAULT 0 NOT NULL,
	`phase_cursor` text,
	`hash_state_json` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`lease_token` text,
	`lease_expires_at` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`d1_committed_at` text,
	`applied_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_system_backup_jobs_actor_status` ON `system_backup_jobs` (`created_by_user_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_system_backup_jobs_expiry` ON `system_backup_jobs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_system_backup_jobs_parent` ON `system_backup_jobs` (`parent_job_id`);--> statement-breakpoint
CREATE TABLE `system_backup_objects` (
	`job_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`logical_ref` text NOT NULL,
	`namespace` text NOT NULL,
	`source_object_key` text,
	`staged_object_key` text,
	`materialized_object_key` text,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`etag` text,
	`bound_kind` text,
	`is_orphan` integer DEFAULT false NOT NULL,
	`processed_bytes` integer DEFAULT 0 NOT NULL,
	`next_chunk_index` integer DEFAULT 0 NOT NULL,
	`hash_state_json` text,
	`first_part_index` integer,
	`part_count` integer DEFAULT 0 NOT NULL,
	`multipart_upload_id` text,
	`multipart_parts_json` text DEFAULT '[]' NOT NULL,
	`state` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`job_id`, `ordinal`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_system_backup_objects_job_ref` ON `system_backup_objects` (`job_id`,`logical_ref`);--> statement-breakpoint
CREATE INDEX `idx_system_backup_objects_job_state` ON `system_backup_objects` (`job_id`,`state`,`ordinal`);--> statement-breakpoint
CREATE TABLE `system_backup_parts` (
	`job_id` text NOT NULL,
	`part_index` integer NOT NULL,
	`part_type` text NOT NULL,
	`table_name` text,
	`ordinal_start` integer,
	`row_count` integer DEFAULT 0 NOT NULL,
	`logical_ref` text,
	`byte_length` integer NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`job_id`, `part_index`)
);
--> statement-breakpoint
CREATE INDEX `idx_system_backup_parts_job_type` ON `system_backup_parts` (`job_id`,`part_type`,`part_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_system_backup_parts_object_key` ON `system_backup_parts` (`object_key`);--> statement-breakpoint
CREATE TABLE `system_backup_rows` (
	`job_id` text NOT NULL,
	`table_name` text NOT NULL,
	`ordinal` integer NOT NULL,
	`row_json` text NOT NULL,
	PRIMARY KEY(`job_id`, `table_name`, `ordinal`)
);
--> statement-breakpoint
CREATE INDEX `idx_system_backup_rows_job_table` ON `system_backup_rows` (`job_id`,`table_name`,`ordinal`);