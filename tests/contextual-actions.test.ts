import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextualActionMenu } from "@/components/contextual-action-menu";
import {
  buildTaskArchiveCommand,
  contextualActionIds,
  nextContextualActionIndex,
  resolveKeyboardContextualEntities,
  resolveContextualActions,
  resolveTaskTriggerContext,
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
      { id: "delete", disabledReason: null },
    ],
  );
  assert.deepEqual(contextualActionIds(context), ["open", "archive", "delete"]);
});

test("Viewer contextual menus expose no mutation controls", () => {
  const actions = resolveContextualActions({
    entities: [entity({ accessRole: "viewer" })],
  });

  assert.deepEqual(actions.map(({ id, disabledReason }) => ({ id, disabledReason })), [
    { id: "open", disabledReason: null },
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
  const editableContext = { entities: [entity()] };
  const archive = resolveContextualActions(editableContext).find((action) => action.id === "archive");
  assert.ok(archive);
  assert.throws(
    () => buildTaskArchiveCommand({ entities: [entity({ version: 4 })] }, archive),
    /context changed/i,
  );
});

test("keeps Archive separate from Delete and removes user-facing Saved View Archive", () => {
  assert.deepEqual(contextualActionIds({ entities: [entity({ kind: "project" })] }), [
    "open",
    "edit",
    "share",
    "archive",
    "delete",
  ]);
  assert.deepEqual(contextualActionIds({ entities: [entity({ kind: "release" })] }), [
    "open",
    "edit",
    "share",
    "delete",
  ]);
  assert.deepEqual(contextualActionIds({ entities: [entity({ kind: "saved_view" })] }), [
    "open",
    "edit",
    "share",
    "delete",
  ]);
});

test("an explicit unselected Task trigger never acts on a hidden multi-selection", () => {
  const tasks = [
    entity({ id: "task-a" }),
    entity({ id: "task-b" }),
    entity({ id: "task-c" }),
  ];
  const selected = new Set(["task-a", "task-b"]);

  assert.deepEqual(
    resolveTaskTriggerContext(tasks, selected, "task-c", null).map((task) => task.id),
    ["task-c"],
  );
  assert.deepEqual(
    resolveTaskTriggerContext(tasks, selected, "task-a", null).map((task) => task.id),
    ["task-a", "task-b"],
  );
});

test("keyboard context prefers a focused Task, then selection, then highlight", () => {
  const tasks = [
    entity({ id: "task-a" }),
    entity({ id: "task-b" }),
    entity({ id: "task-c" }),
  ];
  const selected = new Set(["task-a", "task-b"]);

  assert.deepEqual(
    resolveTaskTriggerContext(tasks, selected, "task-c", "task-b").map((task) => task.id),
    ["task-c"],
  );
  assert.deepEqual(
    resolveTaskTriggerContext(tasks, selected, null, "task-c").map((task) => task.id),
    ["task-a", "task-b"],
  );
  assert.deepEqual(
    resolveTaskTriggerContext(tasks, new Set(), null, "task-c").map((task) => task.id),
    ["task-c"],
  );
});

test("keyboard context gives a focused non-Task entity priority over open Task details", () => {
  const tasks = [entity({ id: "task-active" }), entity({ id: "task-selected" })];
  const activeTask = tasks[0]!;
  const selected = new Set(["task-active", "task-selected"]);

  for (const kind of ["project", "release", "saved_view"] as const) {
    const focused = entity({ kind, id: `${kind}-focused` });
    assert.deepEqual(
      resolveKeyboardContextualEntities(tasks, selected, focused, activeTask, "task-selected"),
      [focused],
    );
  }

  assert.deepEqual(
    resolveKeyboardContextualEntities(tasks, selected, null, activeTask, "task-selected").map((item) => item.id),
    ["task-active"],
  );
});

test("an archived Saved View exposes only its valid Restore lifecycle action", () => {
  const archivedView = entity({
    kind: "saved_view",
    archivedAt: "2026-08-19T12:00:00Z",
  });

  assert.deepEqual(contextualActionIds({ entities: [archivedView] }), ["restore"]);
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

test("renders the shared Viewer menu without mutation controls", () => {
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
  assert.equal((markup.match(/role="menuitem"/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /Archive|Delete|Edit|Members &amp; access/);
});

test("Task delete stays single-only and every delete action is destructive", () => {
  const single = resolveContextualActions({ entities: [entity()] });
  assert.equal(single.find((action) => action.id === "delete")?.destructive, true);
  assert.equal(single.find((action) => action.id === "delete")?.confirmation, null);

  const bulk = resolveContextualActions({
    entities: [entity(), entity({ id: "task-2" })],
  });
  assert.equal(bulk.some((action) => action.id === "delete"), false);
});
