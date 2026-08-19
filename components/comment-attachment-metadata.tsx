"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyCommentAttachmentMetadataResult,
  loadCommentAttachmentMetadata,
  mergeCommentAttachmentRefs,
} from "@/lib/comment-attachment-metadata-loader";
import { visibleCommentAttachmentRefs } from "@/lib/comment-rendering";
import type { TaskRecord } from "@/lib/types";
import type { PublicAttachmentRecord } from "@/components/task-attachments";

type ConsumerId = symbol;
type AttachmentCache = {
  taskId: string;
  epoch: string;
  loaded: Set<string>;
  records: Map<string, PublicAttachmentRecord>;
};
type MetadataContextValue = {
  cache: AttachmentCache;
  epoch: string;
  register: (id: ConsumerId, refs: string[]) => () => void;
  taskId: string;
};

const CommentAttachmentMetadataContext = createContext<MetadataContextValue | null>(null);
const attachmentChangedEvent = "task-manager:attachment-changed";
const automaticRetryDelayMs = 750;

export function CommentAttachmentMetadataProvider({
  task,
  children,
}: {
  task: Pick<TaskRecord, "id" | "attachmentInvalidationCursor">;
  children: React.ReactNode;
}) {
  const consumers = useRef(new Map<ConsumerId, string[]>());
  const requestCache = useRef<AttachmentCache>({
    taskId: task.id,
    epoch: "",
    loaded: new Set(),
    records: new Map(),
  });
  const [cache, setCache] = useState<AttachmentCache>(() => ({
    taskId: task.id,
    epoch: "",
    loaded: new Set(),
    records: new Map(),
  }));
  const [visibleRefs, setVisibleRefs] = useState<string[]>([]);
  const [localInvalidation, setLocalInvalidation] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState<{ key: string; refs: string[] } | null>(null);
  const retryTimer = useRef<number | null>(null);
  const automaticRetry = useRef({ key: "", attempts: 0 });
  const activeRequest = useRef<symbol | null>(null);
  const epoch = `${task.attachmentInvalidationCursor ?? "initial"}:${localInvalidation}`;

  const refreshVisibleRefs = useCallback(() => {
    const next = mergeCommentAttachmentRefs(consumers.current.values());
    setVisibleRefs((current) => arraysEqual(current, next) ? current : next);
  }, []);

  const register = useCallback((id: ConsumerId, refs: string[]) => {
    consumers.current.set(id, refs);
    refreshVisibleRefs();
    return () => {
      consumers.current.delete(id);
      refreshVisibleRefs();
    };
  }, [refreshVisibleRefs]);

  useEffect(() => {
    function handleAttachmentChange(event: Event) {
      const changedTaskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (changedTaskId === task.id) setLocalInvalidation((current) => current + 1);
    }
    window.addEventListener(attachmentChangedEvent, handleAttachmentChange);
    return () => window.removeEventListener(attachmentChangedEvent, handleAttachmentChange);
  }, [task.id]);

  const requestKey = `${task.id}:${epoch}:${visibleRefs.join(",")}`;
  const retryFailed = useCallback(() => {
    if (activeRequest.current) return;
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
    setRetrying(true);
    setRetryNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    let currentCache = requestCache.current;
    if (currentCache.taskId !== task.id || currentCache.epoch !== epoch) {
      const retainedRecords = currentCache.taskId === task.id
        ? currentCache.records
        : new Map<string, PublicAttachmentRecord>();
      currentCache = {
        taskId: task.id,
        epoch,
        loaded: new Set(),
        records: new Map(retainedRecords),
      };
      requestCache.current = currentCache;
    }
    const visible = new Set(visibleRefs);
    for (const ref of currentCache.loaded) {
      if (!visible.has(ref)) currentCache.loaded.delete(ref);
    }
    for (const ref of currentCache.records.keys()) {
      if (!visible.has(ref)) currentCache.records.delete(ref);
    }
    if (!visibleRefs.length) return;
    const requestedRefs = visibleRefs.filter((ref) => !currentCache.loaded.has(ref));
    if (!requestedRefs.length) return;
    const controller = new AbortController();
    const requestToken = Symbol("comment-attachment-request");
    activeRequest.current = requestToken;
    void loadCommentAttachmentMetadata({
      refs: requestedRefs,
      loadChunk: async (chunk) => {
        const searchParams = new URLSearchParams();
        for (const ref of chunk) searchParams.append("refs", ref);
        const response = await fetch(
          `/api/tasks/${encodeURIComponent(task.id)}/attachments?${searchParams}`,
          { cache: "no-store", signal: controller.signal },
        );
        const value = await response.json() as
          | { attachments: PublicAttachmentRecord[] }
          | { error?: string };
        if (!response.ok || !("attachments" in value)) {
          throw new Error("Comment attachments could not be loaded");
        }
        return value.attachments;
      },
    }).then((result) => {
      if (controller.signal.aborted || requestCache.current !== currentCache) return;
      const reconciled = applyCommentAttachmentMetadataResult(currentCache, result);
      currentCache.loaded = reconciled.loaded;
      currentCache.records = reconciled.records;
      setCache(cloneAttachmentCache(currentCache));
      if (result.failedRefs.length) {
        setFailure({ key: requestKey, refs: result.failedRefs });
        if (automaticRetry.current.key !== requestKey) {
          automaticRetry.current = { key: requestKey, attempts: 0 };
        }
        if (automaticRetry.current.attempts < 1) {
          automaticRetry.current.attempts += 1;
          retryTimer.current = window.setTimeout(() => {
            retryTimer.current = null;
            setRetrying(true);
            setRetryNonce((current) => current + 1);
          }, automaticRetryDelayMs);
        }
      } else {
        setFailure((current) => current?.key === requestKey ? null : current);
      }
    }).finally(() => {
      if (activeRequest.current === requestToken) {
        activeRequest.current = null;
        setRetrying(false);
      }
    });
    return () => {
      controller.abort();
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      if (activeRequest.current === requestToken) activeRequest.current = null;
    };
  }, [epoch, requestKey, retryNonce, task.id, visibleRefs]);

  const value = useMemo(() => ({ cache, epoch, register, taskId: task.id }), [cache, epoch, register, task.id]);
  return (
    <CommentAttachmentMetadataContext.Provider value={value}>
      {children}
      {failure?.key === requestKey && <div className="comment-error" role="alert">
        <span>Some comment attachments could not be loaded.</span>
        <button type="button" disabled={retrying} onClick={retryFailed}>
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>}
    </CommentAttachmentMetadataContext.Provider>
  );
}

export function useCommentAttachmentMetadata(
  body: string,
): Map<string, PublicAttachmentRecord> | null {
  const context = useContext(CommentAttachmentMetadataContext);
  const register = context?.register;
  const consumerId = useRef(Symbol("comment-attachment-consumer"));
  const refs = useMemo(() => visibleCommentAttachmentRefs(body), [body]);
  const refKey = refs.join(",");

  useEffect(() => {
    if (!register || refs.length === 0) return;
    return register(consumerId.current, refs);
  }, [refKey, refs, register]);

  if (!refs.length) return new Map();
  if (
    !context ||
    context.cache.taskId !== context.taskId ||
    refs.some((ref) => !context.cache.loaded.has(ref) && !context.cache.records.has(ref))
  ) return null;
  return new Map(refs.flatMap((ref) => {
    const attachment = context.cache.records.get(ref);
    return attachment ? [[ref, attachment] as const] : [];
  }));
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneAttachmentCache(cache: AttachmentCache): AttachmentCache {
  return {
    taskId: cache.taskId,
    epoch: cache.epoch,
    loaded: new Set(cache.loaded),
    records: new Map(cache.records),
  };
}
