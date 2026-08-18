DROP INDEX `idx_labels_owner_name`;--> statement-breakpoint
ALTER TABLE `labels` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
UPDATE `labels` SET `updated_at` = `created_at`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_labels_owner_name_active` ON `labels` (`owner_user_id`,lower("name")) WHERE "labels"."archived_at" IS NULL;
