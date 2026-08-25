import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { POST as mcpPost } from "../app/api/mcp/route";
import {
  POST as createAgentTaskRoute,
} from "../app/api/agent/v1/tasks/route";
import {
  PATCH as updateAgentTaskRoute,
} from "../app/api/agent/v1/tasks/[ref]/route";
import {
  PUT as replaceAgentTaskLabelsRoute,
} from "../app/api/agent/v1/tasks/[ref]/labels/route";
import {
  PUT as setAgentTaskParentRoute,
} from "../app/api/agent/v1/tasks/[ref]/parent/route";
import {
  POST as createAgentTaskRelationRoute,
} from "../app/api/agent/v1/tasks/[ref]/relations/route";
import {
  DELETE as deleteAgentTaskRelationRoute,
  PATCH as updateAgentTaskRelationRoute,
} from "../app/api/agent/v1/tasks/[ref]/relations/[relationRef]/route";
import { issueApiCredential } from "../lib/api-credentials";
import {
  getAgentProjectDetail,
  getAgentTaskDetail,
  listAgentLabels,
} from "../lib/agent-api-repository";
import {
  createLabel,
  createProject,
  createRelease,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  updateLabel,
} from "../lib/repository";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
});

after(async () => dispose?.());

test("Agent REST creates and updates complete basic Task metadata with versioned Label replacement", async () => {
  const owner = await getOrCreateUser(actor("rest-owner"));
  const member = await getOrCreateUser(actor("rest-member"));
  await createProject(owner, { name: "REST parity", taskCode: "RP" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "REST parity",
  )!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: member.email,
    permission: "viewer",
  });
  await createRelease(owner, {
    projectId: project.id,
    name: "0.2",
    status: "planned",
  });
  const release = (await getSnapshot(owner)).releases.find(
    (item) => item.projectId === project.id,
  )!;
  const labels = await createLabel(owner, { name: "Agent one", color: "#336699" });
  const firstLabel = labels.find((item) => item.name === "Agent one")!;
  const withSecond = await createLabel(owner, { name: "Agent two", color: "#884422" });
  const secondLabel = withSecond.find((item) => item.name === "Agent two")!;
  const labelCatalog = await listAgentLabels(owner);
  const firstLabelRef = labelCatalog.items.find((item) => item.name === firstLabel.name)!.ref;
  const secondLabelRef = labelCatalog.items.find((item) => item.name === secondLabel.name)!.ref;
  const projectDetail = await getAgentProjectDetail(owner, project.publicId);
  const started = projectDetail.workflowStatuses.find(
    (status) => status.category === "started",
  )!;
  const credential = await issueApiCredential(owner, {
    name: "REST parity",
    scopes: ["api:write"],
    expiresInDays: 1,
  });
  const authorization = { authorization: `Bearer ${credential.token}` };

  const createdResponse = await createAgentTaskRoute(new Request(
    "https://example.test/api/agent/v1/tasks",
    {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Created through REST",
        description: "Complete metadata",
        statusRef: started.ref,
        priority: "high",
        projectRef: project.publicId,
        releaseRef: release.publicId,
        assigneeEmail: member.email,
        labelRefs: [firstLabelRef],
        estimate: 5,
        dueDate: "2026-08-30",
      }),
    },
  ));
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json() as { data: TaskDetail }).data;
  assert.equal(created.assignee?.displayName, member.displayName);
  assert.deepEqual(created.labels.map((item) => item.ref), [firstLabelRef]);
  assert.equal(created.release?.ref, release.publicId);
  assert.equal(created.status.ref, started.ref);
  assert.equal(created.lifecycle.startedAt !== null, true);

  const updatedResponse = await updateAgentTaskRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${created.ref}`, authorization, {
      version: created.version,
      title: "Updated through REST",
      description: "Updated metadata",
      priority: "urgent",
      assigneeEmail: null,
      releaseRef: null,
      estimate: 8,
      dueDate: null,
      rank: 1234.5,
      archived: true,
    }, "PATCH"),
    taskContext(created.ref),
  );
  assert.equal(updatedResponse.status, 200);
  const updated = (await updatedResponse.json() as { data: TaskDetail }).data;
  assert.equal(updated.version, created.version + 1);
  assert.equal(updated.assignee, null);
  assert.equal(updated.release, null);
  assert.equal(updated.lifecycle.archivedAt !== null, true);
  assert.equal(updated.estimate, 8);
  assert.equal(updated.rank, 1234.5);

  const replacedResponse = await replaceAgentTaskLabelsRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${created.ref}/labels`, authorization, {
      version: updated.version,
      labelRefs: [secondLabelRef],
    }, "PUT"),
    taskContext(created.ref),
  );
  assert.equal(replacedResponse.status, 200);
  const replaced = (await replacedResponse.json() as { data: TaskDetail }).data;
  assert.equal(replaced.version, updated.version + 1);
  assert.deepEqual(replaced.labels.map((item) => item.ref), [secondLabelRef]);

  const staleReplace = await replaceAgentTaskLabelsRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${created.ref}/labels`, authorization, {
      version: updated.version,
      labelRefs: [firstLabelRef],
    }, "PUT"),
    taskContext(created.ref),
  );
  assert.equal(staleReplace.status, 409);
  assert.deepEqual(
    (await getAgentTaskDetail(owner, created.ref)).labels.map((item) => item.ref),
    [secondLabelRef],
  );

  await updateLabel(owner, secondLabel.id, {
    action: "archive",
    version: secondLabel.version,
  });
  const retainedArchived = await replaceAgentTaskLabelsRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${created.ref}/labels`, authorization, {
      version: replaced.version,
      labelRefs: [secondLabelRef],
    }, "PUT"),
    taskContext(created.ref),
  );
  assert.equal(retainedArchived.status, 200);
  const retained = (await retainedArchived.json() as { data: TaskDetail }).data;
  assert.equal(retained.version, replaced.version);
  const clearedArchived = await replaceAgentTaskLabelsRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${created.ref}/labels`, authorization, {
      version: retained.version,
      labelRefs: [],
    }, "PUT"),
    taskContext(created.ref),
  );
  assert.equal(clearedArchived.status, 200);
  const cleared = (await clearedArchived.json() as { data: TaskDetail }).data;
  assert.equal(cleared.version, retained.version + 1);
  const archivedReassign = await replaceAgentTaskLabelsRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${created.ref}/labels`, authorization, {
      version: cleared.version,
      labelRefs: [secondLabelRef],
    }, "PUT"),
    taskContext(created.ref),
  );
  assert.equal(archivedReassign.status, 400);

  const memberCredential = await issueApiCredential(member, {
    name: "REST viewer denial",
    scopes: ["api:write"],
    expiresInDays: 1,
  });
  const viewerDenied = await updateAgentTaskRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${created.ref}`, {
      authorization: `Bearer ${memberCredential.token}`,
    }, { version: replaced.version, title: "Denied" }, "PATCH"),
    taskContext(created.ref),
  );
  assert.equal(viewerDenied.status, 403);
});

test("Agent REST hierarchy and relation commands enforce refs, cycles, two-sided ACL, and retry identity", async () => {
  const owner = await getOrCreateUser(actor("rest-graph-owner"));
  const oneSideEditor = await getOrCreateUser(actor("rest-graph-editor"));
  await createProject(owner, { name: "REST graph A", taskCode: "GA" });
  await createProject(owner, { name: "REST graph B", taskCode: "GB" });
  const snapshot = await getSnapshot(owner);
  const projectA = snapshot.projects.find((item) => item.name === "REST graph A")!;
  const projectB = snapshot.projects.find((item) => item.name === "REST graph B")!;
  await createTask(owner, { title: "Graph source", projectId: projectA.id });
  await createTask(owner, { title: "Graph child", projectId: projectA.id });
  await createTask(owner, { title: "Graph peer", projectId: projectA.id });
  await createTask(owner, { title: "Graph cross-project", projectId: projectB.id });
  const tasks = (await getSnapshot(owner)).tasks;
  const source = tasks.find((item) => item.title === "Graph source")!;
  const child = tasks.find((item) => item.title === "Graph child")!;
  const peer = tasks.find((item) => item.title === "Graph peer")!;
  const crossProject = tasks.find((item) => item.title === "Graph cross-project")!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: projectA.id,
    email: oneSideEditor.email,
    permission: "editor",
  });
  const credential = await issueApiCredential(owner, {
    name: "REST graph",
    scopes: ["api:write"],
    expiresInDays: 1,
  });
  const authorization = { authorization: `Bearer ${credential.token}` };

  const attachedResponse = await setAgentTaskParentRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${child.publicId}/parent`, authorization, {
      version: child.version,
      parentTaskRef: source.publicId,
    }, "PUT"),
    taskContext(child.publicId),
  );
  assert.equal(attachedResponse.status, 200);
  const attached = (await attachedResponse.json() as { data: TaskDetail }).data;
  assert.equal(attached.parent?.ref, source.publicId);
  const sourceDetail = await getAgentTaskDetail(owner, source.publicId);
  const cycle = await setAgentTaskParentRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/parent`, authorization, {
      version: sourceDetail.version,
      parentTaskRef: child.publicId,
    }, "PUT"),
    taskContext(source.publicId),
  );
  assert.equal(cycle.status, 400);
  assert.equal((await getAgentTaskDetail(owner, source.publicId)).parent, null);

  const crossProjectDenied = await createAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations`, authorization, {
      targetTaskRef: crossProject.publicId,
      type: "related",
      direction: "outgoing",
      idempotencyKey: "rest-cross-project-denied",
    }, "POST"),
    taskContext(source.publicId),
  );
  assert.equal(crossProjectDenied.status, 400);

  const relationInput = {
    targetTaskRef: peer.publicId,
    type: "blocks",
    direction: "outgoing",
    idempotencyKey: "rest-cross-project-retry",
  };
  const relationResponse = await createAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations`, authorization, relationInput, "POST"),
    taskContext(source.publicId),
  );
  assert.equal(relationResponse.status, 200);
  const relationResult = (await relationResponse.json() as {
    data: { relation: RelationDetail; task: TaskDetail };
  }).data;
  assert.equal(relationResult.relation.task.ref, peer.publicId);
  assert.equal(relationResult.relation.presentation, "blocks");

  const retry = await createAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations`, authorization, relationInput, "POST"),
    taskContext(source.publicId),
  );
  assert.equal(retry.status, 200);
  assert.equal(
    (await retry.json() as { data: { relation: RelationDetail } }).data.relation.ref,
    relationResult.relation.ref,
  );
  const selfRelation = await createAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations`, authorization, {
      ...relationInput,
      targetTaskRef: source.publicId,
      idempotencyKey: "rest-self-relation",
    }, "POST"),
    taskContext(source.publicId),
  );
  assert.equal(selfRelation.status, 400);
  const invalidRelation = await createAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations`, authorization, {
      ...relationInput,
      targetTaskRef: "missing-task-ref",
      idempotencyKey: "rest-invalid-relation",
    }, "POST"),
    taskContext(source.publicId),
  );
  assert.equal(invalidRelation.status, 404);
  const oneSideCredential = await issueApiCredential(oneSideEditor, {
    name: "REST graph one side",
    scopes: ["api:write"],
    expiresInDays: 1,
  });
  const oneSideDenied = await createAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations`, {
      authorization: `Bearer ${oneSideCredential.token}`,
    }, {
      ...relationInput,
      targetTaskRef: crossProject.publicId,
      idempotencyKey: "rest-one-side-relation",
    }, "POST"),
    taskContext(source.publicId),
  );
  assert.equal(oneSideDenied.status, 404);

  const staleUpdate = await updateAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations/${relationResult.relation.ref}`, authorization, {
      version: relationResult.relation.version + 1,
      type: "related",
      direction: "outgoing",
    }, "PATCH"),
    relationContext(source.publicId, relationResult.relation.ref),
  );
  assert.equal(staleUpdate.status, 409);
  const updated = await updateAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations/${relationResult.relation.ref}`, authorization, {
      version: relationResult.relation.version,
      type: "related",
      direction: "outgoing",
    }, "PATCH"),
    relationContext(source.publicId, relationResult.relation.ref),
  );
  assert.equal(updated.status, 200);
  const updatedRelation = (await updated.json() as {
    data: { relation: RelationDetail };
  }).data.relation;
  const removed = await deleteAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations/${updatedRelation.ref}`, authorization, {
      version: updatedRelation.version,
    }, "DELETE"),
    relationContext(source.publicId, updatedRelation.ref),
  );
  assert.equal(removed.status, 200);
  const afterRemoval = await getAgentTaskDetail(owner, source.publicId);
  const duplicateResponse = await createAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations`, authorization, {
      targetTaskRef: peer.publicId,
      type: "duplicate_of",
      direction: "outgoing",
      idempotencyKey: "rest-duplicate-relation",
      taskVersion: afterRemoval.version,
    }, "POST"),
    taskContext(source.publicId),
  );
  assert.equal(duplicateResponse.status, 200);
  const duplicateResult = (await duplicateResponse.json() as {
    data: { relation: RelationDetail; task: TaskDetail };
  }).data;
  assert.equal(duplicateResult.relation.presentation, "duplicate_of");
  assert.equal(duplicateResult.task.status.category, "canceled");
  const deletedDuplicate = await deleteAgentTaskRelationRoute(
    jsonRequest(`https://example.test/api/agent/v1/tasks/${source.publicId}/relations/${duplicateResult.relation.ref}`, authorization, {
      version: duplicateResult.relation.version,
    }, "DELETE"),
    relationContext(source.publicId, duplicateResult.relation.ref),
  );
  assert.equal(deletedDuplicate.status, 200);
});

