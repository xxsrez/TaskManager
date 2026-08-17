export const TASK_IMAGE_REFERENCE_SCHEME = "attachment:v1:";

export type TaskImageReference = {
  ref: string;
  alt: string;
  caption: string | null;
  token: string;
  start: number;
  end: number;
};

const nativeImagePattern = /!\[([^\]\n]+)\]\(attachment:v1:([A-Za-z0-9_-]{8,128})(?:\s+"([^"\n]*)")?\)/g;

export function parseTaskImageReferences(description: string) {
  const references: TaskImageReference[] = [];
  for (const match of description.matchAll(nativeImagePattern)) {
    references.push({
      ref: match[2]!,
      alt: match[1]!.trim(),
      caption: match[3]?.trim() || null,
      token: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return references;
}

export function parseTaskImageLine(line: string) {
  const trimmed = line.trim();
  const references = parseTaskImageReferences(trimmed);
  return references.length === 1 && references[0]!.token === trimmed
    ? references[0]!
    : null;
}

export function hasMalformedTaskImageReference(description: string) {
  if (!description.includes(TASK_IMAGE_REFERENCE_SCHEME)) return false;
  let remaining = "";
  let offset = 0;
  for (const reference of parseTaskImageReferences(description)) {
    remaining += description.slice(offset, reference.start);
    offset = reference.end;
  }
  remaining += description.slice(offset);
  return remaining.includes(TASK_IMAGE_REFERENCE_SCHEME);
}

export function taskDescriptionUsesAttachment(
  description: string | null | undefined,
  attachmentRef: string,
) {
  if (!description) return false;
  return parseTaskImageReferences(description).some(
    (reference) => reference.ref === attachmentRef,
  );
}

export function buildTaskImageToken(
  attachmentRef: string,
  alt: string,
  caption?: string | null,
) {
  const safeRef = attachmentRef.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(safeRef)) {
    throw new Error("Invalid attachment reference");
  }
  const safeAlt = normalizeTokenText(alt).replaceAll("]", ")");
  if (!safeAlt) throw new Error("Image alt text is required");
  const safeCaption = caption ? normalizeTokenText(caption).replaceAll('"', "'") : "";
  return `![${safeAlt}](${TASK_IMAGE_REFERENCE_SCHEME}${safeRef}${safeCaption ? ` "${safeCaption}"` : ""})`;
}

function normalizeTokenText(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
