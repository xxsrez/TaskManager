CREATE INDEX `idx_task_labels_label_task` ON `task_labels` (`label_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_project_status_archived` ON `tasks` (`project_id`,`status_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_assignee_archived` ON `tasks` (`assignee_user_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_due_archived` ON `tasks` (`due_date`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_updated_id` ON `tasks` (`updated_at`,`id`);