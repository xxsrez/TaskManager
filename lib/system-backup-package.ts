import { ValidationError } from "./domain";
import {
  systemBackupCurrentSchemaVersion,
  systemBackupD1TableContracts,
  systemBackupExactTableContracts,
  systemBackupR2ObjectClassContracts,
  systemBackupUnknownR2ObjectPolicy,
} from "./system-backup-contract";

export const systemBackupPackageFormat = "task-manager-system-backup" as const;
export const systemBackupPackageVersion = 2 as const;
export const systemBackupPackageMediaType =
  "application/vnd.task-manager.system-backup+ndjson";
export const maxSystemBackupPartBytes = 2_000_000;
export const maxSystemBackupRowBytes = 1_500_000;
export const targetSystemBackupPartBytes = 512_000;
export const systemBackupObjectChunkBytes = 384_000;

export type SystemBackupPartType = "rows" | "object";

export type SystemBackupPackageHeader = {
  format: typeof systemBackupPackageFormat;
  version: typeof systemBackupPackageVersion;
  frame: "header";
  schemaVersion: typeof systemBackupCurrentSchemaVersion;
  schemaFingerprint: string;
  siteOrigin: string;
  environmentScope: string;
  exportedAt: string;
};

export type SystemBackupPartDescriptor = {
  index: number;
  type: SystemBackupPartType;
  table: string | null;
  ordinal: number | null;
  logicalRef: string | null;
  byteLength: number;
  count: number;
  sha256: string;
};

export type SystemBackupRowsFrame = SystemBackupPartDescriptor & {
  format: typeof systemBackupPackageFormat;
  version: typeof systemBackupPackageVersion;
  frame: "rows";
  table: string;
  ordinal: number;
  logicalRef: null;
  records: Record<string, string | number | null>[];
};

export type SystemBackupObjectFrame = SystemBackupPartDescriptor & {
  format: typeof systemBackupPackageFormat;
  version: typeof systemBackupPackageVersion;
  frame: "object";
  table: null;
  ordinal: number;
  logicalRef: string;
  bytesBase64: string;
};

export type SystemBackupDataFrame =
  | SystemBackupRowsFrame
  | SystemBackupObjectFrame;

export type SystemBackupObjectManifest = {
  ordinal: number;
  logicalRef: string;
  namespace: "stored-files" | "attachments";
  byteSize: number;
  sha256: string;
  boundKind: "stored_file" | "legacy_attachment" | null;
  orphan: boolean;
  firstPartIndex: number;
  partCount: number;
};

export type SystemBackupPackageManifest = {
  format: typeof systemBackupPackageFormat;
  version: typeof systemBackupPackageVersion;
  frame: "manifest";
  schemaVersion: typeof systemBackupCurrentSchemaVersion;
  schemaFingerprint: string;
  siteOrigin: string;
  environmentScope: string;
  exportedAt: string;
  counts: Record<string, number>;
  objects: SystemBackupObjectManifest[];
  parts: SystemBackupPartDescriptor[];
  totalRows: number;
  totalBytes: number;
  stateSha256: string;
  rootSha256: string;
};

const encoder = new TextEncoder();

