CREATE TABLE `api_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes_json` text NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_api_credentials_token_hash` ON `api_credentials` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_api_credentials_owner_active` ON `api_credentials` (`owner_user_id`,`revoked_at`);