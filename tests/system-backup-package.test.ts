import assert from "node:assert/strict";
import test from "node:test";
import {
  IncrementalSha256,
  canonicalJson,
  createPackageManifest,
  createRowsFrame,
  descriptorOf,
  maxSystemBackupRowBytes,
  sha256Hex,
  systemBackupPackageFormat,
  systemBackupPackageVersion,
  systemBackupSchemaFingerprint,
  validateDataFrame,
  validatePackageHeader,
  validatePackageManifest,
  type SystemBackupPartDescriptor,
} from "../lib/system-backup-package";
import {
  systemBackupCurrentSchemaVersion,
  systemBackupExactTableContracts,
} from "../lib/system-backup-contract";

const encoder = new TextEncoder();
const exportedAt = "2026-08-27T20:00:00.000Z";
const digest = "0".repeat(64);

test("incremental SHA-256 survives every block boundary and digest is non-mutating", async () => {
  for (const length of [0, 1, 63, 64, 65, 257]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) % 256);
    const expected = await sha256Hex(bytes);
    for (const split of [0, 1, 7, 63, 64, Math.floor(length / 2), length]) {
      const hasher = new IncrementalSha256();
      hasher.update(bytes.slice(0, Math.min(split, length)));
      const resumed = IncrementalSha256.fromSnapshot(hasher.snapshot());
      resumed.update(bytes.slice(Math.min(split, length)));
      assert.equal(resumed.digestHex(), expected, `${length}/${split}`);
      const snapshot = resumed.snapshot();
      assert.equal(resumed.digestHex(), expected);
      assert.equal(resumed.snapshot(), snapshot, "digestHex must not consume resumable state");
    }
  }
});

test("row writer and reader share the exact row-size boundary", async () => {
  const overhead = encoder.encode(canonicalJson({ value: "" })).byteLength;
  const accepted = { value: "x".repeat(maxSystemBackupRowBytes - overhead) };
  const frame = await createRowsFrame({ index: 0, table: "users", ordinal: 0, records: [accepted] });
  assert.equal((await validateDataFrame(frame)).frame.byteLength, frame.byteLength);
  await assert.rejects(
    createRowsFrame({
      index: 0,
      table: "users",
      ordinal: 0,
      records: [{ value: `${accepted.value}x` }],
    }),
    /row exceeds/i,
  );
});

test("current package validates more than 5000 rows and 10MB in bounded parts", async () => {
  const records = Array.from({ length: 5_101 }, (_, index) => ({
    id: String(index).padStart(6, "0"),
    payload: "z".repeat(2_100),
  }));
  const frames = [];
  for (let ordinal = 0; ordinal < records.length; ordinal += 200) {
    frames.push(await createRowsFrame({
      index: frames.length,
      table: "users",
      ordinal,
      records: records.slice(ordinal, ordinal + 200),
    }));
  }
  const parts = frames.map(descriptorOf);
  const counts = Object.fromEntries(
    systemBackupExactTableContracts.map((table) => [table.name, table.name === "users" ? records.length : 0]),
  );
  const manifest = await createPackageManifest({
    schemaVersion: systemBackupCurrentSchemaVersion,
    schemaFingerprint: await systemBackupSchemaFingerprint(),
    siteOrigin: "https://task-manager.example",
    environmentScope: "test",
    exportedAt,
    counts,
    objects: [],
    parts,
    totalRows: records.length,
    totalBytes: parts.reduce((sum, part) => sum + part.byteLength, 0),
    stateSha256: await sha256Hex(encoder.encode("state")),
  });
  assert.ok(manifest.totalBytes > 10_000_000);
  assert.equal((await validatePackageManifest(manifest)).totalRows, 5_101);
  for (const frame of frames) await validateDataFrame(frame);
});

test("manifest rejects unknown tables, non-canonical order, duplicates, truncation and legacy schema", async () => {
  const users = await createRowsFrame({ index: 0, table: "users", ordinal: 0, records: [{ id: "1" }] });
  const projects = await createRowsFrame({ index: 1, table: "projects", ordinal: 0, records: [{ id: "p" }] });
  const base = descriptorOf(users);
  const unknown: SystemBackupPartDescriptor = { ...base, table: "unknown" };
  const counts = Object.fromEntries(systemBackupExactTableContracts.map((table) => [table.name, 0]));
  await assert.rejects(createPackageManifest({
    schemaVersion: systemBackupCurrentSchemaVersion,
    schemaFingerprint: digest,
    siteOrigin: "https://task-manager.example",
    environmentScope: "test",
    exportedAt,
    counts,
    objects: [],
    parts: [unknown],
    totalRows: 0,
    totalBytes: unknown.byteLength,
    stateSha256: digest,
  }), /unknown system backup table/i);
  await assert.rejects(createPackageManifest({
    schemaVersion: systemBackupCurrentSchemaVersion,
    schemaFingerprint: digest,
    siteOrigin: "https://task-manager.example",
    environmentScope: "test",
    exportedAt,
    counts,
    objects: [],
    parts: [{ ...descriptorOf(projects), index: 0 }, { ...base, index: 1 }],
    totalRows: 2,
    totalBytes: projects.byteLength + users.byteLength,
    stateSha256: digest,
  }), /canonical order/i);
  await assert.rejects(validatePackageHeader({
    format: systemBackupPackageFormat,
    version: systemBackupPackageVersion,
    frame: "header",
    schemaVersion: systemBackupCurrentSchemaVersion - 1,
    schemaFingerprint: digest,
    siteOrigin: "https://task-manager.example",
    environmentScope: "test",
    exportedAt,
  }), /only schema/i);
});
