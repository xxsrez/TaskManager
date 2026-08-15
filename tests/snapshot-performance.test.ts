import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureRuntimeEnvironment } from "../lib/runtime-environment";
import { getOrCreateUser, getSnapshot } from "../lib/repository";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;
let directCollectionReads = 0;
let batchCalls = 0;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
  configureRuntimeEnvironment({
    DB: instrumentDatabase(harness.database),
  });
});

after(async () => dispose?.());

test("workspace snapshot collection reads use one D1 batch round trip", async () => {
  const user = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "snapshot-performance-user",
    displayName: "Snapshot Performance",
    email: "snapshot-performance@example.test",
  });
  directCollectionReads = 0;
  batchCalls = 0;

  await getSnapshot(user, { taskLimit: 40 });

  assert.equal(directCollectionReads, 0);
  assert.equal(batchCalls, 1);
});

function instrumentDatabase(database: D1Database): D1Database {
  const rawStatements = new WeakMap<object, D1PreparedStatement>();

  function instrumentStatement(statement: D1PreparedStatement): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => instrumentStatement(target.bind(...values));
        }
        if (property === "all") {
          return <T = unknown>() => {
            directCollectionReads += 1;
            return target.all<T>();
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1PreparedStatement;
    rawStatements.set(proxy, statement);
    return proxy;
  }

  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => instrumentStatement(target.prepare(query));
      }
      if (property === "batch") {
        return <T = unknown>(statements: D1PreparedStatement[]) => {
          batchCalls += 1;
          return target.batch<T>(
            statements.map((statement) => rawStatements.get(statement) ?? statement),
          );
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}
