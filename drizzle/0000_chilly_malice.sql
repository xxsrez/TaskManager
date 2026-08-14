CREATE TABLE `access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`grantee_user_id` text NOT NULL,
	`granted_by_user_id` text NOT NULL,
	`permission` text DEFAULT 'full_access' NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_access_grants_resource_grantee` ON `access_grants` (`resource_type`,`resource_id`,`grantee_user_id`);--> statement-breakpoint
CREATE INDEX `idx_access_grants_grantee_active` ON `access_grants` (`grantee_user_id`,`resource_type`,`resource_id`) WHERE "access_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#6b7280' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_labels_owner_name` ON `labels` (`owner_user_id`,`name`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`creator_user_id` text NOT NULL,
	`name` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`lead_user_id` text,
	`start_date` text,
	`target_date` text,
	`icon` text DEFAULT 'cube' NOT NULL,
	`color` text DEFAULT '#8b7cf6' NOT NULL,
	`archived_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_projects_owner_archived` ON `projects` (`owner_user_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`creator_user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`target_date` text,
	`released_at` text,
	`release_notes` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_releases_project_status` ON `releases` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`scope_project_id` text,
	`query_json` text DEFAULT '{}' NOT NULL,
	`display_json` text DEFAULT '{}' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_labels` (
	`task_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `label_id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`creator_user_id` text NOT NULL,
	`identifier` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status_id` text NOT NULL,
	`priority` text DEFAULT 'none' NOT NULL,
	`assignee_user_id` text,
	`project_id` text,
	`release_id` text,
	`estimate` integer,
	`due_date` text,
	`parent_task_id` text,
	`rank` real DEFAULT 0 NOT NULL,
	`started_at` text,
	`completed_at` text,
	`canceled_at` text,
	`archived_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_owner_identifier` ON `tasks` (`owner_user_id`,`identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_owner_sequence` ON `tasks` (`owner_user_id`,`sequence_number`);--> statement-breakpoint
CREATE INDEX `idx_tasks_owner_status_archived` ON `tasks` (`owner_user_id`,`status_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_project_release` ON `tasks` (`project_id`,`release_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_owner_updated` ON `tasks` (`owner_user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_key` text NOT NULL,
	`verified_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`provider`, `provider_account_key`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`email` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`color` text NOT NULL,
	`position` integer NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflow_statuses_owner_name` ON `workflow_statuses` (`owner_user_id`,`name`);