import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const taskTracker = readFileSync(
  new URL("../components/task-tracker.tsx", import.meta.url),
  "utf8",
);
const taskAttachments = readFileSync(
  new URL("../components/task-attachments.tsx", import.meta.url),
  "utf8",
);
const stagedFileUpload = readFileSync(
  new URL("../lib/staged-file-upload.ts", import.meta.url),
  "utf8",
);
const taskDescriptionEditor = readFileSync(
  new URL("../components/task-description-editor.tsx", import.meta.url),
  "utf8",
);
const commentAttachmentMetadata = readFileSync(
  new URL("../components/comment-attachment-metadata.tsx", import.meta.url),
  "utf8",
);
const nativeImageWidthEditor = readFileSync(
  new URL("../components/native-image-width-editor.tsx", import.meta.url),
  "utf8",
);
const commentAttachmentAuthoring = readFileSync(
  new URL("../components/comment-attachment-authoring.tsx", import.meta.url),
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

test("entity deletion entrypoints stay touch-visible with 44px targets", () => {
  assert.match(declarations(".entity-card-shell"), /position:\s*relative\s*;/);
  assert.match(declarations(".release-row-shell"), /position:\s*relative\s*;/);
  assert.match(declarations(".entity-card-action"), /cursor:\s*pointer\s*;/);
  assert.match(declarations(".release-row-action"), /cursor:\s*pointer\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.release-row-action,\s*\.entity-card-action\s*\{[^}]*width:\s*44px\s*;[^}]*height:\s*44px\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.mobile-sidebar-open \.sidebar-saved-view-item > button\s*\{[^}]*width:\s*44px\s*;[^}]*height:\s*44px\s*;[^}]*opacity:\s*1\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.title-row \.icon-button,\s*\.title-actions \.button\s*\{[^}]*min-width:\s*44px\s*;[^}]*min-height:\s*44px\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.details-panel > header \.icon-button\s*\{[^}]*width:\s*44px\s*;[^}]*height:\s*44px\s*;/,
  );
});

test("the application owns its reset without Tailwind Preflight", () => {
  assert.doesNotMatch(css, /@import\s+["']tailwindcss["']/);
  assert.match(css, /\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*border-box\s*;/);
  assert.match(declarations("button"), /padding:\s*0\s*;/);
});

test("owner workspace selector stays bounded at 390x844 and 844x390", () => {
  const selector = declarations(".workspace-scope-selector");
  assert.match(selector, /min-width:\s*0\s*;/);
  assert.match(selector, /overflow:\s*hidden\s*;/);
  assert.match(declarations(".main-surface"), /min-width:\s*0\s*;/);
  assert.match(declarations(".main-surface"), /overflow:\s*hidden\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.workspace-scope-selector\s*\{[^}]*max-width:\s*min\(230px,\s*34vw\)\s*;[^}]*height:\s*40px\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.workspace-scope-selector\s*\{[^}]*max-width:\s*132px\s*;[^}]*flex-basis:\s*132px\s*;/,
  );
});

