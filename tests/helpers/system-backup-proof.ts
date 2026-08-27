import assert from "node:assert/strict";
import {
  advanceSystemBackupJob,
  createSystemBackupImportJob,
  finalizeSystemBackupImport,
  uploadSystemBackupImportPart,
  type SystemBackupJobStatus,
} from "../../lib/system-backup-jobs";
import { systemBackupExactTableContracts } from "../../lib/system-backup-contract";
import {
  IncrementalSha256,
  base64ToBytes,
  canonicalJson,
  createObjectFrame,
  createPackageManifest,
  createRowsFrame,
  descriptorOf,
  sha256Hex,
  systemBackupObjectChunkBytes,
  targetSystemBackupPartBytes,
  type SystemBackupDataFrame,
  type SystemBackupObjectManifest,
  type SystemBackupPackageHeader,
  type SystemBackupPackageManifest,
} from "../../lib/system-backup-package";
import type { UserRecord } from "../../lib/types";

const encoder = new TextEncoder();

export type PortableBackupObject = Omit<
  SystemBackupObjectManifest,
  "ordinal" | "byteSize" | "sha256" | "firstPartIndex" | "partCount"
> & {
  bytes: Uint8Array;
};

export type PortableBackupSnapshot = {
  header: SystemBackupPackageHeader;
  rows: Record<string, Record<string, string | number | null>[]>;
  objects: PortableBackupObject[];
};

export type BuiltBackupPackage = PortableBackupSnapshot & {
  frames: SystemBackupDataFrame[];
  manifest: SystemBackupPackageManifest;
};

export async function driveSystemBackupJob(
  currentUser: UserRecord,
  jobId: string,
  terminal: string[],
  options: {
    max?: number;
    onStatus?: (status: SystemBackupJobStatus, step: number) => void | Promise<void>;
  } = {},
) {
  let status: SystemBackupJobStatus | undefined;
  for (let step = 0; step < (options.max ?? 5_000); step += 1) {
    status = await advanceSystemBackupJob(currentUser, jobId);
    await options.onStatus?.(status, step);
    if (terminal.includes(status.status)) return status;
    if (status.error?.startsWith("applied_state_mismatch:")) {
      throw new Error(status.error);
    }
  }
  throw new Error(
    `Job ${jobId} did not reach ${terminal.join("/")}; last=${status?.status}/${status?.phase}`,
  );
}

export async function parseSystemBackupPackage(response: Response): Promise<BuiltBackupPackage> {
  const lines = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(lines.length >= 2, "system backup package must contain header and manifest");
  const header = lines[0] as SystemBackupPackageHeader;
  const manifest = lines.at(-1) as SystemBackupPackageManifest;
  const frames = lines.slice(1, -1) as SystemBackupDataFrame[];
  const rows: PortableBackupSnapshot["rows"] = Object.fromEntries(
    systemBackupExactTableContracts.map((table) => [table.name, []]),
  );
  const objectChunks = new Map<number, Uint8Array[]>();
  for (const frame of frames) {
    if (frame.frame === "rows") {
      rows[frame.table]!.push(...frame.records);
    } else {
      const chunks = objectChunks.get(frame.ordinal) ?? [];
      chunks.push(base64ToBytes(frame.bytesBase64));
      objectChunks.set(frame.ordinal, chunks);
    }
  }
  const objects = manifest.objects.map((object) => ({
    logicalRef: object.logicalRef,
    namespace: object.namespace,
    boundKind: object.boundKind,
    orphan: object.orphan,
    bytes: concatenate(objectChunks.get(object.ordinal) ?? []),
  }));
  return { header, manifest, frames, rows, objects };
}

