PRAGMA foreign_keys=OFF;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_code` text DEFAULT 'PR' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `code_locked_at` text;--> statement-breakpoint
WITH ranked_projects AS (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY owner_user_id ORDER BY id) - 1 AS ordinal
  FROM projects
)
UPDATE projects
SET task_code = (
  SELECT 'Z' ||
    char(65 + (ranked_projects.ordinal / 26) % 26) ||
    char(65 + ranked_projects.ordinal % 26)
  FROM ranked_projects WHERE ranked_projects.id = projects.id
);--> statement-breakpoint
UPDATE projects AS target
SET task_code = 'TM'
WHERE lower(trim(target.name)) = 'task manager'
  AND target.id = (
    SELECT MIN(candidate.id) FROM projects candidate
    WHERE candidate.owner_user_id = target.owner_user_id
      AND lower(trim(candidate.name)) = 'task manager'
  );--> statement-breakpoint
UPDATE projects AS target
SET task_code = 'MD'
WHERE lower(trim(target.name)) = 'mind diary'
  AND target.id = (
    SELECT MIN(candidate.id) FROM projects candidate
    WHERE candidate.owner_user_id = target.owner_user_id
      AND lower(trim(candidate.name)) = 'mind diary'
  );--> statement-breakpoint
UPDATE projects AS target
SET task_code = 'SE'
WHERE lower(trim(target.name)) = 'scorched earth'
  AND target.id = (
    SELECT MIN(candidate.id) FROM projects candidate
    WHERE candidate.owner_user_id = target.owner_user_id
      AND lower(trim(candidate.name)) = 'scorched earth'
  );--> statement-breakpoint
UPDATE projects AS target
SET task_code = 'HO'
WHERE lower(trim(target.name)) = 'homeostat'
  AND target.id = (
    SELECT MIN(candidate.id) FROM projects candidate
    WHERE candidate.owner_user_id = target.owner_user_id
      AND lower(trim(candidate.name)) = 'homeostat'
  );--> statement-breakpoint
INSERT INTO projects (
  id, public_id, owner_user_id, creator_user_id, name, task_code,
  task_sequence, summary, description, status, lead_user_id, icon, color,
  version, created_at, updated_at
)
SELECT
  'project_migration_inbox_' || lower(hex(randomblob(16))),
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-8' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  owner_user_id, owner_user_id, 'Migration Inbox', 'MI', 0,
  'Temporary home for provider-onboarding migration records.', '', 'planned',
  owner_user_id, 'inbox', '#6b7280', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT owner_user_id FROM tasks
  WHERE project_id IS NULL AND identifier IN ('AND-1', 'AND-2', 'AND-3', 'AND-4')
) owners
WHERE NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.owner_user_id = owners.owner_user_id
    AND p.task_code = 'MI' AND p.archived_at IS NULL
);--> statement-breakpoint
UPDATE tasks
SET project_id = (
  SELECT p.id FROM projects p
  WHERE p.owner_user_id = tasks.owner_user_id
    AND lower(trim(p.name)) = 'mind diary' AND p.archived_at IS NULL
  ORDER BY p.id LIMIT 1
)
WHERE project_id IS NULL
  AND identifier LIKE 'AND-%'
  AND CAST(substr(identifier, 5) AS INTEGER) BETWEEN 91 AND 146;--> statement-breakpoint
UPDATE tasks
SET project_id = (
  SELECT p.id FROM projects p
  WHERE p.owner_user_id = tasks.owner_user_id
    AND p.task_code = 'MI' AND p.archived_at IS NULL
  ORDER BY p.id LIMIT 1
)
WHERE project_id IS NULL
  AND identifier IN ('AND-1', 'AND-2', 'AND-3', 'AND-4');--> statement-breakpoint
CREATE TABLE `__migration_0018_task_aliases` AS
SELECT id AS task_id, identifier, CURRENT_TIMESTAMP AS created_at FROM tasks;--> statement-breakpoint
UPDATE tasks
SET identifier = (
  SELECT p.task_code || '-' || tasks.sequence_number
  FROM projects p WHERE p.id = tasks.project_id
);--> statement-breakpoint
UPDATE projects AS target
SET task_sequence = COALESCE((
      SELECT MAX(t.sequence_number) FROM tasks t WHERE t.project_id = target.id
    ), 0),
    code_locked_at = (
      SELECT MIN(t.created_at) FROM tasks t WHERE t.project_id = target.id
    );--> statement-breakpoint
CREATE TABLE `__migration_0018_comments` AS SELECT * FROM comments;--> statement-breakpoint
CREATE TABLE `__migration_0018_comment_reactions` AS SELECT * FROM comment_reactions;--> statement-breakpoint
CREATE TABLE `__migration_0018_attachments` AS SELECT * FROM attachments;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_comments_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_comments_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_comments_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_comment_reactions_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_comment_reactions_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_attachments_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_attachments_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_attachments_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_lazy_invalidation_fanout`;--> statement-breakpoint
DELETE FROM comment_reactions;--> statement-breakpoint
DELETE FROM comments;--> statement-breakpoint
DELETE FROM attachments;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`creator_user_id` text NOT NULL,
	`identifier` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status_id` text NOT NULL,
	`priority` text DEFAULT 'none' NOT NULL,
	`assignee_user_id` text,
	`project_id` text NOT NULL,
	`release_id` text,
	`estimate` integer,
	`due_date` text,
	`parent_task_id` text,
	`rank` real DEFAULT 0 NOT NULL,
	`started_at` text,
	`completed_at` text,
	`canceled_at` text,
	`archived_at` text,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "public_id", "owner_user_id", "creator_user_id", "identifier", "sequence_number", "title", "description", "status_id", "priority", "assignee_user_id", "project_id", "release_id", "estimate", "due_date", "parent_task_id", "rank", "started_at", "completed_at", "canceled_at", "archived_at", "comment_count", "version", "created_at", "updated_at") SELECT "id", "public_id", "owner_user_id", "creator_user_id", "identifier", "sequence_number", "title", "description", "status_id", "priority", "assignee_user_id", "project_id", "release_id", "estimate", "due_date", "parent_task_id", "rank", "started_at", "completed_at", "canceled_at", "archived_at", "comment_count", "version", "created_at", "updated_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `task_identifier_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`identifier` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO task_identifier_aliases (id, task_id, identifier, created_at)
