PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`grantee_user_id` text NOT NULL,
	`granted_by_user_id` text NOT NULL,
	`permission` text DEFAULT 'viewer' NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_access_grants`("id", "resource_type", "resource_id", "owner_user_id", "grantee_user_id", "granted_by_user_id", "permission", "revoked_at", "created_at") SELECT "id", "resource_type", "resource_id", "owner_user_id", "grantee_user_id", "granted_by_user_id", "permission", "revoked_at", "created_at" FROM `access_grants`;--> statement-breakpoint
DROP TABLE `access_grants`;--> statement-breakpoint
ALTER TABLE `__new_access_grants` RENAME TO `access_grants`;--> statement-breakpoint
UPDATE `access_grants`
SET `permission` = CASE
	WHEN `resource_type` = 'project' THEN 'manager'
	ELSE 'editor'
END
WHERE `permission` = 'full_access';--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_access_grants_resource_grantee` ON `access_grants` (`resource_type`,`resource_id`,`grantee_user_id`);--> statement-breakpoint
CREATE INDEX `idx_access_grants_grantee_active` ON `access_grants` (`grantee_user_id`,`resource_type`,`resource_id`) WHERE "access_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_access_grants_owner_resource_active` ON `access_grants` (`owner_user_id`,`resource_type`,`resource_id`) WHERE "access_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_saved_views_scope_project` ON `saved_views` (`scope_project_id`);
