import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextualActionMenu } from "@/components/contextual-action-menu";
import {
  buildTaskArchiveCommand,
  contextualActionIds,
  nextContextualActionIndex,
  resolveContextualActions,
  type ContextualActionEntity,
} from "@/lib/contextual-actions";

function entity(
  overrides: Partial<ContextualActionEntity> = {},
): ContextualActionEntity {
  return {
    kind: "task",
    id: "task-1",
    label: "TM-1",
    accessRole: "editor",
    archivedAt: null,
    version: 3,
    ...overrides,
  } as ContextualActionEntity;
}

test("resolves one stable action set independently of its UI trigger", () => {
  const context = { entities: [entity()] };

  assert.deepEqual(
    resolveContextualActions(context).map(({ id, disabledReason }) => ({ id, disabledReason })),
    [
      { id: "open", disabledReason: null },
      { id: "archive", disabledReason: null },
    ],
  );
  assert.deepEqual(contextualActionIds(context), ["open", "archive"]);
});

test("keeps viewer mutations visible but disabled with a deterministic reason", () => {
  const actions = resolveContextualActions({
    entities: [entity({ accessRole: "viewer" })],
  });

  assert.deepEqual(actions.map(({ id, disabledReason }) => ({ id, disabledReason })), [
    { id: "open", disabledReason: null },
    { id: "archive", disabledReason: "Viewer access is read-only." },
  ]);
});

test("does not partially archive a mixed or partially read-only Task selection", () => {
  const mixedLifecycle = resolveContextualActions({
    entities: [entity(), entity({ id: "task-2", archivedAt: "2026-08-18T12:00:00Z" })],
  });
  assert.deepEqual(mixedLifecycle.map(({ id, disabledReason }) => ({ id, disabledReason })), [
    { id: "open", disabledReason: "Open is available for a single item." },
    { id: "archive", disabledReason: "Select either active or archived Tasks, not both." },
  ]);

  const mixedAccess = resolveContextualActions({
    entities: [entity(), entity({ id: "task-2", accessRole: "viewer" })],
  });
  assert.equal(
    mixedAccess.find((action) => action.id === "archive")?.disabledReason,
    "One or more selected Tasks are read-only.",
  );
});

test("restores only a uniformly archived editable Task selection", () => {
  const actions = resolveContextualActions({
    entities: [
      entity({ archivedAt: "2026-08-18T12:00:00Z" }),
      entity({ id: "task-2", archivedAt: "2026-08-18T12:00:00Z", version: 8 }),
    ],
  });

  assert.deepEqual(actions.map(({ id, label, confirmation }) => ({ id, label, confirmation })), [
    {
      id: "open",
      label: "Open",
      confirmation: null,
    },
    {
      id: "restore",
      label: "Restore 2 Tasks",
      confirmation: null,
    },
  ]);
});

test("builds one atomic bulk command with every current Task version", () => {
  const context = {
    entities: [entity(), entity({ id: "task-2", version: 8 })],
  };
  const archive = resolveContextualActions(context).find((action) => action.id === "archive");
  assert.ok(archive);

  assert.deepEqual(buildTaskArchiveCommand(context, archive), {
    path: "/api/tasks/bulk",
    method: "POST",
    body: {
      ids: ["task-1", "task-2"],
      versions: { "task-1": 3, "task-2": 8 },
      field: "archived",
      value: true,
    },
  });
});

test("rejects direct execution of disabled and stale resolved commands", () => {
  const viewerContext = { entities: [entity({ accessRole: "viewer" })] };
  const viewerArchive = resolveContextualActions(viewerContext).find((action) => action.id === "archive");
  assert.ok(viewerArchive);
  assert.throws(
    () => buildTaskArchiveCommand(viewerContext, viewerArchive),
    /Viewer access is read-only/,
  );

  const editableContext = { entities: [entity()] };
  const archive = resolveContextualActions(editableContext).find((action) => action.id === "archive");
  assert.ok(archive);
  assert.throws(
    () => buildTaskArchiveCommand({ entities: [entity({ version: 4 })] }, archive),
    /context changed/i,
  );
});

test("exposes only existing MVP actions for Project, Release, and Saved View contexts", () => {
  assert.deepEqual(contextualActionIds({ entities: [entity({ kind: "project" })] }), [
    "open",
    "edit",
    "share",
    "archive",
  ]);
  assert.deepEqual(contextualActionIds({ entities: [entity({ kind: "release" })] }), [
    "open",
    "edit",
    "share",
  ]);
  assert.deepEqual(contextualActionIds({ entities: [entity({ kind: "saved_view" })] }), [
    "open",
    "edit",
    "share",
    "archive",
  ]);
});

test("keyboard navigation wraps and skips disabled actions", () => {
  const actions = resolveContextualActions({
    entities: [entity(), entity({ id: "task-2" })],
  });
  assert.equal(nextContextualActionIndex(actions, 0, 1), 1);

  const mixed = resolveContextualActions({
    entities: [entity(), entity({ id: "task-2", archivedAt: "2026-08-18T12:00:00Z" })],
  });
  assert.equal(nextContextualActionIndex(mixed, 0, 1), 0);
  assert.equal(nextContextualActionIndex(mixed, 0, -1), 0);
});

test("renders the shared menu with accessible roles and disabled reasons", () => {
  const actions = resolveContextualActions({
    entities: [entity({ accessRole: "viewer" })],
  });
  const markup = renderToStaticMarkup(createElement(ContextualActionMenu, {
    actions,
    x: 16,
    y: 24,
    busy: false,
    onExecute: () => undefined,
    onClose: () => undefined,
  }));

  assert.match(markup, /role="menu"/);
  assert.equal((markup.match(/role="menuitem"/g) ?? []).length, 2);
  assert.match(markup, /aria-disabled="true"/);
  assert.match(markup, /Viewer access is read-only/);
});
