CREATE TRIGGER `workspace_sync_attachments_insert`
AFTER INSERT ON `attachments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.task_id, 'task_attachments');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_attachments_update`
AFTER UPDATE ON `attachments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.task_id, 'task_attachments');
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT OLD.task_id, 'task_attachments'
  WHERE OLD.task_id <> NEW.task_id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_attachments_delete`
AFTER DELETE ON `attachments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (OLD.task_id, 'task_attachments');
END;
