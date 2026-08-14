CREATE INDEX `idx_tasks_parent` ON `tasks` (`parent_task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_archived` ON `tasks` (`release_id`,`archived_at`);