test("global search stays bounded, focus-safe, and overflow-free across phone orientations", () => {
  const dialog = declarations(".global-search-dialog");
  assert.match(dialog, /width:\s*min\(680px,\s*calc\(100vw\s*-\s*32px\)\)\s*;/);
  assert.match(dialog, /max-height:\s*min\(680px,\s*calc\(100dvh/);
  assert.match(declarations(".global-search-results"), /overflow-x:\s*hidden\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.global-search-backdrop\s*\{[^}]*safe-area-inset-top[^}]*safe-area-inset-right[^}]*safe-area-inset-bottom[^}]*safe-area-inset-left[^}]*\}/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.global-search-dialog\s*\{[^}]*width:\s*100%\s*;[^}]*max-height:\s*100%\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-height:\s*480px\)[\s\S]*?\.global-search-dialog\s*\{[^}]*max-height:\s*calc\(100dvh/,
  );
  assert.match(taskTracker, /globalSearchReturnFocus/);
  assert.match(taskTracker, /queryRef\.current === requestedQuery/);
  assert.match(taskTracker, /applyNavigation\(next, "push", false, result\.href\)/);
  assert.match(taskTracker, /setForcedTaskDetailId\(result\.id\)/);
  assert.doesNotMatch(taskTracker, /window\.location\.assign\(results\[highlighted\]\.href\)/);
  assert.match(taskTracker, /onOpen\(results\[highlighted\]\)/);
  assert.match(taskTracker, /handleLocalLink\(event, \(\) => onOpen\(item\)\)/);
  assert.match(taskTracker, /setContinuationError\(\{ query: requestedQuery, cursor: requestedCursor \}\)/);
  assert.doesNotMatch(taskTracker, /catch \{[\s\S]{0,120}setStatus\("error"\)/);
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

test("release header names truncate before displacing desktop or mobile actions", () => {
  const cluster = declarations(".title-cluster");
  assert.match(cluster, /flex:\s*1\s+1\s+auto\s*;/);
  assert.match(cluster, /overflow:\s*hidden\s*;/);
  assert.match(declarations(".title-actions"), /flex:\s*0\s+0\s+auto\s*;/);
  const title = declarations(".title-cluster h1");
  assert.match(title, /overflow:\s*hidden\s*;/);
  assert.match(title, /text-overflow:\s*ellipsis\s*;/);
  assert.match(title, /white-space:\s*nowrap\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.title-cluster h1\s*\{[^}]*max-width:\s*46vw\s*;/,
  );
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

test("board cards reuse the metadata corner for selection and keep the title full width", () => {
  assert.doesNotMatch(css, /\.task-card\.editable h3::before\s*\{/);
  const selectionSpace = declarations(".task-card.editable .card-meta::after");
  assert.match(selectionSpace, /flex:\s*0\s+0\s+28px\s*;/);
  assert.match(selectionSpace, /width:\s*28px\s*;/);
  const identifier = declarations(".card-identifier");
  assert.match(identifier, /flex:\s*0\s+0\s+auto\s*;/);
  assert.match(identifier, /white-space:\s*nowrap\s*;/);
  const checkbox = declarations(".task-card > .card-check");
  assert.match(checkbox, /bottom:\s*9px\s*;/);
  assert.doesNotMatch(checkbox, /top:/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.task-card\s*>\s*\.card-check\s*\{[^}]*right:\s*12px\s*;[^}]*bottom:\s*12px\s*;/,
  );
  assert.match(
    declarations(".task-card:focus-within .card-check span, .card-check:focus-visible span"),
    /opacity:\s*1\s*;/,
  );
});

test("list and board expose the same keyboard highlight and selection semantics", () => {
  assert.match(taskTracker, /data-task-keyboard-id=\{task\.id\}/);
  assert.match(taskTracker, /aria-pressed=\{selected\}/);
  assert.match(taskTracker, /aria-current=\{highlighted \? "true" : undefined\}/);
  assert.match(taskTracker, /onSelect\(event\.shiftKey\)/);
  assert.match(taskTracker, /dispatchTaskKeyboardIntegrationCommand/);
  assert.match(taskTracker, /if \(command === "global-search"\)[\s\S]*?if \(!claimed\) openGlobalSearch\(\)/);
  assert.match(taskTracker, /event\.target === event\.currentTarget && event\.key === "Enter"[\s\S]*?onOpen\(\)/);
  assert.doesNotMatch(taskTracker, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(taskTracker, /addEventListener\("keydown", handleKey\)/);
  assert.match(taskTracker, /previousFocus\?\.isConnected/);
  assert.match(taskTracker, /closest\("\[role='dialog'\]\[aria-modal='true'\]"\)/);
  assert.match(declarations(".task-card:hover, .task-card.highlighted"), /border-color:\s*var\(--border-strong\)\s*;/);
  assert.match(declarations(".task-row:focus-visible, .task-card:focus-visible"), /outline:\s*2px\s+solid/);
});

test("mobile drawer logic centralizes dismissal and restores focus", () => {
  assert.match(taskTracker, /function closeMobileSidebar\(/);
  assert.match(taskTracker, /mobileMenuRef\.current\?\.focus\(\)/);
  assert.match(taskTracker, /mobileSidebarCloseRef\.current\?\.focus\(\)/);
  assert.match(taskTracker, /aria-label="Close navigation"[\s\S]*?autoFocus/);
});

test("mobile task toolbar keeps a visible touch-sized layout switcher", () => {
  assert.match(declarations(".mobile-layout-switcher"), /display:\s*none\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.mobile-layout-switcher\s*\{[^}]*display:\s*flex\s*;/,
  );
  const buttons = declarations(".mobile-layout-switcher button");
  assert.match(buttons, /min-width:\s*40px\s*;/);
  assert.match(buttons, /height:\s*40px\s*;/);
});

test("mobile task rows use a two-line title and wrapping metadata without horizontal overflow", () => {
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.task-row\s*\{[^}]*grid-template-areas:\s*"check priority identity title"\s*"\. \. metadata metadata"\s*;[^}]*max-width:\s*100%\s*;[^}]*overflow:\s*hidden\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.task-title\s*\{[^}]*-webkit-line-clamp:\s*2\s*;[^}]*white-space:\s*normal\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.row-metadata\s*\{[^}]*display:\s*flex\s*;[^}]*flex-wrap:\s*wrap\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.task-list\s*\{[^}]*overflow-x:\s*hidden\s*;/,
  );
  assert.match(taskTracker, /aria-label=\{`Open contextual actions for \$\{task\.identifier\}`\}[\s\S]*?onContextActions\(rect\.right, rect\.bottom, event\.currentTarget\)/);
});

