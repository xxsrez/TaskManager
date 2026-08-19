CREATE TABLE `comment_attachment_refs` (
	`comment_id` text NOT NULL,
	`task_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`comment_id`, `attachment_id`),
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_comment_attachment_refs_task_attachment` ON `comment_attachment_refs` (`task_id`,`attachment_id`,`comment_id`);