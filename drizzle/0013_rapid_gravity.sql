CREATE TABLE `workspace_sync_invalidations` (
	`task_id` text NOT NULL,
	`invalidation_type` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_sync_maintenance` (
	`key` text PRIMARY KEY NOT NULL,
	`last_run_at` text NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_lazy_invalidation_fanout`
AFTER INSERT ON `workspace_sync_invalidations`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT t.owner_user_id AS audience_user_id
      FROM tasks t
      WHERE t.id = NEW.task_id AND t.project_id IS NULL
    UNION SELECT p.owner_user_id
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = NEW.task_id
    UNION SELECT ag.grantee_user_id
      FROM tasks t JOIN access_grants ag ON ag.revoked_at IS NULL AND (
        (t.project_id IS NOT NULL AND ag.resource_type = 'project'
          AND ag.resource_id = t.project_id) OR
        (t.project_id IS NULL AND ag.resource_type = 'task'
          AND ag.resource_id = t.id)
      )
      WHERE t.id = NEW.task_id
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE
    SET last_sequence = last_sequence + 1;

  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence,
         NEW.invalidation_type, NEW.task_id, 'invalidate'
  FROM (
    SELECT t.owner_user_id AS audience_user_id
      FROM tasks t
      WHERE t.id = NEW.task_id AND t.project_id IS NULL
    UNION SELECT p.owner_user_id
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = NEW.task_id
    UNION SELECT ag.grantee_user_id
      FROM tasks t JOIN access_grants ag ON ag.revoked_at IS NULL AND (
        (t.project_id IS NOT NULL AND ag.resource_type = 'project'
          AND ag.resource_id = t.project_id) OR
        (t.project_id IS NULL AND ag.resource_type = 'task'
          AND ag.resource_id = t.id)
      )
      WHERE t.id = NEW.task_id
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);

  DELETE FROM workspace_sync_invalidations WHERE rowid = NEW.rowid;
END;
--> statement-breakpoint
DROP TRIGGER `workspace_sync_task_labels_insert`;
--> statement-breakpoint
DROP TRIGGER `workspace_sync_task_labels_delete`;
--> statement-breakpoint
DROP TRIGGER `workspace_sync_task_relations_insert`;
--> statement-breakpoint
DROP TRIGGER `workspace_sync_task_relations_delete`;
--> statement-breakpoint
DROP TRIGGER `workspace_sync_labels_insert`;
--> statement-breakpoint
DROP TRIGGER `workspace_sync_labels_update`;
--> statement-breakpoint
DROP TRIGGER `workspace_sync_labels_delete`;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_labels_insert`
AFTER INSERT ON `task_labels`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.task_id, 'task_detail');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_labels_delete`
AFTER DELETE ON `task_labels`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (OLD.task_id, 'task_detail');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_relations_insert`
AFTER INSERT ON `task_relations`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.source_task_id, 'task_detail');
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT NEW.target_task_id, 'task_detail'
  WHERE NEW.target_task_id <> NEW.source_task_id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_relations_delete`
AFTER DELETE ON `task_relations`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (OLD.source_task_id, 'task_detail');
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT OLD.target_task_id, 'task_detail'
  WHERE OLD.target_task_id <> OLD.source_task_id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_labels_update`
AFTER UPDATE ON `labels`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT task_id, 'task_detail' FROM task_labels WHERE label_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_labels_delete`
AFTER DELETE ON `labels`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT task_id, 'task_detail' FROM task_labels WHERE label_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_comments_insert`
AFTER INSERT ON `comments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.task_id, 'task_comments');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_comments_update`
AFTER UPDATE ON `comments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.task_id, 'task_comments');
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT OLD.task_id, 'task_comments'
  WHERE OLD.task_id <> NEW.task_id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_comments_delete`
AFTER DELETE ON `comments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (OLD.task_id, 'task_comments');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_comment_reactions_insert`
AFTER INSERT ON `comment_reactions`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT task_id, 'task_comments' FROM comments WHERE id = NEW.comment_id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_comment_reactions_delete`
AFTER DELETE ON `comment_reactions`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT task_id, 'task_comments' FROM comments WHERE id = OLD.comment_id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_external_records_insert`
AFTER INSERT ON `external_records`
WHEN NEW.target_type = 'task'
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.target_id, 'task_external_source');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_external_records_update`
AFTER UPDATE ON `external_records`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT NEW.target_id, 'task_external_source'
  WHERE NEW.target_type = 'task';
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT OLD.target_id, 'task_external_source'
  WHERE OLD.target_type = 'task'
    AND (NEW.target_type <> 'task' OR OLD.target_id <> NEW.target_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_external_records_delete`
AFTER DELETE ON `external_records`
WHEN OLD.target_type = 'task'
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (OLD.target_id, 'task_external_source');
END;