test("list status controls keep compact desktop placement and touch-safe mobile geometry", () => {
  const statusControl = declarations(".task-status-control");
  assert.match(statusControl, /width:\s*28px\s*;/);
  assert.match(statusControl, /height:\s*28px\s*;/);
  assert.match(statusControl, /overflow:\s*visible\s*;/);
  assert.match(declarations(".task-status-control select"), /position:\s*absolute\s*;/);
  assert.match(declarations(".task-status-control:focus-within"), /outline:/);
  assert.match(
    css,
    /\.task-row\.show-status\s*\{[^}]*grid-template-columns:\s*25px\s+22px\s+58px\s+28px\s+minmax\(180px,\s*1fr\)\s+auto\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.task-row\.show-status\s*\{[^}]*grid-template-columns:\s*25px\s+20px\s+52px\s+40px\s+minmax\(0,\s*1fr\)\s*;[^}]*grid-template-areas:\s*"check priority identity status title"\s*"\. \. metadata metadata metadata"\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.task-status-control\s*\{[^}]*width:\s*40px\s*;[^}]*height:\s*40px\s*;/,
  );
  assert.match(
    taskTracker,
    /onStatusChange=\{\(task, statusId\) => mutate\(`\/api\/tasks\/\$\{task\.id\}`,[\s\S]{0,180}version: taskMutationVersion\(task\), statusId/,
  );
});

test("Label controls remain searchable and stack without mobile overflow", () => {
  assert.match(
    taskTracker,
    /type="search" value=\{query\}[\s\S]{0,300}placeholder="Search labels…"/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.label-settings-create\s*\{[^}]*grid-template-columns:\s*34px\s+minmax\(0,\s*1fr\)\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.label-settings-create input\[name="description"\][^{]*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*;/,
  );
});

test("filter formula stays bounded on desktop and stacks into mobile touch rows", () => {
  assert.match(declarations(".filter-popover"), /max-height:/);
  assert.match(declarations(".filter-popover"), /overflow-y:\s*auto\s*;/);
  assert.match(declarations(".filter-chip-list"), /overflow-x:\s*auto\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.filter-builder\.compact \.filter-condition-row\s*\{[^}]*grid-template-columns:/,
  );
  assert.match(taskTracker, /encodeTemporaryViewQuery/);
  assert.match(taskTracker, /Load more/);
});

test("Hierarchy controls stack into touch-sized rows without mobile overflow", () => {
  assert.match(taskTracker, /aria-label="Task parent"/);
  assert.match(taskTracker, /aria-label="New subtask title"/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.hierarchy-controls > label, \.hierarchy-controls form\s*\{[^}]*grid-template-columns:\s*1fr\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.hierarchy-controls select, \.hierarchy-controls input, \.hierarchy-controls form \.button\s*\{[^}]*min-height:\s*44px\s*;/,
  );
});

test("pull-to-refresh indicator is mobile-only and respects reduced motion", () => {
  assert.match(declarations(".pull-refresh-indicator"), /display:\s*none\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.pull-refresh-indicator\s*\{[^}]*display:\s*flex\s*;/,
  );
  assert.match(declarations(".pull-refresh-spinner"), /border-radius:\s*50%\s*;/);
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation-duration:\s*\.01ms\s*!important/,
  );
});

