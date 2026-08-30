import { getD1 } from "@/db";
import { NotFoundError, PermissionError, ValidationError } from "./domain";
import {
  createProjectBackup,
  projectBackupRestoreTableDefinitions,
  projectBackupTableDefinitions,
  projectBackupTableNames,
  projectRestoreInsertSql,
  validateProjectBackup,
  type ProjectBackup,
  type ProjectExternalTaskRelationDescriptor,
  type ProjectBackupTables,
  type ProjectSharingDescriptor,
} from "./project-backup-format";
import { normalizeDbRow } from "./system-backup-format";
import type {
  AppliedProjectBackup,
  ProjectBackupPreview,
  UserRecord,
} from "./types";
import {
  collectAttachmentBackupObjects,
  deleteAttachmentObjects,
  materializeStagedAttachmentObjects,
  parseStagedAttachmentObject,
  serializeStagedAttachmentObject,
  stageAttachmentBackupObjects,
} from "./attachment-backup";
import { restoreStoredFileStatements } from "./attachments";
import {
  projectRestorePurgeJobCleanupParameters,
  projectRestorePurgeJobCleanupSql,
} from "./system-backup-contract";

type DbRow = Record<string, unknown>;

const unsafeExternalRelationPredicate = `(
  (source.project_id = ? AND COALESCE(target.project_id, '') <> ?) OR
  (target.project_id = ? AND COALESCE(source.project_id, '') <> ?)
) AND (
  source.id IS NULL OR target.id IS NULL OR
  source.project_id IS NULL OR target.project_id IS NULL OR
  tr.type NOT IN ('blocks', 'related') OR
  (source.project_id = ? AND NOT EXISTS (
    SELECT 1 FROM user_import_rows incoming
    WHERE incoming.import_id = ? AND incoming.row_type = 'tasks'
      AND json_extract(incoming.row_json, '$.id') = source.id
  )) OR
  (target.project_id = ? AND NOT EXISTS (
    SELECT 1 FROM user_import_rows incoming
    WHERE incoming.import_id = ? AND incoming.row_type = 'tasks'
      AND json_extract(incoming.row_json, '$.id') = target.id
  ))
)`;

export const projectExternalRelationRestoreGuardSql = `INSERT INTO user_import_rows
  (import_id, row_type, ordinal, row_json)
  SELECT ?, '__external_relation_restore_guard__', -1, NULL
  WHERE EXISTS (
    SELECT 1 FROM task_relations tr
    LEFT JOIN tasks source ON source.id = tr.source_task_id
    LEFT JOIN tasks target ON target.id = tr.target_task_id
    WHERE ${unsafeExternalRelationPredicate}
  )`;

export function projectExternalRelationRestoreGuardParameters(
  projectId: string,
  importId: string,
) {
  return [
    importId,
    ...unsafeExternalRelationPredicateParameters(projectId, importId),
  ];
}

function unsafeExternalRelationPredicateParameters(
  projectId: string,
  importId: string,
) {
  return [
    projectId, projectId, projectId, projectId,
    projectId, importId,
    projectId, importId,
  ];
}

export const projectInternalRelationDeleteSql = `DELETE FROM task_relations WHERE
  source_task_id IN (SELECT id FROM tasks WHERE project_id = ?) AND
  target_task_id IN (SELECT id FROM tasks WHERE project_id = ?)`;

export function projectInternalRelationDeleteParameters(projectId: string) {
  return [projectId, projectId];
}

