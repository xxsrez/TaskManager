CREATE TABLE `team_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`permission` text NOT NULL,
	`granted_by_user_id` text NOT NULL,
	`revoked_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "team_grants_resource_permission_check" CHECK(("team_grants"."resource_type" = 'project'
          AND "team_grants"."permission" IN ('manager', 'editor', 'viewer'))
        OR ("team_grants"."resource_type" IN ('task', 'saved_view')
          AND "team_grants"."permission" IN ('editor', 'viewer')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_grants_team_resource` ON `team_grants` (`team_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `idx_team_grants_team_active` ON `team_grants` (`team_id`,`resource_type`,`resource_id`) WHERE "team_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_team_grants_resource_active` ON `team_grants` (`resource_type`,`resource_id`,`team_id`) WHERE "team_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE `team_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`deactivated_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "team_memberships_role_check" CHECK("team_memberships"."role" IN ('owner', 'member')),
	CONSTRAINT "team_memberships_status_check" CHECK("team_memberships"."status" IN ('active', 'inactive')),
	CONSTRAINT "team_memberships_lifecycle_check" CHECK(("team_memberships"."status" = 'active' AND "team_memberships"."deactivated_at" IS NULL)
        OR ("team_memberships"."status" = 'inactive' AND "team_memberships"."deactivated_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_memberships_team_user` ON `team_memberships` (`team_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_team_memberships_team_status` ON `team_memberships` (`team_id`,`status`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_team_memberships_user_status` ON `team_memberships` (`user_id`,`status`,`team_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`archived_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "teams_name_check" CHECK(length(trim("teams"."name")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_teams_public_id` ON `teams` (`public_id`);--> statement-breakpoint
CREATE INDEX `idx_teams_owner_archived` ON `teams` (`owner_user_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_teams_name_search` ON `teams` (lower("name"));