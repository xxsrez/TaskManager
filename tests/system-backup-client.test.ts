import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SystemBackupClientError,
  canApplySystemBackupImport,
  createSystemBackupExport,
  readBackupCheckpoint,
  readSystemBackupFrames,
  retainBackupCheckpoint,
  runSystemBackupJob,
  safeBackupMessage,
  safeSystemBackupDownloadUrl,
  uploadSystemBackupPackage,
  writeBackupCheckpoint,
  type BackupRequest,
  type StorageLike,
  type SystemBackupCheckpoint,
} from "../lib/system-backup-client";
import type { SystemBackupJobStatus } from "../lib/types";
import { SystemBackupPreview } from "../components/task-tracker";

function job(
  overrides: Partial<SystemBackupJobStatus> = {},
): SystemBackupJobStatus {
  return {
    jobId: "system-import:11111111-1111-4111-8111-111111111111",
    kind: "import",
    status: "uploading",
    phase: "uploading",
    schemaVersion: 15,
    schemaFingerprint: "a".repeat(64),
    exportedAt: "2026-08-27T20:00:00.000Z",
    rootSha256: null,
    stateSha256: null,
    counts: {},
    progress: { rows: 0, bytes: 0, parts: 0, nextPartIndex: 0 },
    rollbackJobId: null,
    cleanupPending: false,
    error: null,
    format: {
      name: "task-manager-system-backup",
      version: 2,
      schemaVersion: 15,
      schemaFingerprint: "a".repeat(64),
    },
    siteOrigin: "https://task-manager-uat.example.test",
    environmentScope: "uat:attachments",
    r2: { objects: 0, bytes: 0, bound: 0, unbound: 0, orphan: 0, namespaces: {} },
    policies: { exact: [], rebuild: [], reset: [], revoke: [], excluded: [] },
    warnings: [],
    validationErrors: [],
    expiresAt: "2026-08-28T20:00:00.000Z",
    downloadUrl: null,
    ...overrides,
  };
}

const header = {
  format: "task-manager-system-backup",
  version: 2,
  frame: "header",
  schemaVersion: 15,
  schemaFingerprint: "a".repeat(64),
  siteOrigin: "https://task-manager-uat.example.test",
  environmentScope: "uat:attachments",
  exportedAt: "2026-08-27T20:00:00.000Z",
};

function rowPart(index: number) {
  return {
    format: "task-manager-system-backup",
    version: 2,
    frame: "rows",
    index,
    type: "rows",
    table: "users",
    ordinal: index,
    logicalRef: null,
    byteLength: 2,
    count: 0,
    sha256: "b".repeat(64),
    records: [],
  };
}

function manifest(partCount: number) {
  return {
    format: "task-manager-system-backup",
    version: 2,
    frame: "manifest",
    schemaVersion: 15,
    schemaFingerprint: "a".repeat(64),
    siteOrigin: "https://task-manager-uat.example.test",
    environmentScope: "uat:attachments",
    exportedAt: "2026-08-27T20:00:00.000Z",
    counts: { users: 0 },
    objects: [],
    parts: Array.from({ length: partCount }, (_, index) => rowPart(index)),
    totalRows: 0,
    totalBytes: 0,
    stateSha256: "c".repeat(64),
    rootSha256: "d".repeat(64),
  };
}

function backupFile(frames: unknown[], name = "full.tmbak") {
  return new File(
    [frames.map((frame) => JSON.stringify(frame)).join("\n")],
    name,
    { type: "application/vnd.task-manager.system-backup+ndjson", lastModified: 42 },
  );
}

test("bounded NDJSON reader emits header, parts, and manifest without file.text", async () => {
  const frames = [];
  for await (const frame of readSystemBackupFrames(backupFile([header, rowPart(0), manifest(1)]))) {
    frames.push(frame);
  }
  assert.deepEqual(frames.map((frame) => frame.frame), ["header", "rows", "manifest"]);

  await assert.rejects(
    async () => {
      for await (const frame of readSystemBackupFrames(new Blob([`${JSON.stringify(header)}\n{broken`]))) void frame;
    },
    (error: unknown) => error instanceof SystemBackupClientError
      && error.code === "bad_file"
      && /повреждена/.test(error.message),
  );
});

