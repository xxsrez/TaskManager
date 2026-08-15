import { readdirSync, readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import {
  configureRuntimeEnvironment,
  resetRuntimeEnvironmentForTests,
} from "../../lib/runtime-environment";

export async function createD1TestHarness(
  variables: Record<string, string> = {},
) {
  const miniflare = new Miniflare({
    compatibilityDate: "2026-05-22",
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: ["DB"],
  });
  const database = await miniflare.getD1Database("DB");
  const migrations = readdirSync(new URL("../../drizzle", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    const statements = readFileSync(
      new URL(`../../drizzle/${migration}`, import.meta.url),
      "utf8",
    )
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    if (statements.length) {
      await database.batch(statements.map((statement) => database.prepare(statement)));
    }
  }
  configureRuntimeEnvironment({
    DB: database as unknown as D1Database,
    ...variables,
  });
  return {
    database: database as unknown as D1Database,
    async dispose() {
      resetRuntimeEnvironmentForTests();
      await miniflare.dispose();
    },
  };
}
