import { getD1 } from "@/db";
import { ValidationError } from "./domain";
import { maxSystemBackupRowBytes } from "./system-backup-package";
import {
  systemBackupExactTableContracts,
  type BackupColumnShape,
} from "./system-backup-contract";

type SystemBackupValidationStep = () => Promise<void>;

export interface SystemBackupValidationProgress {
  nextStepIndex: number;
  complete: boolean;
}

export async function validateSystemBackupStagedState(
  jobId: string,
  claimedCounts: Record<string, number>,
  currentAdminUserId: string,
) {
  for (const step of systemBackupStagedValidationSteps(
    jobId,
    claimedCounts,
    currentAdminUserId,
  )) {
    await step();
  }
}

export async function validateSystemBackupStagedStateStep(
  jobId: string,
  claimedCounts: Record<string, number>,
  currentAdminUserId: string,
  stepIndex: number,
): Promise<SystemBackupValidationProgress> {
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new ValidationError("Invalid system backup preflight cursor");
  }
  const steps = [...systemBackupStagedValidationSteps(
    jobId,
    claimedCounts,
    currentAdminUserId,
  )];
  if (stepIndex >= steps.length) {
    throw new ValidationError("Invalid system backup preflight cursor");
  }
  await steps[stepIndex]!();
  const nextStepIndex = stepIndex + 1;
  return {
    nextStepIndex,
    complete: nextStepIndex >= steps.length,
  };
}