SELECT 'task_alias_' || lower(hex(randomblob(16))), task_id, identifier, created_at
FROM __migration_0018_task_aliases;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_identifier_aliases_task_identifier` ON `task_identifier_aliases` (`task_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `idx_task_identifier_aliases_lookup` ON `task_identifier_aliases` (lower("identifier"));--> statement-breakpoint
INSERT INTO comments SELECT * FROM __migration_0018_comments;--> statement-breakpoint
INSERT INTO comment_reactions SELECT * FROM __migration_0018_comment_reactions;--> statement-breakpoint
INSERT INTO attachments SELECT * FROM __migration_0018_attachments;--> statement-breakpoint
DROP TABLE `__migration_0018_task_aliases`;--> statement-breakpoint
DROP TABLE `__migration_0018_comments`;--> statement-breakpoint
DROP TABLE `__migration_0018_comment_reactions`;--> statement-breakpoint
DROP TABLE `__migration_0018_attachments`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_public_id` ON `tasks` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_project_sequence` ON `tasks` (`project_id`,`sequence_number`);--> statement-breakpoint
CREATE INDEX `idx_tasks_owner_status_archived` ON `tasks` (`owner_user_id`,`status_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_project_release` ON `tasks` (`project_id`,`release_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_parent` ON `tasks` (`parent_task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_archived` ON `tasks` (`release_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_owner_updated` ON `tasks` (`owner_user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_title_search` ON `tasks` (lower("title"));--> statement-breakpoint
CREATE INDEX `idx_tasks_identifier_search` ON `tasks` (lower("identifier"));--> statement-breakpoint
CREATE UNIQUE INDEX `idx_projects_owner_task_code_active` ON `projects` (`owner_user_id`,`task_code`) WHERE "projects"."archived_at" IS NULL;--> statement-breakpoint
CREATE TRIGGER `projects_task_code_insert_guard`
BEFORE INSERT ON `projects`
WHEN length(NEW.task_code) NOT IN (2, 3)
  OR NEW.task_code GLOB '*[^A-Z]*'
  OR NEW.task_sequence < 0
  OR (NEW.task_sequence > 0 AND NEW.code_locked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'Invalid Project task code or sequence');
END;--> statement-breakpoint
CREATE TRIGGER `projects_task_code_update_guard`
BEFORE UPDATE OF `task_code`, `task_sequence`, `code_locked_at` ON `projects`
WHEN length(NEW.task_code) NOT IN (2, 3)
  OR NEW.task_code GLOB '*[^A-Z]*'
  OR NEW.task_sequence < OLD.task_sequence
  OR (NEW.task_sequence > 0 AND NEW.code_locked_at IS NULL)
  OR (OLD.code_locked_at IS NOT NULL AND NEW.code_locked_at IS NULL)
  OR (OLD.code_locked_at IS NOT NULL AND NEW.task_code <> OLD.task_code)
BEGIN
  SELECT RAISE(ABORT, 'Invalid or locked Project task code or sequence');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_tasks_insert`
AFTER INSERT ON `tasks`
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
  SELECT audience_user_id, sequence.last_sequence, 'task', NEW.id, 'upsert'
  FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p WHERE p.id = NEW.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = NEW.project_id
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_tasks_update`
AFTER UPDATE ON `tasks`
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
  SELECT audience_user_id, sequence.last_sequence, 'task', NEW.id, 'upsert'
  FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p WHERE p.id = NEW.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = NEW.project_id
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_tasks_move`
AFTER UPDATE OF `project_id`, `owner_user_id` ON `tasks`
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.owner_user_id IS NOT NEW.owner_user_id
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
  SELECT audience_user_id, sequence.last_sequence, 'task', OLD.id, 'upsert'
  FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p WHERE p.id = OLD.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = OLD.project_id
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_tasks_delete`
AFTER DELETE ON `tasks`
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
  SELECT audience_user_id, sequence.last_sequence, 'task', OLD.id, 'remove'
  FROM (
    SELECT p.owner_user_id AS audience_user_id FROM projects p WHERE p.id = OLD.project_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = OLD.project_id
        AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_comments_insert`
AFTER INSERT ON `comments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.task_id, 'task_comments');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_comments_update`
AFTER UPDATE ON `comments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.task_id, 'task_comments');
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT OLD.task_id, 'task_comments'
  WHERE OLD.task_id <> NEW.task_id;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_comments_delete`
AFTER DELETE ON `comments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (OLD.task_id, 'task_comments');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_comment_reactions_insert`
AFTER INSERT ON `comment_reactions`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT task_id, 'task_comments' FROM comments WHERE id = NEW.comment_id;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_comment_reactions_delete`
AFTER DELETE ON `comment_reactions`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT task_id, 'task_comments' FROM comments WHERE id = OLD.comment_id;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_attachments_insert`
AFTER INSERT ON `attachments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.task_id, 'task_attachments');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_attachments_update`
AFTER UPDATE ON `attachments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.task_id, 'task_attachments');
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  SELECT OLD.task_id, 'task_attachments'
  WHERE OLD.task_id <> NEW.task_id;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_attachments_delete`
AFTER DELETE ON `attachments`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (OLD.task_id, 'task_attachments');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_lazy_invalidation_fanout`
AFTER INSERT ON `workspace_sync_invalidations`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT p.owner_user_id AS audience_user_id
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = NEW.task_id
    UNION SELECT ag.grantee_user_id
      FROM tasks t JOIN access_grants ag
        ON ag.resource_type = 'project' AND ag.resource_id = t.project_id
          AND ag.revoked_at IS NULL
      WHERE t.id = NEW.task_id
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE
    SET last_sequence = last_sequence + 1;

  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence,
         NEW.invalidation_type, NEW.task_id, 'invalidate'
  FROM (
    SELECT p.owner_user_id AS audience_user_id
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = NEW.task_id
    UNION SELECT ag.grantee_user_id
      FROM tasks t JOIN access_grants ag
        ON ag.resource_type = 'project' AND ag.resource_id = t.project_id
          AND ag.revoked_at IS NULL
      WHERE t.id = NEW.task_id
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);

  DELETE FROM workspace_sync_invalidations WHERE rowid = NEW.rowid;
END;--> statement-breakpoint
PRAGMA foreign_keys=ON;
