import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AccountMenu,
  nextAccountMenuFocusIndex,
} from "../components/task-tracker";

const user = {
  id: "user-1",
  displayName: "Test User",
  email: "test@example.com",
  timezone: "UTC",
};

function renderAccountMenu(isAdmin: boolean) {
  return renderToStaticMarkup(createElement(AccountMenu, {
    user,
    isAdmin,
    onNavigate: () => undefined,
  }));
}

test("account menu exposes only identity, Workspace, Settings, and authorized Administration", () => {
  const userMarkup = renderAccountMenu(false);
  const adminMarkup = renderAccountMenu(true);

  assert.match(userMarkup, /role="menu"[^>]*aria-label="Account menu"/);
  assert.match(userMarkup, /class="account-menu-user account-menu-identity"[^>]*href="\/settings\/profile"[^>]*role="menuitem"/);
  assert.match(userMarkup, /href="\/workspace"[^>]*role="menuitem"[\s\S]*?>Workspace</);
  assert.match(userMarkup, /href="\/settings\/profile"[^>]*role="menuitem"[\s\S]*?>Settings</);
  assert.doesNotMatch(userMarkup, /Administration/);
  assert.match(adminMarkup, /href="\/admin"[^>]*role="menuitem"[\s\S]*?>Administration</);

  for (const removed of [
    "My tasks",
    "Codex setup",
    "Workflow statuses",
    "Labels",
    "Label groups",
    "Project backup",
    "Appearance",
  ]) {
    assert.doesNotMatch(userMarkup, new RegExp(removed));
    assert.doesNotMatch(adminMarkup, new RegExp(removed));
  }
});

test("account menu keyboard navigation wraps and supports Home and End", () => {
  assert.equal(nextAccountMenuFocusIndex("ArrowDown", 0, 3), 1);
  assert.equal(nextAccountMenuFocusIndex("ArrowDown", 2, 3), 0);
  assert.equal(nextAccountMenuFocusIndex("ArrowUp", 0, 3), 2);
  assert.equal(nextAccountMenuFocusIndex("Home", 2, 3), 0);
  assert.equal(nextAccountMenuFocusIndex("End", 0, 3), 2);
  assert.equal(nextAccountMenuFocusIndex("Enter", 0, 3), null);
  assert.equal(nextAccountMenuFocusIndex("ArrowDown", 0, 0), null);
});

test("account menu keeps canonical browser anchors and local history integration", () => {
  const source = readFileSync(
    new URL("../components/task-tracker.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /<AccountMenu[\s\S]*?onNavigate=\{\(event, nextSurface\) => handleLocalLink\(event, \(\) => \{[\s\S]*?navigateSurface\(nextSurface, "list"\)/);
  assert.match(source, /accountMenuOpen[\s\S]*?accountTriggerRef\.current\?\.focus\(\)/);
  assert.match(source, /accountMenuFirstItemRef\.current\?\.focus\(\)/);
});

test("Administration navigation reloads the server-projected admin surface", () => {
  const source = readFileSync(
    new URL("../components/task-tracker.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /function navigateSurface\(nextSurface: string, nextLayout\?: Layout\)\s*\{[\s\S]*?if \(nextSurface === "admin"\) \{[\s\S]*?window\.location\.assign\("\/admin"\);[\s\S]*?return;/,
  );
});

test("account menu remains overflow-safe and touch-sized in both phone orientations", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.account-menu\s*\{[^}]*overflow-x:\s*hidden\s*;/);
  assert.match(css, /\.account-menu-identity\s*\{[^}]*width:\s*100%\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.mobile-sidebar-open \.account-menu-item,\s*\.mobile-sidebar-open \.account-menu-identity\s*\{[^}]*min-height:\s*44px\s*;/,
  );
});

test("canonical interface docs keep Labels and Label groups inside Settings", () => {
  const specification = readFileSync(
    new URL("../docs/specs/interface.md", import.meta.url),
    "utf8",
  );

  assert.match(specification, /`Settings → Labels` содержит owner-only/);
  assert.match(specification, /`Settings → Labels` также содержит управление Label groups/);
  assert.doesNotMatch(specification, /Account menu `Labels`/);
  assert.doesNotMatch(specification, /Account menu `Label groups`/);
});
