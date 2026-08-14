import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

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
