import { getAttachmentBucket } from "@/db";
import { ValidationError } from "./domain";
import { attachmentStorageScope } from "./attachment-storage";
import type { BackupRow } from "./system-backup-format";

export const attachmentBackupEncoding = "base64" as const;

export type AttachmentBackupObject = {
  key: string;
  byteSize: number;
  checksumSha256: string;
  encoding: typeof attachmentBackupEncoding;
  data: string;
};

export type StagedAttachmentObject = {
  stagingKey: string;
  finalKey: string;
  checksumSha256: string;
  byteSize: number;
};

const backedStates = new Set(["ready", "deleted"]);

export async function collectAttachmentBackupObjects(
  rows: BackupRow[],
): Promise<{ rows: BackupRow[]; objects: AttachmentBackupObject[] }> {
  const bucket = getAttachmentBucket();
  const objects = new Map<string, AttachmentBackupObject>();
  const normalizedRows: BackupRow[] = [];

  for (const source of rows) {
    const state = String(source.state);
    if (state === "pending" || state === "uploading") {
      throw new ValidationError(
        "Attachment backup requires every upload to be settled",
      );
    }
    const row = { ...source };
    if (backedStates.has(state)) {
      const object = await bucket.get(String(source.object_key));
      if (!object) {
        throw new ValidationError(
          "Attachment backup found metadata without its original object",
        );
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      const checksumSha256 = await sha256Hex(bytes);
      const expectedChecksum = String(source.checksum_sha256);
      const expectedSize = Number(source.byte_size);
      if (
        bytes.byteLength !== expectedSize ||
        checksumSha256 !== expectedChecksum
      ) {
        throw new ValidationError(
          "Attachment backup found an object checksum or size mismatch",
        );
      }
      const key = logicalObjectKey(checksumSha256);
      row.object_key = key;
      if (!objects.has(key)) {
        objects.set(key, {
          key,
          byteSize: bytes.byteLength,
          checksumSha256,
          encoding: attachmentBackupEncoding,
          data: encodeBase64(bytes),
        });
      }
    } else {
      row.object_key = logicalMissingObjectKey(String(source.id));
    }
    normalizedRows.push(row);
  }

  return {
    rows: normalizedRows,
    objects: [...objects.values()].sort((left, right) =>
      left.key.localeCompare(right.key),
    ),
  };
}

export async function validateAttachmentBackupObjects(
  rows: BackupRow[],
  values: unknown,
): Promise<AttachmentBackupObject[]> {
  if (!Array.isArray(values)) {
    throw new ValidationError("Attachment backup objects must be an array");
  }
  const objects: AttachmentBackupObject[] = [];
  const byKey = new Map<string, AttachmentBackupObject>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidationError(`Attachment object ${index} must be an object`);
    }
    const source = value as Record<string, unknown>;
    const expected = ["key", "byteSize", "checksumSha256", "encoding", "data"];
    for (const field of expected) {
      if (!(field in source)) {
        throw new ValidationError(`Attachment object ${index} is missing ${field}`);
      }
    }
    for (const field of Object.keys(source)) {
      if (!expected.includes(field)) {
        throw new ValidationError(
          `Attachment object ${index} contains unsupported field ${field}`,
        );
      }
    }
    if (
      typeof source.key !== "string" ||
      typeof source.checksumSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.checksumSha256) ||
      source.key !== logicalObjectKey(source.checksumSha256) ||
      source.encoding !== attachmentBackupEncoding ||
      typeof source.data !== "string" ||
      !Number.isSafeInteger(source.byteSize) ||
      Number(source.byteSize) < 1
    ) {
      throw new ValidationError(`Attachment object ${index} has invalid metadata`);
    }
    if (byKey.has(source.key)) {
      throw new ValidationError(`Duplicate attachment object ${source.key}`);
    }
    const bytes = decodeBase64(source.data);
    if (
      bytes.byteLength !== Number(source.byteSize) ||
      (await sha256Hex(bytes)) !== source.checksumSha256
    ) {
      throw new ValidationError(
        `Attachment object ${index} checksum or size does not match`,
      );
    }
    const object: AttachmentBackupObject = {
      key: source.key,
      byteSize: Number(source.byteSize),
      checksumSha256: source.checksumSha256,
      encoding: attachmentBackupEncoding,
      data: source.data,
    };
    objects.push(object);
    byKey.set(object.key, object);
  }

  const referenced = new Set<string>();
  for (const row of rows) {
    const state = String(row.state);
    const key = String(row.object_key);
    if (backedStates.has(state)) {
      const object = byKey.get(key);
      if (!object) {
        throw new ValidationError(
          "Attachment metadata references a missing backup object",
        );
      }
      if (
        object.byteSize !== Number(row.byte_size) ||
        object.checksumSha256 !== String(row.checksum_sha256)
      ) {
        throw new ValidationError(
          "Attachment metadata does not match its backup object",
        );
      }
      referenced.add(key);
    } else if (!key.startsWith("missing:")) {
      throw new ValidationError(
        "Attachment without a durable object has an invalid backup reference",
      );
    }
  }
  for (const object of objects) {
    if (!referenced.has(object.key)) {
      throw new ValidationError("Attachment backup contains an unreferenced object");
    }
  }
  return objects.sort((left, right) => left.key.localeCompare(right.key));
}