test("workspace overview collapses to one column without horizontal overflow", () => {
  assert.match(declarations(".workspace-overview"), /overflow-y:\s*auto\s*;/);
  assert.match(declarations(".workspace-overview"), /overflow-x:\s*hidden\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.workspace-overview-grid\s*\{[^}]*grid-template-columns:\s*1fr\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.workspace-metrics\s*\{[^}]*grid-template-columns:\s*1fr\s*;/,
  );
});

test("Teams catalog and membership lifecycle stay focus-visible and phone-safe", () => {
  assert.match(declarations(".teams-surface, .team-detail-surface"), /overflow-x:\s*hidden\s*;/);
  assert.match(declarations(".team-card"), /min-width:\s*0\s*;/);
  assert.match(declarations(".team-member-row"), /grid-template-columns:\s*32px\s+minmax\(0,\s*1fr\)\s+auto\s+auto\s*;/);
  assert.match(taskTracker, /className="team-live-region" role="status" aria-live="polite"/);
  assert.match(taskTracker, /className="team-local-alert" role="alert"/);
  assert.match(taskTracker, /href=\{`\/teams\/\$\{encodeURIComponent\(team\.publicId\)\}`\}/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.team-member-row\s*\{[^}]*grid-template-columns:\s*44px\s+minmax\(0,\s*1fr\)\s+auto\s*;[^}]*overflow:\s*hidden\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.team-member-actions \.button\s*\{[^}]*min-height:\s*44px\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.team-dialog-form input,\s*\.team-dialog \.dialog-actions \.button\s*\{[^}]*min-height:\s*44px\s*;/,
  );
});

test("Codex setup hands mobile users to Desktop or CLI without horizontal overflow", () => {
  assert.match(declarations(".codex-setup-body"), /overflow-x:\s*hidden\s*;/);
  assert.match(declarations(".codex-mobile-handoff"), /display:\s*none\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.codex-mobile-handoff\s*\{[^}]*display:\s*grid\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.codex-copy-block button\s*\{[^}]*min-width:\s*44px\s*;[^}]*height:\s*44px\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.modal\.codex-setup-modal\s*\{[^}]*width:\s*100vw\s*;[^}]*max-width:\s*100vw\s*;[^}]*min-height:\s*100dvh\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.codex-copy-block > code, \.codex-copy-block pre code\s*\{[^}]*white-space:\s*pre-wrap\s*;[^}]*overflow-wrap:\s*anywhere\s*;/,
  );
  assert.match(taskTracker, /Installing from a phone\?/);
  assert.match(taskTracker, /These checks do not fix the platform install redirect bug/);
  assert.match(
    taskTracker,
    /function openCodexCliFallback\(\)[\s\S]{0,240}nextCodexSetupMode\(currentMode, \{ type: "open_cli_fallback" \}\)/,
  );
  assert.match(
    taskTracker,
    /className="button secondary codex-cli-fallback"[^>]*onClick=\{openCodexCliFallback\}/,
  );
});

test("task rows do not attach a hidden double-click action", () => {
  assert.doesNotMatch(taskTracker, /onDoubleClick=\{onPeek\}/);
});

