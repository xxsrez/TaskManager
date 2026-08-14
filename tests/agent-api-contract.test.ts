import assert from "node:assert/strict";
import test from "node:test";
import {
  apiTokenFromAuthorization,
  createApiToken,
  hashApiToken,
  normalizeApiScopes,
} from "../lib/api-credential-crypto";
import {
  AgentApiError,
  encodeCursor,
  parseAgentTaskListQuery,
} from "../lib/agent-api-contract";
import { agentApiOpenApi } from "../lib/agent-api-openapi";

test("API credentials are opaque bearer tokens and write includes read", async () => {
  const { token, prefix } = createApiToken();
  assert.match(token, /^tm_pat_[A-Za-z0-9_-]{40,}$/);
  assert.equal(token.startsWith(prefix), true);
  assert.equal(apiTokenFromAuthorization(`Bearer ${token}`), token);
  assert.equal(apiTokenFromAuthorization(`bearer ${token}`), token);
  assert.equal(apiTokenFromAuthorization(`Basic ${token}`), null);
  assert.deepEqual(normalizeApiScopes(["api:write"]), [
    "api:read",
    "api:write",
  ]);
  assert.notEqual(await hashApiToken(token), token);
  assert.equal(await hashApiToken(token), await hashApiToken(token));
});

test("task collection parser accepts bounded filters and resumes its cursor", async () => {
  const first = await parseAgentTaskListQuery(
    new URLSearchParams(
      "limit=25&project_ref=project-ref&status_category=started&priority=high&search=ship&order=updated",
    ),
  );
  assert.equal(first.limit, 25);
  assert.equal(first.projectRef, "project-ref");
  assert.deepEqual(first.statusCategories, ["started"]);
  assert.deepEqual(first.priorities, ["high"]);

  const cursor = encodeCursor(25, first.fingerprint);
  const second = await parseAgentTaskListQuery(
    new URLSearchParams(
      `limit=25&project_ref=project-ref&status_category=started&priority=high&search=ship&order=updated&cursor=${cursor}`,
    ),
  );
  assert.equal(second.offset, 25);

  const priorityOrder = await parseAgentTaskListQuery(
    new URLSearchParams("order=priority"),
  );
  assert.equal(priorityOrder.direction, "asc");
});

test("task collection parser rejects unknown fields and cross-query cursors", async () => {
  await assert.rejects(
    parseAgentTaskListQuery(new URLSearchParams("include=description")),
    (error: unknown) =>
      error instanceof AgentApiError && error.code === "invalid_argument",
  );
  const first = await parseAgentTaskListQuery(
    new URLSearchParams("project_ref=one"),
  );
  const cursor = encodeCursor(50, first.fingerprint);
  await assert.rejects(
    parseAgentTaskListQuery(
      new URLSearchParams(`project_ref=two&cursor=${cursor}`),
    ),
    (error: unknown) =>
      error instanceof AgentApiError && error.code === "invalid_argument",
  );
});

test("OpenAPI exposes task work but no administration or sharing operations", () => {
  const paths = Object.keys(agentApiOpenApi.paths);
  assert.equal(paths.includes("/tasks"), true);
  assert.equal(paths.includes("/tasks/{ref}"), true);
  assert.equal(paths.includes("/projects"), true);
  assert.equal(paths.includes("/releases"), true);
  assert.equal(paths.some((path) => /admin|backup|share|credential/.test(path)), false);
  assert.equal(
    Object.hasOwn(
      agentApiOpenApi.components.schemas.TaskSummary.properties,
      "description",
    ),
    false,
  );
  assert.deepEqual(
    agentApiOpenApi.components.schemas.TaskUpdate.required,
    ["version"],
  );
});