export async function buildSystemBackupPackage(
  source: PortableBackupSnapshot,
): Promise<BuiltBackupPackage> {
  const frames: SystemBackupDataFrame[] = [];
  const normalizedRows: PortableBackupSnapshot["rows"] = Object.fromEntries(
    systemBackupExactTableContracts.map((table) => [table.name, source.rows[table.name]?.map(cloneRow) ?? []]),
  );
  for (const table of systemBackupExactTableContracts) {
    const records = normalizedRows[table.name]!;
    let ordinal = 0;
    while (ordinal < records.length) {
      const chunk: typeof records = [];
      let bytes = 2;
      while (ordinal + chunk.length < records.length && chunk.length < 250) {
        const next = records[ordinal + chunk.length]!;
        const nextBytes = encoder.encode(canonicalJson(next)).byteLength + 1;
        if (chunk.length && bytes + nextBytes > targetSystemBackupPartBytes) break;
        chunk.push(next);
        bytes += nextBytes;
      }
      frames.push(await createRowsFrame({
        index: frames.length,
        table: table.name,
        ordinal,
        records: chunk,
      }));
      ordinal += chunk.length;
    }
  }

  const objects: PortableBackupObject[] = source.objects.map((object) => ({
    logicalRef: object.logicalRef,
    namespace: object.namespace,
    boundKind: object.boundKind,
    orphan: object.orphan,
    bytes: object.bytes.slice(),
  }));
  const objectManifest: SystemBackupObjectManifest[] = [];
  for (let ordinal = 0; ordinal < objects.length; ordinal += 1) {
    const object = objects[ordinal]!;
    const firstPartIndex = frames.length;
    const partCount = Math.max(1, Math.ceil(object.bytes.byteLength / systemBackupObjectChunkBytes));
    for (let chunk = 0; chunk < partCount; chunk += 1) {
      const start = chunk * systemBackupObjectChunkBytes;
      frames.push(await createObjectFrame({
        index: frames.length,
        objectOrdinal: ordinal,
        logicalRef: object.logicalRef,
        bytes: object.bytes.slice(start, Math.min(start + systemBackupObjectChunkBytes, object.bytes.byteLength)),
      }));
    }
    objectManifest.push({
      ordinal,
      logicalRef: object.logicalRef,
      namespace: object.namespace,
      byteSize: object.bytes.byteLength,
      sha256: await sha256Hex(object.bytes),
      boundKind: object.boundKind,
      orphan: object.orphan,
      firstPartIndex,
      partCount,
    });
  }

  const counts = Object.fromEntries(
    systemBackupExactTableContracts.map((table) => [table.name, normalizedRows[table.name]!.length]),
  );
  const state = new IncrementalSha256();
  state.update(encoder.encode(`schema:${source.header.schemaFingerprint}\n`));
  for (const table of systemBackupExactTableContracts) {
    normalizedRows[table.name]!.forEach((row, ordinal) => {
      state.update(encoder.encode(`${table.name}\0${ordinal}\0${canonicalJson(row)}\n`));
    });
  }
  for (const object of objectManifest) {
    state.update(encoder.encode(
      `object\0${object.logicalRef}\0${object.byteSize}\0${object.sha256}\n`,
    ));
  }
  const manifest = await createPackageManifest({
    schemaVersion: source.header.schemaVersion,
    schemaFingerprint: source.header.schemaFingerprint,
    siteOrigin: source.header.siteOrigin,
    environmentScope: source.header.environmentScope,
    exportedAt: source.header.exportedAt,
    counts,
    objects: objectManifest,
    parts: frames.map(descriptorOf),
    totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    totalBytes: frames.reduce((sum, frame) => sum + frame.byteLength, 0),
    stateSha256: state.digestHex(),
  });
  return { header: source.header, rows: normalizedRows, objects, frames, manifest };
}

export async function uploadSystemBackupPackage(
  currentUser: UserRecord,
  source: Pick<BuiltBackupPackage, "header" | "frames" | "manifest">,
) {
  const created = await createSystemBackupImportJob(currentUser, source.header);
  for (const frame of source.frames) {
    await uploadSystemBackupImportPart(currentUser, created.jobId, frame.index, frame);
  }
  await finalizeSystemBackupImport(currentUser, created.jobId, source.manifest);
  return created.jobId;
}

export function canonicalPortableState(source: PortableBackupSnapshot) {
  return {
    rows: Object.fromEntries(systemBackupExactTableContracts.map((table) => [
      table.name,
      (source.rows[table.name] ?? []).map(canonicalJson),
    ])),
    objects: source.objects.map((object) => ({
      logicalRef: object.logicalRef,
      namespace: object.namespace,
      boundKind: object.boundKind,
      orphan: object.orphan,
      byteSize: object.bytes.byteLength,
      sha256: null as string | null,
    })),
  };
}

export async function canonicalPortableStateWithDigests(source: PortableBackupSnapshot) {
  const canonical = canonicalPortableState(source);
  for (let index = 0; index < canonical.objects.length; index += 1) {
    canonical.objects[index]!.sha256 = await sha256Hex(source.objects[index]!.bytes);
  }
  return canonical;
}

export function clonePortableSnapshot(source: PortableBackupSnapshot): PortableBackupSnapshot {
  return {
    header: { ...source.header },
    rows: Object.fromEntries(Object.entries(source.rows).map(([table, rows]) => [
      table,
      rows.map(cloneRow),
    ])),
    objects: source.objects.map((object) => ({ ...object, bytes: object.bytes.slice() })),
  };
}

function cloneRow(row: Record<string, string | number | null>) {
  return { ...row };
}

function concatenate(chunks: Uint8Array[]) {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
