import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeModules = [
  "lib/repository.ts",
  "lib/oauth.ts",
  "lib/api-credentials.ts",
  "lib/project-backup.ts",
  "lib/system-backup.ts",
  "lib/comments.ts",
  "lib/workspace-sync.ts",
];

test("runtime requests rely on versioned migrations instead of schema bootstrap", async () => {
  const sources = await Promise.all(
    runtimeModules.map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")),
  );
  const runtimeSource = sources.join("\n");

  assert.doesNotMatch(runtimeSource, /ensureDatabase/);
  assert.doesNotMatch(runtimeSource, /CREATE TABLE IF NOT EXISTS/);
  assert.doesNotMatch(runtimeSource, /ALTER TABLE/);
});