test("task description reading mode grows fully and wraps long content", () => {
  const rule = declarations(".task-description-markdown");
  assert.match(rule, /overflow-wrap:\s*anywhere\s*;/);
  assert.doesNotMatch(rule, /max-height\s*:/);
  assert.doesNotMatch(rule, /overflow:\s*hidden\s*;/);
  assert.match(declarations(".task-description-markdown pre"), /overflow:\s*auto\s*;/);
  assert.match(declarations(".task-description-markdown ul"), /list-style:\s*disc\s*;/);
  assert.match(declarations(".task-description-markdown ol"), /list-style:\s*decimal\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.task-description-section > header \.button, \.task-description-editor \.button\s*\{[^}]*min-height:\s*44px\s*;/,
  );
});

test("task details title grows to wrapped content across mobile and desktop viewports", () => {
  assert.match(
    taskTracker,
    /<textarea[\s\S]*?className="details-title"[\s\S]*?rows=\{1\}/,
  );
  assert.match(taskTracker, /event\.key === "Escape"[\s\S]*?cancelTitleSave\.current = true/);
  assert.match(taskTracker, /onBlur=\{\(\) => \{[\s\S]*?if \(cancelTitleSave\.current\)/);

  const editableTitle = declarations(".details-title");
  assert.match(editableTitle, /min-width:\s*0\s*;/);
  assert.match(editableTitle, /max-width:\s*100%\s*;/);
  assert.match(editableTitle, /resize:\s*none\s*;/);
  assert.match(editableTitle, /overflow-wrap:\s*anywhere\s*;/);
  assert.match(editableTitle, /word-break:\s*break-word\s*;/);
  assert.doesNotMatch(editableTitle, /white-space:\s*nowrap\s*;/);
  assert.doesNotMatch(editableTitle, /text-overflow:\s*ellipsis\s*;/);
  assert.doesNotMatch(editableTitle, /line-clamp/);

  const readOnlyTitle = declarations(".read-only-title");
  assert.match(readOnlyTitle, /max-width:\s*100%\s*;/);
  assert.match(readOnlyTitle, /overflow-wrap:\s*anywhere\s*;/);
  assert.match(readOnlyTitle, /word-break:\s*break-word\s*;/);
  assert.doesNotMatch(readOnlyTitle, /white-space:\s*nowrap\s*;/);
  assert.doesNotMatch(readOnlyTitle, /line-clamp/);

  assert.match(
    taskTracker,
    /<aside className="details-panel">[\s\S]*?<\/header>[\s\S]*?<div className="details-body">[\s\S]*?<textarea[\s\S]*?className="details-title"/,
  );

  const panelMatch = css.match(/(?:^|\n)\.details-panel\s*\{([^}]+)\}/);
  assert.ok(panelMatch, "Missing standalone .details-panel rule");
  const panel = panelMatch[1];
  assert.match(panel, /width:\s*min\(680px,\s*calc\(100vw\s*-\s*48px\)\)\s*;/);
  assert.match(declarations(".details-body"), /overflow-x:\s*hidden\s*;/);
  assert.match(declarations(".details-body"), /overflow-y:\s*auto\s*;/);

  for (const width of [390, 844, 1280, 1440]) {
    if (width <= 640) {
      assert.match(
        css,
        /@media\s*\(max-width:\s*640px\)[\s\S]*?\.details-panel\s*\{[^}]*width:\s*100vw\s*;[^}]*max-width:\s*100vw\s*;[^}]*height:\s*100dvh\s*;/,
      );
    } else {
      assert.match(panel, /max-width:\s*100%\s*;/);
    }
  }
});

