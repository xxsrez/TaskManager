import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  planImportedAttachments,
  reconcileImportedAttachments,
} from "../lib/imported-attachments";
import { listTaskAttachments } from "../lib/attachments";
import {
  createProject,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  revokeAccess,
} from "../lib/repository";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "attachment-migration-owner",
  displayName: "Attachment Migration Owner",
  email: "attachment-migration-owner@example.test",
};
const viewerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "attachment-migration-viewer",
  displayName: "Attachment Migration Viewer",
  email: "attachment-migration-viewer@example.test",
};
const editorActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "attachment-migration-editor",
  displayName: "Attachment Migration Editor",
  email: "attachment-migration-editor@example.test",
};
const outsiderActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "attachment-migration-outsider",
  displayName: "Attachment Migration Outsider",
  email: "attachment-migration-outsider@example.test",
};

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;

before(async () => {
  const harness = await createD1TestHarness({
    TASK_MANAGER_ADMIN_EMAILS: `${ownerActor.email},${editorActor.email}`,
    TASK_MANAGER_ATTACHMENT_SCOPE: "migration-test",
    TASK_MANAGER_ATTACHMENT_MAX_BYTES: "1024",
    TASK_MANAGER_ATTACHMENT_MIGRATION_HOSTS: "files.example.test",
  }, { r2: true });
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => {
  await dispose?.();
});

test("attachment planner preserves stable source positions and blocks malformed rows", () => {
  const planned = planImportedAttachments("source:1", "task:1", JSON.stringify({
    attachments: [
      { id: "a-1", title: "Evidence", url: "https://files.example.test/evidence.pdf#preview" },
      { title: "Duplicate", url: "https://files.example.test/evidence.pdf" },
      { title: "Missing URL" },
      "invalid",
    ],
  }));
  assert.deepEqual(planned.map((item) => ({
    index: item.sourceIndex,
    disposition: item.disposition,
    reason: item.reason,
  })), [
    { index: 0, disposition: "candidate", reason: null },
    { index: 1, disposition: "skipped", reason: "duplicate_source_url:0" },
    { index: 2, disposition: "blocked", reason: "attachment_url_missing" },
    { index: 3, disposition: "blocked", reason: "attachment_not_object" },
  ]);
  assert.equal(planned[0]?.url, "https://files.example.test/evidence.pdf");
  assert.equal(planned[0]?.sourceAttachmentId, "a-1");

  const malformed = planImportedAttachments("source:2", "task:2", "{bad json");
  assert.equal(malformed[0]?.sourceIndex, -1);
  assert.equal(malformed[0]?.reason, "metadata_not_json");
});

test("attachment migration is bounded, resumable, ACL-readable, and source-URL safe", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const editor = await getOrCreateUser(editorActor);
  const viewer = await getOrCreateUser(viewerActor);
  const outsider = await getOrCreateUser(outsiderActor);
  await createProject(owner, { name: "Attachment migration", taskCode: "AM" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Attachment migration")!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: viewer.email,
    permission: "viewer",
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: editor.email,
    permission: "editor",
  });
  const task = await createTask(owner, { title: "Imported attachment task", projectId: project.id });
  const sourceRecordId = "external:attachment-migration";
  await database.prepare(`INSERT INTO external_records (
      id, owner_user_id, target_type, target_id, source, source_id,
      source_url, metadata_json, imported_at
    ) VALUES (?, ?, 'task', ?, 'linear', 'AM-1', NULL, ?, CURRENT_TIMESTAMP)`)
    .bind(sourceRecordId, owner.id, task.id, JSON.stringify({
      attachments: [
        { id: "binary", title: "Evidence PDF", url: "https://files.example.test/evidence.pdf" },
        { id: "link", title: "Reference", url: "https://files.example.test/reference" },
        { id: "missing", title: "Unavailable", url: "https://files.example.test/missing" },
        { id: "duplicate", title: "Duplicate PDF", url: "https://files.example.test/evidence.pdf" },
      ],
    })).run();

  const inventory = await reconcileImportedAttachments(owner, { mode: "inventory" });
  assert.equal(inventory.sourceRecordCount, 1);
  assert.equal(inventory.sourceAttachmentCount, 4);
  assert.equal(inventory.pendingCount, 3);
  assert.equal(inventory.blockedCount, 0);
  assert.equal(inventory.skippedCount, 1);
  assert.equal(inventory.cutoverReady, false);
  const editorInventory = await reconcileImportedAttachments(editor, {
    mode: "inventory",
    sourceRecordId,
  });
  assert.equal(editorInventory.sourceRecordCount, 1);
  assert.equal(editorInventory.pendingCount, 3);

  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname === "/evidence.pdf") {
      const body = new TextEncoder().encode("%PDF-1.7\nmigrated\n%%EOF");
      return new Response(body, {
        headers: {
          "content-type": "application/pdf",
          "content-length": String(body.byteLength),
          "content-disposition": "attachment; filename=linear-evidence.pdf",
        },
      });
    }
    if (url.pathname === "/reference") {
      return new Response("<!doctype html><title>Reference</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const applied = await reconcileImportedAttachments(owner, {
    mode: "apply",
    fetcher,
    maxAttachments: 10,
  });
  assert.equal(applied.migratedCount, 1);
  assert.equal(applied.nonBinaryMappedCount, 1);
  assert.equal(applied.skippedCount, 1);
  assert.equal(applied.blockedCount, 1);
  assert.equal(applied.pendingCount, 0);
  assert.equal(applied.cutoverReady, false);
  assert.deepEqual(requests, ["/evidence.pdf", "/reference", "/missing"]);
  assert.doesNotMatch(JSON.stringify(applied), /files\.example\.test/);

  const ownerAttachments = await listTaskAttachments(owner, task.id);
  const editorAttachments = await listTaskAttachments(editor, task.id);
  const viewerAttachments = await listTaskAttachments(viewer, task.id);
  assert.equal(ownerAttachments.items.length, 1);
  assert.equal(editorAttachments.items[0]?.checksumSha256, ownerAttachments.items[0]?.checksumSha256);
  assert.equal(viewerAttachments.items[0]?.checksumSha256, ownerAttachments.items[0]?.checksumSha256);
  await assert.rejects(listTaskAttachments(outsider, task.id), /not found/i);

  const rerun = await reconcileImportedAttachments(owner, {
    mode: "apply",
    sourceRecordId,
    sourceIndex: 0,
    fetcher: (() => {
      throw new Error("idempotent migration must not refetch");
    }) as typeof fetch,
  });
  assert.equal(rerun.items[0]?.action, "already_migrated");
  assert.equal((await listTaskAttachments(owner, task.id)).items.length, 1);

  const outcomes = await database.prepare(`SELECT source_index, outcome, reason,
      attachment_id, mapped_url, raw_json
    FROM attachment_migration_outcomes WHERE source_record_id = ? ORDER BY source_index`)
    .bind(sourceRecordId).all<Record<string, unknown>>();
  assert.deepEqual(outcomes.results.map((row) => ({
    sourceIndex: Number(row.source_index),
    outcome: String(row.outcome),
    reason: row.reason == null ? null : String(row.reason),
    hasAttachment: row.attachment_id !== null,
  })), [
    { sourceIndex: 0, outcome: "migrated", reason: null, hasAttachment: true },
    { sourceIndex: 1, outcome: "non_binary_mapped", reason: "html_link_preserved", hasAttachment: false },
    { sourceIndex: 2, outcome: "blocked", reason: "source_unavailable:404", hasAttachment: false },
    { sourceIndex: 3, outcome: "skipped", reason: "duplicate_source_url:0", hasAttachment: false },
  ]);
  assert.match(String(outcomes.results[1]?.mapped_url), /^https:\/\/files\.example\.test/);
  assert.match(String(outcomes.results[0]?.raw_json), /evidence\.pdf/);

  const viewerGrant = await database.prepare(`SELECT id FROM access_grants
    WHERE resource_type = 'project' AND resource_id = ? AND grantee_user_id = ?
      AND revoked_at IS NULL`).bind(project.id, viewer.id).first<{ id: string }>();
  assert.ok(viewerGrant);
  await revokeAccess(owner, viewerGrant.id);
  await assert.rejects(listTaskAttachments(viewer, task.id), /not found/i);
});

