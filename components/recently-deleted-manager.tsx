"use client";

import { AlertCircle, Clock3, LoaderCircle, RotateCcw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PermanentDeleteDialog, deletionTypeLabel } from "@/components/deletion-dialogs";
import {
  DeletionRequestError,
  RECENTLY_DELETED_CHANGED_EVENT,
  fetchDeletionPreview,
  fetchRecentlyDeleted,
  deletionErrorRequiresRefetch,
  notifyRecentlyDeletedChanged,
  performDeletionAction,
} from "@/lib/deletion-client";
import type {
  DeletableEntityType,
  DeletionPreview,
  RecentlyDeletedRecord,
} from "@/lib/types";

const deletionFilters: Array<{ value: "all" | DeletableEntityType; label: string }> = [
  { value: "all", label: "All" },
  { value: "task", label: "Tasks" },
  { value: "project", label: "Projects" },
  { value: "release", label: "Releases" },
  { value: "saved_view", label: "Saved Views" },
];

type PendingPurge = {
  preview: DeletionPreview;
  trigger: HTMLButtonElement;
};

export function RecentlyDeletedManager({
  invalidationEpoch = 0,
  onWorkspaceChanged,
}: {
  invalidationEpoch?: number;
  onWorkspaceChanged?: () => Promise<unknown> | unknown;
}) {
  const [type, setType] = useState<"all" | DeletableEntityType>("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<RecentlyDeletedRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [pendingPurge, setPendingPurge] = useState<PendingPurge | null>(null);
  const [purgeError, setPurgeError] = useState("");
  const [localEpoch, setLocalEpoch] = useState(0);
  const [clockEpoch, setClockEpoch] = useState(() => Date.now());
  const requestRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => setLocalEpoch((current) => current + 1), []);

  useEffect(() => {
    const changed = () => reload();
    window.addEventListener(RECENTLY_DELETED_CHANGED_EVENT, changed);
    return () => window.removeEventListener(RECENTLY_DELETED_CHANGED_EVENT, changed);
  }, [reload]);

  useEffect(() => {
    const interval = window.setInterval(() => setClockEpoch(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const request = ++requestRef.current;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void fetchRecentlyDeleted({
        type: type === "all" ? undefined : type,
        search,
        limit: 30,
        signal: controller.signal,
      }).then((page) => {
        if (request !== requestRef.current) return;
        setItems(page.items);
        setNextCursor(page.page.nextCursor);
      }).catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        if (request !== requestRef.current) return;
        setError(requestError instanceof Error ? requestError.message : "Recently deleted could not be loaded");
      }).finally(() => {
        if (request === requestRef.current) setLoading(false);
      });
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [invalidationEpoch, localEpoch, search, type]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const request = requestRef.current;
    setLoadingMore(true);
    setError("");
    try {
      const page = await fetchRecentlyDeleted({
        type: type === "all" ? undefined : type,
        search,
        cursor: nextCursor,
        limit: 30,
      });
      if (request !== requestRef.current) return;
      setItems((current) => mergeDeletedRows(current, page.items));
      setNextCursor(page.page.nextCursor);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "More deleted items could not be loaded");
    } finally {
      setLoadingMore(false);
    }
  }

  async function restore(item: RecentlyDeletedRecord) {
    const key = deletedRowKey(item);
    setBusyKey(key);
    setError("");
    try {
      await performDeletionAction(item.type, item.id, "restore_deleted", item.version);
      setItems((current) => current.filter((candidate) => deletedRowKey(candidate) !== key));
      setStatus(`${deletionTypeLabel(item.type)} restored.`);
      notifyRecentlyDeletedChanged();
      await Promise.resolve(onWorkspaceChanged?.()).catch(() => undefined);
      searchRef.current?.focus();
    } catch (requestError) {
      handleMutationError(requestError, "This item changed in another session. The list was refreshed.");
    } finally {
      setBusyKey(null);
    }
  }

  async function openPermanentDelete(item: RecentlyDeletedRecord, trigger: HTMLButtonElement) {
    const key = deletedRowKey(item);
    setPreviewKey(key);
    setError("");
    try {
      const preview = await fetchDeletionPreview(item.type, item.id, item.version);
      setPendingPurge({ preview, trigger });
      setPurgeError("");
    } catch (requestError) {
      handleMutationError(requestError, "This item changed in another session. The list was refreshed.");
    } finally {
      setPreviewKey(null);
    }
  }

  function closePermanentDelete(restoreFocus = true) {
    const trigger = pendingPurge?.trigger;
    setPendingPurge(null);
    setPurgeError("");
    if (restoreFocus) window.setTimeout(() => trigger?.focus(), 0);
  }

  async function purge(confirmation: string) {
    if (!pendingPurge) return;
    const { preview } = pendingPurge;
    const key = `${preview.type}:${preview.id}`;
    setBusyKey(key);
    setPurgeError("");
    try {
      await performDeletionAction(preview.type, preview.id, "purge", preview.version, { confirmation });
      setItems((current) => current.filter((candidate) => deletedRowKey(candidate) !== key));
      setStatus(`${deletionTypeLabel(preview.type)} permanently deleted.`);
      closePermanentDelete(false);
      notifyRecentlyDeletedChanged();
      await Promise.resolve(onWorkspaceChanged?.()).catch(() => undefined);
      window.setTimeout(() => searchRef.current?.focus(), 0);
    } catch (requestError) {
      if (requestError instanceof DeletionRequestError && requestError.status >= 500) {
        setPurgeError("Permanent deletion could not finish. The item remains here and can be retried safely.");
        reload();
      } else {
        closePermanentDelete(false);
        handleMutationError(requestError, "This item changed or is no longer available. The list was refreshed.");
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
    } finally {
      setBusyKey(null);
    }
  }

  function handleMutationError(requestError: unknown, staleMessage: string) {
    if (deletionErrorRequiresRefetch(requestError)) {
      setStatus(staleMessage);
      reload();
      return;
    }
    setError(requestError instanceof Error ? requestError.message : "The action could not be completed");
  }

  return <section className="recently-deleted-manager" aria-label="Recently deleted items">
    <div className="recently-deleted-toolbar">
      <label className="recently-deleted-search"><Search size={14} aria-hidden="true" /><input
        ref={searchRef}
        data-recently-deleted-focus
        type="search"
        value={search}
        maxLength={120}
        placeholder="Search deleted items…"
        aria-label="Search recently deleted"
        onChange={(event) => setSearch(event.target.value)}
      /></label>
      <label className="recently-deleted-filter"><span>Type</span><select
        value={type}
        aria-label="Filter recently deleted by type"
        onChange={(event) => setType(event.target.value as "all" | DeletableEntityType)}
      >{deletionFilters.map((filter) => <option value={filter.value} key={filter.value}>{filter.label}</option>)}</select></label>
    </div>
    <p className="recently-deleted-guidance">Items can be restored for 30 days. Physical cleanup may finish later; the expiry shown here is the restore cutoff.</p>
    <div className="recently-deleted-live" role="status" aria-live="polite">{status}</div>
    {error && <div className="recently-deleted-error" role="alert"><AlertCircle size={15} /><span>{error}</span><button className="button ghost compact" type="button" onClick={reload}>Retry</button></div>}
    {loading ? <div className="recently-deleted-loading" role="status"><LoaderCircle className="spin" size={17} />Loading recently deleted…</div>
      : items.length === 0 ? <div className="recently-deleted-empty"><Trash2 size={22} /><b>Nothing in Recently deleted</b><span>{search.trim() || type !== "all" ? "Try a different search or type." : "Deleted Tasks, Projects, Releases, and Saved Views appear here."}</span></div>
        : <div className="recently-deleted-list">{items.map((item) => {
          const key = deletedRowKey(item);
          const busy = busyKey === key;
          const actions = recentlyDeletedActions(item, clockEpoch);
          const expired = actions.expired;
          return <article className="recently-deleted-row" key={`${key}:${item.version}`}>
            <div className="recently-deleted-identity">
              <span className="recently-deleted-type">{deletionTypeLabel(item.type)}</span>
              <b>{item.displayName}</b>
              {item.context && <small>Project: {item.context}</small>}
              <p>{deletionExplanation(item.type)}</p>
            </div>
            <dl className="recently-deleted-meta">
              <div><dt>Deleted by</dt><dd>{item.deletedBy.isCurrentUser ? "You" : item.deletedBy.displayName}</dd></div>
              <div><dt>Deleted</dt><dd>{formatDeletedDate(item.deletedAt)}</dd></div>
              <div><dt>Restore cutoff</dt><dd className={expired ? "expired" : ""}><Clock3 size={12} />{expired ? "Expired" : remainingUntil(item.purgeAfter)}</dd></div>
            </dl>
            <div className="recently-deleted-actions">
              {item.purgeState === "retry_required" && <span className="purge-retry-state">Cleanup needs retry</span>}
              {actions.restore && <button className="button secondary" type="button" disabled={busy} aria-label={`Restore ${item.displayName}`} onClick={() => void restore(item)}><RotateCcw size={14} />{busy ? "Restoring…" : "Restore"}</button>}
              {actions.purge && <button className="button danger" type="button" disabled={busy || previewKey === key} aria-label={`Delete ${item.displayName} permanently`} onClick={(event) => void openPermanentDelete(item, event.currentTarget)}><Trash2 size={14} />{previewKey === key ? "Preparing…" : item.purgeState === "retry_required" ? "Retry permanent delete" : "Delete permanently"}</button>}
              {actions.readOnly && <span className="read-only-badge">Read-only</span>}
            </div>
          </article>;
        })}</div>}
    {nextCursor && !loading && <div className="recently-deleted-more"><button className="button secondary" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button></div>}
    {pendingPurge && <PermanentDeleteDialog preview={pendingPurge.preview} busy={busyKey === `${pendingPurge.preview.type}:${pendingPurge.preview.id}`} error={purgeError} onConfirm={(confirmation) => void purge(confirmation)} onClose={() => closePermanentDelete()} />}
  </section>;
}

export function mergeDeletedRows(
  current: RecentlyDeletedRecord[],
  incoming: RecentlyDeletedRecord[],
) {
  const seen = new Set(current.map(deletedRowKey));
  return [...current, ...incoming.filter((item) => !seen.has(deletedRowKey(item)))];
}

function deletedRowKey(item: Pick<RecentlyDeletedRecord, "type" | "id">) {
  return `${item.type}:${item.id}`;
}

export function deletionExplanation(type: DeletableEntityType) {
  if (type === "project") return "Restore removes the Project shadow; separately deleted children stay here.";
  if (type === "release") return "Tasks are kept and their Release membership returns on restore.";
  if (type === "saved_view") return "Tasks, saved query, display, scope, and temporary filters are unchanged.";
  return "Content, subtasks, relations, comments, activity, and attachments are kept until permanent deletion.";
}

export function remainingUntil(value: string, now = Date.now()) {
  const remaining = Date.parse(value) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "Expired";
  const hours = Math.ceil(remaining / 3_600_000);
  if (hours < 48) return `${hours}h remaining`;
  return `${Math.ceil(hours / 24)}d remaining`;
}

export function recentlyDeletedActions(
  item: Pick<RecentlyDeletedRecord, "actions" | "purgeAfter">,
  now = Date.now(),
) {
  const expired = Date.parse(item.purgeAfter) <= now;
  return {
    expired,
    restore: item.actions.canRestore && !expired,
    purge: item.actions.canPurge,
    readOnly: !item.actions.canRestore && !item.actions.canPurge,
  };
}

function formatDeletedDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