test("MCP exposes the same Project-code projection, assignee, Label replacement, hierarchy, and relation command boundary", async () => {
  const owner = await getOrCreateUser(actor("mcp-parity-owner"));
  const member = await getOrCreateUser(actor("mcp-parity-member"));
  await createProject(owner, { name: "MCP parity", taskCode: "mcp-parity2" });
  await createProject(owner, { name: "MCP parity other", taskCode: "MO" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "MCP parity",
  )!;
  const otherProject = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "MCP parity other",
  )!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: member.email,
    permission: "viewer",
  });
  await createTask(owner, { title: "MCP parent", projectId: project.id });
  await createTask(owner, { title: "MCP cross-project", projectId: otherProject.id });
  const parent = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "MCP parent",
  )!;
  const crossProject = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "MCP cross-project",
  )!;
  const labels = await createLabel(owner, { name: "MCP label", color: "#225588" });
  const label = labels.find((item) => item.name === "MCP label")!;
  const labelRef = (await listAgentLabels(owner)).items.find(
    (item) => item.name === label.name,
  )!.ref;
  const credential = await issueApiCredential(owner, {
    name: "MCP parity",
    scopes: ["api:write"],
    expiresInDays: 1,
  });

  const projects = await mcpCall(credential.token, "list_projects", {}) as
    Array<{ name: string; taskCode: string }>;
  assert.equal(
    projects.find((item) => item.name === "MCP parity")?.taskCode,
    "MCP-PARITY2",
  );

  const created = await mcpCall(credential.token, "create_task", {
    title: "MCP created",
    description: "Parity metadata",
    projectRef: project.publicId,
    priority: "medium",
    assigneeEmail: member.email,
    labelRefs: [labelRef],
    estimate: 3,
    dueDate: "2026-09-01",
  }) as TaskDetail;
  assert.equal(created.assignee?.displayName, member.displayName);
  assert.deepEqual(created.labels.map((item) => item.ref), [labelRef]);

  const updated = await mcpCall(credential.token, "update_task", {
    taskRef: created.ref,
    version: created.version,
    priority: "high",
    assigneeEmail: null,
    dueDate: null,
    estimate: 5,
  }) as TaskDetail;
  assert.equal(updated.version, created.version + 1);
  assert.equal(updated.assignee, null);
  const cleared = await mcpCall(credential.token, "replace_task_labels", {
    taskRef: created.ref,
    version: updated.version,
    labelRefs: [],
  }) as TaskDetail;
  assert.equal(cleared.version, updated.version + 1);
  assert.deepEqual(cleared.labels, []);

  const attached = await mcpCall(credential.token, "set_task_parent", {
    taskRef: created.ref,
    version: cleared.version,
    parentTaskRef: parent.publicId,
  }) as TaskDetail;
  assert.equal(attached.parent?.ref, parent.publicId);
  assert.match(
    await mcpCallFailure(credential.token, "create_task_relation", {
      taskRef: created.ref,
      targetTaskRef: crossProject.publicId,
      type: "related",
      direction: "outgoing",
      idempotencyKey: "mcp-parity-cross-project",
    }),
    /same Project/,
  );
  const relationResult = await mcpCall(credential.token, "create_task_relation", {
    taskRef: created.ref,
    targetTaskRef: parent.publicId,
    type: "related",
    direction: "outgoing",
    idempotencyKey: "mcp-parity-relation",
  }) as { relation: RelationDetail; task: TaskDetail };
  assert.equal(relationResult.relation.presentation, "related");
  const changed = await mcpCall(credential.token, "update_task_relation", {
    taskRef: created.ref,
    relationRef: relationResult.relation.ref,
    version: relationResult.relation.version,
    type: "blocks",
    direction: "incoming",
  }) as { relation: RelationDetail; task: TaskDetail };
  assert.equal(changed.relation.presentation, "blocked_by");
  const removed = await mcpCall(credential.token, "delete_task_relation", {
    taskRef: created.ref,
    relationRef: changed.relation.ref,
    version: changed.relation.version,
  }) as { deleted: boolean; relationRef: string; task: TaskDetail };
  assert.equal(removed.deleted, true);
  const duplicate = await mcpCall(credential.token, "create_task_relation", {
    taskRef: created.ref,
    targetTaskRef: parent.publicId,
    type: "duplicate_of",
    direction: "outgoing",
    idempotencyKey: "mcp-parity-duplicate",
    taskVersion: removed.task.version,
  }) as { relation: RelationDetail; task: TaskDetail };
  assert.equal(duplicate.relation.presentation, "duplicate_of");
  assert.equal(duplicate.task.status.category, "canceled");
  const duplicateRemoved = await mcpCall(credential.token, "delete_task_relation", {
    taskRef: created.ref,
    relationRef: duplicate.relation.ref,
    version: duplicate.relation.version,
  }) as { deleted: boolean; relationRef: string; task: TaskDetail };
  assert.equal(duplicateRemoved.deleted, true);
});

