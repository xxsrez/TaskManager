CREATE TABLE `comment_migration_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`source` text NOT NULL,
	`source_record_id` text NOT NULL,
	`source_comment_id` text,
	`source_index` integer NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`comment_id` text,
	`raw_json` text NOT NULL,
	`reconciled_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "check_comment_migration_outcome" CHECK("comment_migration_outcomes"."outcome" IN ('migrated', 'exception'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_comment_migration_source_index` ON `comment_migration_outcomes` (`source_record_id`,`source_index`);--> statement-breakpoint
CREATE INDEX `idx_comment_migration_task_outcome` ON `comment_migration_outcomes` (`task_id`,`outcome`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_comments_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_comments_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_comments_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_comment_reactions_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `workspace_sync_comment_reactions_delete`;--> statement-breakpoint
CREATE TABLE `__new_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author_user_id` text,
	`body` text NOT NULL,
	`source` text DEFAULT 'native' NOT NULL,
	`source_record_id` text,
	`source_comment_id` text,
	`source_parent_comment_id` text,
	`historical_author_name` text,
	`historical_created_at` text,
	`historical_updated_at` text,
	`historical_quoted_text` text,
	`parent_comment_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text,
	`resolved_at` text,
	`resolved_by_user_id` text,
	`resolution_comment_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolution_comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "check_comment_source_shape" CHECK(
		(`source` = 'native' AND `author_user_id` IS NOT NULL
			AND `source_record_id` IS NULL AND `source_comment_id` IS NULL
			AND `source_parent_comment_id` IS NULL
			AND `historical_author_name` IS NULL
			AND `historical_created_at` IS NULL
			AND `historical_updated_at` IS NULL
			AND `historical_quoted_text` IS NULL)
		OR
		(`source` = 'linear' AND `author_user_id` IS NULL
			AND `source_record_id` IS NOT NULL AND `source_comment_id` IS NOT NULL
			AND `historical_author_name` IS NOT NULL
			AND `historical_created_at` IS NOT NULL
			AND `historical_updated_at` IS NOT NULL)
	)
);
--> statement-breakpoint
INSERT INTO `__new_comments`("id", "task_id", "author_user_id", "body", "source", "source_record_id", "source_comment_id", "source_parent_comment_id", "historical_author_name", "historical_created_at", "historical_updated_at", "historical_quoted_text", "parent_comment_id", "idempotency_key", "created_at", "updated_at", "deleted_at", "resolved_at", "resolved_by_user_id", "resolution_comment_id", "version") SELECT "id", "task_id", "author_user_id", "body", "source", NULL, NULL, NULL, NULL, NULL, NULL, NULL, "parent_comment_id", "idempotency_key", "created_at", "updated_at", "deleted_at", "resolved_at", "resolved_by_user_id", "resolution_comment_id", "version" FROM `comments`;--> statement-breakpoint
DROP TABLE `comments`;--> statement-breakpoint
ALTER TABLE `__new_comments` RENAME TO `comments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_comments_task_author_idempotency` ON `comments` (`task_id`,`author_user_id`,`idempotency_key`) WHERE "comments"."author_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_comments_source_identity` ON `comments` (`task_id`,`source`,`source_comment_id`) WHERE "comments"."source_comment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_comments_task_created` ON `comments` (`task_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_comments_parent` ON `comments` (`parent_comment_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `__migration_0022_external_comments` (
  `source_record_id` text NOT NULL,
  `task_id` text NOT NULL,
  `owner_user_id` text NOT NULL,
  `task_source_id` text NOT NULL,
  `source_index` integer NOT NULL,
  `raw_json` text NOT NULL,
  `source_comment_id` text,
  `body` text,
  `author_name` text,
  `source_created_at` text,
  `source_updated_at` text,
  `source_parent_comment_id` text,
  `quoted_text` text,
  `basic_error` text
);--> statement-breakpoint
INSERT INTO `__migration_0022_external_comments`
  (`source_record_id`, `task_id`, `owner_user_id`, `task_source_id`,
   `source_index`, `raw_json`, `source_comment_id`, `body`, `author_name`,
   `source_created_at`, `source_updated_at`, `source_parent_comment_id`,
   `quoted_text`, `basic_error`)
SELECT
  parsed.source_record_id,
  parsed.task_id,
  parsed.owner_user_id,
  parsed.task_source_id,
  parsed.source_index,
  parsed.raw_json,
  CASE WHEN json_type(parsed.object_json, '$.id') = 'text'
    THEN trim(json_extract(parsed.object_json, '$.id')) END,
  CASE WHEN json_type(parsed.object_json, '$.body') = 'text'
    THEN json_extract(parsed.object_json, '$.body') END,
  CASE
    WHEN json_type(parsed.object_json, '$.author.name') = 'text'
      AND length(trim(json_extract(parsed.object_json, '$.author.name'))) > 0
      THEN trim(json_extract(parsed.object_json, '$.author.name'))
    ELSE 'Unknown Linear user'
  END,
  CASE WHEN json_type(parsed.object_json, '$.createdAt') = 'text'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(parsed.object_json, '$.createdAt')) END,
  CASE WHEN json_type(parsed.object_json, '$.updatedAt') = 'text'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(parsed.object_json, '$.updatedAt')) END,
  CASE WHEN json_type(parsed.object_json, '$.parentId') = 'text'
    THEN trim(json_extract(parsed.object_json, '$.parentId')) END,
  CASE WHEN json_type(parsed.object_json, '$.quotedText') = 'text'
    THEN json_extract(parsed.object_json, '$.quotedText') END,
  CASE
    WHEN parsed.source_type <> 'object' THEN 'comment_not_object'
    WHEN json_type(parsed.object_json, '$.id') <> 'text'
      OR length(trim(json_extract(parsed.object_json, '$.id'))) = 0 THEN 'comment_id_missing'
    WHEN json_type(parsed.object_json, '$.body') <> 'text'
      OR length(trim(json_extract(parsed.object_json, '$.body'))) = 0 THEN 'comment_body_missing'
    WHEN json_type(parsed.object_json, '$.createdAt') <> 'text'
      OR json_type(parsed.object_json, '$.updatedAt') <> 'text'
      OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(parsed.object_json, '$.createdAt')) IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(parsed.object_json, '$.updatedAt')) IS NULL
      THEN 'comment_timestamp_invalid'
    WHEN json_type(parsed.object_json, '$.parentId') NOT IN ('text', 'null')
      AND json_type(parsed.object_json, '$.parentId') IS NOT NULL THEN 'parent_comment_id_invalid'
    WHEN json_type(parsed.object_json, '$.parentId') = 'text'
      AND length(trim(json_extract(parsed.object_json, '$.parentId'))) = 0 THEN 'parent_comment_id_invalid'
    WHEN json_type(parsed.object_json, '$.quotedText') NOT IN ('text', 'null')
      AND json_type(parsed.object_json, '$.quotedText') IS NOT NULL THEN 'quoted_text_invalid'
    ELSE NULL
  END
