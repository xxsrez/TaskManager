ALTER TABLE `workflow_statuses` ADD `system_role` text;--> statement-breakpoint
ALTER TABLE `workflow_statuses` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `workflow_statuses` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `workflow_statuses`
SET `name` = 'Duplicate', `category` = 'canceled', `system_role` = 'duplicate',
    `is_default` = 0, `archived_at` = NULL, `version` = `version` + 1,
    `updated_at` = CURRENT_TIMESTAMP
WHERE `id` IN (
  SELECT candidate.id FROM workflow_statuses candidate
  WHERE lower(candidate.name) = 'duplicate'
    AND candidate.id = (
      SELECT preferred.id FROM workflow_statuses preferred
      WHERE preferred.owner_user_id = candidate.owner_user_id
        AND lower(preferred.name) = 'duplicate'
      ORDER BY CASE WHEN preferred.name = 'Duplicate' THEN 0 ELSE 1 END,
        preferred.position, preferred.id
      LIMIT 1
    )
);--> statement-breakpoint
INSERT INTO `workflow_statuses`
  (`id`, `owner_user_id`, `name`, `category`, `color`, `position`,
   `is_default`, `system_role`, `archived_at`, `version`)
SELECT 'status:' || users.id || ':duplicate', users.id, 'Duplicate', 'canceled',
  '#9ca3af', COALESCE(MAX(statuses.position), -1) + 1, 0, 'duplicate', NULL, 1
FROM users
LEFT JOIN workflow_statuses statuses ON statuses.owner_user_id = users.id
WHERE NOT EXISTS (
  SELECT 1 FROM workflow_statuses existing
  WHERE existing.owner_user_id = users.id AND existing.system_role = 'duplicate'
)
GROUP BY users.id;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflow_statuses_owner_system_role` ON `workflow_statuses` (`owner_user_id`,`system_role`);--> statement-breakpoint
CREATE TRIGGER `workspace_sync_statuses_insert`
AFTER INSERT ON `workflow_statuses`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT NEW.owner_user_id AS audience_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.owner_user_id = NEW.owner_user_id
        AND ag.resource_type IN ('project', 'task') AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'workspace', NEW.id, 'reset'
  FROM (
    SELECT NEW.owner_user_id AS audience_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.owner_user_id = NEW.owner_user_id
        AND ag.resource_type IN ('project', 'task') AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_statuses_update`
AFTER UPDATE ON `workflow_statuses`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT NEW.owner_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.owner_user_id IN (OLD.owner_user_id, NEW.owner_user_id)
        AND ag.resource_type IN ('project', 'task') AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'workspace', NEW.id, 'reset'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT NEW.owner_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.owner_user_id IN (OLD.owner_user_id, NEW.owner_user_id)
        AND ag.resource_type IN ('project', 'task') AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;--> statement-breakpoint
CREATE TRIGGER `workspace_sync_statuses_delete`
AFTER DELETE ON `workflow_statuses`
BEGIN
  INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
  SELECT audience_user_id, 1 FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.owner_user_id = OLD.owner_user_id
        AND ag.resource_type IN ('project', 'task') AND ag.revoked_at IS NULL
  ) WHERE audience_user_id IS NOT NULL
  ON CONFLICT(audience_user_id) DO UPDATE SET last_sequence = last_sequence + 1;
  INSERT INTO workspace_change_events
    (audience_user_id, sequence, entity_type, entity_id, operation)
  SELECT audience_user_id, sequence.last_sequence, 'workspace', OLD.id, 'reset'
  FROM (
    SELECT OLD.owner_user_id AS audience_user_id
    UNION SELECT ag.grantee_user_id FROM access_grants ag
      WHERE ag.owner_user_id = OLD.owner_user_id
        AND ag.resource_type IN ('project', 'task') AND ag.revoked_at IS NULL
  ) audience
  JOIN workspace_sync_sequences sequence USING (audience_user_id);
END;