export async function stageAttachmentBackupObjects(
  importId: string,
  rows: BackupRow[],
  objects: AttachmentBackupObject[],
): Promise<{ rows: BackupRow[]; staged: StagedAttachmentObject[] }> {
  const bucket = getAttachmentBucket();
  const objectMap = new Map(objects.map((object) => [object.key, object]));
  const stagingKeys = new Map<string, string>();
  const staged: StagedAttachmentObject[] = [];
  const rewrittenRows: BackupRow[] = [];
  try {
    for (const source of rows) {
      const row = { ...source };
      const logicalKey = String(source.object_key);
      const object = objectMap.get(logicalKey);
      const finalKey = `${attachmentStorageScope()}/attachments/${crypto.randomUUID()}`;
      row.object_key = finalKey;
      if (object) {
        let stagingKey = stagingKeys.get(logicalKey);
        if (!stagingKey) {
          stagingKey = `${attachmentStorageScope()}/backup-staging/${safeImportId(importId)}/${object.checksumSha256}`;
          const bytes = decodeBase64(object.data);
          await bucket.put(stagingKey, bytes, {
            customMetadata: {
              purpose: "attachment-backup-staging",
              checksumSha256: object.checksumSha256,
            },
          });
          stagingKeys.set(logicalKey, stagingKey);
        }
        staged.push({
          stagingKey,
          finalKey,
          checksumSha256: object.checksumSha256,
          byteSize: object.byteSize,
        });
      }
      rewrittenRows.push(row);
    }
    return { rows: rewrittenRows, staged };
  } catch (error) {
    await deleteAttachmentObjects(staged.map((object) => object.stagingKey));
    throw error;
  }
}

export async function materializeStagedAttachmentObjects(
  staged: StagedAttachmentObject[],
) {
  const bucket = getAttachmentBucket();
  const written: string[] = [];
  try {
    for (const descriptor of staged) {
      const object = await bucket.get(descriptor.stagingKey);
      if (!object) {
        throw new ValidationError("A staged attachment object is missing");
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (
        bytes.byteLength !== descriptor.byteSize ||
        (await sha256Hex(bytes)) !== descriptor.checksumSha256
      ) {
        throw new ValidationError(
          "A staged attachment object failed integrity verification",
        );
      }
      await bucket.put(descriptor.finalKey, bytes, {
        customMetadata: { checksumSha256: descriptor.checksumSha256 },
      });
      written.push(descriptor.finalKey);
    }
    return written;
  } catch (error) {
    await deleteAttachmentObjects(written);
    throw error;
  }
}

export async function deleteAttachmentObjects(keys: string[]) {
  const bucket = getAttachmentBucket();
  for (const key of [...new Set(keys)]) {
    await bucket.delete(key).catch(() => undefined);
  }
}

export function serializeStagedAttachmentObject(value: StagedAttachmentObject) {
  return JSON.stringify(value);
}

export function parseStagedAttachmentObject(value: unknown): StagedAttachmentObject {
  if (typeof value !== "string") {
    throw new ValidationError("Staged attachment object descriptor is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ValidationError("Staged attachment object descriptor is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("Staged attachment object descriptor is invalid");
  }
  const row = parsed as Record<string, unknown>;
  if (
    typeof row.stagingKey !== "string" ||
    typeof row.finalKey !== "string" ||
    typeof row.checksumSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.checksumSha256) ||
    !Number.isSafeInteger(row.byteSize) ||
    Number(row.byteSize) < 1
  ) {
    throw new ValidationError("Staged attachment object descriptor is invalid");
  }
  return {
    stagingKey: row.stagingKey,
    finalKey: row.finalKey,
    checksumSha256: row.checksumSha256,
    byteSize: Number(row.byteSize),
  };
}

function logicalObjectKey(checksum: string) {
  return `sha256:${checksum}`;
}

function logicalMissingObjectKey(attachmentId: string) {
  return `missing:${attachmentId}`;
}

function safeImportId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 160);
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new ValidationError("Attachment object data is not valid base64");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ValidationError("Attachment object data is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
