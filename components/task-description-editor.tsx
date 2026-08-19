"use client";

import { FilePlus2, ImagePlus, RotateCcw, X } from "lucide-react";
import {
  notifyTaskAttachmentChanged,
  startTaskAttachmentUpload,
  type PublicAttachmentRecord,
} from "@/components/task-attachments";
import {
  buildTaskFileLink,
  buildTaskImageToken,
} from "@/lib/task-description-format";
import { useEffect, useRef, useState } from "react";

type DescriptionUpload = {
  file: File;
  mode: "image" | "file";
  idempotencyKey: string;
  insertionPoint: number;
  progress: number;
  status: "uploading" | "failed" | "canceled";
  error: string | null;
};

export function TaskDescriptionEditor({
  taskId,
  value,
  onChange,
  onUploadActiveChange,
  disabled,
}: {
  taskId: string;
  value: string;
  onChange: (value: string) => void;
  onUploadActiveChange?: (active: boolean) => void;
  disabled: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerInsertionPointRef = useRef(value.length);
  const cancelUploadRef = useRef<(() => void) | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [upload, setUpload] = useState<DescriptionUpload | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [readyAttachments, setReadyAttachments] = useState<PublicAttachmentRecord[]>([]);
  const [selectedAttachmentRef, setSelectedAttachmentRef] = useState("");

  useEffect(() => () => cancelUploadRef.current?.(), []);
  useEffect(() => {
    onUploadActiveChange?.(upload?.status === "uploading");
  }, [onUploadActiveChange, upload?.status]);
  useEffect(() => () => onUploadActiveChange?.(false), [onUploadActiveChange]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await response.json() as { attachments?: PublicAttachmentRecord[] };
        if (!response.ok || !value.attachments) return;
        const ready = value.attachments.filter((attachment) => attachment.state === "ready");
        setReadyAttachments(ready);
        setSelectedAttachmentRef((current) => current || ready[0]?.ref || "");
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [taskId]);

  function selectImage() {
    if (disabled || upload?.status === "uploading") return;
    pickerInsertionPointRef.current = insertionPoint();
    imageInputRef.current?.click();
  }

  function selectFile() {
    if (disabled || upload?.status === "uploading") return;
    pickerInsertionPointRef.current = insertionPoint();
    fileInputRef.current?.click();
  }

  function insertExistingFile() {
    if (disabled || upload?.status === "uploading") return;
    const attachment = readyAttachments.find(
      (candidate) => candidate.ref === selectedAttachmentRef,
    );
    if (!attachment) return;
    const inserted = insertFileLink(
      valueRef.current,
      insertionPoint(),
      buildTaskFileLink(attachment.ref, filenameLinkLabel(attachment.filename)),
    );
    onChange(inserted.value);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(inserted.cursor, inserted.cursor);
    });
  }

  function acceptFile(
    file: File,
    insertionPoint: number,
    mode: "image" | "file",
  ) {
    if (mode === "image" && !isSupportedRasterImage(file)) {
      setUpload({
        file,
        mode,
        idempotencyKey: `task-description-image:${crypto.randomUUID()}`,
        insertionPoint,
        progress: 0,
        status: "failed",
        error: "Choose a PNG, JPEG, or GIF image.",
      });
      return;
    }
    const next: DescriptionUpload = {
      file,
      mode,
      idempotencyKey: `task-description-${mode}:${crypto.randomUUID()}`,
      insertionPoint,
      progress: 0,
      status: "uploading",
      error: null,
    };
    setUpload(next);
    void runUpload(next);
  }

  async function runUpload(candidate: DescriptionUpload) {
    setUpload({ ...candidate, status: "uploading", error: null });
    const running = startTaskAttachmentUpload(
      taskId,
      candidate.file,
      candidate.idempotencyKey,
      (progress) => setUpload((current) => current &&
        current.idempotencyKey === candidate.idempotencyKey
        ? { ...current, progress }
        : current),
    );
    cancelUploadRef.current = running.cancel;
    try {
      const attachment = await running.promise;
      const token = candidate.mode === "image"
        ? buildTaskImageToken(attachment.ref, filenameAlt(candidate.file.name))
        : buildTaskFileLink(attachment.ref, filenameLinkLabel(candidate.file.name));
      const inserted = candidate.mode === "image"
        ? insertImageToken(valueRef.current, candidate.insertionPoint, token)
        : insertFileLink(valueRef.current, candidate.insertionPoint, token);
      onChange(inserted.value);
      notifyTaskAttachmentChanged(taskId);
      setUpload(null);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(inserted.cursor, inserted.cursor);
      });
    } catch (requestError) {
      const canceled = requestError instanceof DOMException && requestError.name === "AbortError";
      setUpload((current) => current &&
        current.idempotencyKey === candidate.idempotencyKey
        ? {
            ...current,
            status: canceled ? "canceled" : "failed",
            error: canceled
              ? "Upload canceled"
              : requestError instanceof Error
                ? requestError.message
                : "Upload failed",
          }
        : current);
    } finally {
      cancelUploadRef.current = null;
    }
  }

  const insertionPoint = () => textareaRef.current?.selectionStart ?? value.length;

  return (
    <div
      className={`task-description-input ${dragActive ? "drag-active" : ""}`}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragActive(false);
        const file = event.dataTransfer.files[0]!;
        acceptFile(
          file,
          insertionPoint(),
          isSupportedRasterImage(file) ? "image" : "file",
        );
      }}
    >
      <div className="task-description-editor-toolbar">
        <button className="button ghost" type="button" disabled={disabled || upload?.status === "uploading"} onClick={selectImage}>
          <ImagePlus size={14} />Insert image
        </button>
        <button className="button ghost" type="button" disabled={disabled || upload?.status === "uploading"} onClick={selectFile}>
          <FilePlus2 size={14} />Insert file
        </button>
        {readyAttachments.length > 0 && <>
          <select
            aria-label="Ready Task attachment"
            value={selectedAttachmentRef}
            disabled={disabled || upload?.status === "uploading"}
            onChange={(event) => setSelectedAttachmentRef(event.target.value)}
          >
            {readyAttachments.map((attachment) => (
              <option key={attachment.ref} value={attachment.ref}>{attachment.filename}</option>
            ))}
          </select>
          <button className="button ghost" type="button" disabled={disabled || upload?.status === "uploading"} onClick={insertExistingFile}>
            Link selected
          </button>
        </>}
        <span>Private attachment · inserted at the cursor</span>
      </div>
      <input
        ref={imageInputRef}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/gif"
        aria-label="Choose an image for the Task description"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) acceptFile(file, pickerInsertionPointRef.current, "image");
          event.target.value = "";
        }}
      />
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        aria-label="Choose a file for the Task description"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) acceptFile(file, pickerInsertionPointRef.current, "file");
          event.target.value = "";
        }}
      />
      <textarea
        ref={textareaRef}
        className="details-description"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => {
          const file = event.clipboardData.files[0];
          if (!file) return;
          event.preventDefault();
          acceptFile(
            file,
            event.currentTarget.selectionStart,
            isSupportedRasterImage(file) ? "image" : "file",
          );
        }}
        placeholder="Add description…"
        rows={12}
        autoFocus
        disabled={disabled}
      />
      {dragActive && <span className="task-description-drop-message" role="status">Drop a file to upload and insert</span>}
      {upload && (
        <div className={`task-description-upload ${upload.status}`} role="status" aria-live="polite">
          <div>
            <b title={upload.file.name}>{upload.file.name}</b>
            <span>{upload.status === "uploading" ? `${upload.progress}% uploaded` : upload.error}</span>
            {upload.status === "uploading" && <progress value={upload.progress} max="100" aria-label={`Upload progress for ${upload.file.name}`} />}
          </div>
          {upload.status === "uploading" ? (
            <button className="icon-button" type="button" aria-label={`Cancel ${upload.file.name}`} onClick={() => cancelUploadRef.current?.()}><X size={14} /></button>
          ) : (
            <>
              <button className="button ghost" type="button" disabled={upload.mode === "image" && !isSupportedRasterImage(upload.file)} onClick={() => void runUpload(upload)}><RotateCcw size={13} />Retry</button>
              <button className="icon-button" type="button" aria-label={`Dismiss ${upload.file.name}`} onClick={() => setUpload(null)}><X size={14} /></button>
            </>
          )}
        </div>
      )}
      <p className="task-description-image-help">Native image and file links keep only a private attachment ref. Edit the Markdown label to rename it; removing the token does not remove the file.</p>
    </div>
  );
}

function isSupportedRasterImage(file: File) {
  return ["image/png", "image/jpeg", "image/gif"].includes(file.type) ||
    /\.(png|jpe?g|gif)$/i.test(file.name);
}

function filenameAlt(filename: string) {
  const withoutExtension = filename.replace(/\.[^.]+$/, "").trim();
  return withoutExtension || "Attached image";
}

function filenameLinkLabel(filename: string) {
  return filename.trim() || "Attached file";
}

export function insertImageToken(value: string, point: number, token: string) {
  const cursor = Math.max(0, Math.min(value.length, point));
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const prefix = before && !before.endsWith("\n") ? "\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n" : "";
  const insertion = `${prefix}${token}${suffix}`;
  return {
    value: `${before}${insertion}${after}`,
    cursor: before.length + insertion.length,
  };
}

export function insertFileLink(value: string, point: number, token: string) {
  const cursor = Math.max(0, Math.min(value.length, point));
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const prefix = before && !/[\s(]$/.test(before) ? " " : "";
  const suffix = after && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  const insertion = `${prefix}${token}${suffix}`;
  return {
    value: `${before}${insertion}${after}`,
    cursor: before.length + insertion.length,
  };
}
