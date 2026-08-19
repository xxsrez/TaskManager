"use client";
/* eslint-disable @next/next/no-img-element */

import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Image as ImageIcon,
  Paperclip,
  RotateCcw,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TaskRecord, UserRecord } from "@/lib/types";
import { taskDescriptionUsesAttachment } from "@/lib/task-description-format";

const taskAttachmentChangedEvent = "task-manager:attachment-changed";

export type PublicAttachmentRecord = {
  ref: string;
  taskId: string;
  uploaderUserId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string;
  kind: "file" | "image";
  state: "pending" | "uploading" | "ready" | "failed" | "deleted";
  imageWidth: number | null;
  imageHeight: number | null;
  variants: Record<string, unknown>;
  failureCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

type UploadProgress = (percent: number) => void;

export function startTaskAttachmentUpload(
  taskId: string,
  file: File,
  idempotencyKey: string,
  onProgress: UploadProgress = () => undefined,
) {
  const request = new XMLHttpRequest();
  const promise = new Promise<PublicAttachmentRecord>((resolve, reject) => {
    request.open("POST", attachmentCollectionPath(taskId));
    request.responseType = "json";
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.setRequestHeader("Idempotency-Key", idempotencyKey);
    request.setRequestHeader("X-Attachment-Filename", encodeURIComponent(file.name));
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    });
    request.addEventListener("load", () => {
      const value = request.response as
        | { attachment: PublicAttachmentRecord }
        | { error?: string }
        | null;
      if (request.status >= 200 && request.status < 300 && value && "attachment" in value) {
        onProgress(100);
        resolve(value.attachment);
      } else {
        const message = value && "error" in value ? value.error : undefined;
        reject(new Error(message || `Upload failed (${request.status})`));
      }
    });
    request.addEventListener("error", () => reject(new Error("Network connection lost during upload")));
    request.addEventListener("abort", () => reject(new DOMException("Upload canceled", "AbortError")));
    request.send(file);
  });
  return { promise, cancel: () => request.abort() };
}

export function notifyTaskAttachmentChanged(taskId: string) {
  window.dispatchEvent(new CustomEvent(taskAttachmentChangedEvent, {
    detail: { taskId },
  }));
}

type LocalUpload = {
  id: string;
  key: string;
  file: File;
  progress: number;
  status: "queued" | "uploading" | "failed" | "canceled";
  error: string | null;
};

