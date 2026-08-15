CREATE TABLE `task_sequences` (
	`owner_user_id` text PRIMARY KEY NOT NULL,
	`last_value` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_projects_name_search` ON `projects` (lower("name"));--> statement-breakpoint
CREATE INDEX `idx_projects_summary_search` ON `projects` (lower("summary"));--> statement-breakpoint
CREATE INDEX `idx_releases_name_search` ON `releases` (lower("name"));--> statement-breakpoint
CREATE INDEX `idx_tasks_title_search` ON `tasks` (lower("title"));--> statement-breakpoint
CREATE INDEX `idx_tasks_identifier_search` ON `tasks` (lower("identifier"));