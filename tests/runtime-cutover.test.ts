import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const removedRuntimeSurfaces = [
  "app/import/linear/page.tsx",
  "app/api/import/linear/route.ts",
  "app/api/tasks/[id]/external-source/route.ts",
  "app/api/agent/v1/tasks/[ref]/external-context/route.ts",
  "components/linear-importer.tsx",
];

test("provider import and external-context surfaces are absent from the deployed runtime", async () => {
  for (const path of removedRuntimeSurfaces) {
    await assert.rejects(access(new URL(`../${path}`, import.meta.url)));
  }
});

test("public Task contracts contain no Linear source URL or branch metadata", async () => {
  const sources = await Promise.all([
    "components/task-tracker.tsx",
    "lib/agent-api-openapi.ts",
    "lib/agent-api-repository.ts",
    "lib/task-manager-mcp.ts",
  ].map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")));
  const runtime = sources.join("\n");

  assert.doesNotMatch(runtime, /get_task_external_context/);
  assert.doesNotMatch(runtime, /gitBranchName/);
  assert.doesNotMatch(runtime, /\/api\/tasks\/[^\s"'`]+\/external-source/);
});
