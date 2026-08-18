ALTER TABLE `saved_views` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `idx_saved_views_archive_updated` ON `saved_views` (`archived_at`,`updated_at`);