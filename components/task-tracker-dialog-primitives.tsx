"use client";

import type {
ProjectRecord,
ProjectStatus,
ReleaseRecord,
ReleaseStatus
} from "@/lib/types";
import {
Boxes,
CircleDot,
FolderKanban,
Rocket,
X
} from "lucide-react";
import {
KeyboardEvent as ReactKeyboardEvent,
MouseEvent as ReactMouseEvent,
useEffect,
useRef
} from "react";


export function Popover({ title, onClose, children, className = "" }: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) { return <div className={`popover ${className}`}><header><b>{title}</b><button onClick={onClose}><X size={13} /></button></header>{children}</div>; }


export function DialogHeader({ title, icon, onClose, className = "" }: { title: string; icon: React.ReactNode; onClose: () => void; className?: string }) { return <div className={`dialog-header ${className}`}><div>{icon}<h2>{title}</h2></div><button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><X size={15} /></button></div>; }
export function DialogFooter({ busy, label, disabled }: { busy: boolean; label: string; disabled?: boolean }) { return <div className="dialog-footer"><span>Press Esc to close</span><button className="button primary" disabled={busy || disabled}>{busy ? "Saving…" : label}</button></div>; }
export const FOCUSABLE_SELECTOR = "button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";
export function trapFocus(event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
export function Modal({ onClose, children, className = "", ariaLabel }: { onClose: () => void; children: React.ReactNode; className?: string; ariaLabel?: string }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    trapFocus(event, modalRef.current);
  };
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (!modal || modal.contains(document.activeElement)) return;
      modal.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  // The focus-trapped dialog intentionally owns Escape after nested controls have handled it.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div ref={modalRef} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={ariaLabel} tabIndex={-1} onKeyDown={handleKey}>{children}</div></div>;
}


export const projectStatusOptions: ProjectStatus[] = ["planned", "active", "paused", "completed", "canceled"];

export function projectStatusLabel(status: ProjectStatus | ReleaseStatus) {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

export function releasedCompositionNeedsConfirmation(
  currentReleaseId: string | null,
  nextReleaseId: string | null,
  releases: ReleaseRecord[],
) {
  if (currentReleaseId === nextReleaseId) return false;
  return releases.some(
    (release) =>
      (release.id === currentReleaseId || release.id === nextReleaseId)
      && release.status === "released",
  );
}

export function confirmReleasedCompositionChange() {
  return window.confirm(
    "This changes the Task composition of a released Release. Continue?",
  );
}

export function ProjectIcon({ project, size = 18 }: { project?: Pick<ProjectRecord, "icon" | "color">; size?: number }) {
  if (project?.icon === "rocket") return <Rocket size={size} />;
  if (project?.icon === "target") return <CircleDot size={size} />;
  if (project?.icon === "folder") return <FolderKanban size={size} />;
  return <Boxes size={size} />;
}


export function handleLocalLink(event: ReactMouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  navigate();
}


export function displayLabel(value: string) {
  const labels: Record<string, string> = {
    none: "No grouping",
    due: "Due date",
    dueDate: "Due date",
  };
  return labels[value] ?? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

export function initials(value: string) { return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
export function shortDate(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`)); }
export function longDate(value: string, timeZone: string) { try { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone }).format(new Date(value)); } catch { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value)); } }
export function longDateTime(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
export function zonedDateTime(value: string, timeZone: string) { try { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(value)); } catch { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(value)); } }
export function isOverdue(value: string, category: string) { return new Date(`${value}T23:59:59`) < new Date() && category !== "completed" && category !== "canceled"; }
