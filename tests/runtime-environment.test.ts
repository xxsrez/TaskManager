import assert from "node:assert/strict";
import test from "node:test";
import {
  configureRuntimeEnvironment,
  getRuntimeEnvironment,
  resetRuntimeEnvironmentForTests,
} from "../lib/runtime-environment";

test("runtime environment is explicit and replaceable for isolated tests", () => {
  resetRuntimeEnvironmentForTests();
  assert.throws(() => getRuntimeEnvironment(), /not configured/i);
  const environment = { TASK_MANAGER_PUBLIC_ORIGIN: "https://example.test" };
  configureRuntimeEnvironment(environment);
  assert.equal(getRuntimeEnvironment(), environment);
  resetRuntimeEnvironmentForTests();
});
