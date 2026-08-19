export const TASK_ATTACHMENT_REFERENCE_SCHEME = "attachment:v1:";
export const TASK_IMAGE_REFERENCE_SCHEME = TASK_ATTACHMENT_REFERENCE_SCHEME;
export const TASK_ATTACHMENT_LABEL_MAX_LENGTH = 256;

export type TaskImageReference = {
  ref: string;
  alt: string;
  caption: string | null;
  token: string;
  start: number;
  end: number;
};

export type TaskFileReference = {
  ref: string;
  label: string;
  token: string;
  start: number;
  end: number;
};

export type TaskAttachmentReference =
  | (TaskImageReference & { kind: "image" })
  | (TaskFileReference & { kind: "file" });

export type TaskMarkdownLine = {
  text: string;
  kind: "text" | "fence" | "code";
  start: number;
  end: number;
};

export type TaskMarkdownInlineToken = {
  text: string;
  kind: "text" | "code";
  start: number;
  end: number;
};

const attachmentRef = "([A-Za-z0-9_-]{8,128})";
const nativeImagePattern = new RegExp(
  `!\\[([^\\]\\n]{1,${TASK_ATTACHMENT_LABEL_MAX_LENGTH}})\\]\\(attachment:v1:${attachmentRef}(?:\\s+"([^"\\n]*)")?\\)`,
  "g",
);
const nativeFilePattern = new RegExp(
  `(?<!!)\\[([^\\]\\n]{1,${TASK_ATTACHMENT_LABEL_MAX_LENGTH}})\\]\\(attachment:v1:${attachmentRef}\\)`,
  "g",
);

