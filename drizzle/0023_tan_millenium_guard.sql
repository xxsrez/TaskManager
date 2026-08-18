CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`event_type` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`actor_name` text NOT NULL,
	`payload_json` text NOT NULL,
	`source` text DEFAULT 'native' NOT NULL,
	`source_record_id` text,
	`source_event_id` text,
	`source_index` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "check_activity_event_actor" CHECK((
        ("activity_events"."actor_kind" = 'user' AND "activity_events"."actor_user_id" IS NOT NULL)
        OR
        ("activity_events"."actor_kind" IN ('historical', 'system') AND "activity_events"."actor_user_id" IS NULL)
      )),
	CONSTRAINT "check_activity_event_source" CHECK((
        ("activity_events"."source" = 'native' AND "activity_events"."actor_kind" IN ('user', 'system')
          AND "activity_events"."source_record_id" IS NULL AND "activity_events"."source_event_id" IS NULL
          AND "activity_events"."source_index" IS NULL)
        OR
        ("activity_events"."source" = 'linear' AND "activity_events"."source_record_id" IS NOT NULL
          AND "activity_events"."source_index" IS NOT NULL AND "activity_events"."actor_kind" = 'historical'
          AND "activity_events"."actor_user_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE INDEX `idx_activity_events_task_created` ON `activity_events` (`task_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_activity_events_source_position` ON `activity_events` (`source_record_id`,`source_index`) WHERE "activity_events"."source_record_id" IS NOT NULL AND "activity_events"."source_index" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `activity_migration_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`source` text NOT NULL,
	`source_record_id` text NOT NULL,
	`source_event_id` text,
	`source_index` integer NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`activity_event_id` text,
	`raw_json` text NOT NULL,
	`reconciled_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_record_id`) REFERENCES `external_records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`activity_event_id`) REFERENCES `activity_events`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "check_activity_migration_outcome" CHECK("activity_migration_outcomes"."outcome" IN ('migrated', 'exception'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_activity_migration_source_position` ON `activity_migration_outcomes` (`source_record_id`,`source_index`);--> statement-breakpoint
CREATE INDEX `idx_activity_migration_task_outcome` ON `activity_migration_outcomes` (`task_id`,`outcome`);--> statement-breakpoint
CREATE TABLE `__migration_0023_linear_activity` AS
WITH linear_history AS (
  SELECT
    er.id AS source_record_id,
    er.target_id AS task_id,
    CAST(history.key AS INTEGER) AS source_index,
    history.type AS entry_type,
    CASE WHEN history.type = 'object' THEN history.value ELSE '{}' END AS object_json,
    CASE history.type
      WHEN 'text' THEN json_quote(history.value)
      WHEN 'true' THEN 'true'
      WHEN 'false' THEN 'false'
      WHEN 'null' THEN 'null'
      ELSE CAST(history.value AS text)
    END AS raw_json,
    er.imported_at AS reconciled_at
  FROM external_records er
  JOIN json_each(
    CASE
      WHEN json_valid(er.metadata_json)
        AND json_type(er.metadata_json, '$.stateHistory') = 'array'
      THEN json_extract(er.metadata_json, '$.stateHistory')
      ELSE '[]'
    END
  ) history
  WHERE er.source = 'linear' AND er.target_type = 'task'
)
SELECT
  source_record_id,
  task_id,
  source_index,
  CASE
    WHEN json_type(object_json, '$.id') = 'text'
      AND length(trim(json_extract(object_json, '$.id'))) BETWEEN 1 AND 500
    THEN trim(json_extract(object_json, '$.id'))
  END AS source_event_id,
  COALESCE(
    CASE WHEN json_type(object_json, '$.state.name') = 'text'
      AND length(trim(json_extract(object_json, '$.state.name'))) BETWEEN 1 AND 500
      THEN trim(json_extract(object_json, '$.state.name')) END,
    CASE WHEN json_type(object_json, '$.toState.name') = 'text'
      AND length(trim(json_extract(object_json, '$.toState.name'))) BETWEEN 1 AND 500
      THEN trim(json_extract(object_json, '$.toState.name')) END,
    CASE WHEN json_type(object_json, '$.to.name') = 'text'
      AND length(trim(json_extract(object_json, '$.to.name'))) BETWEEN 1 AND 500
      THEN trim(json_extract(object_json, '$.to.name')) END
  ) AS state_name,
  COALESCE(
    CASE WHEN json_type(object_json, '$.fromState.name') = 'text'
      AND length(trim(json_extract(object_json, '$.fromState.name'))) BETWEEN 1 AND 500
      THEN trim(json_extract(object_json, '$.fromState.name')) END,
    CASE WHEN json_type(object_json, '$.from.name') = 'text'
      AND length(trim(json_extract(object_json, '$.from.name'))) BETWEEN 1 AND 500
      THEN trim(json_extract(object_json, '$.from.name')) END,
    CASE WHEN json_type(object_json, '$.previousState.name') = 'text'
      AND length(trim(json_extract(object_json, '$.previousState.name'))) BETWEEN 1 AND 500
      THEN trim(json_extract(object_json, '$.previousState.name')) END
  ) AS previous_state_name,
  COALESCE(
    CASE WHEN json_type(object_json, '$.actor.name') = 'text'
      AND length(trim(json_extract(object_json, '$.actor.name'))) BETWEEN 1 AND 500
      THEN trim(json_extract(object_json, '$.actor.name')) END,
    CASE WHEN json_type(object_json, '$.user.name') = 'text'
      AND length(trim(json_extract(object_json, '$.user.name'))) BETWEEN 1 AND 500
      THEN trim(json_extract(object_json, '$.user.name')) END,
    CASE WHEN json_type(object_json, '$.creator.name') = 'text'
      AND length(trim(json_extract(object_json, '$.creator.name'))) BETWEEN 1 AND 500
      THEN trim(json_extract(object_json, '$.creator.name')) END,
    'Unknown Linear user'
  ) AS actor_name,
  COALESCE(
    CASE WHEN json_type(object_json, '$.createdAt') = 'text'
      THEN json_extract(object_json, '$.createdAt') END,
    CASE WHEN json_type(object_json, '$.updatedAt') = 'text'
      THEN json_extract(object_json, '$.updatedAt') END,
    CASE WHEN json_type(object_json, '$.timestamp') = 'text'
      THEN json_extract(object_json, '$.timestamp') END
  ) AS source_timestamp,
  raw_json,
  reconciled_at,
  CASE
    WHEN entry_type <> 'object' THEN 'activity_not_object'
    WHEN COALESCE(
      CASE WHEN json_type(object_json, '$.state.name') = 'text'
        AND length(trim(json_extract(object_json, '$.state.name'))) BETWEEN 1 AND 500
        THEN trim(json_extract(object_json, '$.state.name')) END,
      CASE WHEN json_type(object_json, '$.toState.name') = 'text'
        AND length(trim(json_extract(object_json, '$.toState.name'))) BETWEEN 1 AND 500
        THEN trim(json_extract(object_json, '$.toState.name')) END,
      CASE WHEN json_type(object_json, '$.to.name') = 'text'
        AND length(trim(json_extract(object_json, '$.to.name'))) BETWEEN 1 AND 500
        THEN trim(json_extract(object_json, '$.to.name')) END
    ) IS NULL THEN 'status_name_missing'
    WHEN COALESCE(
      CASE WHEN json_type(object_json, '$.createdAt') = 'text'
        THEN json_extract(object_json, '$.createdAt') END,
      CASE WHEN json_type(object_json, '$.updatedAt') = 'text'
        THEN json_extract(object_json, '$.updatedAt') END,
      CASE WHEN json_type(object_json, '$.timestamp') = 'text'
        THEN json_extract(object_json, '$.timestamp') END
    ) IS NULL THEN 'activity_timestamp_missing'
    WHEN length(COALESCE(
      json_extract(object_json, '$.createdAt'),
      json_extract(object_json, '$.updatedAt'),
      json_extract(object_json, '$.timestamp')
    )) NOT BETWEEN 1 AND 100 OR julianday(COALESCE(
      json_extract(object_json, '$.createdAt'),
      json_extract(object_json, '$.updatedAt'),
      json_extract(object_json, '$.timestamp')
    )) IS NULL THEN 'activity_timestamp_invalid'
    ELSE NULL
  END AS basic_error
FROM linear_history;--> statement-breakpoint
INSERT INTO activity_migration_outcomes
  (id, task_id, source, source_record_id, source_event_id, source_index,
   outcome, reason, activity_event_id, raw_json, reconciled_at)
SELECT
  'linear:activity-outcome:' || er.id || ':-1',
  er.target_id,
  'linear',
  er.id,
  NULL,
  -1,
  'exception',
  'invalid_activity_collection',
  NULL,
  CASE json_type(er.metadata_json, '$.stateHistory')
    WHEN 'text' THEN json_quote(json_extract(er.metadata_json, '$.stateHistory'))
    WHEN 'true' THEN 'true'
    WHEN 'false' THEN 'false'
    WHEN 'null' THEN 'null'
    ELSE COALESCE(CAST(json_extract(er.metadata_json, '$.stateHistory') AS text), 'null')
  END,
  er.imported_at
FROM external_records er
WHERE er.source = 'linear' AND er.target_type = 'task'
  AND json_valid(er.metadata_json)
  AND json_type(er.metadata_json, '$.stateHistory') IS NOT NULL
  AND json_type(er.metadata_json, '$.stateHistory') <> 'array';--> statement-breakpoint
INSERT INTO activity_events
  (id, task_id, schema_version, event_type, actor_kind, actor_user_id,
   actor_name, payload_json, source, source_record_id, source_event_id,
   source_index, created_at)
SELECT
  'linear:activity:' || source_record_id || ':' || source_index,
  task_id,
  1,
  'status_changed',
  'historical',
  NULL,
  actor_name,
  json_object(
    'changes', json_object(
      'status', json_object('before', previous_state_name, 'after', state_name)
    ),
    'sourceTimestamp', source_timestamp
  ),
  'linear',
  source_record_id,
  source_event_id,
  source_index,
  strftime('%Y-%m-%dT%H:%M:%fZ', source_timestamp)
FROM __migration_0023_linear_activity
WHERE basic_error IS NULL
ON CONFLICT(source_record_id, source_index)
  WHERE source_record_id IS NOT NULL AND source_index IS NOT NULL DO NOTHING;--> statement-breakpoint
INSERT INTO activity_migration_outcomes
  (id, task_id, source, source_record_id, source_event_id, source_index,
   outcome, reason, activity_event_id, raw_json, reconciled_at)
SELECT
  'linear:activity-outcome:' || staged.source_record_id || ':' || staged.source_index,
  staged.task_id,
  'linear',
  staged.source_record_id,
  staged.source_event_id,
  staged.source_index,
  CASE WHEN event.id IS NULL THEN 'exception' ELSE 'migrated' END,
  CASE
    WHEN staged.basic_error IS NOT NULL THEN staged.basic_error
    WHEN staged.actor_name = 'Unknown Linear user' THEN 'actor_name_missing'
    ELSE NULL
  END,
  event.id,
  staged.raw_json,
  staged.reconciled_at
FROM __migration_0023_linear_activity staged
LEFT JOIN activity_events event
  ON event.source_record_id = staged.source_record_id
 AND event.source_index = staged.source_index
ON CONFLICT(source_record_id, source_index) DO UPDATE SET
  source_event_id = excluded.source_event_id,
  outcome = excluded.outcome,
  reason = excluded.reason,
  activity_event_id = excluded.activity_event_id,
  raw_json = excluded.raw_json,
  reconciled_at = excluded.reconciled_at;--> statement-breakpoint
DROP TABLE `__migration_0023_linear_activity`;--> statement-breakpoint
CREATE TRIGGER `activity_events_immutable`
BEFORE UPDATE ON `activity_events`
BEGIN
  SELECT RAISE(ABORT, 'activity events are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_activity_insert`
AFTER INSERT ON `activity_events`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (NEW.task_id, 'task_activity');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_activity_delete`
AFTER DELETE ON `activity_events`
BEGIN
  INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
  VALUES (OLD.task_id, 'task_activity');
END;
