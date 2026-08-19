ALTER TABLE `users` ADD `theme` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `sidebar_preference` text DEFAULT 'expanded' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `version` integer DEFAULT 1 NOT NULL;