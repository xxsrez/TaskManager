import assert from "node:assert/strict";
import test from "node:test";
import {
  insertFileLink,
  insertImageToken,
} from "../components/task-description-editor";
import {
  buildTaskFileLink,
  buildTaskImageToken,
  hasMalformedTaskAttachmentReference,
  hasMalformedTaskImageReference,
  parseTaskAttachmentReferences,
  parseTaskFileReferences,
  parseTaskImageLine,
  parseTaskImageReferences,
  parseTaskMarkdownLines,
  taskDescriptionUsesAttachment,
} from "../lib/task-description-format";

test("native Task image tokens round-trip opaque refs and accessible metadata", () => {
  const ref = "88ff4153-cb23-4043-aab8-6fbc97800762";
  const token = buildTaskImageToken(ref, " Diagram ] one ", 'Caption "quoted"');
  assert.equal(
    token,
    `![Diagram ) one](attachment:v1:${ref} "Caption 'quoted'")`,
  );
  assert.deepEqual(parseTaskImageLine(token), {
    ref,
    alt: "Diagram ) one",
    caption: "Caption 'quoted'",
    token,
    start: 0,
    end: token.length,
  });
  assert.equal(taskDescriptionUsesAttachment(`Before\n${token}\nAfter`, ref), true);
  assert.equal(parseTaskImageReferences(`${token}\n${token}`).length, 2);
});

test("native Task file links round-trip opaque refs and ignore literal code examples", () => {
  const ref = "4d9701e5-fdb5-41f2-9538-fc5e43256ec9";
  const token = buildTaskFileLink(ref, " Design notes ] final.pdf ");
  assert.equal(token, `[Design notes ) final.pdf](attachment:v1:${ref})`);
  assert.deepEqual(parseTaskFileReferences(`Read ${token} now.`), [{
    ref,
    label: "Design notes ) final.pdf",
    token,
    start: 5,
    end: 5 + token.length,
  }]);
  assert.deepEqual(
    parseTaskAttachmentReferences(`![Image](attachment:v1:${ref})\n${token}`)
      .map((reference) => reference.kind),
    ["image", "file"],
  );
  assert.equal(taskDescriptionUsesAttachment(token, ref), true);

  const literals = [
    `\`${token}\``,
    ["```md", token, "```"].join("\n"),
  ].join("\n");
  assert.deepEqual(parseTaskAttachmentReferences(literals), []);
  assert.equal(hasMalformedTaskAttachmentReference(literals), false);
  assert.equal(taskDescriptionUsesAttachment(literals, ref), false);
});

test("Task Markdown fences and escapes have one executable-reference contract", () => {
  const ref = "4d9701e5-fdb5-41f2-9538-fc5e43256ec9";
  const token = buildTaskFileLink(ref, "fenced.pdf");
  const literals = [
    "~~~md",
    token,
    "~~~~",
    "   ```md",
    token,
    "   ```",
    `\\${token}`,
    `\\![diagram](attachment:v1:${ref})`,
  ].join("\n");

  assert.deepEqual(parseTaskAttachmentReferences(literals), []);
  assert.equal(hasMalformedTaskAttachmentReference(literals), false);
  assert.equal(taskDescriptionUsesAttachment(literals, ref), false);
  assert.deepEqual(
    parseTaskMarkdownLines(literals).map((line) => line.kind),
    ["fence", "code", "fence", "fence", "code", "fence", "text", "text"],
  );

  const evenEscape = `\\\\${token}`;
  assert.equal(parseTaskFileReferences(evenEscape).length, 1);
  assert.equal(taskDescriptionUsesAttachment(evenEscape, ref), true);
  assert.equal(
    hasMalformedTaskAttachmentReference("\\[literal](attachment:v1:short)"),
    false,
  );
  assert.equal(
    hasMalformedTaskAttachmentReference("\\\\[active](attachment:v1:short)"),
    true,
  );
});