export function TaskAttachments({
  task,
  currentUser,
  users,
  canWrite,
  description,
}: {
  task: TaskRecord;
  currentUser: UserRecord;
  users: UserRecord[];
  canWrite: boolean;
  description?: string | null;
}) {
  const [attachments, setAttachments] = useState<PublicAttachmentRecord[]>([]);
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [previewRef, setPreviewRef] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeUploads = useRef(new Map<string, () => void>());
  const taskIdRef = useRef(task.id);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const value = await fetchAttachmentJson<{
        attachments: PublicAttachmentRecord[];
        totalCount: number;
      }>(`${attachmentCollectionPath(task.id)}${canWrite ? "?includeDeleted=true" : ""}`, {
        cache: "no-store",
        signal,
      });
      if (taskIdRef.current === task.id) setAttachments(value.attachments);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      if (taskIdRef.current === task.id) {
        setError(requestError instanceof Error ? requestError.message : "Attachments could not be loaded");
      }
    } finally {
      if (taskIdRef.current === task.id) setLoading(false);
    }
  }, [canWrite, task.id]);

  useEffect(() => {
    const uploadsForTask = activeUploads.current;
    taskIdRef.current = task.id;
    setAttachments([]);
    setUploads([]);
    setPreviewRef(null);
    return () => {
      for (const cancel of uploadsForTask.values()) cancel();
      uploadsForTask.clear();
    };
  }, [task.id]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, task.attachmentInvalidationCursor]);

  useEffect(() => {
    function handleAttachmentChange(event: Event) {
      const changedTaskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (changedTaskId === task.id) void load();
    }
    window.addEventListener(taskAttachmentChangedEvent, handleAttachmentChange);
    return () => window.removeEventListener(taskAttachmentChangedEvent, handleAttachmentChange);
  }, [load, task.id]);

  const allUsers = useMemo(() => {
    const byId = new Map(users.map((user) => [user.id, user]));
    byId.set(currentUser.id, currentUser);
    return byId;
  }, [currentUser, users]);

  function queueFiles(files: FileList | File[]) {
    if (!canWrite) return;
    const additions = Array.from(files).map((file) => ({
      id: crypto.randomUUID(),
      key: `task-attachment:${crypto.randomUUID()}`,
      file,
      progress: 0,
      status: "queued" as const,
      error: null,
    }));
    if (!additions.length) return;
    setUploads((current) => [...current, ...additions]);
    for (const upload of additions) void runUpload(upload);
  }

  async function runUpload(upload: LocalUpload) {
    setUploads((current) => updateUpload(current, upload.id, {
      status: "uploading",
      error: null,
    }));
    const running = startTaskAttachmentUpload(
      task.id,
      upload.file,
      upload.key,
      (progress) => setUploads((current) => updateUpload(current, upload.id, { progress })),
    );
    activeUploads.current.set(upload.id, running.cancel);
    try {
      const attachment = await running.promise;
      if (taskIdRef.current !== task.id) return;
      setAttachments((current) => upsertAttachment(current, attachment));
      setUploads((current) => current.filter((item) => item.id !== upload.id));
    } catch (requestError) {
      if (taskIdRef.current !== task.id) return;
      const canceled = requestError instanceof DOMException && requestError.name === "AbortError";
      setUploads((current) => updateUpload(current, upload.id, {
        status: canceled ? "canceled" : "failed",
        error: canceled
          ? "Upload canceled"
          : requestError instanceof Error
            ? requestError.message
            : "Upload failed",
      }));
    } finally {
      activeUploads.current.delete(upload.id);
    }
  }

  async function mutateAttachment(
    attachment: PublicAttachmentRecord,
    action: "delete" | "restore",
  ) {
    setError("");
    try {
      const path = `${attachmentCollectionPath(task.id)}/${encodeURIComponent(attachment.ref)}`;
      const value = action === "delete"
        ? await fetchAttachmentJson<{ attachment: PublicAttachmentRecord }>(path, {
            method: "DELETE",
            headers: { "X-Attachment-Version": String(attachment.version) },
          })
        : await fetchAttachmentJson<{ attachment: PublicAttachmentRecord }>(path, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: attachment.version, deleted: false }),
          });
      setAttachments((current) => upsertAttachment(current, value.attachment));
      if (action === "delete" && previewRef === attachment.ref) setPreviewRef(null);
      notifyTaskAttachmentChanged(task.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Attachment action failed");
      await load();
    }
  }

  const readyImages = attachments.filter(
    (attachment) => attachment.kind === "image" && attachment.state === "ready",
  );
  const previewIndex = previewRef
    ? readyImages.findIndex((attachment) => attachment.ref === previewRef)
    : -1;

  return (
    <section
      className={`task-attachments details-section ${dragActive ? "drag-active" : ""}`}
      aria-labelledby={`attachments-${task.id}`}
      onDragEnter={(event) => {
        if (!canWrite) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!canWrite) return;
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragActive(false);
      }}
      onDrop={(event) => {
        if (!canWrite) return;
        event.preventDefault();
        setDragActive(false);
        queueFiles(event.dataTransfer.files);
      }}
      onPaste={(event) => {
        if (!canWrite || !event.clipboardData.files.length) return;
        event.preventDefault();
        queueFiles(event.clipboardData.files);
      }}
    >
      <header className="attachments-header">
        <h2 id={`attachments-${task.id}`}><Paperclip size={14} />Attachments</h2>
        <span>{attachments.filter((item) => item.state !== "deleted").length + uploads.length}</span>
        {canWrite && (
          <button className="button ghost attachment-add" type="button" onClick={() => inputRef.current?.click()}>
            <Upload size={14} />Add files
          </button>
        )}
      </header>
      {canWrite && (
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          multiple
          aria-label="Choose attachment files"
          onChange={(event) => {
            if (event.target.files) queueFiles(event.target.files);
            event.target.value = "";
          }}
        />
      )}
      {dragActive && <div className="attachment-drop-message" role="status">Drop files to attach</div>}
      {loading && attachments.length === 0 && <p className="inline-note" role="status">Loading attachments…</p>}
      {error && <div className="attachment-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>Retry</button></div>}
      {!loading && !error && attachments.length === 0 && uploads.length === 0 && (
        <p className="attachment-empty">No attachments yet.{canWrite ? " Drop, paste, or choose files." : ""}</p>
      )}
      <div className="attachment-list" aria-live="polite">
        {uploads.map((upload) => (
          <article className="attachment-card attachment-upload" key={upload.id}>
            <span className="attachment-kind"><FileText size={18} /></span>
            <div className="attachment-main">
              <b title={upload.file.name}>{upload.file.name}</b>
              <small>{formatBytes(upload.file.size)} · {upload.status === "uploading" ? `${upload.progress}% uploaded` : upload.status}</small>
              {(upload.status === "uploading" || upload.status === "queued") && (
                <progress value={upload.progress} max="100" aria-label={`Upload progress for ${upload.file.name}`} />
              )}
              {upload.error && <span className="attachment-inline-error">{upload.error}</span>}
            </div>
            <div className="attachment-actions">
              {(upload.status === "failed" || upload.status === "canceled") && (
                <button type="button" className="icon-button" title="Retry upload" aria-label={`Retry ${upload.file.name}`} onClick={() => void runUpload(upload)}><RotateCcw size={14} /></button>
              )}
              {upload.status === "uploading" && (
                <button type="button" className="icon-button" title="Cancel upload" aria-label={`Cancel ${upload.file.name}`} onClick={() => activeUploads.current.get(upload.id)?.()}><X size={14} /></button>
              )}
              {upload.status !== "uploading" && (
                <button type="button" className="icon-button" title="Remove from queue" aria-label={`Remove ${upload.file.name}`} onClick={() => setUploads((current) => current.filter((item) => item.id !== upload.id))}><Trash2 size={14} /></button>
              )}
            </div>
          </article>
        ))}
        {attachments.map((attachment) => {
          const usedInDescription = taskDescriptionUsesAttachment(
            description,
            attachment.ref,
          );
          return (
            <AttachmentCard
              key={attachment.ref}
              taskId={task.id}
              attachment={attachment}
              uploader={allUsers.get(attachment.uploaderUserId)}
              canWrite={canWrite}
              usedInDescription={usedInDescription}
              onPreview={() => setPreviewRef(attachment.ref)}
              onDelete={() => {
                if (usedInDescription) {
                  setError("Remove this attachment from the description before removing it.");
                } else {
                  void mutateAttachment(attachment, "delete");
                }
              }}
              onRestore={() => void mutateAttachment(attachment, "restore")}
            />
          );
        })}
      </div>
      {previewIndex >= 0 && (
        <AttachmentPreview
          key={previewRef}
          taskId={task.id}
          images={readyImages}
          index={previewIndex}
          onIndex={(index) => setPreviewRef(readyImages[index]?.ref ?? null)}
          onClose={() => setPreviewRef(null)}
        />
      )}
    </section>
  );
}