export async function systemBackupSchemaFingerprint(): Promise<string> {
  return sha256Hex(
    encoder.encode(
      canonicalJson({
        d1: systemBackupD1TableContracts.map((table) => ({
          name: table.name,
          columns: table.columns,
          policy: table.policy,
          columnPolicies: table.columnPolicies,
          shapes: "shapes" in table ? table.shapes ?? {} : {},
          reason: table.reason,
          ...("orderBy" in table ? {
            orderBy: table.orderBy,
            restoreOrder: table.restoreOrder,
            deleteOrder: table.deleteOrder,
          } : {}),
        })),
        r2: systemBackupR2ObjectClassContracts,
        unknownR2ObjectPolicy: systemBackupUnknownR2ObjectPolicy,
      }),
    ),
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export async function createRowsFrame(input: {
  index: number;
  table: string;
  ordinal: number;
  records: Record<string, string | number | null>[];
}): Promise<SystemBackupRowsFrame> {
  if (input.records.some((record) =>
    encoder.encode(canonicalJson(record)).byteLength > maxSystemBackupRowBytes)) {
    throw new ValidationError("System backup row exceeds the bounded row limit");
  }
  const payload = encoder.encode(canonicalJson(input.records));
  if (payload.byteLength > maxSystemBackupPartBytes) {
    throw new ValidationError("System backup row part exceeds the bounded part limit");
  }
  const descriptor = await createPartDescriptor({
    index: input.index,
    type: "rows",
    table: input.table,
    ordinal: input.ordinal,
    logicalRef: null,
    byteLength: payload.byteLength,
    count: input.records.length,
    payload,
  });
  return {
    format: systemBackupPackageFormat,
    version: systemBackupPackageVersion,
    frame: "rows",
    ...descriptor,
    table: input.table,
    ordinal: input.ordinal,
    logicalRef: null,
    records: input.records,
  };
}

export async function createObjectFrame(input: {
  index: number;
  objectOrdinal: number;
  logicalRef: string;
  bytes: Uint8Array;
}): Promise<SystemBackupObjectFrame> {
  if (input.bytes.byteLength > systemBackupObjectChunkBytes) {
    throw new ValidationError("System backup object chunk exceeds the bounded part limit");
  }
  const descriptor = await createPartDescriptor({
    index: input.index,
    type: "object",
    table: null,
    ordinal: input.objectOrdinal,
    logicalRef: input.logicalRef,
    byteLength: input.bytes.byteLength,
    count: 1,
    payload: input.bytes,
  });
  return {
    format: systemBackupPackageFormat,
    version: systemBackupPackageVersion,
    frame: "object",
    ...descriptor,
    table: null,
    ordinal: input.objectOrdinal,
    logicalRef: input.logicalRef,
    bytesBase64: bytesToBase64(input.bytes),
  };
}

export async function validateDataFrame(
  value: unknown,
): Promise<{ frame: SystemBackupDataFrame; payload: Uint8Array }> {
  const frame = record(value, "Backup part");
  if (
    frame.format !== systemBackupPackageFormat ||
    frame.version !== systemBackupPackageVersion ||
    (frame.frame !== "rows" && frame.frame !== "object")
  ) {
    throw new ValidationError("Unsupported system backup part");
  }
  const index = nonNegativeInteger(frame.index, "part index");
  const byteLength = nonNegativeInteger(frame.byteLength, "part byte length");
  const count = nonNegativeInteger(frame.count, "part count");
  const claimedDigest = digest(frame.sha256, "part sha256");
  let normalized: SystemBackupDataFrame;
  let payload: Uint8Array;
  if (frame.frame === "rows") {
    const table = requiredString(frame.table, "part table");
    if (!systemBackupExactTableContracts.some((candidate) => candidate.name === table)) {
      throw new ValidationError(`Unknown system backup table ${table}`);
    }
    const ordinal = nonNegativeInteger(frame.ordinal, "row ordinal");
    if (!Array.isArray(frame.records) || frame.records.length !== count || frame.logicalRef !== null) {
      throw new ValidationError("Malformed system backup row part");
    }
    payload = encoder.encode(canonicalJson(frame.records));
    if ((frame.records as unknown[]).some((record) =>
      encoder.encode(canonicalJson(record)).byteLength > maxSystemBackupRowBytes)) {
      throw new ValidationError("System backup row exceeds the bounded row limit");
    }
    normalized = {
      format: systemBackupPackageFormat,
      version: systemBackupPackageVersion,
      frame: "rows",
      index,
      type: "rows",
      table,
      ordinal,
      logicalRef: null,
      byteLength,
      count,
      sha256: claimedDigest,
      records: frame.records as Record<string, string | number | null>[],
    };
  } else {
    if (frame.table !== null) throw new ValidationError("Malformed system backup object part");
    const ordinal = nonNegativeInteger(frame.ordinal, "object ordinal");
    const logicalRef = validateLogicalObjectRef(frame.logicalRef);
    if (count !== 1) throw new ValidationError("Object part count must be one");
    payload = base64ToBytes(requiredString(frame.bytesBase64, "object bytes"));
    normalized = {
      format: systemBackupPackageFormat,
      version: systemBackupPackageVersion,
      frame: "object",
      index,
      type: "object",
      table: null,
      ordinal,
      logicalRef,
      byteLength,
      count,
      sha256: claimedDigest,
      bytesBase64: requiredString(frame.bytesBase64, "object bytes"),
    };
  }
  if (payload.byteLength !== byteLength || payload.byteLength > maxSystemBackupPartBytes) {
    throw new ValidationError("System backup part length does not match its payload");
  }
  const descriptor = descriptorOf(normalized);
  const actual = await digestPart({
    index: descriptor.index,
    type: descriptor.type,
    table: descriptor.table,
    ordinal: descriptor.ordinal,
    logicalRef: descriptor.logicalRef,
    byteLength: descriptor.byteLength,
    count: descriptor.count,
  }, payload);
  if (actual !== claimedDigest) throw new ValidationError("System backup part checksum does not match");
  return { frame: normalized, payload };
}

export async function createPackageManifest(input: Omit<
  SystemBackupPackageManifest,
  "format" | "version" | "frame" | "rootSha256"
>): Promise<SystemBackupPackageManifest> {
  validatePartSequence(input.parts);
  validateObjectManifest(input.objects, input.parts);
  const body = {
    format: systemBackupPackageFormat,
    version: systemBackupPackageVersion,
    frame: "manifest" as const,
    ...input,
  };
  return { ...body, rootSha256: await sha256Hex(encoder.encode(canonicalJson(body))) };
}

export async function validatePackageManifest(
  value: unknown,
): Promise<SystemBackupPackageManifest> {
  const manifest = record(value, "Backup manifest");
  if (
    manifest.format !== systemBackupPackageFormat ||
    manifest.version !== systemBackupPackageVersion ||
    manifest.frame !== "manifest" ||
    manifest.schemaVersion !== systemBackupCurrentSchemaVersion
  ) {
    throw new ValidationError(
      `Unsupported Task Manager system backup; only schema ${systemBackupCurrentSchemaVersion} is accepted`,
    );
  }
  const parts = array(manifest.parts, "manifest parts").map(normalizeDescriptor);
  const objects = array(manifest.objects, "manifest objects").map((value) => {
    const item = record(value, "manifest object");
    const namespace = item.namespace;
    if (namespace !== "stored-files" && namespace !== "attachments") {
      throw new ValidationError("Unknown system backup object namespace");
    }
    return {
      ordinal: nonNegativeInteger(item.ordinal, "object ordinal"),
      logicalRef: validateLogicalObjectRef(item.logicalRef),
      namespace,
      byteSize: nonNegativeInteger(item.byteSize, "object byte size"),
      sha256: digest(item.sha256, "object sha256"),
      boundKind:
        item.boundKind === null || item.boundKind === "stored_file" || item.boundKind === "legacy_attachment"
          ? item.boundKind
          : (() => { throw new ValidationError("Unknown object binding kind"); })(),
      orphan: booleanValue(item.orphan, "object orphan flag"),
      firstPartIndex: nonNegativeInteger(item.firstPartIndex, "first object part"),
      partCount: nonNegativeInteger(item.partCount, "object part count"),
    } satisfies SystemBackupObjectManifest;
  });
  const countsRecord = record(manifest.counts, "manifest counts");
  const counts: Record<string, number> = {};
  for (const table of systemBackupExactTableContracts) {
    counts[table.name] = nonNegativeInteger(countsRecord[table.name], `count ${table.name}`);
  }
  if (Object.keys(countsRecord).length !== systemBackupExactTableContracts.length) {
    throw new ValidationError("System backup manifest has an unknown or missing table count");
  }
  const normalized = {
    format: systemBackupPackageFormat,
    version: systemBackupPackageVersion,
    frame: "manifest" as const,
    schemaVersion: systemBackupCurrentSchemaVersion,
    schemaFingerprint: digest(manifest.schemaFingerprint, "schema fingerprint"),
    siteOrigin: normalizeOrigin(manifest.siteOrigin),
    environmentScope: requiredString(manifest.environmentScope, "environment scope"),
    exportedAt: timestamp(manifest.exportedAt, "exported at"),
    counts,
    objects,
    parts,
    totalRows: nonNegativeInteger(manifest.totalRows, "total rows"),
    totalBytes: nonNegativeInteger(manifest.totalBytes, "total bytes"),
    stateSha256: digest(manifest.stateSha256, "state sha256"),
  };
  validatePartSequence(parts);
  validateObjectManifest(objects, parts);
  for (const table of systemBackupExactTableContracts) {
    const framed = parts
      .filter((part) => part.type === "rows" && part.table === table.name)
      .reduce((sum, part) => sum + part.count, 0);
    if (framed !== counts[table.name]) {
      throw new ValidationError(`Row parts do not match count for ${table.name}`);
    }
  }
  if (Object.values(counts).reduce((sum, value) => sum + value, 0) !== normalized.totalRows) {
    throw new ValidationError("System backup total row count does not match table counts");
  }
  if (parts.reduce((sum, part) => sum + part.byteLength, 0) !== normalized.totalBytes) {
    throw new ValidationError("System backup total byte count does not match its parts");
  }
  const expectedRoot = await sha256Hex(encoder.encode(canonicalJson(normalized)));
  if (digest(manifest.rootSha256, "root sha256") !== expectedRoot) {
    throw new ValidationError("System backup root checksum does not match its manifest");
  }
  return { ...normalized, rootSha256: expectedRoot };
}

export function descriptorOf(frame: SystemBackupDataFrame): SystemBackupPartDescriptor {
  return {
    index: frame.index,
    type: frame.type,
    table: frame.table,
    ordinal: frame.ordinal,
    logicalRef: frame.logicalRef,
    byteLength: frame.byteLength,
    count: frame.count,
    sha256: frame.sha256,
  };
}

export function encodePackageLine(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

export async function validatePackageHeader(
  value: unknown,
): Promise<SystemBackupPackageHeader> {
  const header = record(value, "Backup header");
  if (
    header.format !== systemBackupPackageFormat ||
    header.version !== systemBackupPackageVersion ||
    header.frame !== "header" ||
    header.schemaVersion !== systemBackupCurrentSchemaVersion
  ) {
    throw new ValidationError(
      `Unsupported Task Manager system backup; only schema ${systemBackupCurrentSchemaVersion} is accepted`,
    );
  }
  const normalized: SystemBackupPackageHeader = {
    format: systemBackupPackageFormat,
    version: systemBackupPackageVersion,
    frame: "header",
    schemaVersion: systemBackupCurrentSchemaVersion,
    schemaFingerprint: digest(header.schemaFingerprint, "schema fingerprint"),
    siteOrigin: normalizeOrigin(header.siteOrigin),
    environmentScope: requiredString(header.environmentScope, "environment scope"),
    exportedAt: timestamp(header.exportedAt, "exported at"),
  };
  if (normalized.schemaFingerprint !== await systemBackupSchemaFingerprint()) {
    throw new ValidationError("System backup schema fingerprint does not match this release");
  }
  return normalized;
}

export function validateLogicalObjectRef(value: unknown): string {
  const ref = requiredString(value, "object logical ref");
  if (
    ref.length > 900 ||
    (!ref.startsWith("stored-files/") && !ref.startsWith("attachments/")) ||
    ref.includes("//") ||
    ref.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ValidationError("Invalid system backup object logical ref");
  }
  return ref;
}

export class IncrementalSha256 {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private tail = new Uint8Array(0);
  private bytes = 0;

  update(chunk: Uint8Array) {
    this.bytes += chunk.byteLength;
    const combined = new Uint8Array(this.tail.byteLength + chunk.byteLength);
    combined.set(this.tail);
    combined.set(chunk, this.tail.byteLength);
    const complete = combined.byteLength - (combined.byteLength % 64);
    for (let offset = 0; offset < complete; offset += 64) {
      this.compress(combined.subarray(offset, offset + 64));
    }
    this.tail = combined.slice(complete);
    return this;
  }

  snapshot(): string {
    return JSON.stringify({
      state: Array.from(this.state),
      tail: bytesToBase64(this.tail),
      bytes: this.bytes,
    });
  }

  static fromSnapshot(value: string | null | undefined): IncrementalSha256 {
    const hasher = new IncrementalSha256();
    if (!value) return hasher;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ValidationError("Invalid persisted SHA-256 state");
    }
    const source = record(parsed, "SHA-256 state");
    if (!Array.isArray(source.state) || source.state.length !== 8) {
      throw new ValidationError("Invalid persisted SHA-256 words");
    }
    const words = source.state.map((word) => nonNegativeInteger(word, "SHA-256 word"));
    if (words.some((word) => word > 0xffff_ffff)) throw new ValidationError("Invalid persisted SHA-256 word");
    hasher.state = new Uint32Array(words);
    if (typeof source.tail !== "string") {
      throw new ValidationError("SHA-256 tail must be a base64 string");
    }
    hasher.tail = base64ToBytes(source.tail) as Uint8Array<ArrayBuffer>;
    if (hasher.tail.byteLength >= 64) throw new ValidationError("Invalid persisted SHA-256 tail");
    hasher.bytes = nonNegativeInteger(source.bytes, "SHA-256 byte count");
    return hasher;
  }

  digestHex(): string {
    const clone = IncrementalSha256.fromSnapshot(this.snapshot());
    return clone.finalizeHex();
  }

  private finalizeHex(): string {
    const bitLength = this.bytes * 8;
    const paddingLength = this.tail.byteLength < 56
      ? 64 - this.tail.byteLength
      : 128 - this.tail.byteLength;
    const final = new Uint8Array(this.tail.byteLength + paddingLength);
    final.set(this.tail);
    final[this.tail.byteLength] = 0x80;
    const view = new DataView(final.buffer);
    view.setUint32(final.byteLength - 8, Math.floor(bitLength / 0x1_0000_0000));
    view.setUint32(final.byteLength - 4, bitLength >>> 0);
    for (let offset = 0; offset < final.byteLength; offset += 64) {
      this.compress(final.subarray(offset, offset + 64));
    }
    return Array.from(this.state, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(block: Uint8Array) {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]!;
      const b = words[index - 2]!;
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + s1 + choose + SHA256_K[index]! + words[index]!) >>> 0;
      const s0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a!) >>> 0;
    this.state[1] = (this.state[1]! + b!) >>> 0;
    this.state[2] = (this.state[2]! + c!) >>> 0;
    this.state[3] = (this.state[3]! + d!) >>> 0;
    this.state[4] = (this.state[4]! + e!) >>> 0;
    this.state[5] = (this.state[5]! + f!) >>> 0;
    this.state[6] = (this.state[6]! + g!) >>> 0;
    this.state[7] = (this.state[7]! + h!) >>> 0;
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digestValue = await crypto.subtle.digest("SHA-256", input.buffer);
  return Array.from(new Uint8Array(digestValue), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  const step = 32_768;
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(output);
}

export function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ValidationError("System backup object chunk is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function createPartDescriptor(input: Omit<SystemBackupPartDescriptor, "sha256"> & {
  payload: Uint8Array;
}): Promise<SystemBackupPartDescriptor> {
  const descriptor = {
    index: input.index,
    type: input.type,
    table: input.table,
    ordinal: input.ordinal,
    logicalRef: input.logicalRef,
    byteLength: input.byteLength,
    count: input.count,
  };
  return { ...descriptor, sha256: await digestPart(descriptor, input.payload) };
}

async function digestPart(
  descriptor: Omit<SystemBackupPartDescriptor, "sha256">,
  payload: Uint8Array,
): Promise<string> {
  const metadata = encoder.encode(canonicalJson(descriptor));
  const digestInput = new Uint8Array(metadata.byteLength + 1 + payload.byteLength);
  digestInput.set(metadata);
  digestInput[metadata.byteLength] = 0;
  digestInput.set(payload, metadata.byteLength + 1);
  return sha256Hex(digestInput);
}

function normalizeDescriptor(value: unknown): SystemBackupPartDescriptor {
  const descriptor = record(value, "part descriptor");
  const type = descriptor.type;
  if (type !== "rows" && type !== "object") throw new ValidationError("Unknown backup part type");
  return {
    index: nonNegativeInteger(descriptor.index, "part index"),
    type,
    table: descriptor.table === null ? null : requiredString(descriptor.table, "part table"),
    ordinal: descriptor.ordinal === null ? null : nonNegativeInteger(descriptor.ordinal, "part ordinal"),
    logicalRef: descriptor.logicalRef === null ? null : validateLogicalObjectRef(descriptor.logicalRef),
    byteLength: nonNegativeInteger(descriptor.byteLength, "part byte length"),
    count: nonNegativeInteger(descriptor.count, "part count"),
    sha256: digest(descriptor.sha256, "part sha256"),
  };
}

function validatePartSequence(parts: SystemBackupPartDescriptor[]) {
  const tableOrdinals = new Map<string, number>();
  const tableIndexes = new Map<string, number>(
    systemBackupExactTableContracts.map((table, index) => [table.name, index]),
  );
  let currentTableIndex = 0;
  let objectPartsStarted = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.index !== index) throw new ValidationError("System backup parts are missing, duplicated, or out of order");
    if (part.type === "rows") {
      if (!part.table || part.ordinal === null || part.logicalRef !== null || part.count < 1) {
        throw new ValidationError("Malformed row part descriptor");
      }
      const tableIndex = tableIndexes.get(part.table);
      if (tableIndex === undefined) throw new ValidationError(`Unknown system backup table ${part.table}`);
      if (objectPartsStarted || tableIndex < currentTableIndex) {
        throw new ValidationError("System backup row tables or object parts are out of canonical order");
      }
      currentTableIndex = tableIndex;
      const expected = tableOrdinals.get(part.table) ?? 0;
      if (part.ordinal !== expected) throw new ValidationError(`Rows for ${part.table} are missing, duplicated, or out of order`);
      tableOrdinals.set(part.table, expected + part.count);
    } else {
      objectPartsStarted = true;
      if (part.table !== null || part.ordinal === null || !part.logicalRef || part.count !== 1) {
        throw new ValidationError("Malformed object part descriptor");
      }
    }
  }
  for (const table of systemBackupExactTableContracts) {
    if (!tableOrdinals.has(table.name)) tableOrdinals.set(table.name, 0);
  }
}

