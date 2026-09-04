"use client";

import {
priorityMeta,
type TaskCreateDefaults
} from "@/components/task-tracker-state";
import {
canEditContent,
} from "@/lib/access";
import {
bindStoredFileToTask,
deleteStoredFile,
getStoredFile,
startStoredFileUpload,
type PublicStoredFileRecord,
} from "@/lib/staged-file-upload";
import type {
AppSnapshot,
LabelRecord,
Priority,
TaskRecord
} from "@/lib/types";
import {
ArrowDownWideNarrow,
CircleDot,
FolderKanban,
Paperclip,
Rocket,
UsersRound,
X
} from "lucide-react";
import {
FormEvent,
KeyboardEvent as ReactKeyboardEvent,
useEffect,
useRef,
useState
} from "react";

import {
Modal,
confirmReleasedCompositionChange
} from "@/components/task-tracker-dialogs";

import {
LabelPicker,
PropertySelect,
toggleLabelSelection,
} from "@/components/task-tracker-task-primitives";
import { taskAssigneeOptions } from "@/components/task-tracker-task-surfaces";

export type ComposerAttachment = {
  id: string;
  uploadKey: string;
  bindKey: string;
  file: File | null;
  fileRef: string | null;
  fileVersion: number | null;
  filename: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string | null;
  readyExpiresAt: string | null;
  progress: number;
  status: "uploading" | "staged" | "binding" | "failed" | "canceled" | "complete";
  failedPhase: "upload" | "bind" | "delete" | null;
  error: string | null;
};

export type ComposerRecoveryState = {
  version: 1;
  createdTask: { id: string; identifier: string } | null;
  files: Array<{
    id: string;
    uploadKey: string;
    bindKey: string;
    fileRef: string;
    fileVersion: number;
    filename: string;
    mediaType: string;
    byteSize: number;
    checksumSha256: string;
    readyExpiresAt: string | null;
  }>;
};

