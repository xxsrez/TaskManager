CREATE TABLE `attachment_migration_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`source` text NOT NULL,
	`source_record_id` text NOT NULL,
	`source_attachment_id` text,
	`source_index` integer NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`attachment_id` text,
	`mapped_title` text,
	`mapped_url` text,
	`raw_json` text NOT NULL,
	`reconciled_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_record_id`) REFERENCES `external_records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "check_attachment_migration_outcome" CHECK("attachment_migration_outcomes"."outcome" IN ('migrated', 'non_binary_mapped', 'skipped', 'blocked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attachment_migration_source_position` ON `attachment_migration_outcomes` (`source_record_id`,`source_index`);--> statement-breakpoint
CREATE INDEX `idx_attachment_migration_task_outcome` ON `attachment_migration_outcomes` (`task_id`,`outcome`);