test("chunked import retries one transient part, finalizes, and advances validation", async () => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  let partAttempts = 0;
  const request: BackupRequest = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: String(init.body ?? "") });
    if (url === "/api/admin/import/validate") return Response.json(job());
    if (url.includes("/parts/0")) {
      partAttempts += 1;
      if (partAttempts === 1) return Response.json({ error: "temporary" }, { status: 503 });
      return Response.json(job({ progress: { rows: 0, bytes: 2, parts: 1, nextPartIndex: 1 } }));
    }
    if (url.endsWith("/finalize")) {
      return Response.json(job({ status: "running", phase: "validating_parts", progress: { rows: 0, bytes: 2, parts: 1, nextPartIndex: 1 } }));
    }
    if (url.endsWith("/advance")) {
      return Response.json(job({
        status: "ready",
        phase: "ready",
        rootSha256: "d".repeat(64),
        stateSha256: "c".repeat(64),
        counts: { users: 0 },
        progress: { rows: 0, bytes: 2, parts: 1, nextPartIndex: 1 },
      }));
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  const checkpoints: SystemBackupCheckpoint[] = [];
  const result = await uploadSystemBackupPackage(
    backupFile([header, rowPart(0), manifest(1)]),
    { request, onCheckpoint: (value) => checkpoints.push(value) },
  );

  assert.equal(result.status, "ready");
  assert.equal(partAttempts, 2);
  assert.equal(calls.filter((call) => call.url.includes("/parts/0")).length, 2);
  assert.equal(JSON.parse(calls.find((call) => call.url.endsWith("/finalize"))!.body).frame, "manifest");
  assert.equal(checkpoints.at(-1)?.file?.size, backupFile([header, rowPart(0), manifest(1)]).size);
});

test("upload resumes the same file from server nextPartIndex and rejects a missing frame", async () => {
  const file = backupFile([header, rowPart(0), rowPart(1), manifest(2)]);
  const uploaded: number[] = [];
  const checkpoint: SystemBackupCheckpoint = {
    jobId: job().jobId,
    kind: "import",
    file: { name: file.name, size: file.size, lastModified: file.lastModified },
  };
  const request: BackupRequest = async (url, init = {}) => {
    if (url.endsWith("/status")) {
      return Response.json(job({ progress: { rows: 0, bytes: 2, parts: 2, nextPartIndex: 1 } }));
    }
    const match = url.match(/\/parts\/(\d+)$/);
    if (match) {
      uploaded.push(Number(match[1]));
      return Response.json(job({ progress: { rows: 0, bytes: 4, parts: 2, nextPartIndex: 2 } }));
    }
    if (url.endsWith("/finalize")) return Response.json(job({ status: "running", phase: "preflight", progress: { rows: 0, bytes: 4, parts: 2, nextPartIndex: 2 } }));
    if (url.endsWith("/advance")) return Response.json(job({ status: "ready", phase: "ready", rootSha256: "d".repeat(64), stateSha256: "c".repeat(64), progress: { rows: 0, bytes: 4, parts: 2, nextPartIndex: 2 } }));
    throw new Error(`Unexpected ${init.method ?? "GET"} ${url}`);
  };

  const result = await uploadSystemBackupPackage(file, { request, checkpoint });
  assert.equal(result.status, "ready");
  assert.deepEqual(uploaded, [1]);

  await assert.rejects(
    uploadSystemBackupPackage(backupFile([header, rowPart(1), manifest(1)]), {
      request: async (url) => url === "/api/admin/import/validate"
        ? Response.json(job())
        : Promise.reject(new Error(`Unexpected ${url}`)),
    }),
    /ожидалась часть 0/,
  );
});