export function TaskComposer({ data, contextProject, contextRelease, defaults, onClose, onSubmit, busy }: { data: AppSnapshot; contextProject: string | null; contextRelease: string | null; defaults: TaskCreateDefaults; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<TaskRecord | null>; busy: boolean }) {
  const editableProjects = data.projects.filter(
    (project) => !project.archivedAt && canEditContent(project.accessRole),
  );
  const initialReleaseId = defaults.releaseId !== undefined
    ? defaults.releaseId ?? ""
    : contextRelease ?? "";
  const releaseProjectId = initialReleaseId
    ? data.releases.find((release) => release.id === initialReleaseId)?.projectId
    : undefined;
  const initialProjectId = defaults.projectId !== undefined
    ? defaults.projectId ?? ""
    : contextProject ?? releaseProjectId ?? "";
  const [projectId, setProjectId] = useState(initialProjectId);
  const ownerId = data.projects.find((project) => project.id === projectId)?.ownerUserId ?? data.user.id;
  const statuses = data.statuses.filter(
    (status) => status.ownerUserId === ownerId && !status.archivedAt,
  );
  const [statusId, setStatusId] = useState(defaults.statusId && statuses.some((status) => status.id === defaults.statusId) ? defaults.statusId : statuses.find((status) => status.isDefault)?.id ?? statuses[0]?.id ?? "");
  const [releaseId, setReleaseId] = useState(initialReleaseId);
  const [priority, setPriority] = useState<Priority>(defaults.priority ?? "none");
  const [assigneeUserId, setAssigneeUserId] = useState(
    defaults.assigneeUserId !== undefined
      ? defaults.assigneeUserId ?? ""
      : data.user.id,
  );
  const assignees = taskAssigneeOptions(data, projectId || null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [labelCatalog, setLabelCatalog] = useState<LabelRecord[]>(
    data.labels.filter((label) => label.ownerUserId === ownerId && !label.archivedAt),
  );
  const [selectedLabelIds, setSelectedLabelIds] = useState<Set<string>>(
    new Set(defaults.labelId ? [defaults.labelId] : []),
  );
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [createdTask, setCreatedTask] = useState<{ id: string; identifier: string } | null>(null);
  const [recoveryHydrated, setRecoveryHydrated] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeUploads = useRef(new Map<string, () => void>());
  const recoveryKey = `tm:task-composer-staged:${data.user.id}`;

  useEffect(() => () => {
    for (const cancel of activeUploads.current.values()) cancel();
    activeUploads.current.clear();
  }, []);

  useEffect(() => {
    let stopped = false;
    const timer = window.setTimeout(() => {
      const saved = readComposerRecoveryState(window.localStorage.getItem(recoveryKey));
      if (!saved) {
        setRecoveryHydrated(true);
        return;
      }
      setCreatedTask(saved.createdTask);
      void Promise.all(saved.files.map(async (file) => {
        try {
          const current = await getStoredFile(file.fileRef);
          return recoveredComposerAttachment(file, current);
        } catch {
          return null;
        }
      })).then((files) => {
        if (stopped) return;
        setAttachments(files.filter((file): file is ComposerAttachment => file !== null));
        setRecoveryHydrated(true);
      });
    }, 0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [recoveryKey]);

  useEffect(() => {
    if (!recoveryHydrated) return;
    const files = attachments.flatMap((attachment) =>
      attachment.fileRef && attachment.fileVersion && attachment.checksumSha256 && attachment.status !== "complete"
        ? [{
            id: attachment.id,
            uploadKey: attachment.uploadKey,
            bindKey: attachment.bindKey,
            fileRef: attachment.fileRef,
            fileVersion: attachment.fileVersion,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            byteSize: attachment.byteSize,
            checksumSha256: attachment.checksumSha256,
            readyExpiresAt: attachment.readyExpiresAt,
          }]
        : [],
    );
    if (!createdTask && files.length === 0) {
      window.localStorage.removeItem(recoveryKey);
      return;
    }
    const state: ComposerRecoveryState = { version: 1, createdTask, files };
    window.localStorage.setItem(recoveryKey, JSON.stringify(state));
  }, [attachments, createdTask, recoveryHydrated, recoveryKey]);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void fetch(`/api/labels?projectId=${encodeURIComponent(projectId)}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const value = await response.json() as { labels?: LabelRecord[]; error?: string };
      if (!response.ok || !value.labels) throw new Error(value.error ?? "Labels could not be loaded");
      setLabelCatalog(value.labels);
      setSelectedLabelIds((current) => new Set(
        [...current].filter((id) => value.labels!.some((label) => label.id === id)),
      ));
    }).catch((requestError: unknown) => {
      if (!(requestError instanceof DOMException && requestError.name === "AbortError")) {
        setComposerError(requestError instanceof Error ? requestError.message : "Labels could not be loaded");
      }
    });
    return () => controller.abort();
  }, [projectId]);

  function patchAttachment(id: string, patch: Partial<ComposerAttachment>) {
    setAttachments((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function addFiles(files: FileList | File[]) {
    if (createdTask) return;
    const additions = Array.from(files).map((file) => {
      const id = crypto.randomUUID();
      return {
        id,
        uploadKey: `task-composer-file:${id}`,
        bindKey: `task-composer-bind:${id}`,
        file,
        fileRef: null,
        fileVersion: null,
        filename: file.name,
        mediaType: file.type || "application/octet-stream",
        byteSize: file.size,
        checksumSha256: null,
        readyExpiresAt: null,
        progress: 0,
        status: "uploading" as const,
        failedPhase: null,
        error: null,
      };
    });
    setAttachments((current) => [...current, ...additions]);
    for (const attachment of additions) void stageOne(attachment);
  }

  async function stageOne(attachment: ComposerAttachment) {
    if (!attachment.file) {
      patchAttachment(attachment.id, {
        status: "failed",
        failedPhase: "upload",
        error: "Choose the local file again to retry this upload.",
      });
      return null;
    }
    patchAttachment(attachment.id, {
      status: "uploading",
      failedPhase: null,
      progress: 0,
      error: null,
    });
    const running = startStoredFileUpload(
      attachment.file,
      attachment.uploadKey,
      (progress) => patchAttachment(attachment.id, { progress }),
    );
    activeUploads.current.set(attachment.id, running.cancel);
    try {
      const stored = await running.promise;
      patchAttachment(attachment.id, {
        fileRef: stored.ref,
        fileVersion: stored.version,
        filename: stored.filename,
        mediaType: stored.mediaType,
        byteSize: stored.byteSize,
        checksumSha256: stored.checksumSha256,
        readyExpiresAt: stored.readyExpiresAt,
        status: "staged",
        failedPhase: null,
        progress: 100,
        error: null,
      });
      return stored;
    } catch (requestError) {
      const canceled = requestError instanceof DOMException && requestError.name === "AbortError";
      patchAttachment(attachment.id, {
        status: canceled ? "canceled" : "failed",
        failedPhase: "upload",
        error: canceled
          ? "Upload canceled"
          : requestError instanceof Error
            ? requestError.message
            : "Upload failed",
      });
      return null;
    } finally {
      activeUploads.current.delete(attachment.id);
    }
  }

  async function bindOne(
    task: { id: string; identifier: string },
    attachment: ComposerAttachment,
  ) {
    if (!attachment.fileRef) return false;
    patchAttachment(attachment.id, {
      status: "binding",
      failedPhase: null,
      progress: 100,
      error: null,
    });
    const controller = new AbortController();
    activeUploads.current.set(attachment.id, () => controller.abort());
    try {
      await bindStoredFileToTask(
        task.id,
        attachment.fileRef,
        attachment.bindKey,
        controller.signal,
      );
      patchAttachment(attachment.id, {
        status: "complete",
        failedPhase: null,
        error: null,
      });
      return true;
    } catch (requestError) {
      const canceled = requestError instanceof DOMException && requestError.name === "AbortError";
      patchAttachment(attachment.id, {
        status: canceled ? "canceled" : "failed",
        failedPhase: "bind",
        error: `${task.identifier}: ${canceled
          ? "binding canceled"
          : requestError instanceof Error ? requestError.message : "binding failed"}`,
      });
      return false;
    } finally {
      activeUploads.current.delete(attachment.id);
    }
  }

  async function retryAttachment(attachment: ComposerAttachment) {
    if (attachment.failedPhase === "delete") {
      await removeAttachment(attachment);
      return;
    }
    if (attachment.fileRef) {
      if (createdTask) await bindOne(createdTask, attachment);
      else patchAttachment(attachment.id, { status: "staged", failedPhase: null, error: null });
      return;
    }
    await stageOne(attachment);
  }

  async function removeAttachment(attachment: ComposerAttachment) {
    activeUploads.current.get(attachment.id)?.();
    if (!attachment.fileRef) {
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      return;
    }
    try {
      await deleteStoredFile(attachment.fileRef, attachment.fileVersion ?? 0);
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    } catch (requestError) {
      patchAttachment(attachment.id, {
        status: "failed",
        failedPhase: "delete",
        error: requestError instanceof Error ? requestError.message : "Staged file could not be deleted",
      });
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if ((!createdTask && (!title.trim() || !projectId)) || busy) return;
    setComposerError("");
    const selectedRelease = data.releases.find((release) => release.id === releaseId);
    const confirmReleasedComposition = !createdTask && selectedRelease?.status === "released";
    if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return;
    let bindCandidates = [...attachments];
    let stagingFailed = 0;
    for (const attachment of bindCandidates.filter((item) => !item.fileRef && item.status !== "complete")) {
      const stored = await stageOne(attachment);
      if (!stored) {
        stagingFailed += 1;
        continue;
      }
      bindCandidates = bindCandidates.map((item) => item.id === attachment.id
        ? composerAttachmentWithStoredFile(item, stored)
        : item);
    }
    if (stagingFailed > 0) {
      setComposerError(`${stagingFailed} file${stagingFailed === 1 ? "" : "s"} could not be staged. Retry or remove them before creating the Task.`);
      return;
    }
    const task = createdTask ?? await onSubmit({
      title,
      description,
      projectId,
      releaseId: releaseId || null,
      statusId,
      priority,
      assigneeUserId: assigneeUserId || null,
      labelIds: [...selectedLabelIds],
      ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}),
    });
    if (!task) {
      setComposerError("Task was not created. Staged files are still available for retry or deletion until their TTL expires.");
      return;
    }
    const taskIdentity = { id: task.id, identifier: task.identifier };
    setCreatedTask(taskIdentity);
    const pending = bindCandidates.filter((item) => item.status !== "complete");
    let failed = 0;
    for (const attachment of pending) {
      if (!(await bindOne(taskIdentity, attachment))) failed += 1;
    }
    if (failed === 0) {
      window.localStorage.removeItem(recoveryKey);
      onClose();
    } else {
      setComposerError(`${task.identifier} was created, but ${failed} staged file${failed === 1 ? "" : "s"} failed to bind. Each file remains available for a stable-key retry.`);
    }
  }

  function closeComposer() {
    for (const cancel of activeUploads.current.values()) cancel();
    onClose();
  }

  const pendingCount = attachments.filter((item) => item.status !== "complete").length;
  const fileWorkActive = attachments.some((item) => item.status === "uploading" || item.status === "binding");
  return (
    <Modal onClose={closeComposer} className="composer-modal">
      <form onSubmit={submit}>
        <div className="modal-title-row">
          <span className="muted">{createdTask ? `${createdTask.identifier} created` : "New task"}</span>
          <button type="button" className="icon-button" onClick={closeComposer}><X size={15} /></button>
        </div>
        <fieldset className="composer-fields" disabled={Boolean(createdTask)}>
          <input className="composer-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" autoFocus />
          <textarea className="composer-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add description…" rows={4} onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(); }} />
          <div className="property-bar">
            <PropertySelect icon={<CircleDot size={13} />} value={statusId} onChange={setStatusId}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</PropertySelect>
            <PropertySelect icon={<ArrowDownWideNarrow size={13} />} value={priority} onChange={(value) => setPriority(value as Priority)}>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</PropertySelect>
            <PropertySelect icon={<UsersRound size={13} />} value={assigneeUserId} onChange={setAssigneeUserId}><option value="">No assignee</option>{assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}</PropertySelect>
            <PropertySelect icon={<FolderKanban size={13} />} value={projectId} onChange={(value) => { setProjectId(value); setReleaseId(""); setSelectedLabelIds(new Set()); const nextOwner = data.projects.find((project) => project.id === value)?.ownerUserId ?? data.user.id; const nextAssignees = taskAssigneeOptions(data, value || null); setAssigneeUserId((current) => current === "" || nextAssignees.some((assignee) => assignee.id === current) ? current : data.user.id); setStatusId(data.statuses.find((status) => status.ownerUserId === nextOwner && status.isDefault)?.id ?? data.statuses.find((status) => status.ownerUserId === nextOwner)?.id ?? ""); }}><option value="" disabled>Select project</option>{editableProjects.map((project) => <option key={project.id} value={project.id}>{project.taskCode} · {project.name}</option>)}</PropertySelect>
            <PropertySelect icon={<Rocket size={13} />} value={releaseId} onChange={setReleaseId} disabled={!projectId}><option value="">No release</option>{data.releases.filter((release) => release.projectId === projectId && canEditContent(release.accessRole)).map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</PropertySelect>
          </div>
          <LabelPicker labels={labelCatalog} selected={selectedLabelIds} onToggle={(labelId) => setSelectedLabelIds((current) => toggleLabelSelection(current, labelId, labelCatalog))} disabled={Boolean(createdTask)} label="Task labels" />
        </fieldset>
        {!editableProjects.length && <p className="inline-note">Create an editable Project before adding a Task.</p>}
        <section
          className={`composer-attachments ${dragActive ? "drag-active" : ""}`}
          aria-label="Task attachments"
          onDragEnter={(event) => { if (!createdTask) { event.preventDefault(); setDragActive(true); } }}
          onDragOver={(event) => { if (!createdTask) event.preventDefault(); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
          onDrop={(event) => { if (createdTask) return; event.preventDefault(); setDragActive(false); addFiles(event.dataTransfer.files); }}
          onPaste={(event) => { if (createdTask || !event.clipboardData.files.length) return; event.preventDefault(); addFiles(event.clipboardData.files); }}
        >
          <div>
            <button className="button ghost" type="button" disabled={Boolean(createdTask)} onClick={() => fileInputRef.current?.click()}><Paperclip size={14} />Add files</button>
            <span>{attachments.length ? `${attachments.length} file${attachments.length === 1 ? "" : "s"} · staged before Task creation` : "Files are staged before Task creation"}</span>
          </div>
          <input ref={fileInputRef} className="visually-hidden" type="file" multiple aria-label="Choose files for the new task" disabled={Boolean(createdTask)} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
          {attachments.length > 0 && (
            <div className="composer-attachment-list" aria-live="polite">
              {attachments.map((attachment) => (
                <article key={attachment.id} data-upload-state={attachment.status}>
                  <FileAttachmentIcon filename={attachment.filename} />
                  <div>
                    <b title={attachment.filename}>{attachment.filename}</b>
                    <small>{composerAttachmentStatus(attachment)}</small>
                    {attachment.status === "uploading" && <progress value={attachment.progress} max="100" aria-label={`Upload progress for ${attachment.filename}`} />}
                  </div>
                  <div className="composer-attachment-actions">
                    {(attachment.status === "uploading" || attachment.status === "binding") && <button className="icon-button" type="button" aria-label={`Cancel ${attachment.filename}`} onClick={() => activeUploads.current.get(attachment.id)?.()}><X size={14} /></button>}
                    {(attachment.status === "failed" || attachment.status === "canceled") && <button className="icon-button" type="button" aria-label={`Retry ${attachment.filename}`} onClick={() => void retryAttachment(attachment)}><RotateComposerIcon /></button>}
                    {attachment.status !== "complete" && attachment.status !== "uploading" && attachment.status !== "binding" && <button className="icon-button" type="button" aria-label={`Delete staged ${attachment.filename}`} onClick={() => void removeAttachment(attachment)}><X size={14} /></button>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        {composerError && <p className="composer-upload-error" role="alert">{composerError}</p>}
        <div className="modal-footer">
          <span className="shortcut-hint">{createdTask ? "Unbound staged files remain recoverable until their TTL expires." : <><kbd>⌘</kbd><kbd>Enter</kbd> to create</>}</span>
          <button className="button primary" disabled={busy || (!createdTask && (!title.trim() || !projectId)) || fileWorkActive || !recoveryHydrated}>{busy || fileWorkActive ? "Working…" : createdTask ? pendingCount ? `Retry ${pendingCount} file${pendingCount === 1 ? "" : "s"}` : "Done" : attachments.length ? "Create and attach" : "Create task"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function composerAttachmentWithStoredFile(
  attachment: ComposerAttachment,
  stored: PublicStoredFileRecord,
): ComposerAttachment {
  return {
    ...attachment,
    fileRef: stored.ref,
    fileVersion: stored.version,
    filename: stored.filename,
    mediaType: stored.mediaType,
    byteSize: stored.byteSize,
    checksumSha256: stored.checksumSha256,
    readyExpiresAt: stored.readyExpiresAt,
    progress: 100,
    status: "staged",
    failedPhase: null,
    error: null,
  };
}

export function recoveredComposerAttachment(
  saved: ComposerRecoveryState["files"][number],
  stored: PublicStoredFileRecord,
): ComposerAttachment {
  return composerAttachmentWithStoredFile({
    id: saved.id,
    uploadKey: saved.uploadKey,
    bindKey: saved.bindKey,
    file: null,
    fileRef: saved.fileRef,
    fileVersion: saved.fileVersion,
    filename: saved.filename,
    mediaType: saved.mediaType,
    byteSize: saved.byteSize,
    checksumSha256: saved.checksumSha256,
    readyExpiresAt: saved.readyExpiresAt,
    progress: 100,
    status: "staged",
    failedPhase: null,
    error: null,
  }, stored);
}

export function readComposerRecoveryState(value: string | null): ComposerRecoveryState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ComposerRecoveryState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) return null;
    const createdTask = parsed.createdTask &&
      typeof parsed.createdTask.id === "string" &&
      typeof parsed.createdTask.identifier === "string"
      ? { id: parsed.createdTask.id, identifier: parsed.createdTask.identifier }
      : null;
    const files = parsed.files.filter((file) =>
      file &&
      typeof file.id === "string" &&
      typeof file.uploadKey === "string" &&
      typeof file.bindKey === "string" &&
      typeof file.fileRef === "string" &&
      Number.isSafeInteger(file.fileVersion) &&
      typeof file.filename === "string" &&
      typeof file.mediaType === "string" &&
      Number.isSafeInteger(file.byteSize) &&
      typeof file.checksumSha256 === "string" &&
      (file.readyExpiresAt === null || typeof file.readyExpiresAt === "string"),
    );
    return { version: 1, createdTask, files };
  } catch {
    return null;
  }
}

export function composerAttachmentStatus(attachment: ComposerAttachment) {
  if (attachment.status === "uploading") return `${attachment.progress}% uploaded to staging`;
  if (attachment.status === "staged") return `Staged · ${formatComposerBytes(attachment.byteSize)} · ready to attach`;
  if (attachment.status === "binding") return "Attaching to Task…";
  if (attachment.status === "complete") return "Attached";
  return attachment.error ?? (attachment.status === "canceled" ? "Canceled" : "Failed");
}

export function formatComposerBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

export function FileAttachmentIcon({ filename }: { filename: string }) {
  return <span className="composer-attachment-icon" aria-hidden="true">{filename.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE"}</span>;
}

export function RotateComposerIcon() {
  return <span aria-hidden="true">↻</span>;
}
