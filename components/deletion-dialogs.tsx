"use client";

import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DeletableEntityType, DeletionPreview } from "@/lib/types";

export type RecoverableDeleteTarget = {
  type: DeletableEntityType;
  displayName: string;
  context?: string | null;
  description?: string;
  warning?: string | null;
  impactLines?: string[];
  acknowledgement?: string | null;
};

export function RecoverableDeleteDialog({
  target,
  busy = false,
  onConfirm,
  onClose,
}: {
  target: RecoverableDeleteTarget;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return <DeletionDialogFrame
    title={`Delete ${deletionTypeLabel(target.type)}?`}
    onClose={() => !busy && onClose()}
  >
    <div className="deletion-dialog-body">
      <p><b>{target.displayName}</b>{target.context ? ` · ${target.context}` : ""}</p>
      <p>{target.description ?? "This moves the item to Recently deleted for 30 days. Archive remains a separate action."}</p>
      {target.warning && <p className="deletion-warning"><AlertTriangle size={17} aria-hidden="true" /><span>{target.warning}</span></p>}
      {target.impactLines && target.impactLines.length > 0 && <ul className="deletion-impact" aria-label="Recoverable deletion impact">
        {target.impactLines.map((line) => <li key={line}>{line}</li>)}
      </ul>}
      {target.acknowledgement && <label className="deletion-acknowledgement">
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>{target.acknowledgement}</span>
      </label>}
    </div>
    <div className="deletion-dialog-footer">
      <button className="button secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="button danger deletion-primary" type="button" disabled={busy || Boolean(target.acknowledgement && !acknowledged)} onClick={onConfirm}>
        {busy ? "Deleting…" : "Move to Recently deleted"}
      </button>
    </div>
  </DeletionDialogFrame>;
}

export function PermanentDeleteDialog({
  preview,
  busy = false,
  error = "",
  onConfirm,
  onClose,
}: {
  preview: DeletionPreview;
  busy?: boolean;
  error?: string;
  onConfirm: (confirmation: string) => void;
  onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const impact = deletionImpactLines(preview);
  return <DeletionDialogFrame
    title={`Permanently delete ${deletionTypeLabel(preview.type)}?`}
    onClose={() => !busy && onClose()}
  >
    <div className="deletion-dialog-body">
      <p className="deletion-warning"><AlertTriangle size={17} aria-hidden="true" /><span><b>This cannot be undone.</b> The item leaves Recently deleted permanently.</span></p>
      <div className="deletion-preview-identity">
        <b>{preview.displayName}</b>
        {preview.context && <small>{preview.context}</small>}
      </div>
      {impact.length > 0 && <ul className="deletion-impact" aria-label="Permanent deletion impact">
        {impact.map((line) => <li key={line}>{line}</li>)}
      </ul>}
      <label className="deletion-confirmation">
        <span>Type <code>{preview.confirmation}</code> to continue</span>
        <input
          ref={inputRef}
          value={confirmation}
          autoComplete="off"
          spellCheck={false}
          aria-label="Permanent deletion confirmation"
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      {error && <p className="dialog-error" role="alert">{error}</p>}
    </div>
    <div className="deletion-dialog-footer">
      <button className="button secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      <button
        className="button danger deletion-primary"
        type="button"
        disabled={busy || confirmation !== preview.confirmation}
        onClick={() => onConfirm(confirmation)}
      >{busy ? "Deleting permanently…" : "Delete permanently"}</button>
    </div>
  </DeletionDialogFrame>;
}

export function DeletionUndoToast({
  label,
  timeoutMs = 8_000,
  busy = false,
  onUndo,
  onDismiss,
}: {
  label: string;
  timeoutMs?: number;
  busy?: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (busy) return;
    const timeout = window.setTimeout(onDismiss, timeoutMs);
    return () => window.clearTimeout(timeout);
  }, [busy, onDismiss, timeoutMs]);
  return <div className="deletion-undo-toast" role="status" aria-live="polite">
    <span>{label} moved to Recently deleted.</span>
    <button type="button" disabled={busy} onClick={onUndo}><RotateCcw size={14} />{busy ? "Restoring…" : "Undo"}</button>
    <button className="icon-button" type="button" aria-label="Dismiss deletion notification" onClick={onDismiss}><X size={14} /></button>
  </div>;
}

function DeletionDialogFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )];
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
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const returnFocus = returnFocusRef.current;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [onClose]);
  const titleId = "deletion-dialog-title";
  return <div className="modal-backdrop deletion-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div ref={dialogRef} className="modal deletion-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="dialog-header"><h2 id={titleId}>{title}</h2><button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}><X size={15} /></button></header>
      {children}
    </div>
  </div>;
}

export function deletionTypeLabel(type: DeletableEntityType) {
  if (type === "saved_view") return "Saved View";
  return type[0]!.toUpperCase() + type.slice(1);
}

export function deletionImpactLines(preview: DeletionPreview) {
  const count = (value: number, one: string, many = `${one}s`) =>
    `${value.toLocaleString()} ${value === 1 ? one : many}`;
  if (preview.type === "project") {
    return [
      count(preview.impact.tasks, "Task"),
      count(preview.impact.releases, "Release"),
      count(preview.impact.savedViews, "Saved View"),
      count(preview.impact.comments, "comment"),
      count(preview.impact.attachments, "Attachment"),
    ];
  }
  if (preview.type === "release") {
    return [
      `${count(preview.impact.releaseMemberships, "Task membership")} will be cleared; Tasks stay available.`,
    ];
  }
  if (preview.type === "task") {
    return [
      count(preview.impact.comments, "comment"),
      count(preview.impact.attachments, "Attachment"),
    ];
  }
  return ["Only this Saved View and its direct access grants will be removed. Tasks are unchanged."];
}