test("attachment UI has bounded cards, authenticated thumbnails, and mobile touch controls", () => {
  assert.match(taskAttachments, /\?variant=thumbnail&disposition=inline/);
  assert.match(taskAttachments, /thumbnailFailed \? original : thumbnail/);
  assert.match(taskAttachments, /if \(!thumbnailFailed\) setThumbnailFailed\(true\)/);
  assert.match(stagedFileUpload, /new XMLHttpRequest\(\)/);
  assert.match(stagedFileUpload, /X-File-Filename/);
  assert.match(stagedFileUpload, /Idempotency-Key/);
  assert.match(stagedFileUpload, /fileRef, idempotencyKey/);
  assert.match(taskAttachments, /startStagedTaskAttachmentUpload/);
  assert.match(taskAttachments, /role="dialog" aria-modal="true"/);
  assert.match(taskAttachments, /event\.key === "Escape"/);
  assert.match(declarations(".attachment-card"), /grid-template-columns:\s*42px\s+minmax\(0,\s*1fr\)\s+auto\s*;/);
  assert.match(declarations(".attachment-main b"), /text-overflow:\s*ellipsis\s*;/);
  assert.match(declarations(".attachment-preview-canvas"), /overflow:\s*auto\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.attachment-card \.icon-button\s*\{[^}]*width:\s*44px\s*;[^}]*height:\s*44px\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.modal\.composer-modal\s*\{[^}]*width:\s*100vw\s*;[^}]*min-height:\s*100dvh\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.composer-attachments > div:first-child \.button\s*\{[^}]*min-height:\s*44px\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-height:\s*520px\)[\s\S]*?\.modal\.composer-modal\s*\{[^}]*max-height:\s*100dvh\s*;[^}]*overflow-y:\s*auto\s*;/,
  );
});

