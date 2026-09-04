"use client";

import {
useCommentAttachmentMetadata
} from "@/components/comment-attachment-metadata";
import {
TaskDescriptionFileLink,
TaskDescriptionImage,
type PublicAttachmentRecord
} from "@/components/task-attachments";
import {
isTaskMarkdownEscaped,
parseTaskAttachmentReferences,
parseTaskFileToken,
parseTaskImageLine,
parseTaskMarkdownInlineTokens,
parseTaskMarkdownLines,
} from "@/lib/task-description-format";
import type {
TaskRecord
} from "@/lib/types";
import {
useEffect,
useState
} from "react";



export function CommentMarkdown({ taskId, body }: { taskId: string; body: string }) {
  const attachments = useCommentAttachmentMetadata(body);
  return <MarkdownBody body={body} className="comment-body" taskId={taskId} attachments={attachments} />;
}

export function TaskDescriptionMarkdown({
  task,
  body,
  className,
}: {
  task: TaskRecord;
  body: string;
  className: string;
}) {
  const [attachmentState, setAttachmentState] = useState<{
    key: string;
    records: Map<string, PublicAttachmentRecord>;
  }>({ key: "", records: new Map() });
  const attachmentRefKey = [...new Set(
    parseTaskAttachmentReferences(body).map((reference) => reference.ref),
  )].sort().join(",");

  useEffect(() => {
    if (!attachmentRefKey) return;
    const controller = new AbortController();
    const requestedRefs = new Set(attachmentRefKey.split(","));
    void fetch(`/api/tasks/${encodeURIComponent(task.id)}/attachments`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await response.json() as
          | { attachments: PublicAttachmentRecord[] }
          | { error?: string };
        if (!response.ok || !("attachments" in value)) {
          throw new Error("Native attachments could not be loaded");
        }
        setAttachmentState({
          key: attachmentRefKey,
          records: new Map(value.attachments
            .filter((attachment) => requestedRefs.has(attachment.ref))
            .map((attachment) => [attachment.ref, attachment])),
        });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAttachmentState({ key: attachmentRefKey, records: new Map() });
      });
    return () => controller.abort();
  }, [attachmentRefKey, task.id, task.attachmentInvalidationCursor]);

  const attachments = attachmentState.key === attachmentRefKey
    ? attachmentState.records
    : null;
  return <MarkdownBody body={body} className={className} taskId={task.id} attachments={attachments} />;
}

