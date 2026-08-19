import assert from "node:assert/strict";
import test from "node:test";
import { createUserPreferenceSaveQueue } from "../lib/user-preference-save";
import type { UserProfile } from "../lib/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

test("rapid preference changes serialize and coalesce to the latest user intent", async () => {
  let profile: UserProfile = {
    user: {
      id: "user-1",
      displayName: "User",
      email: "user@example.test",
      timezone: "UTC",
      theme: "system",
      sidebarPreference: "expanded",
      version: 1,
    },
    identities: [],
  };
  const firstWrite = deferred<UserProfile>();
  const writes: Array<{ version: number; theme?: string; sidebarPreference?: string }> = [];
  const queue = createUserPreferenceSaveQueue({
    current: () => profile,
    save: async (version, changes) => {
      writes.push({ version, ...changes });
      if (writes.length === 1) return firstWrite.promise;
      return {
        ...profile,
        user: { ...profile.user, ...changes, version: version + 1 },
      };
    },
    refresh: async () => profile,
    isConflict: () => false,
    apply: (next) => { profile = next; },
    error: () => assert.fail("rapid serialized saves must not fail"),
  });

  const first = queue.enqueue({ theme: "dark" });
  void queue.enqueue({ theme: "light" });
  void queue.enqueue({ theme: "system" });
  void queue.enqueue({ sidebarPreference: "collapsed" });

  firstWrite.resolve({
    ...profile,
    user: { ...profile.user, theme: "dark", version: 2 },
  });
  await first;
  await queue.idle();

  assert.deepEqual(writes, [
    { version: 1, theme: "dark" },
    { version: 2, theme: "system", sidebarPreference: "collapsed" },
  ]);
  assert.equal(profile.user.version, 3);
  assert.equal(profile.user.theme, "system");
  assert.equal(profile.user.sidebarPreference, "collapsed");
});