FROM (
  SELECT
    er.id AS source_record_id,
    er.target_id AS task_id,
    er.owner_user_id,
    er.source_id AS task_source_id,
    CAST(entry.key AS integer) AS source_index,
    entry.type AS source_type,
    CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END AS object_json,
    CASE WHEN entry.type IN ('object', 'array')
      THEN json(entry.value) ELSE json_quote(entry.value) END AS raw_json
  FROM external_records er, json_each(er.metadata_json, '$.comments') entry
  WHERE er.target_type = 'task' AND er.source = 'linear'
    AND json_valid(er.metadata_json)
    AND json_type(er.metadata_json, '$.comments') = 'array'
) parsed;--> statement-breakpoint
INSERT INTO comment_migration_outcomes
  (id, task_id, source, source_record_id, source_comment_id, source_index,
   outcome, reason, comment_id, raw_json, reconciled_at)
SELECT
  'linear:comment-outcome:' || er.id || ':-1',
  er.target_id,
  'linear',
  er.id,
  NULL,
  -1,
  'exception',
  'invalid_comment_collection',
  NULL,
  COALESCE(CAST(json_extract(er.metadata_json, '$.comments') AS text), 'null'),
  er.imported_at
FROM external_records er
WHERE er.target_type = 'task' AND er.source = 'linear'
  AND json_valid(er.metadata_json)
  AND json_type(er.metadata_json, '$.comments') IS NOT NULL
  AND json_type(er.metadata_json, '$.comments') <> 'array';--> statement-breakpoint
