CREATE TABLE `user_import_rows` (
	`import_id` text NOT NULL,
	`row_type` text NOT NULL,
	`ordinal` integer NOT NULL,
	`row_json` text NOT NULL,
	PRIMARY KEY(`import_id`, `row_type`, `ordinal`)
);
--> statement-breakpoint
CREATE INDEX `idx_user_import_rows_import_type` ON `user_import_rows` (`import_id`,`row_type`);--> statement-breakpoint
CREATE TABLE `user_import_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`source_json` text DEFAULT '{}' NOT NULL,
	`preview_json` text DEFAULT '{}' NOT NULL,
	`payload_sha256` text,
	`source_exported_at` text,
	`project_id` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`applied_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_user_import_sessions_owner_status` ON `user_import_sessions` (`created_by_user_id`,`kind`,`status`,`expires_at`);