export async function exportProjectBackup(
  currentUser: UserRecord,
  projectId: string,
  siteOrigin: string,
): Promise<ProjectBackup> {
  const db = getD1();
  const definition = (name: string) => {
    const value = projectBackupTableDefinitions.find((table) => table.name === name);
    if (!value) throw new Error(`Missing project backup table definition: ${name}`);
    return value;
  };
  const results = await db.batch([
    db.prepare(`SELECT ${definition("projects").columns.join(", ")} FROM projects WHERE id = ? AND owner_user_id = ?`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("workflow_statuses").columns.map((column) => `ws.${column}`).join(", ")}
      FROM workflow_statuses ws WHERE EXISTS (
        SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.project_id = ? AND p.owner_user_id = ? AND t.status_id = ws.id
      ) ORDER BY ws.id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("releases").columns.join(", ")} FROM releases WHERE project_id = ?
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = releases.project_id AND p.owner_user_id = ?)
      ORDER BY id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("tasks").columns.join(", ")} FROM tasks WHERE project_id = ?
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id AND p.owner_user_id = ?)
      ORDER BY id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("comments").columns.map((column) => `c.${column}`).join(", ")}
      FROM comments c JOIN tasks t ON t.id = c.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND p.owner_user_id = ?
      ORDER BY c.task_id, c.created_at, c.id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("comment_attachment_refs").columns.map((column) => `ref.${column}`).join(", ")}
      FROM comment_attachment_refs ref JOIN tasks t ON t.id = ref.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND p.owner_user_id = ?
      ORDER BY ref.comment_id, ref.attachment_id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("comment_migration_outcomes").columns.map((column) => `outcome.${column}`).join(", ")}
      FROM comment_migration_outcomes outcome JOIN tasks t ON t.id = outcome.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND p.owner_user_id = ?
      ORDER BY outcome.task_id, outcome.source_record_id, outcome.source_index`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("activity_events").columns.map((column) => `event.${column}`).join(", ")}
      FROM activity_events event JOIN tasks t ON t.id = event.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND p.owner_user_id = ?
      ORDER BY event.task_id, event.created_at, event.id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("activity_migration_outcomes").columns.map((column) => `outcome.${column}`).join(", ")}
      FROM activity_migration_outcomes outcome JOIN tasks t ON t.id = outcome.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND p.owner_user_id = ?
      ORDER BY outcome.task_id, outcome.source_record_id, outcome.source_index`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("comment_reactions").columns.map((column) => `cr.${column}`).join(", ")}
      FROM comment_reactions cr JOIN comments c ON c.id = cr.comment_id
      JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND p.owner_user_id = ?
      ORDER BY cr.comment_id, cr.emoji, cr.user_id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("label_groups").columns.map((column) => `g.${column}`).join(", ")}
      FROM label_groups g WHERE EXISTS (
        SELECT 1 FROM labels l JOIN task_labels tl ON tl.label_id = l.id
        JOIN tasks t ON t.id = tl.task_id JOIN projects p ON p.id = t.project_id
        WHERE t.project_id = ? AND p.owner_user_id = ? AND l.group_id = g.id
      ) ORDER BY g.position, g.id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("labels").columns.map((column) => `l.${column}`).join(", ")}
      FROM labels l WHERE EXISTS (
        SELECT 1 FROM task_labels tl JOIN tasks t ON t.id = tl.task_id
        JOIN projects p ON p.id = t.project_id
        WHERE t.project_id = ? AND p.owner_user_id = ? AND tl.label_id = l.id
      ) ORDER BY l.id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("task_labels").columns.map((column) => `tl.${column}`).join(", ")}
      FROM task_labels tl JOIN tasks t ON t.id = tl.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND p.owner_user_id = ? ORDER BY tl.task_id, tl.label_id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("task_relations").columns.map((column) => `tr.${column}`).join(", ")}
      FROM task_relations tr
      JOIN tasks source ON source.id = tr.source_task_id
      JOIN tasks target ON target.id = tr.target_task_id
      JOIN projects p ON p.id = source.project_id
      WHERE source.project_id = ? AND target.project_id = ? AND p.owner_user_id = ?
      ORDER BY tr.source_task_id, tr.target_task_id, tr.type`).bind(projectId, projectId, currentUser.id),
    db.prepare(`SELECT ${definition("saved_views").columns.join(", ")} FROM saved_views
      WHERE scope_project_id = ? AND EXISTS (
        SELECT 1 FROM projects p WHERE p.id = saved_views.scope_project_id AND p.owner_user_id = ?
      ) ORDER BY id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("external_records").columns.map((column) => `er.${column}`).join(", ")}
      FROM external_records er WHERE EXISTS (
        SELECT 1 FROM projects p WHERE p.id = ? AND p.owner_user_id = ?
      ) AND (
        (er.target_type = 'project' AND er.target_id = ?) OR
        (er.target_type = 'release' AND EXISTS (SELECT 1 FROM releases r WHERE r.id = er.target_id AND r.project_id = ?)) OR
        (er.target_type = 'task' AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = er.target_id AND t.project_id = ?)) OR
        (er.target_type = 'saved_view' AND EXISTS (SELECT 1 FROM saved_views v WHERE v.id = er.target_id AND v.scope_project_id = ?))
      ) ORDER BY er.id`).bind(projectId, currentUser.id, projectId, projectId, projectId, projectId),
    db.prepare(`SELECT ${definition("attachments").columns.map((column) => `a.${column}`).join(", ")}
      FROM attachments a JOIN tasks t ON t.id = a.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND p.owner_user_id = ?
      ORDER BY a.task_id, a.created_at, a.id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("attachment_migration_outcomes").columns.map((column) => `outcome.${column}`).join(", ")}
      FROM attachment_migration_outcomes outcome
      JOIN tasks t ON t.id = outcome.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND p.owner_user_id = ?
      ORDER BY outcome.task_id, outcome.source_record_id, outcome.source_index`)
      .bind(projectId, currentUser.id),
    db.prepare(`SELECT ${definition("task_identifier_aliases").columns.map((column) => `alias.${column}`).join(", ")}
      FROM task_identifier_aliases alias JOIN tasks t ON t.id = alias.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND p.owner_user_id = ?
      ORDER BY alias.task_id, alias.identifier`).bind(projectId, currentUser.id),
    db.prepare(`SELECT ag.grantee_user_id, u.email, u.display_name, ag.permission
      FROM access_grants ag JOIN users u ON u.id = ag.grantee_user_id
      WHERE ag.resource_type = 'project' AND ag.resource_id = ? AND ag.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ag.resource_id AND p.owner_user_id = ?)
      ORDER BY ag.grantee_user_id`).bind(projectId, currentUser.id),
    db.prepare(`SELECT
        ${definition("task_relations").columns.map((column) => `tr.${column}`).join(", ")},
        source.project_id AS source_project_id,
        target.project_id AS target_project_id
      FROM task_relations tr
      LEFT JOIN tasks source ON source.id = tr.source_task_id
      LEFT JOIN tasks target ON target.id = tr.target_task_id
      WHERE (
        (source.project_id = ? AND COALESCE(target.project_id, '') <> ?) OR
        (target.project_id = ? AND COALESCE(source.project_id, '') <> ?)
      ) AND EXISTS (
        SELECT 1 FROM projects p WHERE p.id = ? AND p.owner_user_id = ?
      )
      ORDER BY tr.source_task_id, tr.target_task_id, tr.type`)
      .bind(projectId, projectId, projectId, projectId, projectId, currentUser.id),
  ]);
  const projectRow = results[0].results[0] as DbRow | undefined;
  if (!projectRow) throw new NotFoundError("Project not found");
  const tables = {} as ProjectBackupTables;
  const resultIndex: Record<(typeof projectBackupTableNames)[number], number> = {
    projects: 0,
    workflow_statuses: 1,
    releases: 2,
    tasks: 3,
    comments: 4,
    comment_attachment_refs: 5,
    comment_migration_outcomes: 6,
    activity_events: 7,
    activity_migration_outcomes: 8,
    comment_reactions: 9,
    label_groups: 10,
    labels: 11,
    task_labels: 12,
    task_relations: 13,
    saved_views: 14,
    external_records: 15,
    attachments: 16,
    attachment_migration_outcomes: 17,
    task_identifier_aliases: 18,
  };
  projectBackupTableNames.forEach((name) => {
    const table = definition(name);
    tables[name] = results[resultIndex[name]].results.map((row) => normalizeDbRow(table, row as DbRow));
  });
  const attachmentData = await collectAttachmentBackupObjects(
    tables.attachments,
  );
  tables.attachments = attachmentData.rows;
  const sharing = results[19].results.map((value) => {
    const row = value as DbRow;
    const permission = String(row.permission);
    if (permission !== "manager" && permission !== "editor" && permission !== "viewer") {
      throw new ValidationError("Project contains an unsupported active role");
    }
    return {
      granteeUserId: String(row.grantee_user_id),
      email: String(row.email).trim().toLowerCase(),
      displayName: String(row.display_name),
      permission,
    } satisfies ProjectSharingDescriptor;
  });
  const externalRelationsOmitted = results[20].results.length;
  const externalTaskRelations = results[20].results.flatMap((value) => {
    const row = value as DbRow;
    const type = String(row.type);
    if (type !== "blocks" && type !== "related") {
      return [];
    }
    const internalEndpoint = row.source_project_id === projectId ? "source" : "target";
    return [{
      relation: {
        id: String(row.id),
        sourceTaskId: String(row.source_task_id),
        targetTaskId: String(row.target_task_id),
        type,
        creatorUserId: String(row.creator_user_id),
        idempotencyKey: String(row.idempotency_key),
        version: Number(row.version),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      },
      internalTaskId: String(
        internalEndpoint === "source" ? row.source_task_id : row.target_task_id,
      ),
      internalEndpoint,
      restorePolicy: "not_restored",
    } satisfies ProjectExternalTaskRelationDescriptor];
  });
  return createProjectBackup({
    siteOrigin,
    tables,
    objects: attachmentData.objects,
    sharing,
    externalRelationsOmitted,
    externalTaskRelations,
  });
}

export async function stageProjectBackup(
  currentUser: UserRecord,
  payload: unknown,
  siteOrigin: string,
): Promise<ProjectBackupPreview> {
  const backup = await validateProjectBackup(payload);
  if (backup.siteOrigin !== new URL(siteOrigin).origin) throw new ValidationError("Project backup belongs to another Task Manager Site");
  if (backup.ownerUserId !== currentUser.id) throw new PermissionError("Project backup belongs to another owner");
  const db = getD1();
  const project = await db.prepare("SELECT owner_user_id FROM projects WHERE id = ?").bind(backup.projectId).first<{ owner_user_id: string }>();
  if (project && project.owner_user_id !== currentUser.id) throw new NotFoundError("Project not found");

  const warnings = await validateLiveDependenciesAndCollisions(db, backup, currentUser.id);
  const legacyOpaqueCount =
    backup.warnings.externalRelationsOmitted - backup.externalTaskRelations.length;
  const livePreservedCount = await assertCurrentExternalRelationsAreSafe(
    db,
    backup.projectId,
    new Set(backup.tables.tasks.map((task) => String(task.id))),
  );
  if (backup.externalTaskRelations.length > 0) {
    warnings.push(
      `${backup.externalTaskRelations.length} cross-Project relation descriptor(s) carry provenance only; peer Tasks and relation edges will not be restored.`,
    );
  }
  if (legacyOpaqueCount > 0) {
    warnings.push(
      `${legacyOpaqueCount} legacy or unsupported cross-Project relation(s) have only an opaque count and will not be restored.`,
    );
  }
  if (livePreservedCount > 0) {
    warnings.push(
      `${livePreservedCount} current cross-Project relation(s) are safe to preserve during this exact replacement.`,
    );
  }
  if (backup.sharing.length > 0) warnings.push("Project sharing is staged but will only be restored with explicit opt-in.");

  const currentCounts: Record<string, number> = await loadCurrentProjectCounts(db, backup.projectId);
  const counts = { ...backup.counts } as Record<string, number>;
  const changes = Object.fromEntries(
    Object.entries(counts).map(([name, incoming]) => {
      const current = currentCounts[name] ?? 0;
      return [name, {
        create: Math.max(0, incoming - current),
        update: Math.min(incoming, current),
        delete: Math.max(0, current - incoming),
      }];
    }),
  );
  const importId = `user-import:${crypto.randomUUID()}`;
  const attachmentStage = await stageAttachmentBackupObjects(
    importId,
    backup.tables.attachments,
    backup.objects,
  );
  backup.tables.attachments = attachmentStage.rows;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const preview: ProjectBackupPreview = {
    importId,
    sha256: backup.sha256,
    exportedAt: backup.exportedAt,
    projectId: backup.projectId,
    projectName: backup.projectName,
    projectExists: Boolean(project),
    counts,
    currentCounts,
    changes,
    sharing: backup.sharing,
    externalRelations: {
      descriptors: backup.externalTaskRelations,
      legacyOpaqueCount,
      livePreservedCount,
      restorePolicy: "not_restored",
      acknowledgementRequired: backup.warnings.externalRelationsOmitted > 0,
    },
    warnings,
  };
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM user_import_rows WHERE import_id IN (SELECT id FROM user_import_sessions WHERE expires_at < CURRENT_TIMESTAMP)"),
    db.prepare("UPDATE user_import_sessions SET status = 'expired' WHERE status NOT IN ('applied', 'expired') AND expires_at < CURRENT_TIMESTAMP"),
    db.prepare(`INSERT INTO user_import_sessions
      (id, created_by_user_id, kind, status, source_json,
       preview_json, payload_sha256, source_exported_at,
       project_id, expires_at)
      VALUES (?, ?, 'project_backup', 'uploading', ?, ?, ?, ?, ?, ?)`)
      .bind(
        importId,
        currentUser.id,
        JSON.stringify({ siteOrigin: backup.siteOrigin, projectPublicId: backup.projectPublicId }),
        JSON.stringify(preview),
        backup.sha256,
        backup.exportedAt,
        backup.projectId,
        expiresAt,
      ),
  ];
  const rows: Array<{ type: string; ordinal: number; json: string }> = projectBackupTableNames.flatMap((name) =>
    backup.tables[name].map((row, ordinal) => ({ type: name, ordinal, json: JSON.stringify(row) })),
  );
  rows.push(
    ...attachmentStage.staged.map((object, ordinal) => ({
      type: "__attachment_objects",
      ordinal,
      json: serializeStagedAttachmentObject(object),
    })),
  );
  try {
    const resolvedSharing = await resolveSharingRows(db, backup, currentUser.id);
    rows.push(...resolvedSharing.map((row, ordinal) => ({ type: "sharing" as const, ordinal, json: JSON.stringify(row) })));
    await db.batch(statements);
    for (let offset = 0; offset < rows.length; offset += 500) {
      const portion = rows.slice(offset, offset + 500);
      const inserts: D1PreparedStatement[] = [];
      for (let rowOffset = 0; rowOffset < portion.length; rowOffset += 25) {
        const group = portion.slice(rowOffset, rowOffset + 25);
        inserts.push(
          db.prepare(`INSERT INTO user_import_rows (import_id, row_type, ordinal, row_json) VALUES ${group.map(() => "(?, ?, ?, ?)").join(", ")}`)
            .bind(...group.flatMap((row) => [importId, row.type, row.ordinal, row.json])),
        );
      }
      await db.batch(inserts);
    }
    await db.prepare("UPDATE user_import_sessions SET status = 'staged' WHERE id = ? AND status = 'uploading'")
      .bind(importId).run();
  } catch (error) {
    await db.batch([
      db.prepare("DELETE FROM user_import_rows WHERE import_id = ?").bind(importId),
      db.prepare("UPDATE user_import_sessions SET status = 'failed' WHERE id = ? AND status = 'uploading'").bind(importId),
    ]);
    await deleteAttachmentObjects(
      attachmentStage.staged.map((object) => object.stagingKey),
    );
    throw error;
  }
  return preview;
}

export async function applyProjectBackup(
  currentUser: UserRecord,
  input: {
    importId: string;
    sha256: string;
    confirmation: string;
    currentBackupDownloaded: boolean;
    restoreSharing: boolean;
    externalRelationsAcknowledged?: boolean;
  },
): Promise<AppliedProjectBackup> {
  if (!input.importId.startsWith("user-import:") || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new ValidationError("Invalid staged project backup reference");
  }
  const db = getD1();
  const session = await db.prepare(`SELECT project_id, preview_json FROM user_import_sessions
    WHERE id = ? AND created_by_user_id = ? AND kind = 'project_backup'
      AND status = 'staged' AND payload_sha256 = ? AND expires_at >= CURRENT_TIMESTAMP`)
    .bind(input.importId, currentUser.id, input.sha256)
    .first<{ project_id: string; preview_json: string }>();
  if (!session) throw new ValidationError("Staged project backup is missing or expired");
  const preview = JSON.parse(session.preview_json) as ProjectBackupPreview;
  if (input.confirmation !== preview.projectName) throw new ValidationError("Type the exact project name to confirm restore");
  if (
    preview.externalRelations.acknowledgementRequired &&
    !input.externalRelationsAcknowledged
  ) {
    throw new ValidationError(
      "Acknowledge that cross-Project relation descriptors are provenance-only and will not restore peer Tasks or relation edges",
    );
  }
  const live = await db.prepare("SELECT owner_user_id FROM projects WHERE id = ?").bind(session.project_id).first<{ owner_user_id: string }>();
  if (live && live.owner_user_id !== currentUser.id) throw new NotFoundError("Project not found");
  if (live && !input.currentBackupDownloaded) throw new ValidationError("Download the current project backup before replacing it");
  await assertStagedExternalRelationsAreSafe(db, session.project_id, input.importId);
  await assertAssigneesAndLeadRemainAccessible(db, input.importId, currentUser.id, session.project_id, input.restoreSharing);
  const [descriptorRows, oldObjectRows] = await db.batch([
    db.prepare(`SELECT row_json FROM user_import_rows
      WHERE import_id = ? AND row_type = '__attachment_objects'
      ORDER BY ordinal`).bind(input.importId),
    db.prepare(`SELECT a.object_key, a.stored_file_id FROM attachments a
      JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?`)
      .bind(session.project_id),
  ]);
  const stagedObjects = descriptorRows.results.map((row) =>
    parseStagedAttachmentObject((row as DbRow).row_json),
  );
  const oldStoredFileIds = oldObjectRows.results.flatMap((row) => {
    const value = (row as DbRow).stored_file_id;
    return typeof value === "string" && value ? [value] : [];
  });
  const transition = await db.prepare(`UPDATE user_import_sessions SET status = 'applying'
    WHERE id = ? AND created_by_user_id = ? AND kind = 'project_backup'
      AND status = 'staged' AND payload_sha256 = ? AND expires_at >= CURRENT_TIMESTAMP`)
    .bind(input.importId, currentUser.id, input.sha256).run();
  if (transition.meta.changes !== 1) throw new ValidationError("Project backup is already being applied");
  let writtenObjects: string[] = [];
  try {
    writtenObjects = await materializeStagedAttachmentObjects(stagedObjects);
  } catch (error) {
    await db.prepare("UPDATE user_import_sessions SET status = 'staged' WHERE id = ? AND status = 'applying'")
      .bind(input.importId).run();
    throw error;
  }

  const statements: D1PreparedStatement[] = [
    db.prepare(projectExternalRelationRestoreGuardSql).bind(
      ...projectExternalRelationRestoreGuardParameters(
        session.project_id,
        input.importId,
      ),
    ),
    db.prepare(projectRestorePurgeJobCleanupSql).bind(
      ...projectRestorePurgeJobCleanupParameters(
        session.project_id,
        input.importId,
      ),
    ),
    db.prepare(`DELETE FROM comment_attachment_refs WHERE task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )`).bind(session.project_id),
    db.prepare(`DELETE FROM attachment_migration_outcomes WHERE task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )`).bind(session.project_id),
    db.prepare(`DELETE FROM activity_migration_outcomes WHERE task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )`).bind(session.project_id),
    db.prepare(`DELETE FROM activity_events WHERE task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )`).bind(session.project_id),
    db.prepare(`DELETE FROM comment_migration_outcomes WHERE task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )`).bind(session.project_id),
    db.prepare(`DELETE FROM comment_reactions WHERE comment_id IN (
      SELECT c.id FROM comments c JOIN tasks t ON t.id = c.task_id
      WHERE t.project_id = ?
    )`).bind(session.project_id),
    db.prepare(`DELETE FROM comments WHERE task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )`).bind(session.project_id),
    db.prepare(projectInternalRelationDeleteSql).bind(
      ...projectInternalRelationDeleteParameters(session.project_id),
    ),
    db.prepare("DELETE FROM task_labels WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(session.project_id),
    db.prepare(`DELETE FROM external_records WHERE
      (target_type = 'project' AND target_id = ?) OR
      (target_type = 'release' AND target_id IN (SELECT id FROM releases WHERE project_id = ?)) OR
      (target_type = 'task' AND target_id IN (SELECT id FROM tasks WHERE project_id = ?)) OR
      (target_type = 'saved_view' AND target_id IN (SELECT id FROM saved_views WHERE scope_project_id = ?))`)
      .bind(session.project_id, session.project_id, session.project_id, session.project_id),
    db.prepare(`DELETE FROM attachments WHERE task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )`).bind(session.project_id),
    ...(oldStoredFileIds.length
      ? [db.prepare(
          `DELETE FROM stored_files WHERE id IN (${oldStoredFileIds.map(() => "?").join(", ")})
           AND NOT EXISTS (
             SELECT 1 FROM attachments binding WHERE binding.stored_file_id = stored_files.id
           )`,
        ).bind(...oldStoredFileIds)]
      : []),
    db.prepare("DELETE FROM tasks WHERE project_id = ?").bind(session.project_id),
    db.prepare("DELETE FROM releases WHERE project_id = ?").bind(session.project_id),
    db.prepare("DELETE FROM saved_views WHERE scope_project_id = ?").bind(session.project_id),
  ];
  if (input.restoreSharing) {
    statements.push(db.prepare("DELETE FROM access_grants WHERE resource_type = 'project' AND resource_id = ?").bind(session.project_id));
  }
  statements.push(db.prepare("DELETE FROM projects WHERE id = ?").bind(session.project_id));
  for (const table of projectBackupRestoreTableDefinitions) {
    if (table.name === "workflow_statuses" || table.name === "label_groups" || table.name === "labels") {
      statements.push(
        db.prepare(projectRestoreInsertSql(table, true))
          .bind(input.importId, table.name),
      );
    } else {
      statements.push(db.prepare(projectRestoreInsertSql(table)).bind(input.importId, table.name));
    }
  }
  statements.push(...restoreStoredFileStatements(db));
  if (input.restoreSharing) {
    statements.push(db.prepare(`INSERT INTO access_grants
      (id, resource_type, resource_id, owner_user_id, grantee_user_id,
       granted_by_user_id, permission, revoked_at, created_at)
      SELECT
        json_extract(row_json, '$.id'), 'project', json_extract(row_json, '$.resource_id'),
        json_extract(row_json, '$.owner_user_id'), json_extract(row_json, '$.grantee_user_id'),
        ?, json_extract(row_json, '$.permission'), NULL, CURRENT_TIMESTAMP
      FROM user_import_rows WHERE import_id = ? AND row_type = 'sharing'
      ORDER BY ordinal`).bind(currentUser.id, input.importId));
  }
  statements.push(
    db.prepare("UPDATE user_import_sessions SET status = 'applied', applied_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'applying'").bind(input.importId),
    db.prepare("DELETE FROM user_import_rows WHERE import_id = ?").bind(input.importId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    await deleteAttachmentObjects(writtenObjects);
    await db.prepare("UPDATE user_import_sessions SET status = 'staged' WHERE id = ? AND status = 'applying'")
      .bind(input.importId).run();
    throw error;
  }
  await deleteAttachmentObjects([
    ...oldObjectRows.results.map((row) => String((row as DbRow).object_key)),
    ...stagedObjects.map((object) => object.stagingKey),
  ]);
  await db.prepare("PRAGMA optimize").run();
  return {
    applied: true,
    projectId: preview.projectId,
    projectName: preview.projectName,
    counts: preview.counts,
    sharingRestored: input.restoreSharing,
  };
}

async function assertCurrentExternalRelationsAreSafe(
  db: D1Database,
  projectId: string,
  incomingTaskIds: Set<string>,
) {
  const result = await db.prepare(`SELECT
      tr.id, tr.type, tr.source_task_id, tr.target_task_id,
      source.id AS source_id, source.project_id AS source_project_id,
      target.id AS target_id, target.project_id AS target_project_id
    FROM task_relations tr
    LEFT JOIN tasks source ON source.id = tr.source_task_id
    LEFT JOIN tasks target ON target.id = tr.target_task_id
    WHERE
      (source.project_id = ? AND COALESCE(target.project_id, '') <> ?) OR
      (target.project_id = ? AND COALESCE(source.project_id, '') <> ?)`)
    .bind(projectId, projectId, projectId, projectId)
    .all<DbRow>();
  for (const row of result.results) {
    const type = String(row.type);
    const sourceProjectId = row.source_project_id === null
      ? null
      : String(row.source_project_id);
    const targetProjectId = row.target_project_id === null
      ? null
      : String(row.target_project_id);
    const internalTaskId = sourceProjectId === projectId
      ? String(row.source_task_id)
      : String(row.target_task_id);
    const peerProjectId = sourceProjectId === projectId
      ? targetProjectId
      : sourceProjectId;
    if (
      row.source_id === null || row.target_id === null ||
      (type !== "blocks" && type !== "related") ||
      !incomingTaskIds.has(internalTaskId) ||
      !peerProjectId ||
      (sourceProjectId !== projectId && targetProjectId !== projectId)
    ) {
      throw new ValidationError(
        "Project restore would leave a dangling or unsupported cross-Project Task relation; unlink it or include its local Task before restoring",
      );
    }
  }
  return result.results.length;
}

async function assertStagedExternalRelationsAreSafe(
  db: D1Database,
  projectId: string,
  importId: string,
) {
  const unsafe = await db.prepare(`SELECT tr.id FROM task_relations tr
    LEFT JOIN tasks source ON source.id = tr.source_task_id
    LEFT JOIN tasks target ON target.id = tr.target_task_id
    WHERE ${unsafeExternalRelationPredicate}
    LIMIT 1`)
    .bind(...unsafeExternalRelationPredicateParameters(projectId, importId))
    .first<{ id: string }>();
  if (unsafe) {
    throw new ValidationError(
      "Project restore would leave a dangling or unsupported cross-Project Task relation; unlink it or include its local Task before restoring",
    );
  }
}

async function validateLiveDependenciesAndCollisions(
  db: D1Database,
  backup: ProjectBackup,
  currentUserId: string,
) {
  const groupRows = (await db.prepare("SELECT id, owner_user_id, name FROM label_groups").all()).results as DbRow[];
  const results = await db.batch([
    db.prepare("SELECT id, owner_user_id, name, category FROM workflow_statuses"),
    db.prepare("SELECT id, owner_user_id, name FROM labels"),
    db.prepare("SELECT id FROM users"),
    db.prepare("SELECT id, public_id, owner_user_id, task_code, archived_at, deleted_at FROM projects WHERE id <> ?").bind(backup.projectId),
    db.prepare("SELECT id, public_id, project_id, identifier, sequence_number FROM tasks WHERE project_id <> ?").bind(backup.projectId),
    db.prepare("SELECT id, public_id FROM releases WHERE project_id <> ?").bind(backup.projectId),
    db.prepare("SELECT id, public_id FROM saved_views WHERE scope_project_id IS NULL OR scope_project_id <> ?").bind(backup.projectId),
    db.prepare("SELECT owner_user_id, source, source_id, target_id FROM external_records"),
    db.prepare(`SELECT c.id FROM comments c JOIN tasks t ON t.id = c.task_id
      WHERE t.project_id IS NULL OR t.project_id <> ?`).bind(backup.projectId),
    db.prepare(`SELECT a.id, a.public_id FROM attachments a
      JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id IS NULL OR t.project_id <> ?`).bind(backup.projectId),
    db.prepare(`SELECT alias.id FROM task_identifier_aliases alias
      JOIN tasks t ON t.id = alias.task_id
      WHERE t.project_id <> ?`).bind(backup.projectId),
    db.prepare(`SELECT outcome.id FROM comment_migration_outcomes outcome
      JOIN tasks t ON t.id = outcome.task_id
      WHERE t.project_id IS NULL OR t.project_id <> ?`).bind(backup.projectId),
    db.prepare(`SELECT event.id FROM activity_events event
      JOIN tasks t ON t.id = event.task_id
      WHERE t.project_id IS NULL OR t.project_id <> ?`).bind(backup.projectId),
    db.prepare(`SELECT outcome.id FROM activity_migration_outcomes outcome
      JOIN tasks t ON t.id = outcome.task_id
      WHERE t.project_id IS NULL OR t.project_id <> ?`).bind(backup.projectId),
    db.prepare(`SELECT outcome.id FROM attachment_migration_outcomes outcome
      JOIN tasks t ON t.id = outcome.task_id
      WHERE t.project_id IS NULL OR t.project_id <> ?`).bind(backup.projectId),
  ]);
  const statusRows = results[0].results as DbRow[];
  const labelRows = results[1].results as DbRow[];
  const userRows = results[2].results as DbRow[];
  const statuses = new Map(statusRows.map((row) => [String(row.id), row]));
  const labels = new Map(labelRows.map((row) => [String(row.id), row]));
  const users = new Set(userRows.map((row) => String(row.id)));
  const warnings: string[] = [];
  for (const status of backup.tables.workflow_statuses) {
    const live = statuses.get(String(status.id));
    if (!live) {
      if (status.owner_user_id !== currentUserId) throw new ValidationError("A workflow dependency owned by another user is missing");
      const nameCollision = statusRows.some((row) => row.owner_user_id === status.owner_user_id && row.name === status.name);
      if (nameCollision) throw new ValidationError(`Workflow status ${status.name} collides with a different catalog record`);
      continue;
    }
    if (live.owner_user_id !== status.owner_user_id || live.category !== status.category) {
      throw new ValidationError(`Workflow status ${status.name} is incompatible with the backup`);
    }
    if (live.name !== status.name) warnings.push(`Workflow status ${status.name} was renamed and will keep its current catalog name.`);
  }
  const groups = new Map(groupRows.map((row) => [String(row.id), row]));
  for (const group of backup.tables.label_groups) {
    const live = groups.get(String(group.id));
    if (!live) {
      if (group.owner_user_id !== currentUserId) {
        throw new ValidationError("A Label Group dependency owned by another user is missing");
      }
      const nameCollision = groupRows.some((row) =>
        row.owner_user_id === group.owner_user_id &&
        String(row.name).toLocaleLowerCase() === String(group.name).toLocaleLowerCase()
      );
      if (nameCollision) throw new ValidationError(`Label Group ${group.name} collides with a different catalog record`);
    } else if (live.owner_user_id !== group.owner_user_id) {
      throw new ValidationError(`Label Group ${group.name} has an incompatible owner`);
    } else if (live.name !== group.name) {
      warnings.push(`Label Group ${group.name} was renamed and will keep its current catalog name.`);
    }
  }
  for (const label of backup.tables.labels) {
    const live = labels.get(String(label.id));
    if (!live) {
      if (label.owner_user_id !== currentUserId) throw new ValidationError("A label dependency owned by another user is missing");
      const nameCollision = labelRows.some((row) => row.owner_user_id === label.owner_user_id && row.name === label.name);
      if (nameCollision) throw new ValidationError(`Label ${label.name} collides with a different catalog record`);
    } else if (live.owner_user_id !== label.owner_user_id) {
      throw new ValidationError(`Label ${label.name} has an incompatible owner`);
    } else if (live.name !== label.name) warnings.push(`Label ${label.name} was renamed and will keep its current catalog name.`);
  }
  const referencedUsers = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value) referencedUsers.add(value); };
  for (const project of backup.tables.projects) { add(project.owner_user_id); add(project.creator_user_id); add(project.lead_user_id); add(project.deleted_by_user_id); }
  for (const release of backup.tables.releases) { add(release.owner_user_id); add(release.creator_user_id); add(release.deleted_by_user_id); }
  for (const task of backup.tables.tasks) { add(task.owner_user_id); add(task.creator_user_id); add(task.assignee_user_id); add(task.deleted_by_user_id); }
  for (const attachment of backup.tables.attachments) add(attachment.uploader_user_id);
  for (const comment of backup.tables.comments) { add(comment.author_user_id); add(comment.resolved_by_user_id); }
  for (const event of backup.tables.activity_events) add(event.actor_user_id);
  for (const reaction of backup.tables.comment_reactions) add(reaction.user_id);
  for (const relation of backup.tables.task_relations) add(relation.creator_user_id);
  for (const view of backup.tables.saved_views) { add(view.owner_user_id); add(view.deleted_by_user_id); }
  for (const record of backup.tables.external_records) add(record.owner_user_id);
  for (const id of referencedUsers) if (!users.has(id)) throw new ValidationError("Project backup references a user that no longer exists in this Site");
  assertNoEntityCollisions(backup, results.slice(3, 8), results[8]);
  for (const live of results[9].results as DbRow[]) {
    for (const attachment of backup.tables.attachments) {
      if (live.id === attachment.id || live.public_id === attachment.public_id) {
        throw new ValidationError("Project restore collides on an attachment identity");
      }
    }
  }
  const liveAliasIds = new Set(
    (results[10].results as DbRow[]).map((row) => String(row.id)),
  );
  for (const alias of backup.tables.task_identifier_aliases) {
    if (liveAliasIds.has(String(alias.id))) {
      throw new ValidationError("Project restore collides on a Task identifier alias identity");
    }
  }
  const liveOutcomeIds = new Set(
    (results[11].results as DbRow[]).map((row) => String(row.id)),
  );
  for (const outcome of backup.tables.comment_migration_outcomes) {
    if (liveOutcomeIds.has(String(outcome.id))) {
      throw new ValidationError("Project restore collides on a comment migration outcome identity");
    }
  }
  const liveActivityEventIds = new Set(
    (results[12].results as DbRow[]).map((row) => String(row.id)),
  );
  for (const event of backup.tables.activity_events) {
    if (liveActivityEventIds.has(String(event.id))) {
      throw new ValidationError("Project restore collides on an activity event identity");
    }
  }
  const liveActivityOutcomeIds = new Set(
    (results[13].results as DbRow[]).map((row) => String(row.id)),
  );
  for (const outcome of backup.tables.activity_migration_outcomes) {
    if (liveActivityOutcomeIds.has(String(outcome.id))) {
      throw new ValidationError("Project restore collides on an activity migration outcome identity");
    }
  }
  const liveAttachmentOutcomeIds = new Set(
    (results[14].results as DbRow[]).map((row) => String(row.id)),
  );
  for (const outcome of backup.tables.attachment_migration_outcomes) {
    if (liveAttachmentOutcomeIds.has(String(outcome.id))) {
      throw new ValidationError(
        "Project restore collides on an attachment migration outcome identity",
      );
    }
  }
  return warnings;
}

function assertNoEntityCollisions(
  backup: ProjectBackup,
  results: Array<{ results: unknown[] }>,
  commentRows: { results: unknown[] },
) {
  const collision = (rows: unknown[], incoming: BackupEntity[], fields: string[]) => {
    for (const row of rows as DbRow[]) for (const item of incoming) for (const field of fields) {
      if (String(row[field]) === String(item[field])) throw new ValidationError(`Project restore collides on ${field}: ${String(item[field])}`);
    }
  };
  collision(results[0].results, backup.tables.projects, ["id", "public_id"]);
  for (const row of results[0].results as DbRow[]) for (const project of backup.tables.projects) {
    if (
      row.archived_at === null && row.deleted_at === null &&
      project.archived_at === null && project.deleted_at === null &&
      row.owner_user_id === project.owner_user_id && row.task_code === project.task_code
    ) throw new ValidationError(`Project code ${String(project.task_code)} is already in use`);
  }
  collision(results[1].results, backup.tables.tasks, ["id", "public_id"]);
  collision(results[2].results, backup.tables.releases, ["id", "public_id"]);
  collision(results[3].results, backup.tables.saved_views, ["id", "public_id"]);
  collision(commentRows.results, backup.tables.comments, ["id"]);
  const includedExternalIds = new Set(backup.tables.external_records.map((record) => String(record.target_id)));
  for (const live of results[4].results as DbRow[]) for (const record of backup.tables.external_records) {
    if (
      live.owner_user_id === record.owner_user_id && live.source === record.source &&
      live.source_id === record.source_id && !includedExternalIds.has(String(live.target_id))
    ) throw new ValidationError(`External source ${String(record.source)}/${String(record.source_id)} already targets another record`);
  }
}

type BackupEntity = Record<string, string | number | null>;

async function resolveSharingRows(db: D1Database, backup: ProjectBackup, ownerUserId: string) {
  const rows: BackupEntity[] = [];
  for (const descriptor of backup.sharing) {
    const user = await db.prepare("SELECT id, lower(email) AS email FROM users WHERE id = ?")
      .bind(descriptor.granteeUserId).first<{ id: string; email: string }>();
    if (!user || user.email !== descriptor.email) throw new ValidationError(`Project participant ${descriptor.email} no longer matches this Site`);
    rows.push({
      id: `grant_${crypto.randomUUID()}`,
      resource_id: backup.projectId,
      owner_user_id: ownerUserId,
      grantee_user_id: user.id,
      permission: descriptor.permission,
    });
  }
  return rows;
}

async function loadCurrentProjectCounts(db: D1Database, projectId: string) {
  const results = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").bind(projectId),
    db.prepare("SELECT COUNT(*) AS count FROM releases WHERE project_id = ?").bind(projectId),
    db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?").bind(projectId),
    db.prepare("SELECT COUNT(*) AS count FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(projectId),
    db.prepare("SELECT COUNT(*) AS count FROM comment_attachment_refs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(projectId),
    db.prepare("SELECT COUNT(*) AS count FROM comment_migration_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(projectId),
    db.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(projectId),
    db.prepare("SELECT COUNT(*) AS count FROM activity_migration_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(projectId),
    db.prepare(`SELECT COUNT(*) AS count FROM comment_reactions WHERE comment_id IN (
      SELECT c.id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ?
    )`).bind(projectId),
    db.prepare("SELECT COUNT(*) AS count FROM saved_views WHERE scope_project_id = ?").bind(projectId),
    db.prepare("SELECT COUNT(*) AS count FROM task_labels WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").bind(projectId),
    db.prepare(`SELECT COUNT(*) AS count FROM task_relations WHERE
      source_task_id IN (SELECT id FROM tasks WHERE project_id = ?) AND
      target_task_id IN (SELECT id FROM tasks WHERE project_id = ?)`).bind(projectId, projectId),
    db.prepare(`SELECT COUNT(*) AS count FROM external_records WHERE
      (target_type = 'project' AND target_id = ?) OR
      (target_type = 'release' AND target_id IN (SELECT id FROM releases WHERE project_id = ?)) OR
      (target_type = 'task' AND target_id IN (SELECT id FROM tasks WHERE project_id = ?)) OR
      (target_type = 'saved_view' AND target_id IN (SELECT id FROM saved_views WHERE scope_project_id = ?))`)
      .bind(projectId, projectId, projectId, projectId),
    db.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )`).bind(projectId),
    db.prepare(`SELECT COUNT(*) AS count FROM attachment_migration_outcomes
      WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`)
      .bind(projectId),
    db.prepare(`SELECT COUNT(*) AS count FROM task_identifier_aliases WHERE task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )`).bind(projectId),
    db.prepare("SELECT COUNT(*) AS count FROM access_grants WHERE resource_type = 'project' AND resource_id = ? AND revoked_at IS NULL").bind(projectId),
  ]);
  const counts = results.map((result) => Number((result.results[0] as DbRow | undefined)?.count ?? 0));
  return {
    projects: counts[0], releases: counts[1], tasks: counts[2], comments: counts[3],
    comment_attachment_refs: counts[4],
    comment_migration_outcomes: counts[5], activity_events: counts[6],
    activity_migration_outcomes: counts[7], comment_reactions: counts[8],
    saved_views: counts[9], task_labels: counts[10], task_relations: counts[11],
    external_records: counts[12], attachments: counts[13],
    attachment_migration_outcomes: counts[14],
    task_identifier_aliases: counts[15], sharing: counts[16],
    workflow_statuses: 0, label_groups: 0, labels: 0,
  };
}

