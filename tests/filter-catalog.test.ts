import assert from "node:assert/strict";
import test from "node:test";
import {
  filterCatalogOptions,
  unavailableFilterReferences,
} from "../lib/filter-catalog";
import type { AppSnapshot, ProjectRecord, ReleaseRecord } from "../lib/types";

const now = "2026-08-27T00:00:00.000Z";

function project(id: string, name: string, taskCode: string, ownerUserId: string): ProjectRecord {
  return {
    id, publicId: `${id}-public`, ownerUserId, creatorUserId: ownerUserId,
    name, taskCode, taskSequence: 1, codeLockedAt: now, summary: "", description: "",
    status: "active", leadUserId: null, startDate: null, targetDate: null,
    icon: "cube", color: "#777", version: 1, createdAt: now, updatedAt: now,
    accessRole: "owner",
  };
}

function release(id: string, projectId: string, name: string, status: ReleaseRecord["status"]): ReleaseRecord {
  return {
    id, publicId: `${id}-public`, projectId, ownerUserId: "owner-alpha", creatorUserId: "owner-alpha",
    name, description: "", status, targetDate: null, releasedAt: null, releaseNotes: "",
    version: 1, createdAt: now, updatedAt: now, accessRole: "owner",
  };
}

const alpha = project("project-alpha", "Alpha 2", "ALP", "owner-alpha");
const beta = project("project-beta", "Beta 10", "BET", "owner-beta");

const data = {
  user: { id: "current", displayName: "Current User", email: "current@example.com", timezone: "UTC" },
  users: [
    { id: "outsider", displayName: "Zed Outsider", email: "zed@example.com", timezone: "UTC" },
    { id: "owner-alpha", displayName: "Amy Owner", email: "amy@example.com", timezone: "UTC" },
    { id: "collaborator", displayName: "Bob Member", email: "bob@example.com", timezone: "UTC" },
  ],
  statuses: [
    { id: "alpha-started", ownerUserId: "owner-alpha", name: "Started", category: "started", color: "#0f0", position: 20, isDefault: false, systemRole: null, archivedAt: null, version: 1 },
    { id: "beta-todo", ownerUserId: "owner-beta", name: "Todo", category: "unstarted", color: "#aaa", position: 10, isDefault: true, systemRole: null, archivedAt: null, version: 1 },
    { id: "alpha-todo", ownerUserId: "owner-alpha", name: "Todo", category: "unstarted", color: "#aaa", position: 10, isDefault: true, systemRole: null, archivedAt: null, version: 1 },
  ],
  projects: [beta, alpha, { ...alpha, name: "Duplicate must be ignored" }],
  releases: [
    release("alpha-planned", alpha.id, "2.0", "planned"),
    release("beta-active", beta.id, "3.0", "active"),
    release("alpha-active-09", alpha.id, "0.9", "active"),
    release("alpha-active-010", alpha.id, "0.10", "active"),
    { ...release("alpha-active-010", alpha.id, "duplicate", "active") },
  ],
  labels: [
    { id: "beta-label", ownerUserId: "owner-beta", name: "Beta", color: "#111", description: "", archivedAt: null, version: 1, createdAt: now, updatedAt: now },
    { id: "alpha-label", ownerUserId: "owner-alpha", name: "Alpha", color: "#222", description: "", archivedAt: null, version: 1, createdAt: now, updatedAt: now },
  ],
  labelGroups: [
    { id: "beta-group", ownerUserId: "owner-beta", name: "Beta group", description: "", position: 1, archivedAt: null, version: 1, createdAt: now, updatedAt: now },
    { id: "alpha-group", ownerUserId: "owner-alpha", name: "Alpha group", description: "", position: 1, archivedAt: null, version: 1, createdAt: now, updatedAt: now },
  ],
  tasks: [],
  collaborators: [{ grantId: "grant-1", resourceType: "project", resourceId: alpha.id, userId: "collaborator", displayName: "Bob Member", email: "bob@example.com", permission: "editor" }],
} satisfies Pick<AppSnapshot, "user" | "users" | "statuses" | "projects" | "releases" | "labels" | "labelGroups" | "tasks" | "collaborators">;

test("filter catalogs dedupe and apply deterministic field semantics", () => {
  assert.deepEqual(
    filterCatalogOptions("release", data).map((option) => option.value),
    ["alpha-active-010", "alpha-active-09", "alpha-planned", "beta-active"],
  );
  assert.deepEqual(
    filterCatalogOptions("release", data).map((option) => option.label),
    ["Alpha 2 · 0.10", "Alpha 2 · 0.9", "Alpha 2 · 2.0", "Beta 10 · 3.0"],
  );
  assert.deepEqual(
    filterCatalogOptions("priority", data).map((option) => option.value),
    ["urgent", "high", "medium", "low", "none"],
  );
});

test("Project scope limits owner catalogs, membership, parents, and Releases", () => {
  assert.deepEqual(filterCatalogOptions("status", data, alpha.id).map((option) => option.value), ["alpha-todo", "alpha-started"]);
  assert.deepEqual(filterCatalogOptions("label", data, alpha.id).map((option) => option.value), ["alpha-label"]);
  assert.deepEqual(filterCatalogOptions("label_group", data, alpha.id).map((option) => option.value), ["alpha-group"]);
  assert.deepEqual(filterCatalogOptions("release", data, alpha.id).map((option) => option.value), ["alpha-active-010", "alpha-active-09", "alpha-planned"]);
  assert.deepEqual(filterCatalogOptions("assignee", data, alpha.id).map((option) => option.value), ["owner-alpha", "collaborator", "current"]);
});

test("a global Project condition does not become scope and incompatible scope references remain explicit", () => {
  const query = {
    version: 1 as const,
    op: "all" as const,
    conditions: [
      { field: "project" as const, operator: "is" as const, value: alpha.id },
      { field: "release" as const, operator: "is" as const, value: "beta-active" },
    ],
  };
  assert.equal(filterCatalogOptions("release", data, null).some((option) => option.value === "beta-active"), true);
  assert.deepEqual(unavailableFilterReferences(query, data, alpha.id), [
    { conditionIndex: 1, field: "release", value: "beta-active" },
  ]);
  assert.equal(query.conditions[1]!.value, "beta-active");
});
