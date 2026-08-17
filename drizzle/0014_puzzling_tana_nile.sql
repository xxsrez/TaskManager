CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`task_id` text NOT NULL,
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
	`failure_code` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploader_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attachments_kind_check" CHECK("attachments"."kind" IN ('file', 'image')),
	CONSTRAINT "attachments_state_check" CHECK("attachments"."state" IN ('pending', 'uploading', 'ready', 'failed', 'deleted')),
	CONSTRAINT "attachments_byte_size_check" CHECK("attachments"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attachments_public_id` ON `attachments` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attachments_object_key` ON `attachments` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attachments_task_uploader_idempotency` ON `attachments` (`task_id`,`uploader_user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_attachments_task_state_created` ON `attachments` (`task_id`,`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_attachments_cleanup` ON `attachments` (`state`,`deleted_at`,`upload_expires_at`,`updated_at`);