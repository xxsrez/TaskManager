import assert from "node:assert/strict";
import test from "node:test";
import {
  runWorkspaceSyncCycle,
  type WorkspaceSyncCheckpoint,
} from "../components/workspace-sync-coordinator";
import type { AppSnapshot, WorkspaceSyncResponse } from "../lib/types";

const checkpoint: WorkspaceSyncCheckpoint = {
  taskIds: new Set(),
  projectIds: new Set(),
  releaseIds: new Set(),
  viewIds: new Set(),
};

test("one sync cycle drains ordered incremental pages without a bootstrap", async () => {
  const requests: string[] = [];
  const received: WorkspaceSyncResponse[] = [];
  const pages = [response("cursor-2", true), response("cursor-3", false)];

  const cursor = await runWorkspaceSyncCycle({
    cursor: "cursor-1",
    signal: new AbortController().signal,
    captureCheckpoint: () => checkpoint,
    onIncremental: (value) => received.push(value),
    onReset: () => assert.fail("incremental pages must not reset"),
    fetcher: async (input) => {
      requests.push(String(input));
      return Response.json(pages.shift());
    },
  });

  assert.equal(cursor, "cursor-3");
  assert.deepEqual(requests, [
    "/api/sync?cursor=cursor-1",
    "/api/sync?cursor=cursor-2",
  ]);
  assert.equal(received.length, 2);
});

test("a reset response captures local IDs before one authoritative bootstrap", async () => {
  const requests: string[] = [];
  const snapshot = { syncCursor: "bootstrap-cursor" } as AppSnapshot;
  let resetCheckpoint: WorkspaceSyncCheckpoint | undefined;

  const cursor = await runWorkspaceSyncCycle({
    cursor: "stale-cursor",
    signal: new AbortController().signal,
    captureCheckpoint: () => checkpoint,
    onIncremental: () => assert.fail("reset must not apply an incremental patch"),
    onReset: (_snapshot, captured) => {
      resetCheckpoint = captured;
    },
    fetcher: async (input) => {
      requests.push(String(input));
      return requests.length === 1
        ? Response.json({ ...response("reset-cursor", false), resetRequired: true })
        : Response.json(snapshot);
    },
  });

  assert.equal(cursor, "bootstrap-cursor");
  assert.equal(resetCheckpoint, checkpoint);
  assert.deepEqual(requests, [
    "/api/sync?cursor=stale-cursor",
    "/api/bootstrap",
  ]);
});

function response(cursor: string, hasMore: boolean): WorkspaceSyncResponse {
  return {
    cursor,
    resetRequired: false,
    hasMore,
    changes: {
      tasks: { upsert: [], remove: [] },
      projects: { upsert: [], remove: [] },
      releases: { upsert: [], remove: [] },
      views: { upsert: [], remove: [] },
      invalidations: {
        taskDetails: [],
        taskComments: [],
        taskActivities: [],
        taskAttachments: [],
      },
      labels: [],
      taskLabels: [],
      relations: [],
    },
  };
}