test("job runner reads status after a network interruption and reaches terminal state", async () => {
  let advances = 0;
  let statusReads = 0;
  const initial = job({ status: "running", phase: "preflight" });
  const result = await runSystemBackupJob(initial, {
    request: async (url) => {
      if (url.endsWith("/advance")) {
        advances += 1;
        if (advances === 1) throw new Error("offline");
        return Response.json(job({ status: "ready", phase: "ready", rootSha256: "d".repeat(64) }));
      }
      if (url.endsWith("/status")) {
        statusReads += 1;
        return Response.json(job({ status: "running", phase: "preflight" }));
      }
      throw new Error(`Unexpected ${url}`);
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(advances, 2);
  assert.equal(statusReads, 1);
});

test("checkpoint state is validated and terminal cleanup is explicit", () => {
  const values = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
  const checkpoint: SystemBackupCheckpoint = { jobId: job().jobId, kind: "import" };
  writeBackupCheckpoint(storage, "import", checkpoint);
  assert.deepEqual(readBackupCheckpoint(storage, "import"), checkpoint);
  assert.equal(retainBackupCheckpoint(job({ status: "ready" })), true);
  assert.equal(retainBackupCheckpoint(job({ status: "applied" })), false);
  assert.equal(retainBackupCheckpoint(job({ status: "failed" })), false);
  assert.equal(retainBackupCheckpoint(job({ status: "expired" })), false);
  writeBackupCheckpoint(storage, "import", null);
  assert.equal(readBackupCheckpoint(storage, "import"), null);
});

test("restore stays disabled until validation, a safety download, and literal RESTORE", () => {
  const ready = job({
    status: "ready",
    phase: "ready",
    rootSha256: "d".repeat(64),
  });
  assert.equal(canApplySystemBackupImport(ready, false, "RESTORE"), false);
  assert.equal(canApplySystemBackupImport(ready, true, "restore"), false);
  assert.equal(canApplySystemBackupImport(ready, true, "RESTORE"), true);
  assert.equal(canApplySystemBackupImport({ ...ready, validationErrors: ["invalid"] }, true, "RESTORE"), false);
});

test("server error bodies are not surfaced and download URLs stay same-origin", async () => {
  await assert.rejects(
    createSystemBackupExport(async () => Response.json({ error: "secret token=abc https://evil.test" }, { status: 400 })),
    (error: unknown) => error instanceof SystemBackupClientError
      && error.message === "Сервер не смог начать экспорт."
      && !/abc|evil/.test(error.message),
  );
  assert.equal(safeSystemBackupDownloadUrl("/api/admin/export/system-export%3Aabc"), "/api/admin/export/system-export%3Aabc");
  assert.equal(safeSystemBackupDownloadUrl("https://evil.test/file?token=abc"), null);
  assert.equal(safeSystemBackupDownloadUrl("/api/admin/export/job?token=abc"), null);
  assert.equal(safeBackupMessage("See https://evil.test token=abc"), "See [адрес скрыт] [секрет скрыт]");
});

test("preview renders dynamic D1/R2/policy evidence without record content", () => {
  const status = job({
    status: "ready",
    phase: "ready",
    rootSha256: "d".repeat(64),
    stateSha256: "c".repeat(64),
    counts: { users: 2, tasks: 9, saved_views: 3 },
    r2: {
      objects: 4,
      bytes: 4096,
      bound: 2,
      unbound: 1,
      orphan: 1,
      namespaces: { "stored-files": { objects: 3, bytes: 3072 }, attachments: { objects: 1, bytes: 1024 } },
    },
    policies: {
      exact: ["users", "R2:stored-files"],
      rebuild: ["task_label_group_values"],
      reset: ["workspace_sync_events"],
      revoke: ["api_tokens"],
      excluded: ["system_backup_jobs"],
    },
    warnings: ["Restore committed; old object cleanup is pending"],
    validationErrors: ["validation_failed"],
  });
  const markup = renderToStaticMarkup(createElement(SystemBackupPreview, { status }));
  assert.match(markup, /Все таблицы/);
  assert.match(markup, /saved_views/);
  assert.match(markup, /stored-files/);
  assert.match(markup, /Сироты/);
  assert.match(markup, /task_label_group_values/);
  assert.match(markup, /State SHA-256/);
  assert.doesNotMatch(markup, /title|description|object_key/);
});

test("Administration source has no monolithic system backup blob/text path", async () => {
  const source = await readFile(new URL("../components/task-tracker.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /function downloadSystemBackup/);
  assert.doesNotMatch(source, /await file\.text\(\)/);
  assert.doesNotMatch(source, /Backup file is larger than 10 MB/);
  assert.match(source, /href=\{downloadUrl\} download/);
  assert.match(source, /uploadSystemBackupPackage/);
  assert.match(source, /sessionStorage/);
});