function* systemBackupStagedValidationSteps(
  jobId: string,
  claimedCounts: Record<string, number>,
  currentAdminUserId: string,
): Generator<SystemBackupValidationStep, void, void> {
  const db = getD1();
  for (const table of systemBackupExactTableContracts) {
    yield async () => {
      const actual = await db.prepare(`SELECT COUNT(*) AS count
        FROM system_backup_rows WHERE job_id = ? AND table_name = ?`)
        .bind(jobId, table.name).first<{ count: number }>();
      if (!actual || Number(actual.count) !== claimedCounts[table.name]) {
        throw new ValidationError(`Count mismatch for ${table.name}`);
      }
    };
    yield () => validateRowShape(jobId, table.name, table.columns, table.shapes ?? {});
  }

  yield () => assertUnique(jobId, "users", ["id"]);
  yield () => assertUnique(jobId, "user_identities", ["provider", "provider_account_key"]);
  yield () => assertUnique(jobId, "workflow_statuses", ["id"]);
  yield () => assertUnique(jobId, "workflow_statuses", ["owner_user_id", "name"]);
  yield () => assertUnique(jobId, "projects", ["id"]);
  yield () => assertUnique(jobId, "projects", ["public_id"]);
  yield () => assertUnique(jobId, "releases", ["id"]);
  yield () => assertUnique(jobId, "releases", ["public_id"]);
  yield () => assertUnique(jobId, "tasks", ["id"]);
  yield () => assertUnique(jobId, "tasks", ["public_id"]);
  yield () => assertUnique(jobId, "tasks", ["project_id", "sequence_number"]);
  yield () => assertUnique(jobId, "task_identifier_aliases", ["id"]);
  yield () => assertUnique(jobId, "task_identifier_aliases", ["task_id", "identifier"]);
  yield () => assertUnique(jobId, "stored_files", ["id"]);
  yield () => assertUnique(jobId, "stored_files", ["public_id"]);
  yield () => assertUnique(jobId, "stored_files", ["object_key"]);
  yield () => assertUnique(jobId, "attachments", ["id"]);
  yield () => assertUnique(jobId, "attachments", ["public_id"]);
  yield () => assertUnique(jobId, "attachments", ["object_key"]);
  yield () => assertUnique(jobId, "attachments", ["stored_file_id"], true);
  yield () => assertUnique(jobId, "comments", ["id"]);
  yield () => assertUnique(jobId, "comment_reactions", ["comment_id", "user_id", "emoji"]);
  yield () => assertUnique(jobId, "comment_attachment_refs", ["comment_id", "attachment_id"]);
  yield () => assertUnique(jobId, "activity_events", ["id"]);
  yield () => assertUnique(jobId, "label_groups", ["id"]);
  yield () => assertUnique(jobId, "labels", ["id"]);
  yield () => assertUnique(jobId, "task_labels", ["task_id", "label_id"]);
  yield () => assertUnique(jobId, "task_relations", ["id"]);
  yield () => assertUnique(jobId, "task_relations", ["source_task_id", "target_task_id", "type"]);
  yield () => assertUnique(jobId, "task_relations", ["creator_user_id", "idempotency_key"]);
  yield () => assertUnique(jobId, "saved_views", ["id"]);
  yield () => assertUnique(jobId, "saved_views", ["public_id"]);
  yield () => assertUnique(jobId, "external_records", ["id"]);
  yield () => assertUnique(jobId, "access_grants", ["id"]);
  yield () => assertUnique(jobId, "access_grants", ["resource_type", "resource_id", "grantee_user_id"]);
  yield () => assertUnique(jobId, "task_sequences", ["owner_user_id"]);

  yield () => assertNoRows(jobId, "administrator identity", `
    SELECT 1
    WHERE NOT EXISTS (
      SELECT 1 FROM system_backup_rows imported
      JOIN user_identities live
        ON live.user_id = ?
       AND json_extract(imported.row_json, '$.provider') = live.provider
       AND json_extract(imported.row_json, '$.provider_account_key') = live.provider_account_key
      WHERE imported.job_id = ? AND imported.table_name = 'user_identities'
    )`, [currentAdminUserId, jobId], false);

  yield () => assertNoRows(jobId, "identity user", referenceQuery("user_identities", "user_id", "users", "id"));
  yield () => assertNoRows(jobId, "workflow owner", referenceQuery("workflow_statuses", "owner_user_id", "users", "id"));
  yield () => assertNoRows(jobId, "Project users", `
    SELECT 1 FROM system_backup_rows p
    WHERE p.job_id = ? AND p.table_name = 'projects' AND (
      NOT ${hasRef("users", "id", "json_extract(p.row_json, '$.owner_user_id')")}
      OR NOT ${hasRef("users", "id", "json_extract(p.row_json, '$.creator_user_id')")}
      OR (json_extract(p.row_json, '$.lead_user_id') IS NOT NULL
          AND NOT ${hasRef("users", "id", "json_extract(p.row_json, '$.lead_user_id')")})
    ) LIMIT 1`);
  yield () => assertNoRows(jobId, "Project code and deletion state", `
    SELECT 1 FROM system_backup_rows p
    WHERE p.job_id = ? AND p.table_name = 'projects' AND (
      length(json_extract(p.row_json, '$.task_code')) NOT BETWEEN 1 AND 12
      OR json_extract(p.row_json, '$.task_code') != upper(json_extract(p.row_json, '$.task_code'))
      OR json_extract(p.row_json, '$.task_code') GLOB '*[^A-Z0-9-]*'
      OR json_extract(p.row_json, '$.task_code') LIKE '-%'
      OR json_extract(p.row_json, '$.task_code') LIKE '%-'
      OR ${invalidDeletionTuple("p")}
    ) LIMIT 1`);
  yield () => assertNoRows(jobId, "active Project code", `
    SELECT 1 FROM system_backup_rows p
    JOIN system_backup_rows other
      ON other.job_id = p.job_id AND other.table_name = 'projects'
     AND other.ordinal > p.ordinal
     AND json_extract(other.row_json, '$.owner_user_id') = json_extract(p.row_json, '$.owner_user_id')
     AND json_extract(other.row_json, '$.task_code') = json_extract(p.row_json, '$.task_code')
     AND json_extract(other.row_json, '$.archived_at') IS NULL
    WHERE p.job_id = ? AND p.table_name = 'projects'
      AND json_extract(p.row_json, '$.archived_at') IS NULL LIMIT 1`);

  yield () => assertNoRows(jobId, "Release references", `
    SELECT 1 FROM system_backup_rows r
    WHERE r.job_id = ? AND r.table_name = 'releases' AND (
      NOT ${hasRef("projects", "id", "json_extract(r.row_json, '$.project_id')")}
      OR NOT ${hasRef("users", "id", "json_extract(r.row_json, '$.owner_user_id')")}
      OR NOT ${hasRef("users", "id", "json_extract(r.row_json, '$.creator_user_id')")}
      OR json_extract(r.row_json, '$.owner_user_id') != (
        SELECT json_extract(p.row_json, '$.owner_user_id') FROM system_backup_rows p
        WHERE p.job_id = r.job_id AND p.table_name = 'projects'
          AND json_extract(p.row_json, '$.id') = json_extract(r.row_json, '$.project_id'))
      OR ${invalidDeletionTuple("r")}
    ) LIMIT 1`);

  yield () => assertNoRows(jobId, "Task references and invariants", `
    SELECT 1 FROM system_backup_rows t
    WHERE t.job_id = ? AND t.table_name = 'tasks' AND (
      trim(json_extract(t.row_json, '$.title')) = ''
      OR NOT ${hasRef("users", "id", "json_extract(t.row_json, '$.owner_user_id')")}
      OR NOT ${hasRef("users", "id", "json_extract(t.row_json, '$.creator_user_id')")}
      OR (json_extract(t.row_json, '$.assignee_user_id') IS NOT NULL
          AND NOT ${hasRef("users", "id", "json_extract(t.row_json, '$.assignee_user_id')")})
      OR NOT ${hasRef("projects", "id", "json_extract(t.row_json, '$.project_id')")}
      OR NOT ${hasRef("workflow_statuses", "id", "json_extract(t.row_json, '$.status_id')")}
      OR (json_extract(t.row_json, '$.release_id') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM system_backup_rows r WHERE r.job_id = t.job_id
          AND r.table_name = 'releases'
          AND json_extract(r.row_json, '$.id') = json_extract(t.row_json, '$.release_id')
          AND json_extract(r.row_json, '$.project_id') = json_extract(t.row_json, '$.project_id')))
      OR (json_extract(t.row_json, '$.parent_task_id') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM system_backup_rows parent WHERE parent.job_id = t.job_id
          AND parent.table_name = 'tasks'
          AND json_extract(parent.row_json, '$.id') = json_extract(t.row_json, '$.parent_task_id')
          AND json_extract(parent.row_json, '$.project_id') = json_extract(t.row_json, '$.project_id')))
      OR json_extract(t.row_json, '$.identifier') != (
        SELECT json_extract(p.row_json, '$.task_code') || '-' || json_extract(t.row_json, '$.sequence_number')
        FROM system_backup_rows p WHERE p.job_id = t.job_id AND p.table_name = 'projects'
          AND json_extract(p.row_json, '$.id') = json_extract(t.row_json, '$.project_id'))
      OR ${invalidDeletionTuple("t")}
    ) LIMIT 1`);

  yield () => assertNoRows(jobId, "Task lifecycle timestamps", `
    SELECT 1 FROM system_backup_rows t
    JOIN system_backup_rows s ON s.job_id = t.job_id AND s.table_name = 'workflow_statuses'
      AND json_extract(s.row_json, '$.id') = json_extract(t.row_json, '$.status_id')
    WHERE t.job_id = ? AND t.table_name = 'tasks' AND (
      (json_extract(s.row_json, '$.category') = 'completed'
        AND (json_extract(t.row_json, '$.completed_at') IS NULL OR json_extract(t.row_json, '$.canceled_at') IS NOT NULL))
      OR (json_extract(s.row_json, '$.category') = 'canceled'
        AND (json_extract(t.row_json, '$.canceled_at') IS NULL OR json_extract(t.row_json, '$.completed_at') IS NOT NULL))
      OR (json_extract(s.row_json, '$.category') NOT IN ('completed', 'canceled')
        AND (json_extract(t.row_json, '$.completed_at') IS NOT NULL OR json_extract(t.row_json, '$.canceled_at') IS NOT NULL))
    ) LIMIT 1`);
  yield () => assertNoRows(jobId, "Task hierarchy cycle", `
    WITH RECURSIVE ancestry(root_id, current_id) AS (
      SELECT json_extract(row_json, '$.id'), json_extract(row_json, '$.parent_task_id')
      FROM system_backup_rows WHERE job_id = ? AND table_name = 'tasks'
        AND json_extract(row_json, '$.parent_task_id') IS NOT NULL
      UNION ALL
      SELECT ancestry.root_id, json_extract(parent.row_json, '$.parent_task_id')
      FROM ancestry JOIN system_backup_rows parent
        ON parent.job_id = ? AND parent.table_name = 'tasks'
       AND json_extract(parent.row_json, '$.id') = ancestry.current_id
      WHERE ancestry.current_id IS NOT NULL
    ) SELECT 1 FROM ancestry WHERE root_id = current_id LIMIT 1`, [jobId]);
  yield () => assertNoRows(jobId, "Project Task counter", `
    SELECT 1 FROM system_backup_rows p
    WHERE p.job_id = ? AND p.table_name = 'projects' AND (
      json_extract(p.row_json, '$.task_sequence') < COALESCE((
        SELECT MAX(json_extract(t.row_json, '$.sequence_number'))
        FROM system_backup_rows t WHERE t.job_id = p.job_id AND t.table_name = 'tasks'
          AND json_extract(t.row_json, '$.project_id') = json_extract(p.row_json, '$.id')
      ), 0)
      OR ((json_extract(p.row_json, '$.task_sequence') > 0) !=
          (json_extract(p.row_json, '$.code_locked_at') IS NOT NULL))
    ) LIMIT 1`);

  yield () => assertNoRows(jobId, "StoredFile references and object slot", `
    SELECT 1 FROM system_backup_rows f
    WHERE f.job_id = ? AND f.table_name = 'stored_files' AND (
      NOT ${hasRef("users", "id", "json_extract(f.row_json, '$.uploader_user_id')")}
      OR json_extract(f.row_json, '$.byte_size') < 0
      OR length(json_extract(f.row_json, '$.checksum_sha256')) != 64
      OR json_extract(f.row_json, '$.state') NOT IN ('uploading', 'ready', 'failed', 'expired', 'deleted')
      OR (json_extract(f.row_json, '$.state') = 'ready' AND NOT EXISTS (
        SELECT 1 FROM system_backup_objects o WHERE o.job_id = f.job_id
          AND (o.logical_ref = json_extract(f.row_json, '$.object_key')
            OR o.source_object_key = json_extract(f.row_json, '$.object_key'))))
      OR EXISTS (SELECT 1 FROM system_backup_objects o
        WHERE o.job_id = f.job_id
          AND (o.logical_ref = json_extract(f.row_json, '$.object_key')
            OR o.source_object_key = json_extract(f.row_json, '$.object_key'))
          AND (o.byte_size != json_extract(f.row_json, '$.byte_size')
            OR o.sha256 != json_extract(f.row_json, '$.checksum_sha256')))
    ) LIMIT 1`);
  yield () => assertNoRows(jobId, "Attachment references and object slot", `
    SELECT 1 FROM system_backup_rows a
    WHERE a.job_id = ? AND a.table_name = 'attachments' AND (
      NOT ${hasRef("tasks", "id", "json_extract(a.row_json, '$.task_id')")}
      OR NOT ${hasRef("users", "id", "json_extract(a.row_json, '$.uploader_user_id')")}
      OR json_extract(a.row_json, '$.byte_size') < 0
      OR length(json_extract(a.row_json, '$.checksum_sha256')) != 64
      OR json_extract(a.row_json, '$.state') NOT IN ('pending', 'uploading', 'ready', 'failed', 'deleted')
      OR (json_extract(a.row_json, '$.state') = 'ready' AND NOT EXISTS (
        SELECT 1 FROM system_backup_objects o WHERE o.job_id = a.job_id
          AND (o.logical_ref = json_extract(a.row_json, '$.object_key')
            OR o.source_object_key = json_extract(a.row_json, '$.object_key'))))
      OR EXISTS (SELECT 1 FROM system_backup_objects o
        WHERE o.job_id = a.job_id
          AND (o.logical_ref = json_extract(a.row_json, '$.object_key')
            OR o.source_object_key = json_extract(a.row_json, '$.object_key'))
          AND (o.byte_size != json_extract(a.row_json, '$.byte_size')
            OR o.sha256 != json_extract(a.row_json, '$.checksum_sha256')))
      OR (json_extract(a.row_json, '$.stored_file_id') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM system_backup_rows f WHERE f.job_id = a.job_id AND f.table_name = 'stored_files'
          AND json_extract(f.row_json, '$.id') = json_extract(a.row_json, '$.stored_file_id')
          AND json_extract(f.row_json, '$.object_key') = json_extract(a.row_json, '$.object_key')
          AND json_extract(f.row_json, '$.byte_size') = json_extract(a.row_json, '$.byte_size')
          AND json_extract(f.row_json, '$.checksum_sha256') = json_extract(a.row_json, '$.checksum_sha256')))
    ) LIMIT 1`);

  for (const [label, child, column, parent, parentColumn] of [
    ["task alias", "task_identifier_aliases", "task_id", "tasks", "id"],
    ["attachment migration task", "attachment_migration_outcomes", "task_id", "tasks", "id"],
    ["comment task", "comments", "task_id", "tasks", "id"],
    ["comment migration task", "comment_migration_outcomes", "task_id", "tasks", "id"],
    ["activity task", "activity_events", "task_id", "tasks", "id"],
    ["activity migration task", "activity_migration_outcomes", "task_id", "tasks", "id"],
    ["reaction comment", "comment_reactions", "comment_id", "comments", "id"],
    ["reaction user", "comment_reactions", "user_id", "users", "id"],
    ["comment attachment comment", "comment_attachment_refs", "comment_id", "comments", "id"],
    ["comment attachment task", "comment_attachment_refs", "task_id", "tasks", "id"],
    ["comment attachment attachment", "comment_attachment_refs", "attachment_id", "attachments", "id"],
    ["label group owner", "label_groups", "owner_user_id", "users", "id"],
    ["label owner", "labels", "owner_user_id", "users", "id"],
    ["task label task", "task_labels", "task_id", "tasks", "id"],
    ["task label label", "task_labels", "label_id", "labels", "id"],
    ["relation source", "task_relations", "source_task_id", "tasks", "id"],
    ["relation target", "task_relations", "target_task_id", "tasks", "id"],
    ["relation creator", "task_relations", "creator_user_id", "users", "id"],
    ["view owner", "saved_views", "owner_user_id", "users", "id"],
    ["external owner", "external_records", "owner_user_id", "users", "id"],
    ["grant owner", "access_grants", "owner_user_id", "users", "id"],
    ["grant grantee", "access_grants", "grantee_user_id", "users", "id"],
    ["grant actor", "access_grants", "granted_by_user_id", "users", "id"],
    ["task sequence owner", "task_sequences", "owner_user_id", "users", "id"],
  ] as const) {
    yield () => assertNoRows(jobId, label, referenceQuery(child, column, parent, parentColumn));
  }

  yield () => assertNoRows(jobId, "Label group owner mismatch", `
    SELECT 1 FROM system_backup_rows l JOIN system_backup_rows g
      ON g.job_id = l.job_id AND g.table_name = 'label_groups'
     AND json_extract(g.row_json, '$.id') = json_extract(l.row_json, '$.group_id')
    WHERE l.job_id = ? AND l.table_name = 'labels'
      AND json_extract(l.row_json, '$.group_id') IS NOT NULL
      AND json_extract(l.row_json, '$.owner_user_id') != json_extract(g.row_json, '$.owner_user_id') LIMIT 1`);
  yield () => assertNoRows(jobId, "Task Label catalog mismatch", `
    SELECT 1 FROM system_backup_rows tl
    JOIN system_backup_rows t ON t.job_id = tl.job_id AND t.table_name = 'tasks'
      AND json_extract(t.row_json, '$.id') = json_extract(tl.row_json, '$.task_id')
    JOIN system_backup_rows l ON l.job_id = tl.job_id AND l.table_name = 'labels'
      AND json_extract(l.row_json, '$.id') = json_extract(tl.row_json, '$.label_id')
    WHERE tl.job_id = ? AND tl.table_name = 'task_labels'
      AND json_extract(t.row_json, '$.owner_user_id') != json_extract(l.row_json, '$.owner_user_id') LIMIT 1`);
  yield () => assertNoRows(jobId, "Task Label Group exclusivity", `
    SELECT 1 FROM system_backup_rows first
    JOIN system_backup_rows l1 ON l1.job_id = first.job_id AND l1.table_name = 'labels'
      AND json_extract(l1.row_json, '$.id') = json_extract(first.row_json, '$.label_id')
    JOIN system_backup_rows second ON second.job_id = first.job_id AND second.table_name = 'task_labels'
      AND second.ordinal > first.ordinal
      AND json_extract(second.row_json, '$.task_id') = json_extract(first.row_json, '$.task_id')
    JOIN system_backup_rows l2 ON l2.job_id = second.job_id AND l2.table_name = 'labels'
      AND json_extract(l2.row_json, '$.id') = json_extract(second.row_json, '$.label_id')
    WHERE first.job_id = ? AND first.table_name = 'task_labels'
      AND json_extract(l1.row_json, '$.group_id') IS NOT NULL
      AND json_extract(l1.row_json, '$.group_id') = json_extract(l2.row_json, '$.group_id') LIMIT 1`);

  yield () => assertNoRows(jobId, "Task relation invariant", `
    SELECT 1 FROM system_backup_rows r
    JOIN system_backup_rows source ON source.job_id = r.job_id AND source.table_name = 'tasks'
      AND json_extract(source.row_json, '$.id') = json_extract(r.row_json, '$.source_task_id')
    JOIN system_backup_rows target ON target.job_id = r.job_id AND target.table_name = 'tasks'
      AND json_extract(target.row_json, '$.id') = json_extract(r.row_json, '$.target_task_id')
    WHERE r.job_id = ? AND r.table_name = 'task_relations' AND (
      json_extract(r.row_json, '$.source_task_id') = json_extract(r.row_json, '$.target_task_id')
      OR json_extract(source.row_json, '$.project_id') != json_extract(target.row_json, '$.project_id')
      OR json_extract(r.row_json, '$.type') NOT IN ('blocks', 'related', 'duplicate_of')) LIMIT 1`);
  yield () => assertNoRows(jobId, "Task relation topology", `
    SELECT 1 FROM system_backup_rows r
    WHERE r.job_id = ? AND r.table_name = 'task_relations' AND (
      (json_extract(r.row_json, '$.type') = 'related'
        AND json_extract(r.row_json, '$.source_task_id') > json_extract(r.row_json, '$.target_task_id'))
      OR (json_extract(r.row_json, '$.type') = 'blocks' AND EXISTS (
        SELECT 1 FROM system_backup_rows other WHERE other.job_id = r.job_id
          AND other.table_name = 'task_relations' AND other.ordinal != r.ordinal
          AND json_extract(other.row_json, '$.type') = 'blocks'
          AND json_extract(other.row_json, '$.source_task_id') = json_extract(r.row_json, '$.target_task_id')
          AND json_extract(other.row_json, '$.target_task_id') = json_extract(r.row_json, '$.source_task_id')))
      OR (json_extract(r.row_json, '$.type') = 'duplicate_of' AND EXISTS (
        SELECT 1 FROM system_backup_rows other WHERE other.job_id = r.job_id
          AND other.table_name = 'task_relations' AND other.ordinal != r.ordinal
          AND json_extract(other.row_json, '$.type') = 'duplicate_of'
          AND json_extract(other.row_json, '$.source_task_id') = json_extract(r.row_json, '$.source_task_id')))
    ) LIMIT 1`);

  yield () => assertNoRows(jobId, "Saved View scope", `
    SELECT 1 FROM system_backup_rows v
    WHERE v.job_id = ? AND v.table_name = 'saved_views' AND (
      (json_extract(v.row_json, '$.scope_project_id') IS NOT NULL
        AND NOT ${hasRef("projects", "id", "json_extract(v.row_json, '$.scope_project_id')")})
      OR json_valid(json_extract(v.row_json, '$.query_json')) = 0
      OR json_type(json_extract(v.row_json, '$.query_json')) != 'object'
      OR json_valid(json_extract(v.row_json, '$.display_json')) = 0
      OR json_type(json_extract(v.row_json, '$.display_json')) != 'object'
      OR ${invalidDeletionTuple("v")}
    ) LIMIT 1`);
  yield () => assertNoRows(jobId, "Access grant resource", `
    SELECT 1 FROM system_backup_rows g
    WHERE g.job_id = ? AND g.table_name = 'access_grants' AND (
      json_extract(g.row_json, '$.grantee_user_id') = json_extract(g.row_json, '$.owner_user_id')
      OR (json_extract(g.row_json, '$.resource_type') = 'project'
        AND NOT ${hasRef("projects", "id", "json_extract(g.row_json, '$.resource_id')")})
      OR (json_extract(g.row_json, '$.resource_type') = 'saved_view'
        AND NOT ${hasRef("saved_views", "id", "json_extract(g.row_json, '$.resource_id')")})
      OR (json_extract(g.row_json, '$.resource_type') = 'task'
        AND NOT ${hasRef("tasks", "id", "json_extract(g.row_json, '$.resource_id')")})
      OR json_extract(g.row_json, '$.resource_type') NOT IN ('project', 'task', 'saved_view')
      OR json_extract(g.row_json, '$.owner_user_id') != CASE json_extract(g.row_json, '$.resource_type')
        WHEN 'project' THEN (SELECT json_extract(p.row_json, '$.owner_user_id')
          FROM system_backup_rows p WHERE p.job_id = g.job_id AND p.table_name = 'projects'
            AND json_extract(p.row_json, '$.id') = json_extract(g.row_json, '$.resource_id'))
        WHEN 'task' THEN (SELECT json_extract(t.row_json, '$.owner_user_id')
          FROM system_backup_rows t WHERE t.job_id = g.job_id AND t.table_name = 'tasks'
            AND json_extract(t.row_json, '$.id') = json_extract(g.row_json, '$.resource_id'))
        WHEN 'saved_view' THEN (SELECT json_extract(v.row_json, '$.owner_user_id')
          FROM system_backup_rows v WHERE v.job_id = g.job_id AND v.table_name = 'saved_views'
            AND json_extract(v.row_json, '$.id') = json_extract(g.row_json, '$.resource_id'))
      END
      OR (json_extract(g.row_json, '$.revoked_at') IS NULL
        AND json_extract(g.row_json, '$.resource_type') = 'task'
        AND (SELECT json_extract(t.row_json, '$.project_id') FROM system_backup_rows t
          WHERE t.job_id = g.job_id AND t.table_name = 'tasks'
            AND json_extract(t.row_json, '$.id') = json_extract(g.row_json, '$.resource_id')) IS NOT NULL)
      OR (json_extract(g.row_json, '$.revoked_at') IS NULL
        AND json_extract(g.row_json, '$.resource_type') = 'saved_view'
        AND (SELECT json_extract(v.row_json, '$.scope_project_id') FROM system_backup_rows v
          WHERE v.job_id = g.job_id AND v.table_name = 'saved_views'
            AND json_extract(v.row_json, '$.id') = json_extract(g.row_json, '$.resource_id')) IS NOT NULL)
      OR (json_extract(g.row_json, '$.resource_type') = 'project'
        AND json_extract(g.row_json, '$.permission') NOT IN ('manager','editor','viewer','full_access'))
      OR (json_extract(g.row_json, '$.resource_type') IN ('task','saved_view')
        AND json_extract(g.row_json, '$.permission') NOT IN ('editor','viewer','full_access'))
    ) LIMIT 1`);

  yield* validateCommentAndHistoryState(jobId);
  yield* validateActivityAndMigrationState(jobId);
}

