import { getAttachmentBucket } from "@/db";
import { attachmentStorageScope } from "./attachment-storage";

type DbRow = Record<string, unknown>;

export type AttachmentStorageOwnershipScan = {
  objectCount: number;
  objectBytes: number;
  stagingObjectCount: number;
  orphanObjectCount: number | null;
  truncated: boolean;
};

export async function scanAttachmentStorageOwnership(
  db: D1Database,
  maxObjects = 2_000,
): Promise<AttachmentStorageOwnershipScan> {
  const limit = Math.min(10_000, Math.max(1, Math.trunc(maxObjects)));
  const [liveRows, adminStagedRows, userStagedRows] = await db.batch([
    db.prepare(`SELECT object_key FROM stored_files
      WHERE state IN ('uploading', 'ready', 'failed', 'deleted')
      UNION
      SELECT object_key FROM attachments
      WHERE stored_file_id IS NULL AND state IN ('pending', 'uploading', 'ready', 'failed', 'deleted')
      ORDER BY object_key LIMIT ?`)
      .bind(limit + 1),
    db.prepare(`SELECT json_extract(r.row_json, '$.stagingKey') AS object_key
      FROM admin_import_rows r
      JOIN admin_import_sessions s ON s.id = r.import_id
      WHERE r.table_name = '__attachment_objects'
        AND s.status IN ('staged', 'applying')
      ORDER BY object_key LIMIT ?`).bind(limit + 1),
    db.prepare(`SELECT json_extract(r.row_json, '$.stagingKey') AS object_key
      FROM user_import_rows r
      JOIN user_import_sessions s ON s.id = r.import_id
      WHERE r.row_type = '__attachment_objects'
        AND s.status IN ('uploading', 'staged', 'applying')
      ORDER BY object_key LIMIT ?`).bind(limit + 1),
  ]);
  const liveKeys = new Set(
    (liveRows.results as DbRow[])
      .slice(0, limit)
      .map((row) => String(row.object_key)),
  );
  const stagedKeys = new Set(
    [
      ...(adminStagedRows.results as DbRow[]),
      ...(userStagedRows.results as DbRow[]),
    ]
      .slice(0, limit)
      .map((row) => String(row.object_key)),
  );
  const scope = attachmentStorageScope();
  const [legacyObjects, storedFileObjects, stagingObjects] = await Promise.all([
    listObjects(`${scope}/attachments/`, limit),
    listObjects(`${scope}/stored-files/`, limit),
    listObjects(`${scope}/backup-staging/`, limit),
  ]);
  const truncated =
    liveRows.results.length > limit ||
    adminStagedRows.results.length > limit ||
    userStagedRows.results.length > limit ||
    adminStagedRows.results.length + userStagedRows.results.length > limit ||
    legacyObjects.truncated ||
    storedFileObjects.truncated ||
    stagingObjects.truncated;
  const liveObjects = [...legacyObjects.items, ...storedFileObjects.items];
  const objects = [...liveObjects, ...stagingObjects.items];
  return {
    objectCount: objects.length,
    objectBytes: objects.reduce((total, object) => total + object.size, 0),
    stagingObjectCount: stagingObjects.items.length,
    orphanObjectCount: truncated
      ? null
      : liveObjects.filter((object) => !liveKeys.has(object.key)).length +
        stagingObjects.items.filter((object) => !stagedKeys.has(object.key)).length,
    truncated,
  };
}

async function listObjects(prefix: string, maxObjects: number) {
  const items: Array<{ key: string; size: number }> = [];
  let cursor: string | undefined;
  let truncated = false;
  do {
    const page = await getAttachmentBucket().list({
      prefix,
      limit: Math.min(1_000, maxObjects + 1 - items.length),
      ...(cursor ? { cursor } : {}),
    });
    items.push(
      ...page.objects.map((object) => ({ key: object.key, size: object.size })),
    );
    cursor = page.truncated ? page.cursor : undefined;
    if (items.length > maxObjects) {
      truncated = true;
      break;
    }
  } while (cursor);
  return {
    items: items.slice(0, maxObjects),
    truncated: truncated || Boolean(cursor),
  };
}
