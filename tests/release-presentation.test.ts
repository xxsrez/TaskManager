import assert from "node:assert/strict";
import test from "node:test";
import { metadataForNavigation } from "../lib/navigation-metadata";
import { formatReleaseName } from "../lib/release-presentation";
import type { AppSnapshot } from "../lib/types";

test("release names are qualified by their project from one formatter", () => {
  assert.equal(formatReleaseName("Homeostat", "0.1"), "Homeostat 0.1");
  assert.equal(formatReleaseName("  Homeostat  ", " 0.1 "), "Homeostat 0.1");
  assert.equal(formatReleaseName(undefined, "0.1"), "0.1");
});

test("release metadata uses the qualified name for browser and link previews", () => {
  const data = {
    projects: [{ id: "project-1", name: "Homeostat" }],
    releases: [{
      id: "release-1",
      projectId: "project-1",
      name: "0.1",
      description: "Release description",
    }],
    tasks: [],
    views: [],
  } as unknown as AppSnapshot;

  const metadata = metadataForNavigation(
    { surface: "release:release-1", layout: "board", taskId: null },
    data,
  );

  assert.equal(metadata.title, "Homeostat 0.1 board – Task Manager");
  assert.equal(metadata.openGraph?.title, "Homeostat 0.1 board – Task Manager");
  assert.equal(metadata.twitter?.title, "Homeostat 0.1 board – Task Manager");
});
