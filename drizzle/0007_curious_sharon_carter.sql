CREATE TABLE `oauth_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`grant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`resource` text NOT NULL,
	`scopes_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_access_tokens_hash` ON `oauth_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_access_tokens_grant_active` ON `oauth_access_tokens` (`grant_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `oauth_authorization_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`grant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`resource` text NOT NULL,
	`scopes_json` text NOT NULL,
	`code_challenge` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_auth_codes_hash` ON `oauth_authorization_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_auth_codes_expires` ON `oauth_authorization_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_authorization_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`resource` text NOT NULL,
	`scopes_json` text NOT NULL,
	`state` text,
	`code_challenge` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_auth_requests_expires` ON `oauth_authorization_requests` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`resource` text NOT NULL,
	`scopes_json` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_grants_owner_client_resource` ON `oauth_grants` (`owner_user_id`,`client_id`,`resource`);--> statement-breakpoint
CREATE INDEX `idx_oauth_grants_owner_active` ON `oauth_grants` (`owner_user_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`grant_id` text NOT NULL,
	`family_id` text NOT NULL,
	`parent_id` text,
	`owner_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`resource` text NOT NULL,
	`scopes_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_refresh_tokens_hash` ON `oauth_refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_tokens_family` ON `oauth_refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_tokens_grant_active` ON `oauth_refresh_tokens` (`grant_id`,`revoked_at`);