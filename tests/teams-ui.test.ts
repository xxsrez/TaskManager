import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamsSurface } from "../components/task-tracker";

const trackerSource = readFileSync(
  new URL("../components/task-tracker.tsx", import.meta.url),
  "utf8",
);
const styleSource = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("Teams surface has a stable loading shell and isolated navigation entry", () => {
  const html = renderToStaticMarkup(createElement(TeamsSurface));
  assert.match(html, /Teams catalog/);
  assert.match(html, /Loading Teams/);
  assert.match(trackerSource, /label="Teams"[^\n]+href="\/teams"/);
  assert.match(trackerSource, /No Teams yet/);
  assert.match(trackerSource, /Teams you’ve joined/);
  assert.match(trackerSource, /Deactivate/);
  assert.match(trackerSource, /Reactivate/);
});

test("People & Teams keeps People and Team routes separate and explains Task scope", () => {
  assert.match(trackerSource, /People &amp; Teams/);
  assert.match(trackerSource, /This Task only/);
  assert.match(trackerSource, /does not open the Project or sibling Tasks/);
  assert.match(trackerSource, /Project route/);
  assert.match(trackerSource, /Search your Teams/);
  assert.match(trackerSource, /No Team routes yet\. Existing People access is unchanged/);
  assert.match(styleSource, /\.people-teams-body/);
  assert.match(styleSource, /@media \(max-width: 640px\)[\s\S]+\.teams-surface \{ display: block/);
});