test("Task composer stages safe refs before creation and preserves recoverable bind state", () => {
  assert.match(taskTracker, /startStoredFileUpload/);
  assert.match(taskTracker, /bindStoredFileToTask/);
  assert.match(taskTracker, /tm:task-composer-staged:/);
  assert.match(taskTracker, /Staged files are still available for retry or deletion until their TTL expires/);
  assert.match(taskTracker, /failed to bind/);
  assert.match(taskTracker, /deleteStoredFile/);
  assert.doesNotMatch(taskTracker, /localStorage\.setItem\([^\n]+file:/);
});

test("native description attachments use private refs, cursor upload, and responsive rendering", () => {
  assert.match(taskDescriptionEditor, /startTaskAttachmentUpload/);
  assert.match(taskDescriptionEditor, /event\.clipboardData\.files/);
  assert.match(taskDescriptionEditor, /event\.dataTransfer\.files/);
  assert.match(taskDescriptionEditor, /selectionStart/);
  assert.match(taskDescriptionEditor, /buildTaskImageToken/);
  assert.match(taskDescriptionEditor, /buildTaskFileLink/);
  assert.match(taskDescriptionEditor, /NativeImageWidthEditor/);
  assert.match(taskDescriptionEditor, /Insert file/);
  assert.doesNotMatch(taskDescriptionEditor, /https?:\/\//);
  assert.match(taskAttachments, /Used in description/);
  assert.match(taskAttachments, /Remove from description first/);
  assert.match(taskAttachments, /TaskDescriptionImage/);
  assert.match(taskAttachments, /TaskDescriptionFileLink/);
  assert.match(declarations(".task-description-image"), /width:\s*min\(100%,\s*620px\)\s*;/);
  assert.match(declarations(".task-description-image img"), /max-width:\s*100%\s*;/);
  assert.match(declarations('.task-description-image[data-presentation-width]:not([data-presentation-width="auto"]) img'), /width:\s*100%\s*;/);
  assert.match(declarations(".task-description-file-link"), /max-width:\s*100%\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.task-description-upload \.icon-button\s*\{[^}]*width:\s*44px\s*;[^}]*height:\s*44px\s*;/,
  );
});

test("description and comment authoring share accessible bounded image resize controls", () => {
  assert.match(commentAttachmentAuthoring, /NativeImageWidthEditor/);
  assert.match(nativeImageWidthEditor, /replaceSelectedTaskImageWidth/);
  assert.match(nativeImageWidthEditor, /resolveTaskImageSelection/);
  assert.match(nativeImageWidthEditor, /drag\.current\.selection/);
  assert.doesNotMatch(nativeImageWidthEditor, /occurrence/);
  assert.match(nativeImageWidthEditor, /role="slider"/);
  assert.match(nativeImageWidthEditor, /aria-valuemin=\{TASK_IMAGE_WIDTH_MIN\}/);
  assert.match(nativeImageWidthEditor, /onPointerMove=\{onPointerMove\}/);
  assert.match(nativeImageWidthEditor, /ArrowLeft/);
  assert.match(nativeImageWidthEditor, />Reset to Auto</);
  assert.match(nativeImageWidthEditor, /variant=thumbnail&disposition=inline/);
  assert.match(declarations(".native-image-width-preview"), /max-width:\s*100%\s*;/);
  assert.match(declarations(".native-image-resize-handle"), /touch-action:\s*none\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.native-image-resize-handle\s*\{[^}]*min-height:\s*44px\s*;/,
  );
});

test("comment attachments resolve mounted refs only and reuse the private renderer", () => {
  assert.match(taskTracker, /CommentAttachmentMetadataProvider/);
  assert.match(taskTracker, /useCommentAttachmentMetadata\(body\)/);
  assert.match(taskTracker, /<MarkdownBody body=\{body\} className="comment-body" taskId=\{taskId\} attachments=\{attachments\}/);
  assert.match(taskTracker, /commentBodyPreview\(comment\.body/);
  assert.match(commentAttachmentMetadata, /searchParams\.append\("refs", ref\)/);
  assert.match(commentAttachmentMetadata, /task\.attachmentInvalidationCursor/);
  assert.match(commentAttachmentMetadata, /task-manager:attachment-changed/);
  assert.match(commentAttachmentMetadata, /Some comment attachments could not be loaded/);
  assert.match(commentAttachmentMetadata, /Retry/);
  assert.match(commentAttachmentMetadata, /setRetryNonce/);
  assert.doesNotMatch(commentAttachmentMetadata, /localStorage|commentDraft|setDraft/);
  assert.doesNotMatch(commentAttachmentMetadata, /\/attachments[`"']\s*,/);
  assert.match(declarations(".comment-body .task-description-image"), /max-width:\s*100%\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.comment-body \.task-description-image > button\s*\{[^}]*min-height:\s*44px\s*;/,
  );
});

test("Project lifecycle surfaces remain bounded and touchable on mobile", () => {
  assert.match(declarations(".modal.project-dialog"), /max-height:\s*calc\(100dvh\s*-\s*40px\)/);
  assert.match(declarations(".modal-backdrop:has(.project-dialog)"), /padding-top:\s*20px/);
  assert.match(declarations(".project-overview-heading"), /grid-template-columns:\s*40px\s+minmax\(0,\s*1fr\)\s+auto/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.project-overview-heading\s*\{[^}]*grid-template-columns:\s*40px\s+minmax\(0,\s*1fr\)\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.project-dialog-footer \.button\s*\{[^}]*min-height:\s*44px\s*;/,
  );
  assert.match(taskTracker, /Locked after.*allocated Task number/);
  assert.match(taskTracker, /Confirm the terminal transition/);
  assert.match(declarations(".release-notes"), /border-top:\s*1px\s+solid\s+var\(--border\)/);
  assert.match(taskTracker, /This changes the Task composition of a released Release/);
  assert.match(taskTracker, /Leaving Released clears the server release timestamp/);
});

test("filter count badges have stable centered geometry for one or multiple digits", () => {
  const badge = declarations(".filter-count");
  assert.match(badge, /min-width:\s*16px\s*;/);
  assert.match(badge, /height:\s*16px\s*;/);
  assert.match(badge, /padding:\s*0\s+4px\s*;/);
  assert.match(badge, /line-height:\s*16px\s*;/);
  assert.match(badge, /place-items:\s*center\s*;/);
  assert.match(badge, /font-variant-numeric:\s*tabular-nums\s*;/);
  assert.doesNotMatch(badge, /transform|translate/);
});

test("filter property search owns one focus ring instead of inheriting a nested text field", () => {
  const search = declarations(".filter-property-search");
  assert.match(search, /min-height:\s*34px\s*;/);
  assert.match(search, /cursor:\s*text\s*;/);
  assert.match(
    css,
    /\.filter-property-search:focus-within\s*\{[^}]*border-color:[^}]*box-shadow:/,
  );
  const input = declarations(".filter-property-search input");
  assert.match(input, /height:\s*auto\s*;/);
  assert.match(input, /padding:\s*0\s*;/);
  assert.match(input, /border:\s*0\s*;/);
  assert.match(input, /box-shadow:\s*none\s*;/);
  assert.match(
    css,
    /\.form-stack \.filter-property-search input:focus\s*\{[^}]*border:\s*0\s*;[^}]*box-shadow:\s*none\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.filter-property-search\s*\{[^}]*min-height:\s*40px\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.filter-property-grid button\s*\{[^}]*min-height:\s*40px\s*;/,
  );
});

test("form stacks leave checkboxes to compact display-control geometry", () => {
  assert.match(
    css,
    /\.form-stack input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/,
  );
  assert.doesNotMatch(
    css,
    /\.form-stack input,\s*\.form-stack select,\s*\.form-stack textarea/,
  );
  const checkbox = declarations('.display-properties input[type="checkbox"], .display-checkbox input[type="checkbox"]');
  assert.match(checkbox, /width:\s*16px\s*;/);
  assert.match(checkbox, /height:\s*16px\s*;/);
  assert.match(checkbox, /padding:\s*0\s*;/);
  assert.match(checkbox, /box-shadow:\s*none\s*;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.display-properties label,\s*\.display-checkbox\s*\{[^}]*min-height:\s*44px\s*;/,
  );
});

test("Edit view keeps a fixed shell while only its body scrolls", () => {
  const dialog = declarations(".view-dialog");
  assert.match(dialog, /display:\s*grid\s*;/);
  assert.match(dialog, /grid-template-rows:\s*minmax\(0,\s*1fr\)\s*;/);
  assert.match(dialog, /overflow:\s*hidden\s*;/);
  const form = declarations(".view-dialog > form");
  assert.match(form, /grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto\s*;/);
  assert.match(form, /min-height:\s*0\s*;/);
  assert.match(form, /overflow:\s*hidden\s*;/);
  const body = declarations(".view-dialog-body, .view-dialog > form > .form-stack");
  assert.match(body, /min-height:\s*0\s*;/);
  assert.match(body, /overflow-y:\s*auto\s*;/);
  assert.match(body, /overscroll-behavior:\s*contain\s*;/);
  assert.doesNotMatch(
    css,
    /\.view-dialog \.project-dialog-footer\s*\{[^}]*position:\s*sticky/,
  );
});

test("Edit view uses a safe-area-aware fullscreen shell on phone and landscape", () => {
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.modal-backdrop:has\(\.view-dialog\)\s*\{[^}]*padding:\s*0\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.view-dialog\s*\{[^}]*width:\s*100vw\s*;[^}]*height:\s*100dvh\s*;[^}]*border-radius:\s*0\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.view-dialog-header[^}]*safe-area-inset-top/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.view-dialog-footer[^}]*safe-area-inset-bottom/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.view-dialog-footer \.button[^}]*min-height:\s*44px\s*;/,
  );
  assert.match(
    css,
    /@media\s*\(max-height:\s*480px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.view-dialog\s*\{[^}]*height:\s*100dvh\s*;/,
  );
});

test("Settings navigation and forms collapse without mobile horizontal overflow", () => {
  assert.match(css, /\.settings-surface\s*\{[^}]*grid-template-columns:\s*220px\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.settings-surface\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.settings-navigation\s*\{[^}]*overflow-x:\s*auto;/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.settings-form-row[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /@media\s*\(max-height:\s*480px\)\s*and\s*\(orientation:\s*landscape\)/);
});

test("Recently deleted stays action-visible and overflow-safe at 390x844 and 844x390", () => {
  assert.match(declarations(".recently-deleted-row"), /min-width:\s*0/);
  assert.match(declarations(".recently-deleted-row"), /grid-template-columns:\s*minmax\(180px,\s*1\.2fr\)/);
  assert.match(css, /\.recently-deleted-actions\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/);
  assert.doesNotMatch(css, /\.recently-deleted-actions[^}]*:hover/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.recently-deleted-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.recently-deleted-actions \.button\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.modal\.deletion-dialog\s*\{[^}]*width:\s*100%;[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.deletion-confirmation input\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%/);
  assert.match(taskTracker, /async function refreshAfterDeletionMutation\(\)[\s\S]*?setCatalogPages\(\{\}\)[\s\S]*?setCatalogEpoch[\s\S]*?setRecentlyDeletedEpoch[\s\S]*?await refreshTaskList\(\)/);
});
