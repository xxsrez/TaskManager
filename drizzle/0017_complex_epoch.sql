PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_task_id` text NOT NULL,
	`target_task_id` text NOT NULL,
	`type` text NOT NULL,
	`creator_user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_task_relations`(
	"id", "source_task_id", "target_task_id", "type", "creator_user_id",
	"idempotency_key", "version", "created_at", "updated_at"
)
SELECT
	'relation_legacy:' || "source_task_id" || ':' || "target_task_id" || ':' || "type",
	"source_task_id", "target_task_id", "type", "creator_user_id",
	'legacy:' || "source_task_id" || ':' || "target_task_id" || ':' || "type",
	1, "created_at", "created_at"
FROM `task_relations`;--> statement-breakpoint
DROP TABLE `task_relations`;--> statement-breakpoint
ALTER TABLE `__new_task_relations` RENAME TO `task_relations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_relations_semantic` ON `task_relations` (`source_task_id`,`target_task_id`,`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_relations_idempotency` ON `task_relations` (`creator_user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_relations_duplicate_source` ON `task_relations` (`source_task_id`) WHERE "task_relations"."type" = 'duplicate_of';--> statement-breakpoint
CREATE INDEX `idx_task_relations_target` ON `task_relations` (`target_task_id`,`type`);--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_relations_insert`
AFTER INSERT ON `task_relations`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.source_task_id, 'task_detail');
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT NEW.target_task_id, 'task_detail'
  WHERE NEW.target_task_id <> NEW.source_task_id;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_relations_update`
AFTER UPDATE ON `task_relations`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (OLD.source_task_id, 'task_detail');
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT OLD.target_task_id, 'task_detail'
  WHERE OLD.target_task_id <> OLD.source_task_id;
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT NEW.source_task_id, 'task_detail'
  WHERE NEW.source_task_id NOT IN (OLD.source_task_id, OLD.target_task_id);
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT NEW.target_task_id, 'task_detail'
  WHERE NEW.target_task_id NOT IN (OLD.source_task_id, OLD.target_task_id)
    AND NEW.target_task_id <> NEW.source_task_id;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_relations_delete`
AFTER DELETE ON `task_relations`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (OLD.source_task_id, 'task_detail');
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT OLD.target_task_id, 'task_detail'
  WHERE OLD.target_task_id <> OLD.source_task_id;
END;