function* validateCommentAndHistoryState(
  jobId: string,
): Generator<SystemBackupValidationStep, void, void> {
  yield () => assertNoRows(jobId, "comment topology and provenance", `
    SELECT 1 FROM system_backup_rows c
    WHERE c.job_id = ? AND c.table_name = 'comments' AND (
      (json_extract(c.row_json, '$.source') = 'native' AND (
        json_extract(c.row_json, '$.author_user_id') IS NULL
        OR NOT ${hasRef("users", "id", "json_extract(c.row_json, '$.author_user_id')")}
        OR json_extract(c.row_json, '$.source_record_id') IS NOT NULL
        OR json_extract(c.row_json, '$.source_comment_id') IS NOT NULL
        OR json_extract(c.row_json, '$.historical_author_name') IS NOT NULL))
      OR (json_extract(c.row_json, '$.source') = 'linear' AND (
        json_extract(c.row_json, '$.author_user_id') IS NOT NULL
        OR trim(COALESCE(json_extract(c.row_json, '$.source_record_id'), '')) = ''
        OR trim(COALESCE(json_extract(c.row_json, '$.source_comment_id'), '')) = ''
        OR trim(COALESCE(json_extract(c.row_json, '$.historical_author_name'), '')) = ''))
      OR json_extract(c.row_json, '$.source') NOT IN ('native', 'linear')
      OR (json_extract(c.row_json, '$.deleted_at') IS NULL
        AND trim(json_extract(c.row_json, '$.body')) = '')
      OR (json_extract(c.row_json, '$.parent_comment_id') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM system_backup_rows parent WHERE parent.job_id = c.job_id
          AND parent.table_name = 'comments'
          AND json_extract(parent.row_json, '$.id') = json_extract(c.row_json, '$.parent_comment_id')
          AND json_extract(parent.row_json, '$.task_id') = json_extract(c.row_json, '$.task_id')
          AND json_extract(parent.row_json, '$.parent_comment_id') IS NULL))
      OR (json_extract(c.row_json, '$.parent_comment_id') IS NOT NULL AND (
        json_extract(c.row_json, '$.resolved_at') IS NOT NULL
        OR json_extract(c.row_json, '$.resolved_by_user_id') IS NOT NULL
        OR json_extract(c.row_json, '$.resolution_comment_id') IS NOT NULL))
      OR (json_extract(c.row_json, '$.resolved_at') IS NULL AND (
        json_extract(c.row_json, '$.resolved_by_user_id') IS NOT NULL
        OR json_extract(c.row_json, '$.resolution_comment_id') IS NOT NULL))
      OR (json_extract(c.row_json, '$.resolved_at') IS NOT NULL AND (
        json_extract(c.row_json, '$.resolved_by_user_id') IS NULL
        OR NOT ${hasRef("users", "id", "json_extract(c.row_json, '$.resolved_by_user_id')")}))
      OR (json_extract(c.row_json, '$.resolution_comment_id') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM system_backup_rows resolution WHERE resolution.job_id = c.job_id
          AND resolution.table_name = 'comments'
          AND json_extract(resolution.row_json, '$.id') = json_extract(c.row_json, '$.resolution_comment_id')
          AND (json_extract(resolution.row_json, '$.id') = json_extract(c.row_json, '$.id')
            OR json_extract(resolution.row_json, '$.parent_comment_id') = json_extract(c.row_json, '$.id'))))
    ) LIMIT 1`);
  yield () => assertNoRows(jobId, "Task comment counter", `
    SELECT 1 FROM system_backup_rows t
    WHERE t.job_id = ? AND t.table_name = 'tasks'
      AND json_extract(t.row_json, '$.comment_count') != (
        SELECT COUNT(*) FROM system_backup_rows c WHERE c.job_id = t.job_id
          AND c.table_name = 'comments'
          AND json_extract(c.row_json, '$.task_id') = json_extract(t.row_json, '$.id')
          AND json_extract(c.row_json, '$.deleted_at') IS NULL)
    LIMIT 1`);
  yield () => assertNoRows(jobId, "comment attachment live scope", `
    SELECT 1 FROM system_backup_rows ref
    JOIN system_backup_rows c ON c.job_id = ref.job_id AND c.table_name = 'comments'
      AND json_extract(c.row_json, '$.id') = json_extract(ref.row_json, '$.comment_id')
    JOIN system_backup_rows a ON a.job_id = ref.job_id AND a.table_name = 'attachments'
      AND json_extract(a.row_json, '$.id') = json_extract(ref.row_json, '$.attachment_id')
    WHERE ref.job_id = ? AND ref.table_name = 'comment_attachment_refs' AND (
      json_extract(ref.row_json, '$.task_id') != json_extract(c.row_json, '$.task_id')
      OR json_extract(ref.row_json, '$.task_id') != json_extract(a.row_json, '$.task_id')
      OR json_extract(c.row_json, '$.source') != 'native'
      OR json_extract(c.row_json, '$.deleted_at') IS NOT NULL
      OR json_extract(a.row_json, '$.state') != 'ready') LIMIT 1`);
  yield () => assertNoRows(jobId, "external record shape", `
    SELECT 1 FROM system_backup_rows e
    WHERE e.job_id = ? AND e.table_name = 'external_records' AND (
      json_valid(json_extract(e.row_json, '$.metadata_json')) = 0
      OR json_type(json_extract(e.row_json, '$.metadata_json')) != 'object'
      OR json_extract(e.row_json, '$.target_type') NOT IN
        ('task','project','release','saved_view','label','workflow_status')
      OR NOT EXISTS (SELECT 1 FROM system_backup_rows target WHERE target.job_id = e.job_id
        AND target.table_name = CASE json_extract(e.row_json, '$.target_type')
          WHEN 'task' THEN 'tasks' WHEN 'project' THEN 'projects'
          WHEN 'release' THEN 'releases' WHEN 'saved_view' THEN 'saved_views'
          WHEN 'label' THEN 'labels' ELSE 'workflow_statuses' END
        AND json_extract(target.row_json, '$.id') = json_extract(e.row_json, '$.target_id')
        AND json_extract(target.row_json, '$.owner_user_id') = json_extract(e.row_json, '$.owner_user_id'))
    ) LIMIT 1`);
  yield () => assertNoRows(jobId, "attachment migration outcome", `
    SELECT 1 FROM system_backup_rows o
    WHERE o.job_id = ? AND o.table_name = 'attachment_migration_outcomes' AND (
      json_extract(o.row_json, '$.source') != 'linear'
      OR json_extract(o.row_json, '$.outcome') NOT IN ('migrated','non_binary_mapped','skipped','blocked')
      OR json_valid(json_extract(o.row_json, '$.raw_json')) = 0
      OR NOT EXISTS (SELECT 1 FROM system_backup_rows e WHERE e.job_id = o.job_id
        AND e.table_name = 'external_records'
        AND json_extract(e.row_json, '$.id') = json_extract(o.row_json, '$.source_record_id')
        AND json_extract(e.row_json, '$.source') = 'linear'
        AND json_extract(e.row_json, '$.target_type') = 'task'
        AND json_extract(e.row_json, '$.target_id') = json_extract(o.row_json, '$.task_id'))
      OR (json_extract(o.row_json, '$.outcome') = 'migrated' AND NOT EXISTS (
        SELECT 1 FROM system_backup_rows a WHERE a.job_id = o.job_id AND a.table_name = 'attachments'
          AND json_extract(a.row_json, '$.id') = json_extract(o.row_json, '$.attachment_id')
          AND json_extract(a.row_json, '$.task_id') = json_extract(o.row_json, '$.task_id')
          AND json_extract(a.row_json, '$.state') = 'ready'))
      OR (json_extract(o.row_json, '$.outcome') = 'non_binary_mapped' AND (
        json_extract(o.row_json, '$.attachment_id') IS NOT NULL
        OR trim(COALESCE(json_extract(o.row_json, '$.mapped_title'), '')) = ''
        OR json_extract(o.row_json, '$.mapped_url') NOT LIKE 'https://%'))
      OR (json_extract(o.row_json, '$.outcome') IN ('skipped','blocked') AND (
        json_extract(o.row_json, '$.attachment_id') IS NOT NULL
        OR json_extract(o.row_json, '$.mapped_title') IS NOT NULL
        OR json_extract(o.row_json, '$.mapped_url') IS NOT NULL))
    ) LIMIT 1`);
}