export function parseTaskImageReferences(description: string) {
  const executable = executableMarkdown(description);
  const references: TaskImageReference[] = [];
  for (const match of executable.matchAll(nativeImagePattern)) {
    const alt = match[1]!.trim();
    if (!alt) continue;
    references.push({
      ref: match[2]!,
      alt,
      caption: match[3]?.trim() || null,
      token: description.slice(match.index, match.index + match[0].length),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return references;
}

export function parseTaskFileReferences(description: string) {
  const executable = executableMarkdown(description);
  const references: TaskFileReference[] = [];
  for (const match of executable.matchAll(nativeFilePattern)) {
    const label = match[1]!.trim();
    if (!label) continue;
    references.push({
      ref: match[2]!,
      label,
      token: description.slice(match.index, match.index + match[0].length),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return references;
}

export function parseTaskAttachmentReferences(
  description: string,
): TaskAttachmentReference[] {
  return [
    ...parseTaskImageReferences(description).map((reference) => ({
      ...reference,
      kind: "image" as const,
    })),
    ...parseTaskFileReferences(description).map((reference) => ({
      ...reference,
      kind: "file" as const,
    })),
  ].sort((left, right) => left.start - right.start);
}

export function parseTaskImageLine(line: string) {
  const trimmed = line.trim();
  const references = parseTaskImageReferences(trimmed);
  return references.length === 1 && references[0]!.token === trimmed
    ? references[0]!
    : null;
}

export function parseTaskFileToken(token: string) {
  const references = parseTaskFileReferences(token);
  return references.length === 1 && references[0]!.token === token
    ? references[0]!
    : null;
}

export function parseTaskMarkdownLines(description: string): TaskMarkdownLine[] {
  const lines = description.split("\n");
  const result: TaskMarkdownLine[] = [];
  let offset = 0;
  let fence: { marker: string; length: number } | null = null;
  for (const text of lines) {
    const start = offset;
    const end = start + text.length;
    const marker = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const closes = marker &&
        marker[1]![0] === fence.marker &&
        marker[1]!.length >= fence.length &&
        marker[2]!.trim() === "";
      result.push({ text, kind: closes ? "fence" : "code", start, end });
      if (closes) fence = null;
    } else if (marker) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      result.push({ text, kind: "fence", start, end });
    } else {
      result.push({ text, kind: "text", start, end });
    }
    offset = end + 1;
  }
  return result;
}

export function parseTaskMarkdownInlineTokens(value: string): TaskMarkdownInlineToken[] {
  const result: TaskMarkdownInlineToken[] = [];
  let textStart = 0;
  let cursor = 0;
  while (cursor < value.length) {
    if (value[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let openerEnd = cursor + 1;
    while (openerEnd < value.length && value[openerEnd] === "`") openerEnd += 1;
    const markerLength = openerEnd - cursor;
    const closer = findInlineCodeCloser(value, openerEnd, markerLength);
    if (!closer) {
      cursor = openerEnd;
      continue;
    }
    if (cursor > textStart) {
      result.push({
        text: value.slice(textStart, cursor),
        kind: "text",
        start: textStart,
        end: cursor,
      });
    }
    result.push({
      text: value.slice(openerEnd, closer.start),
      kind: "code",
      start: cursor,
      end: closer.end,
    });
    cursor = closer.end;
    textStart = cursor;
  }
  if (textStart < value.length) {
    result.push({
      text: value.slice(textStart),
      kind: "text",
      start: textStart,
      end: value.length,
    });
  }
  return result;
}

export function isTaskMarkdownEscaped(value: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

export function hasMalformedTaskAttachmentReference(description: string) {
  if (!description.includes(TASK_ATTACHMENT_REFERENCE_SCHEME)) return false;
  const executable = executableMarkdown(description);
  let remaining = "";
  let offset = 0;
  for (const reference of parseTaskAttachmentReferences(description)) {
    remaining += executable.slice(offset, reference.start);
    offset = reference.end;
  }
  remaining += executable.slice(offset);
  return remaining.includes(TASK_ATTACHMENT_REFERENCE_SCHEME);
}

export function hasMalformedTaskImageReference(description: string) {
  return hasMalformedTaskAttachmentReference(description);
}

export function taskDescriptionUsesAttachment(
  description: string | null | undefined,
  attachmentRef: string,
) {
  if (!description) return false;
  return parseTaskAttachmentReferences(description).some(
    (reference) => reference.ref === attachmentRef,
  );
}

export function buildTaskImageToken(
  attachmentRef: string,
  alt: string,
  caption?: string | null,
) {
  const safeRef = normalizeAttachmentRef(attachmentRef);
  const safeAlt = normalizeTokenText(alt).replaceAll("]", ")");
  if (!safeAlt) throw new Error("Image alt text is required");
  if (safeAlt.length > TASK_ATTACHMENT_LABEL_MAX_LENGTH) {
    throw new Error("Image alt text is too long");
  }
  const safeCaption = caption ? normalizeTokenText(caption).replaceAll('"', "'") : "";
  return `![${safeAlt}](${TASK_ATTACHMENT_REFERENCE_SCHEME}${safeRef}${safeCaption ? ` "${safeCaption}"` : ""})`;
}

export function buildTaskFileLink(attachmentRef: string, label: string) {
  const safeRef = normalizeAttachmentRef(attachmentRef);
  const safeLabel = normalizeTokenText(label).replaceAll("]", ")");
  if (!safeLabel) throw new Error("File link label is required");
  if (safeLabel.length > TASK_ATTACHMENT_LABEL_MAX_LENGTH) {
    throw new Error("File link label is too long");
  }
  return `[${safeLabel}](${TASK_ATTACHMENT_REFERENCE_SCHEME}${safeRef})`;
}

function normalizeAttachmentRef(value: string) {
  const safeRef = value.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(safeRef)) {
    throw new Error("Invalid attachment reference");
  }
  return safeRef;
}

function normalizeTokenText(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function executableMarkdown(description: string) {
  const characters = description.split("");
  for (const line of parseTaskMarkdownLines(description)) {
    if (line.kind !== "text") {
      mask(characters, line.start, line.end);
    } else {
      maskInlineCode(characters, description, line.start, line.end);
    }
  }
  maskEscapedAttachmentSyntax(characters);
  return characters.join("");
}

function maskEscapedAttachmentSyntax(characters: string[]) {
  const markdown = characters.join("");
  const candidate = /!?\[[^\]\n]*\]\([^\n)]*attachment:v1:[^\n)]*\)/g;
  for (const match of markdown.matchAll(candidate)) {
    if (isTaskMarkdownEscaped(markdown, match.index)) {
      mask(characters, match.index, match.index + match[0].length);
    }
  }
}

function maskInlineCode(
  characters: string[],
  description: string,
  start: number,
  end: number,
) {
  const line = description.slice(start, end);
  for (const token of parseTaskMarkdownInlineTokens(line)) {
    if (token.kind === "code") {
      mask(characters, start + token.start, start + token.end);
    }
  }
}

function findInlineCodeCloser(value: string, start: number, markerLength: number) {
  let cursor = start;
  while (cursor < value.length) {
    // Preserve the established Task Markdown contract: a preceding backslash
    // does not prevent a same-length backtick run from closing inline code.
    if (value[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let runEnd = cursor + 1;
    while (runEnd < value.length && value[runEnd] === "`") runEnd += 1;
    if (runEnd - cursor === markerLength) return { start: cursor, end: runEnd };
    cursor = runEnd;
  }
  return null;
}

function mask(characters: string[], start: number, end: number) {
  for (let index = start; index < end; index += 1) characters[index] = " ";
}
