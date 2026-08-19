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
  return {
    value: `${before}${insertion}${after}`,
    cursor: before.length + insertion.length,
    token,
  };
}

export function removeCommentAttachmentToken(value: string, token: string) {
  const index = value.indexOf(token);
  if (index < 0) return value;
  const before = value.slice(0, index).replace(/[ \t]+$/, "");
  const after = value.slice(index + token.length).replace(/^[ \t]+/, "");
  return `${before}${after}`.replace(/\n{3,}/g, "\n\n");
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
