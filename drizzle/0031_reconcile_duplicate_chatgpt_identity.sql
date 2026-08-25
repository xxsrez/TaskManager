-- One-time repair for a duplicated ChatGPT identity. The exact IDs keep the
-- operation bounded; no email address is persisted in migration history.
-- Environments without the stale User are a no-op. If that User exists, every
-- production precondition below must still match before any repair is applied.
CREATE TABLE `__identity_repair_20260825_guard` (
	`ok` integer NOT NULL CHECK (`ok` = 1)
);
--> statement-breakpoint
INSERT INTO `__identity_repair_20260825_guard` (`ok`)
SELECT CASE
	WHEN NOT EXISTS (
		SELECT 1 FROM `users`
		WHERE `id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
	) THEN 1
	WHEN
	(SELECT COUNT(*) FROM `users`
		WHERE `id` IN (
			'usr_2d26feb0-ea9b-4985-99fd-bf0177559a9b',
			'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
		)) = 2
	AND lower((SELECT `email` FROM `users`
		WHERE `id` = 'usr_2d26feb0-ea9b-4985-99fd-bf0177559a9b')) =
		lower((SELECT `email` FROM `users`
		WHERE `id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'))
	AND (SELECT COUNT(*) FROM `user_identities`
		WHERE `user_id` = 'usr_2d26feb0-ea9b-4985-99fd-bf0177559a9b'
			AND `provider` = 'chatgpt') = 1
	AND (SELECT COUNT(*) FROM `user_identities`
		WHERE `user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
			AND `provider` = 'chatgpt') = 1
	AND (SELECT COUNT(*) FROM `workflow_statuses`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64') = 6
	AND NOT EXISTS (
		SELECT 1 FROM `tasks`
		WHERE `status_id` IN (
			SELECT `id` FROM `workflow_statuses`
			WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
		)
	)
	AND (SELECT COUNT(*) FROM `access_grants`
		WHERE `grantee_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64') = 2
	AND EXISTS (
		SELECT 1 FROM `access_grants`
		WHERE `id` = 'grant_34b076f1-4f34-46bc-a078-3256e908cafe'
			AND `resource_type` = 'project'
			AND `resource_id` = 'linear:project:usr_c805e9e2-f792-4c9a-b483-2e4ce3292bb6:6c07eabb-e588-4184-8eaa-5974ad67fdda'
			AND `grantee_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
			AND `permission` = 'manager'
	)
	AND EXISTS (
		SELECT 1 FROM `access_grants`
		WHERE `id` = 'grant_135f6361-6c01-4aee-a56b-6f05298851b6'
			AND `resource_type` = 'saved_view'
			AND `grantee_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
			AND `revoked_at` IS NOT NULL
	)
	AND NOT EXISTS (
		SELECT 1 FROM `access_grants` old_grant
		JOIN `access_grants` current_grant
			ON current_grant.`resource_type` = old_grant.`resource_type`
			AND current_grant.`resource_id` = old_grant.`resource_id`
		WHERE old_grant.`grantee_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
			AND current_grant.`grantee_user_id` = 'usr_2d26feb0-ea9b-4985-99fd-bf0177559a9b'
	)
	AND NOT EXISTS (SELECT 1 FROM `projects` WHERE
		`owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
		OR `creator_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
		OR `lead_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `releases` WHERE
		`owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
		OR `creator_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE
		`owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
		OR `creator_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
		OR `assignee_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `stored_files`
		WHERE `uploader_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `attachments`
		WHERE `uploader_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `comments` WHERE
		`author_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
		OR `resolved_by_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `comment_reactions`
		WHERE `user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `activity_events`
		WHERE `actor_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `label_groups`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `labels`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `task_relations`
		WHERE `creator_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `saved_views`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `external_records`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `access_grants` WHERE
		`owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64'
		OR `granted_by_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `api_credentials`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `oauth_authorization_requests`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `oauth_grants`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `oauth_authorization_codes`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `oauth_access_tokens`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `oauth_refresh_tokens`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `task_sequences`
		WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `admin_import_sessions`
		WHERE `created_by_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	AND NOT EXISTS (SELECT 1 FROM `user_import_sessions`
		WHERE `created_by_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64')
	THEN 1
	ELSE 0
END;
--> statement-breakpoint
DELETE FROM `admin_import_rows`
WHERE `import_id` IN (
	SELECT `id` FROM `admin_import_sessions`
	WHERE `status` = 'staged'
		AND datetime(`created_at`) < datetime('now', '-1 day')
);
--> statement-breakpoint
UPDATE `admin_import_sessions`
SET `status` = 'expired'
WHERE `status` = 'staged'
	AND datetime(`created_at`) < datetime('now', '-1 day');
--> statement-breakpoint
UPDATE `access_grants`
SET `grantee_user_id` = 'usr_2d26feb0-ea9b-4985-99fd-bf0177559a9b',
	`revoked_at` = CASE
		WHEN `id` = 'grant_34b076f1-4f34-46bc-a078-3256e908cafe' THEN NULL
		ELSE `revoked_at`
	END
WHERE `id` IN (
	'grant_34b076f1-4f34-46bc-a078-3256e908cafe',
	'grant_135f6361-6c01-4aee-a56b-6f05298851b6'
);
--> statement-breakpoint
UPDATE `user_identities`
SET `user_id` = 'usr_2d26feb0-ea9b-4985-99fd-bf0177559a9b'
WHERE `user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64';
--> statement-breakpoint
DELETE FROM `workflow_statuses`
WHERE `owner_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64';
--> statement-breakpoint
DELETE FROM `workspace_change_events`
WHERE `audience_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64';
--> statement-breakpoint
DELETE FROM `workspace_sync_sequences`
WHERE `audience_user_id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64';
--> statement-breakpoint
DELETE FROM `users`
WHERE `id` = 'usr_d5976aa6-c64c-4cbf-b29e-ba25640a7b64';
--> statement-breakpoint
DROP TABLE `__identity_repair_20260825_guard`;
