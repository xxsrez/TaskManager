CREATE TABLE `stored_files` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`uploader_user_id` text NOT NULL,
	`original_filename` text NOT NULL,
	`display_name` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`checksum_sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'uploading' NOT NULL,
	`image_width` integer,
	`image_height` integer,
	`variant_metadata_json` text DEFAULT '{}' NOT NULL,
	`idempotency_key` text NOT NULL,
	`upload_expires_at` text,
	`ready_expires_at` text,
	`failure_code` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`uploader_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stored_files_kind_check" CHECK("stored_files"."kind" IN ('file', 'image')),
	CONSTRAINT "stored_files_state_check" CHECK("stored_files"."state" IN ('uploading', 'ready', 'failed', 'expired', 'deleted')),
	CONSTRAINT "stored_files_byte_size_check" CHECK("stored_files"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stored_files_public_id` ON `stored_files` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stored_files_object_key` ON `stored_files` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stored_files_uploader_idempotency` ON `stored_files` (`uploader_user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_stored_files_uploader_state_created` ON `stored_files` (`uploader_user_id`,`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_stored_files_cleanup` ON `stored_files` (`state`,`deleted_at`,`upload_expires_at`,`ready_expires_at`,`updated_at`);--> statement-breakpoint
ALTER TABLE `attachments` ADD `stored_file_id` text REFERENCES stored_files(id);--> statement-breakpoint
INSERT INTO `stored_files` (
	`id`, `public_id`, `uploader_user_id`, `original_filename`, `display_name`,
	`media_type`, `byte_size`, `checksum_sha256`, `object_key`, `kind`, `state`,
	`image_width`, `image_height`, `variant_metadata_json`, `idempotency_key`,
	`upload_expires_at`, `ready_expires_at`, `failure_code`, `version`,
	`created_at`, `updated_at`, `deleted_at`
)
SELECT
	'stored_file_' || lower(hex(randomblob(16))),
	lower(hex(randomblob(16))),
	`uploader_user_id`, `original_filename`, `display_name`, `media_type`,
	`byte_size`, `checksum_sha256`, `object_key`, `kind`,
	CASE `state`
		WHEN 'pending' THEN 'uploading'
		ELSE `state`
	END,
	`image_width`, `image_height`, `variant_metadata_json`,
	'migration:' || `id`, `upload_expires_at`, NULL, `failure_code`, `version`,
	`created_at`, `updated_at`, `deleted_at`
FROM `attachments`;--> statement-breakpoint
UPDATE `attachments`
SET `stored_file_id` = (
	SELECT `stored_files`.`id` FROM `stored_files`
	WHERE `stored_files`.`idempotency_key` = 'migration:' || `attachments`.`id`
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attachments_stored_file_id` ON `attachments` (`stored_file_id`);
