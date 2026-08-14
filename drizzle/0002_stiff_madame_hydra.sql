ALTER TABLE `projects` ADD `public_id` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `projects` SET `public_id` =
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))
  WHERE `public_id` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_projects_public_id` ON `projects` (`public_id`);--> statement-breakpoint
ALTER TABLE `releases` ADD `public_id` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `releases` SET `public_id` =
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))
  WHERE `public_id` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_releases_public_id` ON `releases` (`public_id`);--> statement-breakpoint
ALTER TABLE `saved_views` ADD `public_id` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `saved_views` SET `public_id` =
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))
  WHERE `public_id` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_saved_views_public_id` ON `saved_views` (`public_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `public_id` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `tasks` SET `public_id` =
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))
  WHERE `public_id` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_public_id` ON `tasks` (`public_id`);