function* validateActivityAndMigrationState(
  jobId: string,
): Generator<SystemBackupValidationStep, void, void> {
  yield () => assertNoRows(jobId, "activity schema and provenance", `
    SELECT 1 FROM system_backup_rows e
    WHERE e.job_id = ? AND e.table_name = 'activity_events' AND (
      json_extract(e.row_json, '$.schema_version') != 1
      OR json_extract(e.row_json, '$.actor_kind') NOT IN ('user','historical','system')
      OR json_valid(json_extract(e.row_json, '$.payload_json')) = 0
      OR json_type(json_extract(e.row_json, '$.payload_json')) != 'object'
      OR json_extract(e.row_json, '$.source') NOT IN ('native','linear')
      OR (json_extract(e.row_json, '$.actor_kind') = 'user' AND (
        json_extract(e.row_json, '$.actor_user_id') IS NULL
        OR NOT ${hasRef("users", "id", "json_extract(e.row_json, '$.actor_user_id')")}))
      OR (json_extract(e.row_json, '$.actor_kind') != 'user'
        AND json_extract(e.row_json, '$.actor_user_id') IS NOT NULL)
      OR (json_extract(e.row_json, '$.source') = 'native' AND (
        json_extract(e.row_json, '$.actor_kind') NOT IN ('user','system')
        OR json_extract(e.row_json, '$.source_record_id') IS NOT NULL
        OR json_extract(e.row_json, '$.source_event_id') IS NOT NULL
        OR json_extract(e.row_json, '$.source_index') IS NOT NULL))
      OR (json_extract(e.row_json, '$.source') = 'linear' AND (
        json_extract(e.row_json, '$.actor_kind') != 'historical'
        OR json_extract(e.row_json, '$.source_index') < 0
        OR NOT EXISTS (SELECT 1 FROM system_backup_rows source WHERE source.job_id = e.job_id
          AND source.table_name = 'external_records'
          AND json_extract(source.row_json, '$.id') = json_extract(e.row_json, '$.source_record_id')
          AND json_extract(source.row_json, '$.target_type') = 'task'
          AND json_extract(source.row_json, '$.target_id') = json_extract(e.row_json, '$.task_id'))))
    ) LIMIT 1`);
  for (const [table, targetColumn, targetTable] of [
    ["comment_migration_outcomes", "comment_id", "comments"],
    ["activity_migration_outcomes", "activity_event_id", "activity_events"],
  ] as const) {
    yield () => assertNoRows(jobId, `${table} provenance`, `
      SELECT 1 FROM system_backup_rows o
      WHERE o.job_id = ? AND o.table_name = '${table}' AND (
        json_extract(o.row_json, '$.source') != 'linear'
        OR json_extract(o.row_json, '$.outcome') NOT IN ('migrated','exception')
        OR json_valid(json_extract(o.row_json, '$.raw_json')) = 0
        OR NOT EXISTS (SELECT 1 FROM system_backup_rows source WHERE source.job_id = o.job_id
          AND source.table_name = 'external_records'
          AND json_extract(source.row_json, '$.id') = json_extract(o.row_json, '$.source_record_id')
          AND json_extract(source.row_json, '$.target_type') = 'task'
          AND json_extract(source.row_json, '$.target_id') = json_extract(o.row_json, '$.task_id'))
        OR (json_extract(o.row_json, '$.outcome') = 'migrated' AND NOT EXISTS (
          SELECT 1 FROM system_backup_rows target WHERE target.job_id = o.job_id
            AND target.table_name = '${targetTable}'
            AND json_extract(target.row_json, '$.id') = json_extract(o.row_json, '$.${targetColumn}')
            AND json_extract(target.row_json, '$.task_id') = json_extract(o.row_json, '$.task_id')
            AND json_extract(target.row_json, '$.source_record_id') = json_extract(o.row_json, '$.source_record_id')))
        OR (json_extract(o.row_json, '$.outcome') = 'exception'
          AND json_extract(o.row_json, '$.${targetColumn}') IS NOT NULL)
      ) LIMIT 1`);
  }
}

