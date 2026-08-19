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
  const epoch = `${task.attachmentInvalidationCursor ?? "initial"}:${localInvalidation}`;

  const refreshVisibleRefs = useCallback(() => {
    const next = [...new Set([...consumers.current.values()].flat())].sort();
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

  useEffect(() => {
    let currentCache = requestCache.current;
    if (currentCache.taskId !== task.id || currentCache.epoch !== epoch) {
      currentCache = {
        taskId: task.id,
        epoch,
        loaded: new Set(),
        records: new Map(),
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
    const searchParams = new URLSearchParams();
    for (const ref of requestedRefs) searchParams.append("refs", ref);
    void fetch(`/api/tasks/${encodeURIComponent(task.id)}/attachments?${searchParams}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await response.json() as
          | { attachments: PublicAttachmentRecord[] }
          | { error?: string };
        if (!response.ok || !("attachments" in value)) {
          throw new Error("Comment attachments could not be loaded");
        }
        if (requestCache.current !== currentCache) return;
        for (const ref of requestedRefs) currentCache.loaded.add(ref);
        for (const attachment of value.attachments) {
          currentCache.records.set(attachment.ref, attachment);
        }
        setCache(cloneAttachmentCache(currentCache));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (requestCache.current !== currentCache) return;
        for (const ref of requestedRefs) {
          currentCache.loaded.add(ref);
          currentCache.records.delete(ref);
        }
        setCache(cloneAttachmentCache(currentCache));
      });
    return () => controller.abort();
  }, [epoch, task.id, visibleRefs]);

  const value = useMemo(() => ({ cache, epoch, register, taskId: task.id }), [cache, epoch, register, task.id]);
  return (
    <CommentAttachmentMetadataContext.Provider value={value}>
      {children}
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
    context.cache.epoch !== context.epoch ||
    refs.some((ref) => !context.cache.loaded.has(ref))
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