test("migration rejects unapproved hosts without issuing a request or leaking the URL", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Attachment migration")!;
  const task = await createTask(owner, { title: "Unapproved source", projectId: project.id });
  const sourceRecordId = "external:unapproved-host";
  await database.prepare(`INSERT INTO external_records (
      id, owner_user_id, target_type, target_id, source, source_id,
      source_url, metadata_json, imported_at
    ) VALUES (?, ?, 'task', ?, 'linear', 'AM-2', NULL, ?, CURRENT_TIMESTAMP)`)
    .bind(sourceRecordId, owner.id, task.id, JSON.stringify({
      attachments: [{ title: "Private", url: "https://unapproved.example.test/private-file" }],
    })).run();
  let requested = false;
  const report = await reconcileImportedAttachments(owner, {
    mode: "apply",
    sourceRecordId,
    fetcher: (async () => {
      requested = true;
      return new Response("unexpected");
    }) as typeof fetch,
  });
  assert.equal(requested, false);
  assert.equal(report.items[0]?.reason, "source_host_not_allowed");
  assert.doesNotMatch(JSON.stringify(report), /unapproved\.example\.test|private-file/);
});

test("an admin can map one independently verified non-binary URL without a bulk override", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Attachment migration")!;
  const task = await createTask(owner, { title: "Verified non-binary source", projectId: project.id });
  const sourceRecordId = "external:verified-non-binary";
  await database.prepare(`INSERT INTO external_records (
      id, owner_user_id, target_type, target_id, source, source_id,
      source_url, metadata_json, imported_at
    ) VALUES (?, ?, 'task', ?, 'linear', 'AM-3', NULL, ?, CURRENT_TIMESTAMP)`)
    .bind(sourceRecordId, owner.id, task.id, JSON.stringify({
      attachments: [{ id: "site-home", title: "Production", url: "https://files.example.test/" }],
    })).run();

  const unavailable = await reconcileImportedAttachments(owner, {
    mode: "apply",
    sourceRecordId,
    sourceIndex: 0,
    fetcher: (async () => new Response("unavailable", { status: 522 })) as typeof fetch,
  });
  assert.equal(unavailable.items[0]?.reason, "source_unavailable:522");

  await assert.rejects(
    reconcileImportedAttachments(owner, {
      mode: "apply",
      sourceRecordId,
      verifiedNonBinary: true,
    }),
    /requires one exact source record and index/i,
  );

  let requested = false;
  const mapped = await reconcileImportedAttachments(owner, {
    mode: "apply",
    sourceRecordId,
    sourceIndex: 0,
    verifiedNonBinary: true,
    fetcher: (async () => {
      requested = true;
      throw new Error("verified mapping must not fetch through the Worker");
    }) as typeof fetch,
  });
  assert.equal(requested, false);
  assert.equal(mapped.items[0]?.action, "non_binary_mapped");
  assert.equal(mapped.items[0]?.reason, "verified_non_binary_link_preserved");
  assert.equal(mapped.nonBinaryMappedCount, 1);
  assert.equal(mapped.cutoverReady, true);

  const inventory = await reconcileImportedAttachments(owner, {
    mode: "inventory",
    sourceRecordId,
    sourceIndex: 0,
  });
  assert.equal(inventory.nonBinaryMappedCount, 1);
  assert.equal(inventory.cutoverReady, true);
});
