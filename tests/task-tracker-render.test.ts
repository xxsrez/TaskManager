import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskTracker } from "../components/task-tracker";
import type { AppSnapshot } from "../lib/types";

const now = "2026-08-14T09:00:00.000Z";
const snapshot: AppSnapshot = {
  user: {
    id: "user-1",
    displayName: "Test User",
    email: "test@example.com",
    timezone: "UTC",
  },
  users: [],
  statuses: [
    {
      id: "todo",
      ownerUserId: "user-1",
      name: "Todo",
      category: "unstarted",
      color: "#888888",
      position: 0,
      isDefault: true,
    },
  ],
  projects: [],
  releases: [],
  tasks: [
    {
      id: "task-1",
      publicId: "33333333-3333-4333-8333-333333333333",
      ownerUserId: "user-1",
      creatorUserId: "user-1",
      identifier: "TM-1",
      sequenceNumber: 1,
      title: "Direct task",
      description: "",
      statusId: "todo",
      priority: "none",
      assigneeUserId: null,
      projectId: null,
      releaseId: null,
      estimate: 3,
      dueDate: null,
      parentTaskId: null,
      rank: 1000,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ],
  labels: [],
  taskLabels: [],
  relations: [],
  externalSources: [],
  views: [],
  collaborators: [],
};

test("a direct task render has no controlled field warnings", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    renderToStaticMarkup(
      createElement(TaskTracker, {
        initialData: snapshot,
        initialNavigation: {
          surface: "all",
          layout: "list",
          taskId: "task-1",
        },
        signOutPath: "/sign-out",
      }),
    );
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(
    errors.filter((message) => message.includes("without an `onChange` handler")),
    [],
  );
});
