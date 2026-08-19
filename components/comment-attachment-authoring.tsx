"use client";

import {
  FileText,
  Paperclip,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  notifyTaskAttachmentChanged,
  startTaskAttachmentUpload,
  type PublicAttachmentRecord,
} from "@/components/task-attachments";
import {
  commentUploadBlocksSubmit,
  createCommentUploadCandidate,
  insertCommentAttachmentToken,
  removeCommentAttachmentToken,
  type CommentUploadCandidate,
} from "@/lib/comment-attachment-authoring";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ClipboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

export function CommentAttachmentAuthoring({
  taskId,
  value,
  onChange,
  textareaRef,
  disabled,
  onBlockingChange,
  children,
}: {
  taskId: string;
  value: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  onBlockingChange?: (blocked: boolean) => void;
  children?: ReactNode;
}) {
  const [uploads, setUploads] = useState<CommentUploadCandidate[]>([]);
  const [attachments, setAttachments] = useState<PublicAttachmentRecord[]>([]);
  const [selectedAttachmentRef, setSelectedAttachmentRef] = useState("");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [galleryError, setGalleryError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const taskIdRef = useRef(taskId);
  const activeUploads = useRef(new Map<string, () => void>());
  const canceledUploads = useRef(new Set<string>());

  const readyAttachments = attachments.filter(
    (attachment) => attachment.state === "ready",
  );
  const blocked = uploads.some((upload) => commentUploadBlocksSubmit(upload.status));

  const loadAttachments = useCallback(async (signal?: AbortSignal) => {
    setGalleryLoading(true);
    setGalleryError("");
    try {
      const response = await fetch(
        `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
        { cache: "no-store", signal },
      );
      const payload = await response.json() as
        | { attachments: PublicAttachmentRecord[] }
        | { error?: string };
      if (!response.ok || !("attachments" in payload)) {
        throw new Error("Task files could not be loaded");
      }
      if (taskIdRef.current !== taskId) return;
      const ready = payload.attachments.filter((attachment) => attachment.state === "ready");
      setAttachments(ready);
      setSelectedAttachmentRef((current) =>
        ready.some((attachment) => attachment.ref === current)
          ? current
          : ready[0]?.ref ?? "",
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (taskIdRef.current === taskId) {
        setGalleryError(error instanceof Error ? error.message : "Task files could not be loaded");
      }
    } finally {
      if (taskIdRef.current === taskId) setGalleryLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    taskIdRef.current = taskId;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadAttachments(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadAttachments, taskId]);

  useEffect(() => {
    const running = activeUploads.current;
    return () => {
      for (const cancel of running.values()) cancel();
      running.clear();
    };
  }, []);

  useEffect(() => {
    onBlockingChange?.(blocked);
  }, [blocked, onBlockingChange]);

  useEffect(() => () => onBlockingChange?.(false), [onBlockingChange]);

  function updateUpload(id: string, changes: Partial<CommentUploadCandidate>) {
    setUploads((current) => current.map((upload) =>
      upload.id === id ? { ...upload, ...changes } : upload,
    ));
  }

  function focusAt(cursor: number) {
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  async function runUpload(candidate: CommentUploadCandidate, point = candidate.insertionPoint) {
    if (canceledUploads.current.has(candidate.id)) {
      canceledUploads.current.delete(candidate.id);
      return point;
    }
    updateUpload(candidate.id, {
      insertionPoint: point,
      progress: 0,
      status: "uploading",
      error: null,
    });
    const running = startTaskAttachmentUpload(
      taskId,
      candidate.file,
      candidate.idempotencyKey,
      (progress) => updateUpload(candidate.id, { progress }),
    );
    activeUploads.current.set(candidate.id, running.cancel);
    try {
      const attachment = await running.promise;
      if (taskIdRef.current !== taskId || canceledUploads.current.has(candidate.id)) return point;
      updateUpload(candidate.id, { status: "processing", progress: 100 });
      if (attachment.state !== "ready") {
        throw new Error(attachment.failureCode || "Attachment is still processing");
      }
      const inserted = insertCommentAttachmentToken(
        valueRef.current,
        point,
        attachment,
      );
      valueRef.current = inserted.value;
      onChange(inserted.value);
      updateUpload(candidate.id, {
        insertionPoint: inserted.cursor,
        status: "ready",
        error: null,
        token: inserted.token,
      });
      setAttachments((current) => upsertAttachment(current, attachment));
      setSelectedAttachmentRef((current) => current || attachment.ref);
      notifyTaskAttachmentChanged(taskId);
      focusAt(inserted.cursor);
      return inserted.cursor;
    } catch (error) {
      if (taskIdRef.current !== taskId) return point;
      const canceled = error instanceof DOMException && error.name === "AbortError";
      updateUpload(candidate.id, {
        status: canceled ? "canceled" : "failed",
        error: canceled
          ? "Upload canceled"
          : error instanceof Error ? error.message : "Upload failed",
      });
      return point;
    } finally {
      activeUploads.current.delete(candidate.id);
    }
  }

  function queueFiles(files: FileList | File[]) {
    if (disabled) return;
    const point = textareaRef.current?.selectionStart ?? valueRef.current.length;
    const additions = Array.from(files).map((file) =>
      createCommentUploadCandidate(file, point),
    );
    if (!additions.length) return;
    setUploads((current) => [...current, ...additions]);
    void (async () => {
      let insertionPoint = point;
      for (const candidate of additions) {
        insertionPoint = await runUpload(candidate, insertionPoint);
      }
    })();
  }

  function cancelUpload(upload: CommentUploadCandidate) {
    canceledUploads.current.add(upload.id);
    activeUploads.current.get(upload.id)?.();
    updateUpload(upload.id, { status: "canceled", error: "Upload canceled" });
  }

  function retryUpload(upload: CommentUploadCandidate) {
    canceledUploads.current.delete(upload.id);
    void runUpload(upload);
  }

  function removeUpload(upload: CommentUploadCandidate) {
    if (upload.status === "uploading" || upload.status === "processing") {
      cancelUpload(upload);
      return;
    }
    if (upload.status === "queued") {
      canceledUploads.current.add(upload.id);
      setUploads((current) => current.filter((candidate) => candidate.id !== upload.id));
      return;
    }
    if (upload.status === "ready" && upload.token) {
      const next = removeCommentAttachmentToken(valueRef.current, upload.token);
      valueRef.current = next;
      onChange(next);
      focusAt(Math.min(next.length, upload.insertionPoint));
    }
    setUploads((current) => current.filter((candidate) => candidate.id !== upload.id));
    canceledUploads.current.delete(upload.id);
  }

  function insertExistingAttachment() {
    const attachment = readyAttachments.find(
      (candidate) => candidate.ref === selectedAttachmentRef,
    );
    if (!attachment || disabled) return;
    const point = textareaRef.current?.selectionStart ?? valueRef.current.length;
    const inserted = insertCommentAttachmentToken(valueRef.current, point, attachment);
    valueRef.current = inserted.value;
    onChange(inserted.value);
    focusAt(inserted.cursor);
    setGalleryOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || !(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "a") return;
    event.preventDefault();
    inputRef.current?.click();
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    if (disabled || !event.clipboardData.files.length) return;
    event.preventDefault();
    queueFiles(event.clipboardData.files);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (disabled || !event.dataTransfer.files.length) return;
    event.preventDefault();
    setDragActive(false);
    queueFiles(event.dataTransfer.files);
  }

  return (
    <div
      className={`comment-attachment-authoring ${dragActive ? "drag-active" : ""}`}
      onKeyDownCapture={handleKeyDown}
      onPaste={handlePaste}
      onDragEnter={(event) => {
        if (disabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (disabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={handleDrop}
    >
      {children}
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        multiple
        aria-label="Choose files for this comment"
        onChange={(event) => {
          if (event.target.files) queueFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <div className="comment-attachment-controls" role="toolbar" aria-label="Comment attachments">
        <button
          className="comment-attachment-button"
          type="button"
          disabled={disabled}
          title="Attach files (Cmd/Ctrl+Shift+A)"
          aria-label="Attach files"
          onClick={() => inputRef.current?.click()}
        ><Paperclip size={14} /></button>
        <button
          className="comment-gallery-button"
          type="button"
          disabled={disabled}
          aria-expanded={galleryOpen}
          onClick={() => {
            const next = !galleryOpen;
            setGalleryOpen(next);
            if (next) void loadAttachments();
          }}
        >Task files{readyAttachments.length ? ` (${readyAttachments.length})` : ""}</button>
        <span>Drop or paste files</span>
      </div>
      {galleryOpen && (
        <div className="comment-attachment-gallery">
          {galleryLoading ? <span role="status">Loading Task files…</span> : galleryError ? <>
            <span role="alert">{galleryError}</span>
            <button type="button" aria-label="Retry Task files" onClick={() => void loadAttachments()}><RefreshCw size={13} /></button>
          </> : readyAttachments.length ? <>
            <select
              aria-label="Ready Task attachment"
              value={selectedAttachmentRef}
              onChange={(event) => setSelectedAttachmentRef(event.target.value)}
            >
              {readyAttachments.map((attachment) => (
                <option key={attachment.ref} value={attachment.ref}>{attachment.filename}</option>
              ))}
            </select>
            <button className="button ghost" type="button" onClick={insertExistingAttachment}>Insert selected</button>
          </> : <span>No ready Task files yet.</span>}
        </div>
      )}
      {dragActive && <div className="comment-attachment-drop" role="status">Drop files to upload and insert</div>}
      {uploads.length > 0 && (
        <div className="comment-attachment-uploads" aria-live="polite" aria-label="Comment upload status">
          {uploads.map((upload) => (
            <article key={upload.id} data-upload-state={upload.status}>
              <span className="comment-upload-icon"><FileText size={15} /></span>
              <div>
                <b title={upload.file.name}>{upload.file.name}</b>
                <small>{uploadStatusLabel(upload)}</small>
                {(upload.status === "queued" || upload.status === "uploading" || upload.status === "processing") && (
                  <progress value={upload.progress} max="100" aria-label={`Upload progress for ${upload.file.name}`} />
                )}
              </div>
              <div className="comment-upload-actions">
                {(upload.status === "failed" || upload.status === "canceled") && (
                  <button type="button" aria-label={`Retry ${upload.file.name}`} title="Retry upload" onClick={() => retryUpload(upload)}><RotateCcw size={13} /></button>
                )}
                <button
                  type="button"
                  aria-label={`${upload.status === "ready" ? "Remove from draft" : upload.status === "uploading" || upload.status === "processing" ? "Cancel" : "Remove"} ${upload.file.name}`}
                  title={upload.status === "ready" ? "Remove from draft" : "Cancel or remove upload"}
                  onClick={() => removeUpload(upload)}
                ><X size={13} /></button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function uploadStatusLabel(upload: CommentUploadCandidate) {
  if (upload.status === "uploading") return `${upload.progress}% uploaded`;
  if (upload.status === "processing") return "Processing…";
  if (upload.status === "ready") return "Ready · inserted in draft";
  if (upload.status === "queued") return "Queued";
  return upload.error || (upload.status === "canceled" ? "Upload canceled" : "Upload failed");
}

function upsertAttachment(
  attachments: PublicAttachmentRecord[],
  attachment: PublicAttachmentRecord,
) {
  const index = attachments.findIndex((candidate) => candidate.ref === attachment.ref);
  if (index < 0) return [...attachments, attachment];
  const next = [...attachments];
  next[index] = attachment;
  return next;
}
