import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureActorResolverForTests } from "../lib/auth";
import { ConflictError, ValidationError } from "../lib/domain";
import {
  getOrCreateUser,
  getUserProfile,
  updateUserProfile,
} from "../lib/repository";
import { GET, PATCH } from "../app/api/settings/profile/route";
import { createD1TestHarness } from "./helpers/d1";

const actor = {
  provider: "chatgpt" as const,
  providerAccountKey: "settings-owner-account",
  displayName: "Provider Name",
  email: "settings-owner@example.test",
};

let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
  configureActorResolverForTests(async () => actor);
});

after(async () => {
  configureActorResolverForTests(null);
  await dispose?.();
});

test("profile name and timezone survive a second authenticated session", async () => {
  const user = await getOrCreateUser(actor);
  const saved = await updateUserProfile(user, {
    version: user.version,
    displayName: "Andrey Saved",
    timezone: "Atlantic/Madeira",
  });

  const secondSession = await getOrCreateUser({
    ...actor,
    displayName: "Provider Renamed",
  });
  assert.equal(secondSession.displayName, "Andrey Saved");
  assert.equal(secondSession.timezone, "Atlantic/Madeira");
  assert.equal(secondSession.version, saved.user.version);
});

test("invalid timezone and stale version leave the profile unchanged", async () => {
  const user = await getOrCreateUser(actor);
  const before = await getUserProfile(user);

  await assert.rejects(
    updateUserProfile(user, {
      version: before.user.version,
      displayName: "Must not persist",
      timezone: "Madeira/Definitely-Invalid",
    }),
    ValidationError,
  );
  assert.deepEqual((await getUserProfile(user)).user, before.user);

  const saved = await updateUserProfile(user, {
    version: before.user.version,
    displayName: "Fresh version",
  });
  await assert.rejects(
    updateUserProfile(user, {
      version: before.user.version,
      timezone: "UTC",
    }),
    ConflictError,
  );
  assert.equal((await getUserProfile(user)).user.version, saved.user.version);
});

test("profile API projects verified identity server-side and rejects spoof fields", async () => {
  const getResponse = await GET();
  assert.equal(getResponse.status, 200);
  const profile = await getResponse.json() as Awaited<ReturnType<typeof getUserProfile>>;
  assert.equal(profile.user.email, actor.email);
  assert.deepEqual(profile.identities.map((identity) => ({
    provider: identity.provider,
    verifiedEmail: identity.verifiedEmail,
  })), [{ provider: "chatgpt", verifiedEmail: actor.email }]);

  const patchResponse = await PATCH(new Request("https://task-manager.test/api/settings/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: profile.user.version,
      displayName: "Spoof attempt",
      email: "attacker@example.test",
      identities: [{ provider: "google", verifiedEmail: "attacker@example.test" }],
    }),
  }));
  assert.equal(patchResponse.status, 400);
  const after = await getUserProfile(await getOrCreateUser(actor));
  assert.equal(after.user.email, actor.email);
  assert.deepEqual(after.identities.map((identity) => identity.provider), ["chatgpt"]);
});

test("appearance and sidebar preferences are versioned per user", async () => {
  const user = await getOrCreateUser(actor);
  const before = await getUserProfile(user);
  const saved = await updateUserProfile(user, {
    version: before.user.version,
    theme: "dark",
    sidebarPreference: "collapsed",
  });
  assert.equal(saved.user.theme, "dark");
  assert.equal(saved.user.sidebarPreference, "collapsed");
  const reloaded = await getUserProfile(await getOrCreateUser(actor));
  assert.equal(reloaded.user.theme, "dark");
  assert.equal(reloaded.user.sidebarPreference, "collapsed");
});
