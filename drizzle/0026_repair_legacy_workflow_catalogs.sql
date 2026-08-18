WITH legacy_users AS (
  SELECT users.id
  FROM users
  WHERE NOT EXISTS (
    SELECT 1 FROM workflow_statuses defaults
    WHERE defaults.owner_user_id = users.id AND defaults.is_default = 1
  )
    AND EXISTS (
      SELECT 1 FROM workflow_statuses duplicate
      WHERE duplicate.owner_user_id = users.id
        AND duplicate.system_role = 'duplicate'
    )
    AND NOT EXISTS (
      SELECT 1 FROM workflow_statuses ordinary
      WHERE ordinary.owner_user_id = users.id
        AND ordinary.system_role IS NULL
    )
)
INSERT INTO workflow_statuses
  (id, owner_user_id, name, category, color, position, is_default,
   system_role, archived_at, version)
SELECT 'status:' || id || ':backlog', id, 'Backlog', 'backlog', '#6b7280', 0, 0,
  NULL, NULL, 1 FROM legacy_users
UNION ALL
SELECT 'status:' || id || ':unstarted', id, 'Todo', 'unstarted', '#94a3b8', 1, 1,
  NULL, NULL, 1 FROM legacy_users
UNION ALL
SELECT 'status:' || id || ':started', id, 'In Progress', 'started', '#f59e0b', 2, 0,
  NULL, NULL, 1 FROM legacy_users
UNION ALL
SELECT 'status:' || id || ':completed', id, 'Done', 'completed', '#22c55e', 3, 0,
  NULL, NULL, 1 FROM legacy_users
UNION ALL
SELECT 'status:' || id || ':canceled', id, 'Canceled', 'canceled', '#ef4444', 4, 0,
  NULL, NULL, 1 FROM legacy_users;