async function validateRowShape(
  jobId: string,
  table: string,
  columns: readonly string[],
  shapes: Record<string, BackupColumnShape>,
) {
  const allowedKeys = columns.map((column) => `'${column.replaceAll("'", "''")}'`).join(",");
  const typeChecks = columns.map((column) => {
    const shape = shapes[column] ?? {};
    const path = `$.${column}`;
    const accepted = shape.number
      ? shape.integer
        ? "('integer')"
        : "('integer','real')"
      : "('text')";
    const nullable = shape.nullable ? ` OR json_type(row_json, '${path}') = 'null'` : "";
    return `(json_type(row_json, '${path}') IS NULL
      OR NOT (json_type(row_json, '${path}') IN ${accepted}${nullable}))`;
  }).join(" OR ");
  const result = await getD1().prepare(`SELECT 1 FROM system_backup_rows
    WHERE job_id = ? AND table_name = ? AND (
      json_valid(row_json) = 0 OR json_type(row_json) != 'object'
      OR length(CAST(row_json AS BLOB)) > ?
      OR EXISTS (SELECT 1 FROM json_each(row_json) WHERE key NOT IN (${allowedKeys}))
      OR ${typeChecks}
    ) LIMIT 1`).bind(jobId, table, maxSystemBackupRowBytes).first();
  if (result) throw new ValidationError(`Invalid row shape for ${table}`);
}