function validateObjectManifest(
  objects: SystemBackupObjectManifest[],
  parts: SystemBackupPartDescriptor[],
) {
  const refs = new Set<string>();
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index]!;
    if (object.ordinal !== index || refs.has(object.logicalRef)) {
      throw new ValidationError("System backup objects are duplicated or out of order");
    }
    refs.add(object.logicalRef);
    const objectParts = parts.slice(object.firstPartIndex, object.firstPartIndex + object.partCount);
    if (
      objectParts.length !== object.partCount ||
      objectParts.some((part) =>
        part.type !== "object" ||
        part.ordinal !== object.ordinal ||
        part.logicalRef !== object.logicalRef)
    ) {
      throw new ValidationError(`Object ${object.logicalRef} has missing, extra, or out-of-order chunks`);
    }
    if (objectParts.reduce((sum, part) => sum + part.byteLength, 0) !== object.byteSize) {
      throw new ValidationError(`Object ${object.logicalRef} byte size does not match its chunks`);
    }
  }
  const objectPartCount = parts.filter((part) => part.type === "object").length;
  if (objects.reduce((sum, object) => sum + object.partCount, 0) !== objectPartCount) {
    throw new ValidationError("System backup has extra object chunks");
  }
}

function rotate(value: number, amount: number) {
  return (value >>> amount) | (value << (32 - amount));
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ValidationError(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a non-negative integer`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`${label} must be a boolean`);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new ValidationError(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new ValidationError(`${label} must be a timestamp`);
  return result;
}

function normalizeOrigin(value: unknown): string {
  const source = requiredString(value, "site origin");
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new ValidationError("Site origin is invalid");
  }
  if (url.origin !== source || !/^https?:$/.test(url.protocol)) {
    throw new ValidationError("Site origin must be an absolute origin");
  }
  return url.origin;
}
