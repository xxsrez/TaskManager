ALTER TABLE `entity_purge_jobs` ADD `entity_public_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_purge_jobs` ADD `actor_user_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_purge_jobs` ADD `source_version` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_purge_jobs` ADD `completed_at` text;--> statement-breakpoint
ALTER TABLE `entity_purge_jobs` ADD `receipt_expires_at` text;--> statement-breakpoint
CREATE INDEX `idx_entity_purge_jobs_receipt_expiry` ON `entity_purge_jobs` (`receipt_expires_at`);