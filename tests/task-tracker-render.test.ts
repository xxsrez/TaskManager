import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  resolveArchiveBulkAction,
  TaskTracker,
} from "../components/task-tracker";
import type { AppSnapshot } from "../lib/types";

const now = "2026-08-14T09:00:00.000Z";
const snapshot: AppSnapshot = {
  user: {
    id: "user-1",
    displayName: "Test User",
    email: "test@example.com",
    timezone: "UTC",
  },
  admin: null,
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

test("bulk archive action restores an entirely archived selection", () => {
  assert.deepEqual(
    resolveArchiveBulkAction([{ archivedAt: now }, { archivedAt: now }]),
    { archived: false, label: "Restore" },
  );
});

test("bulk archive action archives an active selection", () => {
  assert.deepEqual(resolveArchiveBulkAction([{ archivedAt: null }]), {
    archived: true,
    label: "Archive",
  });
});

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

test("an administrator sees registration and activity statistics", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        admin: {
          registeredUserCount: 1,
          activeUserCount: 1,
          taskCount: 1,
          projectCount: 0,
          releaseCount: 0,
          viewCount: 2,
          users: [
            {
              id: "user-1",
              displayName: "Test User",
              email: "test@example.com",
              isAdmin: true,
              registeredAt: now,
              lastSeenAt: now,
              lastContentActivityAt: now,
              taskCount: 1,
              recentTaskCount: 1,
              projectCount: 0,
              releaseCount: 0,
              viewCount: 2,
            },
          ],
        },
      },
      initialNavigation: {
        surface: "admin",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /Administration/);
  assert.match(markup, />Export</);
  assert.match(markup, />Import</);
  assert.match(markup, /Registered users/);
  assert.match(markup, /test@example\.com/);
  assert.match(markup, /1 changed in 7d/);
  const primaryNavigation = markup.match(/<nav class="nav-scroll"[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.doesNotMatch(primaryNavigation, /Administration/);
});

test("the account identity is not the sign-out target", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: snapshot,
      initialNavigation: {
        surface: "all",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /<button[^>]*class="profile-trigger"/);
  assert.match(markup, /<a[^>]*class="profile-logout"[^>]*href="\/sign-out"/);
  assert.equal(markup.match(/href="\/sign-out"/g)?.length, 1);
});

test("workspace controls navigate to the root without a false dropdown affordance", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: snapshot,
      initialNavigation: {
        surface: "views",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  const workspaceControl = markup.match(/<a class="workspace-switcher"[\s\S]*?<\/a>/)?.[0] ?? "";
  assert.match(workspaceControl, /href="\/issues"/);
  assert.doesNotMatch(workspaceControl, /chevron-down/);
  assert.match(markup, /<a class="breadcrumb-link" href="\/issues">Workspace<\/a>/);
});

test("mobile shell exposes complete navigation and view controls", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: snapshot,
      initialNavigation: {
        surface: "all",
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(
    markup,
    /<button[^>]*aria-controls="workspace-sidebar"[^>]*aria-expanded="false"/,
  );
  assert.match(markup, /<aside[^>]*id="workspace-sidebar"/);
  assert.match(markup, /aria-label="Close navigation"/);
  assert.match(markup, /href="\/shared"/);
  assert.match(markup, /href="\/views"/);
  assert.match(markup, /href="\/projects"/);
  assert.match(markup, /href="\/releases"/);

  assert.match(
    markup,
    /<button[^>]*aria-controls="mobile-view-controls"[^>]*aria-expanded="false"/,
  );
  assert.match(markup, /id="mobile-view-controls"/);
  assert.match(markup, /aria-label="Search tasks on mobile"/);
  assert.match(markup, />Filter</);
  assert.match(markup, />Display</);
  assert.match(markup, />List</);
  assert.match(markup, />Board</);
  assert.match(markup, />New task</);
});

test("release breadcrumbs expose every ancestor and leave the current level static", () => {
  const project = {
    id: "project-1",
    publicId: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "Project Alpha",
    summary: "",
    description: "",
    status: "active",
    leadUserId: null,
    startDate: null,
    targetDate: null,
    color: "#7766dd",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const release = {
    id: "release-1",
    publicId: "22222222-2222-4222-8222-222222222222",
    projectId: project.id,
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "Release One",
    description: "",
    status: "active" as const,
    targetDate: null,
    releasedAt: null,
    releaseNotes: "",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const markup = renderToStaticMarkup(
    createElement(TaskTracker, {
      initialData: {
        ...snapshot,
        projects: [project],
        releases: [release],
      },
      initialNavigation: {
        surface: `release:${release.id}`,
        layout: "list",
        taskId: null,
      },
      signOutPath: "/sign-out",
    }),
  );

  assert.match(markup, /<a class="breadcrumb-link" href="\/projects">Projects<\/a>/);
  assert.match(markup, /<a class="breadcrumb-link" href="\/projects\/11111111-1111-4111-8111-111111111111">Project Alpha<\/a>/);
  assert.match(markup, /<a class="breadcrumb-link" href="\/projects\/11111111-1111-4111-8111-111111111111\/releases">Releases<\/a>/);
  assert.match(markup, /<h1 class="breadcrumb-current">Release One<\/h1>/);
  assert.doesNotMatch(markup, /<a class="breadcrumb-link"[^>]*>Release One<\/a>/);
});