function actor(name: string) {
  return {
    provider: "chatgpt" as const,
    providerAccountKey: name,
    displayName: name,
    email: `${name}@example.test`,
  };
}

function jsonRequest(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  method: string,
) {
  return new Request(url, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function taskContext(ref: string) {
  return { params: Promise.resolve({ ref }) };
}

function relationContext(ref: string, relationRef: string) {
  return { params: Promise.resolve({ ref, relationRef }) };
}

async function mcpCall(
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await mcpPost(new Request("https://example.test/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${name}-${crypto.randomUUID()}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  }));
  assert.equal(response.status, 200, name);
  const text = await response.text();
  const payload = text.startsWith("event:")
    ? text.split("\n").find((line) => line.startsWith("data:"))!
        .slice("data:".length).trim()
    : text;
  const result = JSON.parse(payload) as {
    result: {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
      structuredContent: { data: unknown };
    };
  };
  assert.notEqual(result.result.isError, true, result.result.content?.[0]?.text ?? name);
  return result.result.structuredContent.data;
}

async function mcpCallFailure(
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await mcpPost(new Request("https://example.test/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${name}-${crypto.randomUUID()}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  }));
  assert.equal(response.status, 200, name);
  const text = await response.text();
  const payload = text.startsWith("event:")
    ? text.split("\n").find((line) => line.startsWith("data:"))!
        .slice("data:".length).trim()
    : text;
  const result = JSON.parse(payload) as {
    result: {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
  };
  assert.equal(result.result.isError, true, name);
  return result.result.content?.[0]?.text ?? "";
}

type TaskDetail = {
  ref: string;
  identifier: string;
  title: string;
  description: string;
  version: number;
  estimate: number | null;
  rank: number;
  priority: string;
  status: { ref: string; category: string };
  project: { ref: string } | null;
  release: { ref: string } | null;
  assignee: { displayName: string } | null;
  labels: Array<{ ref: string; name: string }>;
  parent: { ref: string; identifier: string } | null;
  lifecycle: { startedAt: string | null; archivedAt: string | null };
};

type RelationDetail = {
  ref: string;
  version: number;
  type: string;
  direction: string;
  presentation: string;
  task: { ref: string };
};