async function assertAssigneesAndLeadRemainAccessible(
  db: D1Database,
  importId: string,
  ownerUserId: string,
  projectId: string,
  restoreSharing: boolean,
) {
  const principals = await db.prepare(`SELECT DISTINCT user_id FROM (
    SELECT json_extract(row_json, '$.lead_user_id') AS user_id
      FROM user_import_rows WHERE import_id = ? AND row_type = 'projects'
    UNION ALL
    SELECT json_extract(row_json, '$.assignee_user_id') AS user_id
      FROM user_import_rows WHERE import_id = ? AND row_type = 'tasks'
  ) WHERE user_id IS NOT NULL AND user_id <> ?`).bind(importId, importId, ownerUserId).all<{ user_id: string }>();
  for (const principal of principals.results) {
    const hasAccess = restoreSharing
      ? await db.prepare("SELECT 1 FROM user_import_rows WHERE import_id = ? AND row_type = 'sharing' AND json_extract(row_json, '$.grantee_user_id') = ?")
          .bind(importId, principal.user_id).first()
      : await db.prepare("SELECT 1 FROM access_grants WHERE resource_type = 'project' AND resource_id = ? AND grantee_user_id = ? AND revoked_at IS NULL")
          .bind(projectId, principal.user_id).first();
    if (!hasAccess) throw new ValidationError("Restore would assign a lead or task to a user without project access; enable sharing restore or update the project first");
  }
}
