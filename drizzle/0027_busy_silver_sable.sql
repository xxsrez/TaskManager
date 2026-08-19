CREATE TABLE `label_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_label_groups_owner_name_active` ON `label_groups` (`owner_user_id`,lower("name")) WHERE "label_groups"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_label_groups_owner_position` ON `label_groups` (`owner_user_id`,`position`);--> statement-breakpoint
CREATE TABLE `task_label_group_values` (
	`task_id` text NOT NULL,
	`group_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `group_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `label_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_label_group_values_task_label` ON `task_label_group_values` (`task_id`,`label_id`);--> statement-breakpoint
CREATE INDEX `idx_task_label_group_values_label` ON `task_label_group_values` (`label_id`,`task_id`);--> statement-breakpoint
ALTER TABLE `labels` ADD `group_id` text REFERENCES label_groups(id);--> statement-breakpoint
CREATE TRIGGER `label_group_owner_insert_guard`
BEFORE INSERT ON `labels`
WHEN NEW.group_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM label_groups g
  WHERE g.id = NEW.group_id AND g.owner_user_id = NEW.owner_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'Label and Label Group owners must match');
END;--> statement-breakpoint
CREATE TRIGGER `label_group_owner_update_guard`
BEFORE UPDATE OF group_id, owner_user_id ON `labels`
WHEN NEW.group_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM label_groups g
  WHERE g.id = NEW.group_id AND g.owner_user_id = NEW.owner_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'Label and Label Group owners must match');
END;--> statement-breakpoint
CREATE TRIGGER `label_group_value_insert_guard`
AFTER INSERT ON `task_labels`
WHEN EXISTS (SELECT 1 FROM labels l WHERE l.id = NEW.label_id AND l.group_id IS NOT NULL)
BEGIN
  INSERT INTO task_label_group_values (task_id, group_id, label_id)
  SELECT NEW.task_id, l.group_id, NEW.label_id FROM labels l WHERE l.id = NEW.label_id;
END;--> statement-breakpoint
CREATE TRIGGER `label_group_value_delete_guard`
AFTER DELETE ON `task_labels`
BEGIN
  DELETE FROM task_label_group_values
  WHERE task_id = OLD.task_id AND label_id = OLD.label_id;
END;--> statement-breakpoint
CREATE TRIGGER `label_group_label_move_guard`
BEFORE UPDATE OF group_id ON `labels`
WHEN NEW.group_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM task_labels own_assignment
  JOIN task_label_group_values other
    ON other.task_id = own_assignment.task_id
   AND other.group_id = NEW.group_id
   AND other.label_id <> NEW.id
  WHERE own_assignment.label_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'A Task can have at most one Label from each Label Group');
END;--> statement-breakpoint
CREATE TRIGGER `label_group_label_move_sync`
AFTER UPDATE OF group_id ON `labels`
BEGIN
  DELETE FROM task_label_group_values WHERE label_id = NEW.id;
  INSERT INTO task_label_group_values (task_id, group_id, label_id)
  SELECT tl.task_id, NEW.group_id, NEW.id FROM task_labels tl
  WHERE tl.label_id = NEW.id AND NEW.group_id IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `label_group_catalog_owner_update_guard`
BEFORE UPDATE OF owner_user_id ON `label_groups`
WHEN EXISTS (
  SELECT 1 FROM labels l WHERE l.group_id = NEW.id AND l.owner_user_id <> NEW.owner_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'Label and Label Group owners must match');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_label_groups_update`
AFTER UPDATE ON `label_groups`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT DISTINCT tl.task_id, 'task_detail'
  FROM labels l JOIN task_labels tl ON tl.label_id = l.id
  WHERE l.group_id = NEW.id;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_label_groups_delete`
BEFORE DELETE ON `label_groups`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT DISTINCT tl.task_id, 'task_detail'
  FROM labels l JOIN task_labels tl ON tl.label_id = l.id
  WHERE l.group_id = OLD.id;
END;
