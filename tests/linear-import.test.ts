import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLinearImportPlan,
  type LinearImportPlan,
} from "../lib/linear-import";
import { ValidationError } from "../lib/domain";

const exportedAt = "2026-08-14T07:30:00.000Z";

function fixture(): Record<string, unknown> {
  return {
    version: 1,
    source: {
      provider: "linear",
      exportedAt,
    },
    statuses: [
      { id: "s1", name: "Todo", type: "unstarted" },
      { id: "s2", name: "Done", type: "completed" },
      { id: "s3", name: "Duplicate", type: "duplicate" },
    ],
    labels: [{ id: "l1", name: "Bug", color: "#eb5757" }],
    projects: [
      {
        id: "p1",
        name: "Project",
        summary: "Summary",
        description: "Description",
        status: { type: "started" },
        lead: { id: "linear-user" },
        startDate: "2026-08-01",
        targetDate: null,
        icon: null,
        color: "#123456",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        milestones: [
          {
            id: "m1",
            name: "0.1",
            description: "Release scope",
            targetDate: null,
          },
        ],
      },
    ],
    issues: [
      {
        id: "AND-2",
        title: "Child",
        description: "Child description",
        status: "Done",
        statusType: "completed",
        priority: { value: 1, name: "Urgent" },
        projectId: "p1",
        projectMilestone: { id: "m1", name: "0.1" },
        parentId: "AND-1",
        assigneeId: "linear-user",
        labels: ["Bug"],
        relations: {
          blocks: [],
          blockedBy: [],
          relatedTo: [{ id: "AND-1", title: "Parent" }],
          duplicateOf: null,
        },
        attachments: [
          { title: "Evidence", subtitle: null, url: "https://example.com" },
        ],
        stateHistory: [{ state: { name: "Done" } }],
        url: "https://linear.app/example/AND-2",
        gitBranchName: "and-2-child",
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
        completedAt: "2026-08-03T00:00:00.000Z",
        startedAt: "2026-08-02T12:00:00.000Z",
        canceledAt: null,
        archivedAt: null,
        dueDate: null,
      },
      {
        id: "AND-1",
        title: "Parent",
        description: "Parent description",
        status: "Todo",
        statusType: "unstarted",
        priority: { value: 0, name: "No priority" },
        projectId: "p1",
        projectMilestone: { id: "m1", name: "0.1" },
        parentId: null,
        assigneeId: null,
        labels: [],
        relations: {
          blocks: [{ id: "AND-2", title: "Child" }],
          blockedBy: [],
          relatedTo: [{ id: "AND-2", title: "Child" }],
          duplicateOf: null,
        },
        attachments: [],
        stateHistory: [],
        url: "https://linear.app/example/AND-1",
        gitBranchName: "and-1-parent",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T01:00:00.000Z",
        completedAt: null,
        startedAt: null,
        canceledAt: null,
        archivedAt: null,
        dueDate: null,
      },
    ],
    views: [
      {
        sourceId: "v1",
        name: "Project board",
        sourceProjectId: "p1",
        sourceMilestoneId: "m1",
        query: {},
        display: {
          layout: "board",
          groupBy: "status",
          orderBy: "priority",
          direction: "asc",
          showEmptyGroups: false,
          visibleFields: ["priority", "project", "release"],
        },
        url: "https://linear.app/example/view",
      },
    ],
    commentsByIssue: {
      "AND-2": [{ id: "c1", body: "Imported discussion" }],
      "AND-1": [],
    },
  };
}

test("Linear import preserves identifiers, hierarchy, labels, relations and views", () => {
  const plan: LinearImportPlan = buildLinearImportPlan(
    "usr_test",
    fixture(),
  );
  assert.equal(plan.projects.length, 1);
  assert.equal(plan.releases.length, 1);
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.taskLabels.length, 1);
  assert.equal(plan.relations.length, 2);
  assert.equal(plan.views.length, 1);

  const child = plan.tasks.find((task) => task.identifier === "AND-2");
  const parent = plan.tasks.find((task) => task.identifier === "AND-1");
  assert.ok(child);
  assert.ok(parent);
  assert.equal(child.parentTaskId, parent.id);
  assert.equal(child.priority, "urgent");
  assert.equal(child.releaseId, plan.releases[0].id);
  assert.equal(plan.views[0].display.layout, "board");
  assert.equal(plan.views[0].query.projectId, plan.projects[0].id);
  assert.equal(plan.views[0].query.releaseId, plan.releases[0].id);
  assert.equal(
    plan.statuses.find((status) => status.name === "Duplicate")?.category,
    "canceled",
  );

  const childSource = plan.externalRecords.find(
    (record) => record.targetType === "task" && record.sourceId === "AND-2",
  );
  assert.ok(childSource);
  assert.match(childSource.metadataJson, /"stateHistory"/);
  assert.match(childSource.metadataJson, /"Evidence"/);
  assert.match(childSource.metadataJson, /"Imported discussion"/);
});

test("Linear import rejects missing hierarchy targets before writing", () => {
  const value = fixture();
  const issues = value.issues as Array<Record<string, unknown>>;
  issues[0].parentId = "AND-999";
  assert.throws(
    () => buildLinearImportPlan("usr_test", value),
    ValidationError,
  );
});

test("Linear import rejects cyclic parent hierarchies before writing", () => {
  const value = fixture();
  const issues = value.issues as Array<Record<string, unknown>>;
  issues[1].parentId = "AND-2";
  assert.throws(
    () => buildLinearImportPlan("usr_test", value),
    ValidationError,
  );
});
