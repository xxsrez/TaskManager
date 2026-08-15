import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const taskTracker = readFileSync(
  new URL("../components/task-tracker.tsx", import.meta.url),
  "utf8",
);

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[1];
}

test("desktop task links vertically center their single-line content", () => {
  const rule = declarations(".task-identity, .task-title");
  assert.match(rule, /display:\s*(?:inline-)?flex\s*;/);
  assert.match(rule, /align-items:\s*center\s*;/);
});

test("share member actions keep a padded desktop hit target", () => {
  const rule = declarations(".access-row button");
  assert.match(rule, /min-height:\s*28px\s*;/);
  assert.match(rule, /padding:\s*0\s+[1-9][0-9]*px\s*;/);
});

test("the application owns its reset without Tailwind Preflight", () => {
  assert.doesNotMatch(css, /@import\s+["']tailwindcss["']/);
  assert.match(css, /\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*border-box\s*;/);
  assert.match(declarations("button"), /padding:\s*0\s*;/);
});

test("board cards do not shrink their content through the bottom padding", () => {
  const rule = declarations(".task-card");
  assert.match(rule, /flex:\s*0\s+0\s+auto\s*;/);
});

test("sidebar navigation clips and truncates long labels without losing its right inset", () => {
  assert.match(declarations(".nav-item"), /overflow:\s*hidden\s*;/);
  const label = declarations(".nav-label");
  assert.match(label, /min-width:\s*0\s*;/);
  assert.match(label, /flex:\s*1\s*;/);
  assert.match(label, /overflow:\s*hidden\s*;/);
  assert.match(label, /text-overflow:\s*ellipsis\s*;/);
  assert.match(label, /white-space:\s*nowrap\s*;/);
  assert.match(declarations(".nav-count"), /flex:\s*0\s+0\s+auto\s*;/);
});

test("the mobile close control stays hidden on desktop independently of icon-button order", () => {
  assert.match(declarations(".icon-button.mobile-sidebar-close"), /display:\s*none\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.icon-button\.mobile-sidebar-close\s*\{[^}]*display:\s*inline-grid\s*;/,
  );
});

test("sidebar height constraints keep only navigation scrollable", () => {
  assert.match(declarations(".app-shell"), /height:\s*100dvh\s*;/);
  assert.match(declarations(".sidebar"), /min-height:\s*0\s*;/);
  assert.match(
    declarations(".sidebar-head, .sidebar-search, .sidebar-foot"),
    /flex:\s*0\s+0\s+auto\s*;/,
  );
  const navigation = declarations(".nav-scroll");
  assert.match(navigation, /overflow-y:\s*auto\s*;/);
  assert.match(navigation, /overflow-x:\s*hidden\s*;/);
  assert.match(declarations(".account-menu"), /max-height:\s*calc\(100dvh\s*-\s*88px/);
  assert.match(declarations(".account-menu"), /overflow-y:\s*auto\s*;/);
});

test("board titles reserve only the checkbox hit area and reveal it for keyboard focus", () => {
  assert.doesNotMatch(declarations(".task-card h3"), /margin:\s*0\s+21px/);
  const exclusion = declarations(".task-card.editable h3::before");
  assert.match(exclusion, /float:\s*right\s*;/);
  assert.match(exclusion, /width:\s*28px\s*;/);
  assert.match(exclusion, /height:\s*28px\s*;/);
  assert.match(
    declarations(".task-card:focus-within .card-check span, .card-check:focus-visible span"),
    /opacity:\s*1\s*;/,
  );
});

test("mobile drawer logic centralizes dismissal and restores focus", () => {
  assert.match(taskTracker, /function closeMobileSidebar\(/);
  assert.match(taskTracker, /mobileMenuRef\.current\?\.focus\(\)/);
  assert.match(taskTracker, /mobileSidebarCloseRef\.current\?\.focus\(\)/);
  assert.match(taskTracker, /aria-label="Close navigation"[\s\S]*?autoFocus/);
});

test("task rows do not attach a hidden double-click action", () => {
  assert.doesNotMatch(taskTracker, /onDoubleClick=\{onPeek\}/);
});
