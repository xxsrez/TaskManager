CREATE TABLE `external_records` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`source_url` text,
	`metadata_json` text NOT NULL,
	`imported_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_records_owner_source` ON `external_records` (`owner_user_id`,`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_external_records_target` ON `external_records` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `task_relations` (
	`source_task_id` text NOT NULL,
	`target_task_id` text NOT NULL,
	`type` text NOT NULL,
	`creator_user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`source_task_id`, `target_task_id`, `type`)
);
--> statement-breakpoint
CREATE INDEX `idx_task_relations_target` ON `task_relations` (`target_task_id`,`type`);