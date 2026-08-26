ALTER TABLE `projects` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `deleted_by_user_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `purge_after` text;--> statement-breakpoint
CREATE INDEX `idx_projects_deleted_purge` ON `projects` (`deleted_at`,`purge_after`);--> statement-breakpoint
ALTER TABLE `releases` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `deleted_by_user_id` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `purge_after` text;--> statement-breakpoint
CREATE INDEX `idx_releases_deleted_purge` ON `releases` (`deleted_at`,`purge_after`);--> statement-breakpoint
ALTER TABLE `saved_views` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `saved_views` ADD `deleted_by_user_id` text;--> statement-breakpoint
ALTER TABLE `saved_views` ADD `purge_after` text;--> statement-breakpoint
CREATE INDEX `idx_saved_views_deleted_purge` ON `saved_views` (`deleted_at`,`purge_after`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `deleted_by_user_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `purge_after` text;--> statement-breakpoint
CREATE INDEX `idx_tasks_deleted_purge` ON `tasks` (`deleted_at`,`purge_after`);
--> statement-breakpoint
CREATE TRIGGER `projects_deleted_lifecycle_insert_guard`
BEFORE INSERT ON `projects`
WHEN (NEW.deleted_at IS NULL) <> (NEW.deleted_by_user_id IS NULL)
  OR (NEW.deleted_at IS NULL) <> (NEW.purge_after IS NULL)
  OR (NEW.deleted_at IS NOT NULL AND NEW.purge_after <= NEW.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Invalid Project deletion lifecycle');
END;
--> statement-breakpoint
CREATE TRIGGER `projects_deleted_lifecycle_update_guard`
BEFORE UPDATE OF `deleted_at`, `deleted_by_user_id`, `purge_after` ON `projects`
WHEN (NEW.deleted_at IS NULL) <> (NEW.deleted_by_user_id IS NULL)
  OR (NEW.deleted_at IS NULL) <> (NEW.purge_after IS NULL)
  OR (NEW.deleted_at IS NOT NULL AND NEW.purge_after <= NEW.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Invalid Project deletion lifecycle');
END;
--> statement-breakpoint
CREATE TRIGGER `releases_deleted_lifecycle_insert_guard`
BEFORE INSERT ON `releases`
WHEN (NEW.deleted_at IS NULL) <> (NEW.deleted_by_user_id IS NULL)
  OR (NEW.deleted_at IS NULL) <> (NEW.purge_after IS NULL)
  OR (NEW.deleted_at IS NOT NULL AND NEW.purge_after <= NEW.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Invalid Release deletion lifecycle');
END;
--> statement-breakpoint
CREATE TRIGGER `releases_deleted_lifecycle_update_guard`
BEFORE UPDATE OF `deleted_at`, `deleted_by_user_id`, `purge_after` ON `releases`
WHEN (NEW.deleted_at IS NULL) <> (NEW.deleted_by_user_id IS NULL)
  OR (NEW.deleted_at IS NULL) <> (NEW.purge_after IS NULL)
  OR (NEW.deleted_at IS NOT NULL AND NEW.purge_after <= NEW.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Invalid Release deletion lifecycle');
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_deleted_lifecycle_insert_guard`
BEFORE INSERT ON `tasks`
WHEN (NEW.deleted_at IS NULL) <> (NEW.deleted_by_user_id IS NULL)
  OR (NEW.deleted_at IS NULL) <> (NEW.purge_after IS NULL)
  OR (NEW.deleted_at IS NOT NULL AND NEW.purge_after <= NEW.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Invalid Task deletion lifecycle');
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_deleted_lifecycle_update_guard`
BEFORE UPDATE OF `deleted_at`, `deleted_by_user_id`, `purge_after` ON `tasks`
WHEN (NEW.deleted_at IS NULL) <> (NEW.deleted_by_user_id IS NULL)
  OR (NEW.deleted_at IS NULL) <> (NEW.purge_after IS NULL)
  OR (NEW.deleted_at IS NOT NULL AND NEW.purge_after <= NEW.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Invalid Task deletion lifecycle');
END;
--> statement-breakpoint
CREATE TRIGGER `saved_views_deleted_lifecycle_insert_guard`
BEFORE INSERT ON `saved_views`
WHEN (NEW.deleted_at IS NULL) <> (NEW.deleted_by_user_id IS NULL)
  OR (NEW.deleted_at IS NULL) <> (NEW.purge_after IS NULL)
  OR (NEW.deleted_at IS NOT NULL AND NEW.purge_after <= NEW.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Invalid Saved View deletion lifecycle');
END;
--> statement-breakpoint
CREATE TRIGGER `saved_views_deleted_lifecycle_update_guard`
BEFORE UPDATE OF `deleted_at`, `deleted_by_user_id`, `purge_after` ON `saved_views`
WHEN (NEW.deleted_at IS NULL) <> (NEW.deleted_by_user_id IS NULL)
  OR (NEW.deleted_at IS NULL) <> (NEW.purge_after IS NULL)
  OR (NEW.deleted_at IS NOT NULL AND NEW.purge_after <= NEW.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Invalid Saved View deletion lifecycle');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_project_deletion_reset`
AFTER UPDATE OF `deleted_at` ON `projects`
WHEN OLD.deleted_at IS NOT NEW.deleted_at
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
  SELECT audience_user_id, sequence.last_sequence, 'workspace', NEW.id, 'reset'
  FROM (
    SELECT NEW.owner_user_id AS audience_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = NEW.id
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_sync_release_deletion_reset`
AFTER UPDATE OF `deleted_at` ON `releases`
WHEN OLD.deleted_at IS NOT NEW.deleted_at
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
  SELECT audience_user_id, sequence.last_sequence, 'workspace', NEW.id, 'reset'
  FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p WHERE p.id = NEW.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = NEW.project_id
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_live_project_insert_guard`
BEFORE INSERT ON `tasks`
WHEN EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.deleted_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Tasks require a live Project');
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_live_project_update_guard`
BEFORE UPDATE OF `project_id` ON `tasks`
WHEN EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.deleted_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Tasks require a live Project');
END;
--> statement-breakpoint
CREATE TRIGGER `releases_live_project_insert_guard`
BEFORE INSERT ON `releases`
WHEN EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.deleted_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Releases require a live Project');
END;
--> statement-breakpoint
CREATE TRIGGER `releases_live_project_update_guard`
BEFORE UPDATE OF `project_id` ON `releases`
WHEN EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.deleted_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Releases require a live Project');
END;
--> statement-breakpoint
CREATE TRIGGER `saved_views_live_project_insert_guard`
BEFORE INSERT ON `saved_views`
WHEN NEW.scope_project_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.scope_project_id AND p.deleted_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Saved Views require a live scoped Project');
END;
--> statement-breakpoint
CREATE TRIGGER `saved_views_live_project_update_guard`
BEFORE UPDATE OF `scope_project_id` ON `saved_views`
WHEN NEW.scope_project_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.scope_project_id AND p.deleted_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Saved Views require a live scoped Project');
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_live_release_insert_guard`
BEFORE INSERT ON `tasks`
WHEN NEW.release_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM releases r
  WHERE r.id = NEW.release_id AND r.project_id = NEW.project_id
    AND r.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Task Release must be live and belong to its Project');
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_live_release_update_guard`
BEFORE UPDATE OF `release_id`, `project_id` ON `tasks`
WHEN (NEW.release_id IS NOT OLD.release_id OR NEW.project_id IS NOT OLD.project_id)
  AND NEW.release_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM releases r
  WHERE r.id = NEW.release_id AND r.project_id = NEW.project_id
    AND r.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Task Release must be live and belong to its Project');
END;
