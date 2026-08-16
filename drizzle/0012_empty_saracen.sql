CREATE TABLE `workspace_change_events` (
	`audience_user_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`operation` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`audience_user_id`, `sequence`)
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_change_events_created` ON `workspace_change_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_sync_sequences` (
	`audience_user_id` text PRIMARY KEY NOT NULL,
	`last_sequence` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_tasks_insert`
AFTER INSERT ON `tasks`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT NEW.owner_user_id AS audience_user_id WHERE NEW.project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = NEW.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (NEW.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = NEW.project_id) OR
        (NEW.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = NEW.id)
      )
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'task', NEW.id, 'upsert'
  FROM (
    SELECT NEW.owner_user_id AS audience_user_id WHERE NEW.project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = NEW.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (NEW.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = NEW.project_id) OR
        (NEW.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = NEW.id)
      )
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_projects_insert`
AFTER INSERT ON `projects`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT NEW.owner_user_id AS audience_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = NEW.id
        AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'project', NEW.id, 'upsert'
  FROM (
    SELECT NEW.owner_user_id AS audience_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = NEW.id
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_projects_update`
AFTER UPDATE ON `projects`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT NEW.owner_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id IN (OLD.id, NEW.id)
        AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'project', NEW.id, 'upsert'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT NEW.owner_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id IN (OLD.id, NEW.id)
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_projects_delete`
AFTER DELETE ON `projects`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = OLD.id
        AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'project', OLD.id, 'remove'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = OLD.id
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_releases_insert`
AFTER INSERT ON `releases`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p WHERE p.id = NEW.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = NEW.project_id
        AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'release', NEW.id, 'upsert'
  FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p WHERE p.id = NEW.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = NEW.project_id
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_releases_update`
AFTER UPDATE ON `releases`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p
      WHERE p.id IN (OLD.project_id, NEW.project_id)
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project'
        AND ag.resource_id IN (OLD.project_id, NEW.project_id)
        AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'release', NEW.id, 'upsert'
  FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p
      WHERE p.id IN (OLD.project_id, NEW.project_id)
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project'
        AND ag.resource_id IN (OLD.project_id, NEW.project_id)
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_releases_delete`
AFTER DELETE ON `releases`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p WHERE p.id = OLD.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = OLD.project_id
        AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'release', OLD.id, 'remove'
  FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p WHERE p.id = OLD.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = OLD.project_id
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_views_insert`
AFTER INSERT ON `saved_views`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT NEW.owner_user_id AS audience_user_id WHERE NEW.scope_project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = NEW.scope_project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (NEW.scope_project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = NEW.scope_project_id) OR
        (NEW.scope_project_id IS NULL AND ag.resource_type = 'saved_view' AND ag.resource_id = NEW.id)
      )
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'saved_view', NEW.id, 'upsert'
  FROM (
    SELECT NEW.owner_user_id AS audience_user_id WHERE NEW.scope_project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = NEW.scope_project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (NEW.scope_project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = NEW.scope_project_id) OR
        (NEW.scope_project_id IS NULL AND ag.resource_type = 'saved_view' AND ag.resource_id = NEW.id)
      )
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_views_update`
AFTER UPDATE ON `saved_views`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT NEW.owner_user_id AS audience_user_id WHERE NEW.scope_project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = NEW.scope_project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (NEW.scope_project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = NEW.scope_project_id) OR
        (NEW.scope_project_id IS NULL AND ag.resource_type = 'saved_view' AND ag.resource_id = NEW.id)
      )
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'saved_view', NEW.id, 'upsert'
  FROM (
    SELECT NEW.owner_user_id AS audience_user_id WHERE NEW.scope_project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = NEW.scope_project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (NEW.scope_project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = NEW.scope_project_id) OR
        (NEW.scope_project_id IS NULL AND ag.resource_type = 'saved_view' AND ag.resource_id = NEW.id)
      )
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_views_move`
AFTER UPDATE OF `scope_project_id`, `owner_user_id` ON `saved_views`
WHEN OLD.scope_project_id IS NOT NEW.scope_project_id OR OLD.owner_user_id IS NOT NEW.owner_user_id
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id WHERE OLD.scope_project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = OLD.scope_project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (OLD.scope_project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = OLD.scope_project_id) OR
        (OLD.scope_project_id IS NULL AND ag.resource_type = 'saved_view' AND ag.resource_id = OLD.id)
      )
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'saved_view', OLD.id, 'upsert'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id WHERE OLD.scope_project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = OLD.scope_project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (OLD.scope_project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = OLD.scope_project_id) OR
        (OLD.scope_project_id IS NULL AND ag.resource_type = 'saved_view' AND ag.resource_id = OLD.id)
      )
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_views_delete`
AFTER DELETE ON `saved_views`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id WHERE OLD.scope_project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = OLD.scope_project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (OLD.scope_project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = OLD.scope_project_id) OR
        (OLD.scope_project_id IS NULL AND ag.resource_type = 'saved_view' AND ag.resource_id = OLD.id)
      )
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'saved_view', OLD.id, 'remove'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id WHERE OLD.scope_project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = OLD.scope_project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (OLD.scope_project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = OLD.scope_project_id) OR
        (OLD.scope_project_id IS NULL AND ag.resource_type = 'saved_view' AND ag.resource_id = OLD.id)
      )
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_access_insert`
AFTER INSERT ON `access_grants`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT NEW.owner_user_id AS audience_user_id
    UNION SELECT NEW.grantee_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = NEW.resource_type
        AND ag.resource_id = NEW.resource_id AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'workspace', NEW.resource_id, 'reset'
  FROM (
    SELECT NEW.owner_user_id AS audience_user_id
    UNION SELECT NEW.grantee_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = NEW.resource_type
        AND ag.resource_id = NEW.resource_id AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_access_update`
AFTER UPDATE ON `access_grants`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT NEW.owner_user_id
    UNION SELECT OLD.grantee_user_id
    UNION SELECT NEW.grantee_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (ag.resource_type = OLD.resource_type AND ag.resource_id = OLD.resource_id) OR
        (ag.resource_type = NEW.resource_type AND ag.resource_id = NEW.resource_id)
      )
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'workspace', NEW.resource_id, 'reset'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT NEW.owner_user_id
    UNION SELECT OLD.grantee_user_id
    UNION SELECT NEW.grantee_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (ag.resource_type = OLD.resource_type AND ag.resource_id = OLD.resource_id) OR
        (ag.resource_type = NEW.resource_type AND ag.resource_id = NEW.resource_id)
      )
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_access_delete`
AFTER DELETE ON `access_grants`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT OLD.grantee_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = OLD.resource_type
        AND ag.resource_id = OLD.resource_id AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'workspace', OLD.resource_id, 'reset'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT OLD.grantee_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = OLD.resource_type
        AND ag.resource_id = OLD.resource_id AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_tasks_update`
AFTER UPDATE ON `tasks`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT NEW.owner_user_id AS audience_user_id WHERE NEW.project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = NEW.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (NEW.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = NEW.project_id) OR
        (NEW.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = NEW.id)
      )
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'task', NEW.id, 'upsert'
  FROM (
    SELECT NEW.owner_user_id AS audience_user_id WHERE NEW.project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = NEW.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (NEW.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = NEW.project_id) OR
        (NEW.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = NEW.id)
      )
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_tasks_move`
AFTER UPDATE OF `project_id`, `owner_user_id` ON `tasks`
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.owner_user_id IS NOT NEW.owner_user_id
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id WHERE OLD.project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = OLD.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (OLD.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = OLD.project_id) OR
        (OLD.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = OLD.id)
      )
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'task', OLD.id, 'upsert'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id WHERE OLD.project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = OLD.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (OLD.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = OLD.project_id) OR
        (OLD.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = OLD.id)
      )
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_tasks_delete`
AFTER DELETE ON `tasks`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id WHERE OLD.project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = OLD.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (OLD.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = OLD.project_id) OR
        (OLD.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = OLD.id)
      )
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'task', OLD.id, 'remove'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id WHERE OLD.project_id IS NULL
    UNION SELECT p.owner_user_id FROM projects p WHERE p.id = OLD.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.revoked_at IS NULL AND (
        (OLD.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = OLD.project_id) OR
        (OLD.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = OLD.id)
      )
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_labels_insert`
AFTER INSERT ON `task_labels`
BEGIN
  UPDATE tasks
  SET updated_at = updated_at
  WHERE id = NEW.task_id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_labels_delete`
AFTER DELETE ON `task_labels`
BEGIN
  UPDATE tasks
  SET updated_at = updated_at
  WHERE id = OLD.task_id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_relations_insert`