export function TaskDescriptionImage({
  taskId,
  attachment,
  alt,
  caption,
  width,
}: {
  taskId: string;
  attachment: PublicAttachmentRecord | null | undefined;
  alt: string;
  caption: string | null;
  width: number | null;
}) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  if (attachment === undefined) {
    return <figure className="task-description-image" style={{ width: width == null ? undefined : `min(100%, ${width}px)` }} data-presentation-width={width ?? "auto"}><span className="task-description-image-placeholder" role="status">Loading image…</span></figure>;
  }
  if (!attachment || attachment.kind !== "image" || attachment.state !== "ready") {
    return <figure className="task-description-image" style={{ width: width == null ? undefined : `min(100%, ${width}px)` }} data-presentation-width={width ?? "auto"}><span className="task-description-image-placeholder" role="img" aria-label={alt}>Image unavailable</span></figure>;
  }
  const content = attachmentContentPath(taskId, attachment.ref);
  const source = thumbnailFailed
    ? `${content}?disposition=inline`
    : `${content}?variant=thumbnail&disposition=inline`;
  return (
    <figure className="task-description-image" style={{ width: width == null ? undefined : `min(100%, ${width}px)` }} data-presentation-width={width ?? "auto"}>
      {unavailable ? (
        <span className="task-description-image-placeholder" role="img" aria-label={alt}>Image unavailable</span>
      ) : (
        <button type="button" onClick={() => setPreviewOpen(true)} aria-label={`Preview ${alt}`}>
          <img
            src={source}
            alt={alt}
            width={attachment.imageWidth ?? undefined}
            height={attachment.imageHeight ?? undefined}
            onError={() => {
              if (!thumbnailFailed) setThumbnailFailed(true);
              else setUnavailable(true);
            }}
          />
        </button>
      )}
      {caption && <figcaption>{caption}</figcaption>}
      {previewOpen && (
        <AttachmentPreview
          taskId={taskId}
          images={[attachment]}
          index={0}
          onIndex={() => undefined}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </figure>
  );
}

export function TaskDescriptionFileLink({
  taskId,
  attachment,
  label,
}: {
  taskId: string;
  attachment: PublicAttachmentRecord | null | undefined;
  label: string;
}) {
  if (attachment === undefined) {
    return (
      <span className="task-description-file-link unavailable" role="status">
        <FileText size={13} aria-hidden="true" />Loading {label}…
      </span>
    );
  }
  if (!attachment || attachment.state !== "ready") {
    return (
      <span
        className="task-description-file-link unavailable"
        role="link"
        aria-disabled="true"
        aria-label={`${label} unavailable`}
      >
        <FileText size={13} aria-hidden="true" />{label}
      </span>
    );
  }
  return (
    <a
      className="task-description-file-link"
      href={attachmentContentPath(taskId, attachment.ref)}
      download={attachment.filename}
      aria-label={`Download ${label}`}
      title={`${attachment.filename} · ${formatBytes(attachment.byteSize)}`}
    >
      <FileText size={13} aria-hidden="true" />
      <span>{label}</span>
    </a>
  );
}

function AttachmentCard({
  taskId,
  attachment,
  uploader,
  canWrite,
  usedInDescription,
  onPreview,
  onDelete,
  onRestore,
}: {
  taskId: string;
  attachment: PublicAttachmentRecord;
  uploader?: UserRecord;
  canWrite: boolean;
  usedInDescription: boolean;
  onPreview: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [thumbnailReady, setThumbnailReady] = useState(false);
  const content = attachmentContentPath(taskId, attachment.ref);
  const thumbnail = `${content}?variant=thumbnail&disposition=inline`;
  const original = `${content}?disposition=inline`;
  const deleted = attachment.state === "deleted";
  return (
    <article className={`attachment-card ${deleted ? "deleted" : ""}`}>
      {attachment.kind === "image" && !deleted ? (
        <button className="attachment-thumbnail" type="button" onClick={onPreview} aria-label={`Preview ${attachment.filename}`}>
          {!thumbnailReady && <span className="attachment-thumbnail-state" role="status">Preparing preview…</span>}
          <img
            src={thumbnailFailed ? original : thumbnail}
            alt={attachment.filename}
            onLoad={() => setThumbnailReady(true)}
            onError={() => {
              if (!thumbnailFailed) setThumbnailFailed(true);
              else setThumbnailReady(true);
            }}
          />
        </button>
      ) : (
        <span className="attachment-kind">{attachment.kind === "image" ? <ImageIcon size={18} /> : <FileText size={18} />}</span>
      )}
      <div className="attachment-main">
        <b title={attachment.filename}>{attachment.filename}</b>
        <small>
          {deleted ? "Removed · recovery available" : `${formatBytes(attachment.byteSize)} · ${uploader?.displayName ?? "Unknown uploader"} · ${relativeAttachmentTime(attachment.createdAt)}`}
        </small>
        {usedInDescription && !deleted && <span className="attachment-usage">Used in description</span>}
        {thumbnailFailed && attachment.kind === "image" && !deleted && <span className="attachment-fallback">Preview fallback uses the original image</span>}
      </div>
      <div className="attachment-actions">
        {!deleted && (
          <a className="icon-button" href={content} title="Download original" aria-label={`Download ${attachment.filename}`}><Download size={14} /></a>
        )}
        {canWrite && !deleted && <button type="button" className="icon-button" title={usedInDescription ? "Remove from description first" : "Remove attachment"} aria-label={`Remove ${attachment.filename}`} onClick={onDelete}><Trash2 size={14} /></button>}
        {canWrite && deleted && <button type="button" className="button ghost attachment-restore" onClick={onRestore}><RotateCcw size={13} />Restore</button>}
      </div>
    </article>
  );
}

function AttachmentPreview({
  taskId,
  images,
  index,
  onIndex,
  onClose,
}: {
  taskId: string;
  images: PublicAttachmentRecord[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const [fit, setFit] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const image = images[index]!;
  const path = `${attachmentContentPath(taskId, image.ref)}?disposition=inline`;
  const previous = () => onIndex((index - 1 + images.length) % images.length);
  const next = () => onIndex((index + 1) % images.length);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog?.querySelector<HTMLElement>("button")?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && images.length > 1) {
        onIndex((index - 1 + images.length) % images.length);
      }
      if (event.key === "ArrowRight" && images.length > 1) {
        onIndex((index + 1) % images.length);
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button, a[href]")]
        .filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, [image.ref, images.length, index, onClose, onIndex]);

  return (
    <div className="attachment-lightbox" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="attachment-lightbox-dialog" role="dialog" aria-modal="true" aria-label={`Preview ${image.filename}`}>
        <header>
          <div><b title={image.filename}>{image.filename}</b><small>{index + 1} of {images.length}</small></div>
          <div>
            <button type="button" className="icon-button" onClick={() => setFit((value) => !value)} title={fit ? "Show actual size" : "Zoom to fit"} aria-label={fit ? "Show actual size" : "Zoom to fit"}>{fit ? <ZoomIn size={16} /> : <ZoomOut size={16} />}</button>
            <a className="icon-button" href={attachmentContentPath(taskId, image.ref)} title="Download original" aria-label={`Download ${image.filename}`}><Download size={16} /></a>
            <button type="button" className="icon-button" onClick={onClose} title="Close preview" aria-label="Close preview"><X size={17} /></button>
          </div>
        </header>
        <div className={`attachment-preview-canvas ${fit ? "fit" : "actual"}`}>
          {images.length > 1 && <button className="attachment-preview-nav previous" type="button" onClick={previous} aria-label="Previous image"><ChevronLeft size={22} /></button>}
          <img src={path} alt={image.filename} />
          {images.length > 1 && <button className="attachment-preview-nav next" type="button" onClick={next} aria-label="Next image"><ChevronRight size={22} /></button>}
        </div>
      </div>
    </div>
  );
}

function updateUpload(
  uploads: LocalUpload[],
  id: string,
  patch: Partial<LocalUpload>,
) {
  return uploads.map((upload) => upload.id === id ? { ...upload, ...patch } : upload);
}

function upsertAttachment(
  attachments: PublicAttachmentRecord[],
  incoming: PublicAttachmentRecord,
) {
  const found = attachments.some((attachment) => attachment.ref === incoming.ref);
  return found
    ? attachments.map((attachment) => attachment.ref === incoming.ref ? incoming : attachment)
    : [...attachments, incoming];
}

function attachmentCollectionPath(taskId: string) {
  return `/api/tasks/${encodeURIComponent(taskId)}/attachments`;
}

function attachmentContentPath(taskId: string, attachmentRef: string) {
  return `${attachmentCollectionPath(taskId)}/${encodeURIComponent(attachmentRef)}/content`;
}

async function fetchAttachmentJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = await response.json() as T | { error?: string };
  if (!response.ok) {
    throw new Error(value && typeof value === "object" && "error" in value && value.error
      ? value.error
      : `Attachment request failed (${response.status})`);
  }
  return value as T;
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

function relativeAttachmentTime(value: string) {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1_000);
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of ranges) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, "second");
}