async function assertUnique(
  jobId: string,
  table: string,
  columns: readonly string[],
  nullable = false,
) {
  const values = columns.map((column) => `json_extract(row_json, '$.${column}')`);
  const nonNull = nullable
    ? `AND ${values.map((value) => `${value} IS NOT NULL`).join(" AND ")}`
    : "";
  const result = await getD1().prepare(`SELECT 1 FROM system_backup_rows
    WHERE job_id = ? AND table_name = ? ${nonNull}
    GROUP BY ${values.join(", ")} HAVING COUNT(*) > 1 LIMIT 1`)
    .bind(jobId, table).first();
  if (result) throw new ValidationError(`Duplicate ${table} ${columns.join("/")}`);
}

async function assertNoRows(
  jobId: string,
  label: string,
  sql: string,
  extraBindings: unknown[] = [],
  prependJobId = true,
) {
  const bindings = prependJobId ? [jobId, ...extraBindings] : extraBindings;
  const result = await getD1().prepare(sql).bind(...bindings).first();
  if (result) throw new ValidationError(`Invalid system backup ${label}`);
}

function referenceQuery(
  childTable: string,
  childColumn: string,
  parentTable: string,
  parentColumn: string,
) {
  return `SELECT 1 FROM system_backup_rows child
    WHERE child.job_id = ? AND child.table_name = '${childTable}'
      AND NOT ${hasRef(parentTable, parentColumn, `json_extract(child.row_json, '$.${childColumn}')`)}
    LIMIT 1`;
}