export function MarkdownBody({
  body,
  className,
  taskId,
  attachments,
}: {
  body: string;
  className: string;
  taskId?: string;
  attachments?: Map<string, PublicAttachmentRecord> | null;
}) {
  const lines = parseTaskMarkdownLines(body);
  const blocks: React.ReactNode[] = [];
  let code: string[] | null = null;
  let list: { ordered: boolean; items: React.ReactNode[]; key: number } | null = null;

  function flushList() {
    if (!list) return;
    const current = list;
    blocks.push(current.ordered
      ? <ol key={`list-${current.key}`}>{current.items}</ol>
      : <ul key={`list-${current.key}`}>{current.items}</ul>);
    list = null;
  }

  function appendListItem(ordered: boolean, item: React.ReactNode, key: number) {
    if (!list || list.ordered !== ordered) {
      flushList();
      list = { ordered, items: [], key };
    }
    list.items.push(<li key={key}>{item}</li>);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const markdownLine = lines[index]!;
    const line = markdownLine.text;
    if (markdownLine.kind === "fence") {
      if (code) {
        blocks.push(<pre key={`code-${index}`}><code>{code.join("\n")}</code></pre>);
        code = null;
      } else {
        flushList();
        code = [];
      }
      continue;
    }
    if (markdownLine.kind === "code") {
      if (!code) code = [];
      code.push(line);
      continue;
    }
    const nativeImage = taskId ? parseTaskImageLine(line) : null;
    if (nativeImage) {
      flushList();
      blocks.push(
        <TaskDescriptionImage
          key={`image-${index}-${nativeImage.ref}`}
          taskId={taskId!}
          attachment={attachments === null || attachments === undefined
            ? undefined
            : attachments.get(nativeImage.ref) ?? null}
          alt={nativeImage.alt}
          caption={nativeImage.caption}
          width={nativeImage.width}
        />,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const checklist = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (checklist) {
      appendListItem(false, <label className="markdown-checklist-item"><input type="checkbox" checked={checklist[1].toLowerCase() === "x"} readOnly disabled /><span>{renderMarkdownInline(checklist[2], taskId, attachments)}</span></label>, index);
    } else if (bullet) {
      appendListItem(false, renderMarkdownInline(bullet[1], taskId, attachments), index);
    } else if (ordered) {
      appendListItem(true, renderMarkdownInline(ordered[1], taskId, attachments), index);
    } else {
      flushList();
      if (heading) {
        if (heading[1].length === 1) blocks.push(<h2 key={index}>{renderMarkdownInline(heading[2], taskId, attachments)}</h2>);
        else if (heading[1].length === 2) blocks.push(<h3 key={index}>{renderMarkdownInline(heading[2], taskId, attachments)}</h3>);
        else blocks.push(<h4 key={index}>{renderMarkdownInline(heading[2], taskId, attachments)}</h4>);
      } else if (line.startsWith("> ")) {
        blocks.push(<blockquote key={index}>{renderMarkdownInline(line.slice(2), taskId, attachments)}</blockquote>);
      } else if (line.trim()) {
        blocks.push(<p key={index}>{renderMarkdownInline(line, taskId, attachments)}</p>);
      }
    }
  }
  if (code) blocks.push(<pre key="code-final"><code>{code.join("\n")}</code></pre>);
  flushList();
  return <div className={className}>{blocks}</div>;
}

export function renderMarkdownInline(
  value: string,
  taskId?: string,
  attachments?: Map<string, PublicAttachmentRecord> | null,
) {
  const nodes: React.ReactNode[] = [];
  for (const token of parseTaskMarkdownInlineTokens(value)) {
    if (token.kind === "code") {
      nodes.push(<code key={token.start}>{token.text}</code>);
    } else {
      nodes.push(...renderMarkdownInlineText(
        token.text,
        token.start,
        taskId,
        attachments,
      ));
    }
  }
  return nodes;
}

export function renderMarkdownInlineText(
  value: string,
  keyOffset: number,
  taskId?: string,
  attachments?: Map<string, PublicAttachmentRecord> | null,
) {
  const pattern = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const nodes: React.ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > offset) nodes.push(value.slice(offset, match.index));
    const token = match[0];
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const escaped = isTaskMarkdownEscaped(value, match.index) ||
        (match.index > 0 && value[match.index - 1] === "!");
      const nativeFile = taskId && !escaped ? parseTaskFileToken(token) : null;
      if (nativeFile) {
        nodes.push(
          <TaskDescriptionFileLink
            key={keyOffset + match.index}
            taskId={taskId!}
            attachment={attachments === null || attachments === undefined
              ? undefined
              : attachments.get(nativeFile.ref) ?? null}
            label={nativeFile.label}
          />,
        );
      } else if (!escaped) {
        const href = safeMarkdownHref(link[2]);
        nodes.push(href ? <a key={keyOffset + match.index} href={href} target="_blank" rel="noreferrer">{link[1]}</a> : token);
      } else nodes.push(token);
    } else if (token.startsWith("**")) nodes.push(<strong key={keyOffset + match.index}>{token.slice(2, -2)}</strong>);
    else nodes.push(<em key={keyOffset + match.index}>{token.slice(1, -1)}</em>);
    offset = match.index + token.length;
  }
  if (offset < value.length) nodes.push(value.slice(offset));
  return nodes;
}

export function safeMarkdownHref(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

export function formatCommentSelection(textarea: HTMLTextAreaElement | null, setValue: (value: string) => void, before: string, after = before) {
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const next = `${textarea.value.slice(0, start)}${before}${textarea.value.slice(start, end)}${after}${textarea.value.slice(end)}`;
  setValue(next);
  window.setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(start + before.length, end + before.length);
  }, 0);
}

export function prefixCommentLines(textarea: HTMLTextAreaElement | null, setValue: (value: string) => void, prefix: string) {
  if (!textarea) return;
  const start = textarea.selectionStart;
  const lineStart = textarea.value.lastIndexOf("\n", start - 1) + 1;
  setValue(`${textarea.value.slice(0, lineStart)}${prefix}${textarea.value.slice(lineStart)}`);
  window.setTimeout(() => textarea.focus(), 0);
}

export async function fetchCommentJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = await response.json() as T | { error: string };
  if (!response.ok || (value && typeof value === "object" && "error" in value)) {
    throw new Error(value && typeof value === "object" && "error" in value ? value.error : "Comment request failed");
  }
  return value as T;
}

export function copyCommentPermalink(commentId: string) {
  const url = new URL(window.location.href);
  url.hash = `comment-${commentId}`;
  void navigator.clipboard.writeText(url.toString());
}

export function relativeTime(value: string) {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of ranges) if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  return formatter.format(seconds, "second");
}

export function avatarHue(value: string) {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}