AFTER INSERT ON `task_relations`
BEGIN
  UPDATE tasks
  SET updated_at = updated_at
  WHERE id IN (NEW.source_task_id, NEW.target_task_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_task_relations_delete`
AFTER DELETE ON `task_relations`
BEGIN
  UPDATE tasks
  SET updated_at = updated_at
  WHERE id IN (OLD.source_task_id, OLD.target_task_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_labels_insert`
AFTER INSERT ON `labels`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  VALUES (NEW.owner_user_id, 1)
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT NEW.owner_user_id, last_sequence, 'workspace', NEW.id, 'reset'
  FROM workspace_sync_sequences
  WHERE audience_user_id = NEW.owner_user_id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_labels_update`
AFTER UPDATE ON `labels`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT NEW.owner_user_id
    UNION SELECT t.owner_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      WHERE tl.label_id = NEW.id AND t.project_id IS NULL
    UNION SELECT p.owner_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      JOIN projects p ON p.id = t.project_id
      WHERE tl.label_id = NEW.id
    UNION SELECT ag.grantee_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      JOIN access_grants ag ON ag.revoked_at IS NULL AND (
        (t.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = t.project_id) OR
        (t.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = t.id)
      )
      WHERE tl.label_id = NEW.id
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'workspace', NEW.id, 'reset'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT NEW.owner_user_id
    UNION SELECT t.owner_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      WHERE tl.label_id = NEW.id AND t.project_id IS NULL
    UNION SELECT p.owner_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      JOIN projects p ON p.id = t.project_id
      WHERE tl.label_id = NEW.id
    UNION SELECT ag.grantee_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      JOIN access_grants ag ON ag.revoked_at IS NULL AND (
        (t.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = t.project_id) OR
        (t.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = t.id)
      )
      WHERE tl.label_id = NEW.id
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_labels_delete`
AFTER DELETE ON `labels`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT t.owner_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      WHERE tl.label_id = OLD.id AND t.project_id IS NULL
    UNION SELECT p.owner_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      JOIN projects p ON p.id = t.project_id
      WHERE tl.label_id = OLD.id
    UNION SELECT ag.grantee_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      JOIN access_grants ag ON ag.revoked_at IS NULL AND (
        (t.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = t.project_id) OR
        (t.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = t.id)
      )
      WHERE tl.label_id = OLD.id
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'workspace', OLD.id, 'reset'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT t.owner_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      WHERE tl.label_id = OLD.id AND t.project_id IS NULL
    UNION SELECT p.owner_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      JOIN projects p ON p.id = t.project_id
      WHERE tl.label_id = OLD.id
    UNION SELECT ag.grantee_user_id FROM tasks t
      JOIN task_labels tl ON tl.task_id = t.id
      JOIN access_grants ag ON ag.revoked_at IS NULL AND (
        (t.project_id IS NOT NULL AND ag.resource_type = 'project' AND ag.resource_id = t.project_id) OR
        (t.project_id IS NULL AND ag.resource_type = 'task' AND ag.resource_id = t.id)
      )
      WHERE tl.label_id = OLD.id
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
