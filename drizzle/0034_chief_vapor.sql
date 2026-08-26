CREATE TABLE `entity_purge_jobs` (
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`attempt_count` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`entity_type`, `entity_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_entity_purge_jobs_updated` ON `entity_purge_jobs` (`updated_at`);