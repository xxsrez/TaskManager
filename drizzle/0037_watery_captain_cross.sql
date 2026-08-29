UPDATE `system_backup_jobs`
SET `status` = 'expired',
	`phase` = 'expired',
	`lease_token` = NULL,
	`lease_expires_at` = NULL,
	`completed_at` = COALESCE(`completed_at`, CURRENT_TIMESTAMP),
	`error_code` = COALESCE(`error_code`, 'expired_before_current_export_guard'),
	`updated_at` = CURRENT_TIMESTAMP
WHERE `kind` = 'export'
	AND `status` IN ('running', 'ready')
	AND datetime(`expires_at`) <= datetime('now');
--> statement-breakpoint
WITH `ranked_current_exports` AS (
	SELECT `id`, ROW_NUMBER() OVER (
		PARTITION BY `created_by_user_id`, `site_origin`, `environment_scope`
		ORDER BY CASE `status` WHEN 'running' THEN 0 ELSE 1 END,
			COALESCE(`exported_at`, '') DESC,
			`id` DESC
	) AS `scope_rank`
	FROM `system_backup_jobs`
	WHERE `kind` = 'export' AND `status` IN ('running', 'ready')
)
UPDATE `system_backup_jobs`
SET `status` = 'expired',
	`phase` = 'expired',
	`lease_token` = NULL,
	`lease_expires_at` = NULL,
	`completed_at` = COALESCE(`completed_at`, CURRENT_TIMESTAMP),
	`error_code` = COALESCE(`error_code`, 'superseded_by_current_export_guard'),
	`updated_at` = CURRENT_TIMESTAMP
WHERE `id` IN (
	SELECT `id` FROM `ranked_current_exports` WHERE `scope_rank` > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_system_backup_jobs_current_export_scope` ON `system_backup_jobs` (`created_by_user_id`,`site_origin`,`environment_scope`) WHERE kind = 'export' AND status IN ('running', 'ready');
