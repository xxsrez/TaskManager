CREATE TABLE `comment_reactions` (
	`comment_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`comment_id`, `user_id`, `emoji`),
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_comment_reactions_lookup` ON `comment_reactions` (`comment_id`,`emoji`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`body` text NOT NULL,
	`source` text DEFAULT 'native' NOT NULL,
	`parent_comment_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text,
	`resolved_at` text,
	`resolved_by_user_id` text,
	`resolution_comment_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolution_comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_comments_task_author_idempotency` ON `comments` (`task_id`,`author_user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_comments_task_created` ON `comments` (`task_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_comments_parent` ON `comments` (`parent_comment_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `comment_count` integer DEFAULT 0 NOT NULL;