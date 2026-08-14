CREATE TABLE `admin_import_rows` (
	`import_id` text NOT NULL,
	`table_name` text NOT NULL,
	`ordinal` integer NOT NULL,
	`row_json` text NOT NULL,
	PRIMARY KEY(`import_id`, `table_name`, `ordinal`)
);
--> statement-breakpoint
CREATE INDEX `idx_admin_import_rows_import_table` ON `admin_import_rows` (`import_id`,`table_name`);--> statement-breakpoint
CREATE TABLE `admin_import_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by_user_id` text NOT NULL,
	`source_exported_at` text NOT NULL,
	`source_schema_version` integer NOT NULL,
	`payload_sha256` text NOT NULL,
	`counts_json` text NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`applied_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_admin_import_sessions_status_created` ON `admin_import_sessions` (`status`,`created_at`);