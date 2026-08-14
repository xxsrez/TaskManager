CREATE TABLE `oauth_registered_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris_json` text NOT NULL,
	`grant_types_json` text NOT NULL,
	`response_types_json` text NOT NULL,
	`token_endpoint_auth_method` text NOT NULL,
	`last_used_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