WITH RECURSIVE
valid AS (
  SELECT staged.*
  FROM __migration_0022_external_comments staged
  WHERE staged.basic_error IS NULL
    AND 1 = (
      SELECT COUNT(*) FROM __migration_0022_external_comments duplicate
      WHERE duplicate.source_record_id = staged.source_record_id
        AND duplicate.source_comment_id = staged.source_comment_id
        AND duplicate.basic_error IS NULL
    )
),
walk(source_record_id, child_id, current_id, next_parent_id, root_id, path, cycle) AS (
  SELECT source_record_id, source_comment_id, source_comment_id,
    source_parent_comment_id,
    CASE WHEN source_parent_comment_id IS NULL THEN source_comment_id END,
    '|' || source_comment_id || '|',
    0
  FROM valid
  UNION ALL
  SELECT walk.source_record_id, walk.child_id, parent.source_comment_id,
    parent.source_parent_comment_id,
    CASE WHEN parent.source_parent_comment_id IS NULL THEN parent.source_comment_id END,
    walk.path || parent.source_comment_id || '|',
    instr(walk.path, '|' || parent.source_comment_id || '|') > 0
  FROM walk
  JOIN valid parent
    ON parent.source_record_id = walk.source_record_id
   AND parent.source_comment_id = walk.next_parent_id
  WHERE walk.root_id IS NULL AND walk.cycle = 0
),
roots AS (
  SELECT source_record_id, child_id, max(root_id) AS root_id
  FROM walk WHERE root_id IS NOT NULL AND cycle = 0
  GROUP BY source_record_id, child_id
)
INSERT INTO comments
  (id, task_id, author_user_id, body, source, source_record_id,
   source_comment_id, source_parent_comment_id, historical_author_name,
   historical_created_at, historical_updated_at, historical_quoted_text,
   parent_comment_id, idempotency_key, created_at, updated_at, version)
SELECT
  'linear:comment:' || valid.owner_user_id || ':' || valid.task_source_id || ':' || valid.source_comment_id,
  valid.task_id,
  NULL,
  valid.body,
  'linear',
  valid.source_record_id,
  valid.source_comment_id,
  valid.source_parent_comment_id,
  valid.author_name,
  valid.source_created_at,
  valid.source_updated_at,
  valid.quoted_text,
  NULL,
  'linear:' || valid.source_comment_id,
  valid.source_created_at,
  valid.source_updated_at,
  1
FROM valid
JOIN roots ON roots.source_record_id = valid.source_record_id
  AND roots.child_id = valid.source_comment_id
WHERE valid.source_parent_comment_id IS NULL
ON CONFLICT(task_id, source, source_comment_id)
  WHERE source_comment_id IS NOT NULL DO NOTHING;--> statement-breakpoint
WITH RECURSIVE
valid AS (
  SELECT staged.*
  FROM __migration_0022_external_comments staged
  WHERE staged.basic_error IS NULL
    AND 1 = (
      SELECT COUNT(*) FROM __migration_0022_external_comments duplicate
      WHERE duplicate.source_record_id = staged.source_record_id
        AND duplicate.source_comment_id = staged.source_comment_id
        AND duplicate.basic_error IS NULL
    )
),
walk(source_record_id, child_id, current_id, next_parent_id, root_id, path, cycle) AS (
  SELECT source_record_id, source_comment_id, source_comment_id,
    source_parent_comment_id,
    CASE WHEN source_parent_comment_id IS NULL THEN source_comment_id END,
    '|' || source_comment_id || '|',
    0
  FROM valid
  UNION ALL
  SELECT walk.source_record_id, walk.child_id, parent.source_comment_id,
    parent.source_parent_comment_id,
    CASE WHEN parent.source_parent_comment_id IS NULL THEN parent.source_comment_id END,
    walk.path || parent.source_comment_id || '|',
    instr(walk.path, '|' || parent.source_comment_id || '|') > 0
  FROM walk
  JOIN valid parent
    ON parent.source_record_id = walk.source_record_id
   AND parent.source_comment_id = walk.next_parent_id
  WHERE walk.root_id IS NULL AND walk.cycle = 0
),
roots AS (
  SELECT source_record_id, child_id, max(root_id) AS root_id
  FROM walk WHERE root_id IS NOT NULL AND cycle = 0
  GROUP BY source_record_id, child_id
)
INSERT INTO comments
  (id, task_id, author_user_id, body, source, source_record_id,
   source_comment_id, source_parent_comment_id, historical_author_name,
   historical_created_at, historical_updated_at, historical_quoted_text,
   parent_comment_id, idempotency_key, created_at, updated_at, version)
SELECT
  'linear:comment:' || valid.owner_user_id || ':' || valid.task_source_id || ':' || valid.source_comment_id,
  valid.task_id,
  NULL,
  valid.body,
  'linear',
  valid.source_record_id,
  valid.source_comment_id,
  valid.source_parent_comment_id,
  valid.author_name,
  valid.source_created_at,
  valid.source_updated_at,
  valid.quoted_text,
  'linear:comment:' || valid.owner_user_id || ':' || valid.task_source_id || ':' || roots.root_id,
  'linear:' || valid.source_comment_id,
  valid.source_created_at,
  valid.source_updated_at,
  1
