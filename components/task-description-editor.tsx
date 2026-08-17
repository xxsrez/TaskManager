"use client";

import { ImagePlus, RotateCcw, X } from "lucide-react";
import {
  notifyTaskAttachmentChanged,
  startTaskAttachmentUpload,
} from "@/components/task-attachments";
import { buildTaskImageToken } from "@/lib/task-description-format";
import { useEffect, useRef, useState } from "react";

type ImageUpload = {
  file: File;
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerInsertionPointRef = useRef(value.length);
  const cancelUploadRef = useRef<(() => void) | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [upload, setUpload] = useState<ImageUpload | null>(null);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => () => cancelUploadRef.current?.(), []);
  useEffect(() => {
    onUploadActiveChange?.(upload?.status === "uploading");
  }, [onUploadActiveChange, upload?.status]);
  useEffect(() => () => onUploadActiveChange?.(false), [onUploadActiveChange]);

  function selectImage() {
    if (disabled || upload?.status === "uploading") return;
    pickerInsertionPointRef.current = insertionPoint();
    fileInputRef.current?.click();
  }

  function acceptImage(file: File, insertionPoint: number) {
    if (!isSupportedRasterImage(file)) {
      setUpload({
        file,
        idempotencyKey: `task-description-image:${crypto.randomUUID()}`,
        insertionPoint,
        progress: 0,
        status: "failed",
        error: "Choose a PNG, JPEG, or GIF image.",
      });
      return;
    }
    const next: ImageUpload = {
      file,
      idempotencyKey: `task-description-image:${crypto.randomUUID()}`,
      insertionPoint,
      progress: 0,
      status: "uploading",
      error: null,
    };
    setUpload(next);
    void runUpload(next);
  }

  async function runUpload(candidate: ImageUpload) {
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
      const alt = filenameAlt(candidate.file.name);
      const token = buildTaskImageToken(attachment.ref, alt);
      const inserted = insertImageToken(valueRef.current, candidate.insertionPoint, token);
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
        acceptImage(event.dataTransfer.files[0]!, insertionPoint());
      }}
    >
      <div className="task-description-editor-toolbar">
        <button className="button ghost" type="button" disabled={disabled || upload?.status === "uploading"} onClick={selectImage}>
          <ImagePlus size={14} />Insert image
        </button>
        <span>PNG, JPEG, or GIF · inserted at the cursor</span>
      </div>
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/gif"
        aria-label="Choose an image for the Task description"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) acceptImage(file, pickerInsertionPointRef.current);
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
          acceptImage(file, event.currentTarget.selectionStart);
        }}
        placeholder="Add description…"
        rows={12}
        autoFocus
        disabled={disabled}
      />
      {dragActive && <span className="task-description-drop-message" role="status">Drop an image to upload and insert</span>}
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
              <button className="button ghost" type="button" disabled={!isSupportedRasterImage(upload.file)} onClick={() => void runUpload(upload)}><RotateCcw size={13} />Retry</button>
              <button className="icon-button" type="button" aria-label={`Dismiss ${upload.file.name}`} onClick={() => setUpload(null)}><X size={14} /></button>
            </>
          )}
        </div>
      )}
      <p className="task-description-image-help">Native image tokens keep only a private attachment ref. Edit the text inside <code>![alt]</code> to change its accessible label; removing the token does not remove the file.</p>
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
