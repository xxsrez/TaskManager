import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/favicon.ico/route";

test("the browser favicon route returns an image instead of 404", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.match(await response.text(), /<svg/);
});