function hasRef(table: string, column: string, valueExpression: string) {
  return `EXISTS (SELECT 1 FROM system_backup_rows ref
    WHERE ref.job_id = ${outerJobExpression(valueExpression)}
      AND ref.table_name = '${table}'
      AND json_extract(ref.row_json, '$.${column}') = ${valueExpression})`;
}

function outerJobExpression(valueExpression: string) {
  const alias = /^json_extract\(([a-zA-Z_][a-zA-Z0-9_]*)\./.exec(valueExpression)?.[1];
  return alias ? `${alias}.job_id` : "child.job_id";
}

function invalidDeletionTuple(alias: string) {
  return `(
    (json_extract(${alias}.row_json, '$.deleted_at') IS NULL) !=
      (json_extract(${alias}.row_json, '$.deleted_by_user_id') IS NULL)
    OR (json_extract(${alias}.row_json, '$.deleted_at') IS NULL) !=
      (json_extract(${alias}.row_json, '$.purge_after') IS NULL)
    OR (json_extract(${alias}.row_json, '$.deleted_at') IS NOT NULL AND (
      datetime(json_extract(${alias}.row_json, '$.purge_after')) <= datetime(json_extract(${alias}.row_json, '$.deleted_at'))
      OR NOT ${hasRef("users", "id", `json_extract(${alias}.row_json, '$.deleted_by_user_id')`)}
    ))
  )`;
}
