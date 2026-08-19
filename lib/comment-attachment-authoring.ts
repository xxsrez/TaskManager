import {
  buildTaskFileLink,
  buildTaskImageToken,
} from "@/lib/task-description-format";

export type CommentAttachmentChoice = {
  ref: string;
  filename: string;
  kind: "file" | "image";
};

export type CommentUploadStatus =
  | "queued"
  | "uploading"
  | "processing"
  | "ready"
  | "failed"
  | "canceled";

export type CommentUploadCandidate = {
  id: string;
  idempotencyKey: string;
  file: File;
  insertionPoint: number;
  progress: number;
  status: CommentUploadStatus;
  error: string | null;
  token: string | null;
};

export type CommentAttachmentInsertion = {
  token: string;
  start: number;
  end: number;
  tokenStart: number;
  tokenEnd: number;
};

export function buildCommentAttachmentToken(attachment: CommentAttachmentChoice) {
  if (attachment.kind === "image") {
    const alt = attachment.filename.replace(/\.[^.]+$/, "").trim() || "Attached image";
    return buildTaskImageToken(attachment.ref, alt);
  }
  return buildTaskFileLink(
    attachment.ref,
    attachment.filename.trim() || "Attached file",
  );
}

export function insertCommentAttachmentToken(
  value: string,
  point: number,
  attachment: CommentAttachmentChoice,
) {
  const token = buildCommentAttachmentToken(attachment);
  const cursor = Math.max(0, Math.min(value.length, point));
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const block = attachment.kind === "image";
  const prefix = block
    ? before && !before.endsWith("\n") ? "\n" : ""
    : before && !/[\s(]$/.test(before) ? " " : "";
  const suffix = block
    ? after && !after.startsWith("\n") ? "\n" : ""
    : after && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  const insertion = `${prefix}${token}${suffix}`;
  const start = before.length;
  const tokenStart = start + prefix.length;
  return {
    value: `${before}${insertion}${after}`,
    cursor: before.length + insertion.length,
    token,
    insertion: {
      token,
      start,
      end: start + insertion.length,
      tokenStart,
      tokenEnd: tokenStart + token.length,
    } satisfies CommentAttachmentInsertion,
  };
}

export function rebaseCommentAttachmentInsertion(
  previousValue: string,
  nextValue: string,
  insertion: CommentAttachmentInsertion,
): CommentAttachmentInsertion | null {
  if (previousValue.slice(insertion.tokenStart, insertion.tokenEnd) !== insertion.token) {
    return null;
  }
  if (previousValue === nextValue) return insertion;

  let prefix = 0;
  const sharedLength = Math.min(previousValue.length, nextValue.length);
  while (prefix < sharedLength && previousValue[prefix] === nextValue[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < sharedLength - prefix &&
    previousValue[previousValue.length - 1 - suffix] === nextValue[nextValue.length - 1 - suffix]
  ) suffix += 1;

  const previousEditEnd = previousValue.length - suffix;
  const nextEditEnd = nextValue.length - suffix;
  if (previousEditEnd <= insertion.start) {
    const delta = nextEditEnd - previousEditEnd;
    return shiftInsertion(insertion, delta);
  }
  if (prefix >= insertion.end) return insertion;
  return null;
}

export function removeCommentAttachmentInsertion(
  value: string,
  insertion: CommentAttachmentInsertion,
) {
  const exact = insertion.start >= 0 &&
    insertion.end <= value.length &&
    value.slice(insertion.tokenStart, insertion.tokenEnd) === insertion.token;
  if (!exact) return { value, removed: false };
  return {
    value: `${value.slice(0, insertion.start)}${value.slice(insertion.end)}`,
    removed: true,
  };
}

export function commentUploadBlocksSubmit(status: CommentUploadStatus) {
  return status !== "ready";
}

export function createCommentUploadCandidate(
  file: File,
  insertionPoint: number,
  randomId: () => string = () => crypto.randomUUID(),
): CommentUploadCandidate {
  const id = randomId();
  return {
    id,
    idempotencyKey: `comment-attachment:${id}`,
    file,
    insertionPoint,
    progress: 0,
    status: "queued",
    error: null,
    token: null,
  };
}

function shiftInsertion(
  insertion: CommentAttachmentInsertion,
  delta: number,
): CommentAttachmentInsertion {
  return {
    ...insertion,
    start: insertion.start + delta,
    end: insertion.end + delta,
    tokenStart: insertion.tokenStart + delta,
    tokenEnd: insertion.tokenEnd + delta,
  };
}