FROM valid
JOIN roots ON roots.source_record_id = valid.source_record_id
  AND roots.child_id = valid.source_comment_id
WHERE valid.source_parent_comment_id IS NOT NULL
ON CONFLICT(task_id, source, source_comment_id)
  WHERE source_comment_id IS NOT NULL DO NOTHING;--> statement-breakpoint
INSERT INTO comment_migration_outcomes
  (id, task_id, source, source_record_id, source_comment_id, source_index,
   outcome, reason, comment_id, raw_json, reconciled_at)
SELECT
  'linear:comment-outcome:' || staged.source_record_id || ':' || staged.source_index,
  staged.task_id,
  'linear',
  staged.source_record_id,
  staged.source_comment_id,
  staged.source_index,
  CASE WHEN comment.id IS NULL THEN 'exception' ELSE 'migrated' END,
  CASE
    WHEN staged.basic_error IS NOT NULL THEN staged.basic_error
    WHEN (
      SELECT COUNT(*) FROM __migration_0022_external_comments duplicate
      WHERE duplicate.source_record_id = staged.source_record_id
        AND duplicate.source_comment_id = staged.source_comment_id
        AND duplicate.basic_error IS NULL
    ) > 1 THEN 'duplicate_source_comment_id'
    WHEN comment.id IS NULL THEN 'invalid_parent_topology'
    WHEN staged.author_name = 'Unknown Linear user'
      AND staged.source_parent_comment_id IS NOT NULL
      AND comment.parent_comment_id <> (
        SELECT parent.id FROM comments parent
        WHERE parent.source_record_id = staged.source_record_id
          AND parent.source_comment_id = staged.source_parent_comment_id
      ) THEN 'author_name_missing,nested_reply_flattened'
    WHEN staged.author_name = 'Unknown Linear user' THEN 'author_name_missing'
    WHEN staged.source_parent_comment_id IS NOT NULL
      AND comment.parent_comment_id <> (
        SELECT parent.id FROM comments parent
        WHERE parent.source_record_id = staged.source_record_id
          AND parent.source_comment_id = staged.source_parent_comment_id
      ) THEN 'nested_reply_flattened'
    ELSE NULL
  END,
  comment.id,
  staged.raw_json,
  COALESCE((SELECT imported_at FROM external_records WHERE id = staged.source_record_id), CURRENT_TIMESTAMP)
FROM __migration_0022_external_comments staged
LEFT JOIN comments comment
  ON comment.task_id = staged.task_id
 AND comment.source = 'linear'
 AND comment.source_comment_id = staged.source_comment_id
ON CONFLICT(source_record_id, source_index) DO UPDATE SET
  source_comment_id = excluded.source_comment_id,
  outcome = excluded.outcome,
  reason = excluded.reason,
  comment_id = excluded.comment_id,
  raw_json = excluded.raw_json,
  reconciled_at = excluded.reconciled_at;--> statement-breakpoint
UPDATE tasks SET comment_count = (
  SELECT COUNT(*) FROM comments
  WHERE comments.task_id = tasks.id AND comments.deleted_at IS NULL
)
WHERE id IN (SELECT DISTINCT task_id FROM __migration_0022_external_comments);--> statement-breakpoint
DROP TABLE `__migration_0022_external_comments`;--> statement-breakpoint
CREATE TRIGGER `comments_historical_facts_immutable`
BEFORE UPDATE OF body, author_user_id, source, source_record_id,
  source_comment_id, source_parent_comment_id, historical_author_name,
  historical_created_at, historical_updated_at, historical_quoted_text,
  parent_comment_id, idempotency_key, created_at, deleted_at
ON `comments`
WHEN OLD.source <> 'native' AND (
  NEW.body IS NOT OLD.body OR
  NEW.author_user_id IS NOT OLD.author_user_id OR
  NEW.source IS NOT OLD.source OR
  NEW.source_record_id IS NOT OLD.source_record_id OR
  NEW.source_comment_id IS NOT OLD.source_comment_id OR
  NEW.source_parent_comment_id IS NOT OLD.source_parent_comment_id OR
  NEW.historical_author_name IS NOT OLD.historical_author_name OR
  NEW.historical_created_at IS NOT OLD.historical_created_at OR
  NEW.historical_updated_at IS NOT OLD.historical_updated_at OR
  NEW.historical_quoted_text IS NOT OLD.historical_quoted_text OR
  NEW.parent_comment_id IS NOT OLD.parent_comment_id OR
  NEW.idempotency_key IS NOT OLD.idempotency_key OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.deleted_at IS NOT OLD.deleted_at
)
BEGIN
  SELECT RAISE(ABORT, 'historical comment facts are immutable');
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
END;