test("Task Markdown keeps complex inline code literal while validating adjacent executable refs", () => {
  const literalRef = "literal-reference-123";
  const activeRef = "active-reference-456";
  const literal = `[literal.pdf](attachment:v1:${literalRef})`;
  const active = `[active.pdf](attachment:v1:${activeRef})`;
  const description = `\`\`Example with one \` inside: ${literal}\`\` then ${active}`;

  assert.deepEqual(
    parseTaskAttachmentReferences(description).map((reference) => reference.ref),
    [activeRef],
  );
  assert.equal(taskDescriptionUsesAttachment(description, literalRef), false);
  assert.equal(taskDescriptionUsesAttachment(description, activeRef), true);
  assert.equal(hasMalformedTaskAttachmentReference(description), false);
});

test("Task Markdown handles unclosed code delimiters deterministically and fail-safe", () => {
  const token = "[literal.pdf](attachment:v1:literal-reference-123)";
  const unclosedFence = [
    "```markdown",
    token,
    "~~~",
    token,
  ].join("\n");

  assert.deepEqual(parseTaskAttachmentReferences(unclosedFence), []);
  assert.equal(hasMalformedTaskAttachmentReference(unclosedFence), false);
  assert.deepEqual(
    parseTaskMarkdownLines(unclosedFence).map((line) => line.kind),
    ["fence", "code", "code", "code"],
  );

  const unclosedInline = `Unclosed \`${token}`;
  assert.deepEqual(
    parseTaskAttachmentReferences(unclosedInline).map((reference) => reference.ref),
    ["literal-reference-123"],
  );
  assert.equal(taskDescriptionUsesAttachment(unclosedInline, "literal-reference-123"), true);
});

test("native Task file links require a bounded label and exact versioned syntax", () => {
  const ref = "4d9701e5-fdb5-41f2-9538-fc5e43256ec9";
  assert.equal(hasMalformedTaskAttachmentReference(`[PDF](attachment:v1:${ref})`), false);
  assert.equal(hasMalformedTaskAttachmentReference(`[](attachment:v1:${ref})`), true);
  assert.equal(hasMalformedTaskAttachmentReference(`[   ](attachment:v1:${ref})`), true);
  assert.equal(hasMalformedTaskAttachmentReference(`[PDF](attachment:v1:short)`), true);
  assert.equal(hasMalformedTaskAttachmentReference(`[PDF](attachment:v1:${ref} "title")`), true);
  assert.throws(() => buildTaskFileLink("../object-key", "unsafe"));
  assert.throws(() => buildTaskFileLink(ref, ""));
  assert.throws(() => buildTaskFileLink(ref, "x".repeat(257)));
});

test("native Task image syntax rejects malformed markers without enabling external images", () => {
  assert.equal(hasMalformedTaskImageReference("![x](attachment:v1:short)"), true);
  assert.equal(hasMalformedTaskImageReference("![x](https://example.test/x.png)"), false);
  assert.equal(parseTaskImageLine("![x](https://example.test/x.png)"), null);
  assert.throws(() => buildTaskImageToken("../object-key", "unsafe"));
  assert.throws(() => buildTaskImageToken("valid_reference", ""));
});

test("description image upload inserts a block token at the current cursor", () => {
  const inserted = insertImageToken("BeforeAfter", 6, "![Image](attachment:v1:reference-123)");
  assert.equal(
    inserted.value,
    "Before\n![Image](attachment:v1:reference-123)\nAfter",
  );
  assert.equal(inserted.cursor, "Before\n![Image](attachment:v1:reference-123)\n".length);
});

test("description file upload inserts an inline link at the current cursor", () => {
  const token = "[notes.pdf](attachment:v1:reference-123)";
  const inserted = insertFileLink("Readnow.", 4, token);
  assert.equal(inserted.value, `Read ${token} now.`);
  assert.equal(inserted.cursor, `Read ${token} `.length);
});
