import assert from "node:assert/strict";
import test from "node:test";
import {
  AdminAccessError,
  assertAdmin,
  buildAdminOverview,
  isAdminEmail,
  type AdminUserAggregate,
} from "../lib/admin";

const adminEmails = " owner@example.com,second@example.com ";

test("admin access uses a normalized server-side allowlist", () => {
  assert.equal(isAdminEmail("OWNER@example.com", adminEmails), true);
  assert.equal(isAdminEmail("visitor@example.com", adminEmails), false);
  assert.doesNotThrow(() =>
    assertAdmin(
      {
        id: "owner",
        displayName: "Owner",
        email: "owner@example.com",
        timezone: "UTC",
      },
      adminEmails,
    ),
  );
});

test("a non-admin cannot cross the administration boundary", () => {
  assert.throws(
    () =>
      assertAdmin(
        {
          id: "visitor",
          displayName: "Visitor",
          email: "visitor@example.com",
          timezone: "UTC",
        },
        adminEmails,
      ),
    AdminAccessError,
  );
});

test("admin overview reports registrations, activity, and owned data counts", () => {
  const rows: AdminUserAggregate[] = [
    {
      id: "owner",
      displayName: "Owner",
      email: "owner@example.com",
      registeredAt: "2026-08-01 10:00:00",
      lastSeenAt: "2026-08-14 10:00:00",
      taskCount: 7,
      recentTaskCount: 3,
      projectCount: 2,
      releaseCount: 1,
      viewCount: 4,
      lastTaskActivityAt: "2026-08-14T09:30:00.000Z",
      lastProjectActivityAt: "2026-08-10T08:00:00.000Z",
      lastReleaseActivityAt: null,
      lastViewActivityAt: "2026-08-13T08:00:00.000Z",
    },
    {
      id: "visitor",
      displayName: "Visitor",
      email: "visitor@example.com",
      registeredAt: "2026-07-01 10:00:00",
      lastSeenAt: "2026-07-02 10:00:00",
      taskCount: 2,
      recentTaskCount: 0,
      projectCount: 1,
      releaseCount: 0,
      viewCount: 1,
      lastTaskActivityAt: "2026-07-02T09:30:00.000Z",
      lastProjectActivityAt: null,
      lastReleaseActivityAt: null,
      lastViewActivityAt: null,
    },
  ];

  const overview = buildAdminOverview(
    rows,
    adminEmails,
    Date.parse("2026-08-14T11:00:00.000Z"),
  );
  assert.equal(overview.registeredUserCount, 2);
  assert.equal(overview.activeUserCount, 1);
  assert.equal(overview.taskCount, 9);
  assert.equal(overview.projectCount, 3);
  assert.equal(overview.releaseCount, 1);
  assert.equal(overview.viewCount, 5);
  assert.equal(overview.users[0]?.isAdmin, true);
  assert.equal(
    overview.users[0]?.lastContentActivityAt,
    "2026-08-14T09:30:00.000Z",
  );
  assert.equal(overview.users[0]?.recentTaskCount, 3);
});
