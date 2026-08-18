UPDATE access_grants
SET revoked_at = CURRENT_TIMESTAMP
WHERE revoked_at IS NULL
  AND resource_type = 'saved_view'
  AND EXISTS (
    SELECT 1
    FROM saved_views
    WHERE saved_views.id = access_grants.resource_id
      AND saved_views.scope_project_id IS NOT NULL
  );
