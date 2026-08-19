import {
  parseTaskAttachmentReferences,
  parseTaskMarkdownInlineTokens,
} from "./task-description-format";

export const COMMENT_PREVIEW_LENGTH = 1_200;

export function visibleCommentAttachmentRefs(body: string): string[] {
  return [...new Set(parseTaskAttachmentReferences(body).map((reference) => reference.ref))];
}

export function commentBodyPreview(
  body: string,
  maxLength = COMMENT_PREVIEW_LENGTH,
): { body: string; truncated: boolean } {
  if (body.length <= maxLength) return { body, truncated: false };
  const boundedLength = Math.max(1, Math.floor(maxLength));
  let boundary = boundedLength;
  const whitespace = Math.max(
    body.lastIndexOf("\n", boundary),
    body.lastIndexOf(" ", boundary),
    body.lastIndexOf("\t", boundary),
  );
  if (whitespace >= Math.floor(boundedLength * 0.7)) boundary = whitespace;

  for (const reference of parseTaskAttachmentReferences(body)) {
    if (reference.start < boundary && reference.end > boundary) {
      boundary = reference.start;
    }
  }
  for (const token of parseTaskMarkdownInlineTokens(body)) {
    if (token.kind === "code" && token.start < boundary && token.end > boundary) {
      boundary = token.start;
    }
  }
  for (const token of body.matchAll(/!?\[[^\]\n]+\]\([^\n)]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*/g)) {
    const start = token.index;
    const end = start + token[0].length;
    if (start < boundary && end > boundary) boundary = start;
  }

  const preview = body.slice(0, boundary).trimEnd();
  return { body: preview ? `${preview}…` : "…", truncated: true };
}
