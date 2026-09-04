"use client";

import type {
LabelGroupRecord,
LabelRecord,
StatusCategory,
WorkflowStatusRecord
} from "@/lib/types";
import {
Archive,
ArchiveRestore,
ArrowDown,
ArrowUp,
Plus,
SlidersHorizontal,
Tag
} from "lucide-react";
import {
FormEvent,
useCallback,
useEffect,
useRef,
useState
} from "react";

import { DialogHeader,Modal } from "@/components/task-tracker-dialog-primitives";

export type WorkflowSettingsStatus = WorkflowStatusRecord & {
  taskCount: number;
  savedViewCount: number;
};

export const workflowCategoryLabels: Record<StatusCategory, string> = {
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  completed: "Completed",
  canceled: "Canceled",
};

export function WorkflowSettingsDialog({
  initialStatuses,
  onClose,
  onStatuses,
  embedded = false,
}: {
  initialStatuses: WorkflowStatusRecord[];
  onClose: () => void;
  onStatuses: (statuses: WorkflowStatusRecord[]) => void;
  embedded?: boolean;
}) {
  const [statuses, setStatuses] = useState<WorkflowSettingsStatus[]>(
    initialStatuses.map((status) => ({ ...status, taskCount: 0, savedViewCount: 0 })),
  );
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  const onStatusesRef = useRef(onStatuses);

  useEffect(() => {
    onStatusesRef.current = onStatuses;
  }, [onStatuses]);

  const apply = useCallback((next: WorkflowSettingsStatus[]) => {
    setStatuses(next);
    onStatusesRef.current(next);
  }, []);

  const request = useCallback(async (
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    actionId: string,
  ) => {
    setBusyId(actionId);
    setError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json() as { statuses?: WorkflowSettingsStatus[]; error?: string };
      if (!response.ok || !value.statuses) {
        if (response.status === 409) {
          const refreshedResponse = await fetch("/api/settings/workflow-statuses", { cache: "no-store" });
          const refreshed = await refreshedResponse.json() as { statuses?: WorkflowSettingsStatus[] };
          if (refreshedResponse.ok && refreshed.statuses) apply(refreshed.statuses);
        }
        throw new Error(value.error ?? "Workflow status could not be saved");
      }
      apply(value.statuses);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Workflow status could not be saved");
      return false;
    } finally {
      setBusyId(null);
    }
  }, [apply]);

  useEffect(() => {
    let current = true;
    void fetch("/api/settings/workflow-statuses", { cache: "no-store" })
      .then(async (response) => {
        const value = await response.json() as { statuses?: WorkflowSettingsStatus[]; error?: string };
        if (!response.ok || !value.statuses) throw new Error(value.error ?? "Workflow statuses could not be loaded");
        if (current) apply(value.statuses);
      })
      .catch((requestError: unknown) => {
        if (current) setError(requestError instanceof Error ? requestError.message : "Workflow statuses could not be loaded");
      })
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [apply]);

  const active = statuses.filter((status) => !status.archivedAt);
  const archived = statuses.filter((status) => status.archivedAt);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (await request("/api/settings/workflow-statuses", "POST", values, "create")) form.reset();
  }

  function renderStatus(status: WorkflowSettingsStatus) {
    const categoryPeers = active.filter((candidate) =>
      candidate.category === status.category && candidate.id !== status.id,
    );
    const peerIndex = active.filter((candidate) => candidate.category === status.category)
      .sort((left, right) => left.position - right.position)
      .findIndex((candidate) => candidate.id === status.id);
    const orderedPeers = active.filter((candidate) => candidate.category === status.category)
      .sort((left, right) => left.position - right.position);
    const replacementRequired = status.isDefault || status.taskCount > 0 || status.savedViewCount > 0;
    const replacementId = replacements[status.id] ?? categoryPeers[0]?.id ?? "";
    return (
      <article className={`workflow-status-row ${status.archivedAt ? "archived" : ""}`} key={`${status.id}:${status.version}`}>
        <form onSubmit={(event) => {
          event.preventDefault();
          const values = Object.fromEntries(new FormData(event.currentTarget));
          void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", {
            action: "update",
            version: status.version,
            name: values.name,
            color: values.color,
          }, status.id);
        }}>
          <input className="workflow-color" type="color" name="color" defaultValue={status.color} aria-label={`Color for ${status.name}`} disabled={Boolean(status.archivedAt) || busyId !== null} />
          <span className="workflow-status-main">
            <input name="name" defaultValue={status.name} aria-label={`Name for ${status.name}`} disabled={Boolean(status.archivedAt) || status.systemRole === "duplicate" || busyId !== null} />
            <small>{workflowCategoryLabels[status.category]} · {status.taskCount} task{status.taskCount === 1 ? "" : "s"}{status.savedViewCount ? ` · ${status.savedViewCount} view${status.savedViewCount === 1 ? "" : "s"}` : ""}</small>
          </span>
          {!status.archivedAt && <button className="button ghost compact" disabled={busyId !== null} type="submit">Save</button>}
        </form>
        <div className="workflow-status-actions">
          {!status.archivedAt && <>
            <button className="icon-button" type="button" title="Move up" aria-label={`Move ${status.name} up`} disabled={busyId !== null || peerIndex <= 0} onClick={() => {
              const peer = orderedPeers[peerIndex - 1];
              if (peer) void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "move", direction: "up", version: status.version, peerVersion: peer.version }, status.id);
            }}><ArrowUp size={14} /></button>
            <button className="icon-button" type="button" title="Move down" aria-label={`Move ${status.name} down`} disabled={busyId !== null || peerIndex < 0 || peerIndex >= orderedPeers.length - 1} onClick={() => {
              const peer = orderedPeers[peerIndex + 1];
              if (peer) void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "move", direction: "down", version: status.version, peerVersion: peer.version }, status.id);
            }}><ArrowDown size={14} /></button>
            {status.isDefault ? <span className="workflow-default">Default</span> : (["backlog", "unstarted"] as StatusCategory[]).includes(status.category) && <button className="button ghost compact" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "update", version: status.version, isDefault: true }, status.id)}>Make default</button>}
            {status.systemRole === "duplicate" ? <span className="workflow-reserved">Reserved</span> : <>
              {replacementRequired && <select aria-label={`Replacement for ${status.name}`} value={replacementId} disabled={busyId !== null} onChange={(event) => setReplacements((current) => ({ ...current, [status.id]: event.target.value }))}><option value="" disabled>Replacement…</option>{categoryPeers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select>}
              <button className="button ghost compact danger" type="button" disabled={busyId !== null || categoryPeers.length === 0 || (replacementRequired && !replacementId)} onClick={() => void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "archive", version: status.version, replacementStatusId: replacementId || undefined }, status.id)}><Archive size={13} />Archive</button>
            </>}
          </>}
          {status.archivedAt && <button className="button ghost compact" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "restore", version: status.version }, status.id)}><ArchiveRestore size={13} />Restore</button>}
        </div>
      </article>
    );
  }

  const body = <>
      {!embedded && <DialogHeader title="Workflow statuses" icon={<SlidersHorizontal size={17} />} onClose={() => busyId === null && onClose()} />}
      <p className="dialog-copy">Statuses belong to your workflow. Their category is permanent because it controls task lifecycle timestamps.</p>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {loading ? <p className="dialog-copy">Loading workflow…</p> : <div className="workflow-status-list">{active.map(renderStatus)}</div>}
      <form className="workflow-status-create" onSubmit={create}>
        <input name="name" required maxLength={80} placeholder="New status" aria-label="New workflow status name" disabled={busyId !== null} />
        <select name="category" defaultValue="unstarted" aria-label="New workflow status category" disabled={busyId !== null}>{Object.entries(workflowCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <input className="workflow-color" type="color" name="color" defaultValue="#6b7280" aria-label="New workflow status color" disabled={busyId !== null} />
        <button className="button primary" disabled={busyId !== null}><Plus size={14} />Add</button>
      </form>
      {archived.length > 0 && <details className="workflow-archived"><summary>Archived statuses ({archived.length})</summary><div className="workflow-status-list">{archived.map(renderStatus)}</div></details>}
    </>;
  return embedded
    ? <section className="settings-catalog" aria-label="Workflow status settings">{body}</section>
    : <Modal onClose={() => busyId === null && onClose()} className="workflow-settings-modal" ariaLabel="Workflow status settings">{body}</Modal>;
}
export type LabelSettingsRecord = LabelRecord & { taskCount: number };
export type LabelGroupSettingsRecord = LabelGroupRecord & { taskCount: number; labelCount: number };

export function LabelGroupSettingsDialog({
  initialGroups,
  initialLabels,
  onClose,
  onGroups,
  onLabels,
}: {
  initialGroups: LabelGroupRecord[];
  initialLabels: LabelRecord[];
  onClose: () => void;
  onGroups: (groups: LabelGroupRecord[]) => void;
  onLabels: (labels: LabelRecord[]) => void;
}) {
  const [groups, setGroups] = useState<LabelGroupSettingsRecord[]>(
    initialGroups.map((group) => ({ ...group, taskCount: 0, labelCount: 0 })),
  );
  const [labels, setLabels] = useState<LabelRecord[]>(initialLabels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [groupResponse, labelResponse] = await Promise.all([
      fetch("/api/settings/label-groups", { cache: "no-store" }),
      fetch("/api/settings/labels", { cache: "no-store" }),
    ]);
    const groupValue = await groupResponse.json() as { labelGroups?: LabelGroupSettingsRecord[]; error?: string };
    const labelValue = await labelResponse.json() as { labels?: LabelSettingsRecord[]; error?: string };
    if (!groupResponse.ok || !groupValue.labelGroups) throw new Error(groupValue.error ?? "Label Groups could not be loaded");
    if (!labelResponse.ok || !labelValue.labels) throw new Error(labelValue.error ?? "Labels could not be loaded");
    setGroups(groupValue.labelGroups);
    setLabels(labelValue.labels);
    onGroups(groupValue.labelGroups);
    onLabels(labelValue.labels);
  }, [onGroups, onLabels]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Catalog could not be loaded"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function write(path: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "Catalog could not be saved");
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Catalog could not be saved");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const activeGroups = groups.filter((group) => !group.archivedAt);
  const archivedGroups = groups.filter((group) => group.archivedAt);
  const renderGroup = (group: LabelGroupSettingsRecord) => (
    <article className={`label-settings-row ${group.archivedAt ? "archived" : ""}`} key={`${group.id}:${group.version}`}>
      <form onSubmit={(event) => { event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget)); void write(`/api/settings/label-groups/${encodeURIComponent(group.id)}`, "PATCH", { action: "update", version: group.version, name: value.name, description: value.description, position: Number(value.position) }); }}>
        <span className="label-settings-main">
          <input name="name" defaultValue={group.name} disabled={busy || Boolean(group.archivedAt)} aria-label={`Name for ${group.name}`} />
          <input name="description" defaultValue={group.description} disabled={busy || Boolean(group.archivedAt)} placeholder="Usage guidance" />
          <input name="position" type="number" min="0" defaultValue={group.position} disabled={busy || Boolean(group.archivedAt)} aria-label={`Position for ${group.name}`} />
          <small>{group.labelCount} labels · {group.taskCount} tasks</small>
        </span>
        {!group.archivedAt && <button className="button ghost compact" disabled={busy}>Save</button>}
      </form>
      <div className="label-settings-actions">
        <button className={`button ghost compact ${group.archivedAt ? "" : "danger"}`} type="button" disabled={busy} onClick={() => void write(`/api/settings/label-groups/${encodeURIComponent(group.id)}`, "PATCH", { action: group.archivedAt ? "restore" : "archive", version: group.version })}>{group.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}{group.archivedAt ? "Restore" : "Archive"}</button>
      </div>
    </article>
  );

  return <Modal onClose={() => !busy && onClose()} className="workflow-settings-modal" ariaLabel="Label Group settings">
    <DialogHeader title="Label groups" icon={<Tag size={17} />} onClose={() => !busy && onClose()} />
    <p className="dialog-copy">Each Task can hold one value from a group. Ungrouped labels remain independently selectable.</p>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="label-settings-list">{activeGroups.map(renderGroup)}</div>
    <form className="label-settings-create" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const value = Object.fromEntries(new FormData(form)); if (await write("/api/settings/label-groups", "POST", value)) form.reset(); }}>
      <input name="name" required maxLength={80} placeholder="New label group" disabled={busy} />
      <input name="description" maxLength={2000} placeholder="Usage guidance" disabled={busy} />
      <button className="button primary" disabled={busy}><Plus size={14} />Add group</button>
    </form>
    <section className="details-section">
      <h2><Tag size={14} />Group membership</h2>
      <div className="label-settings-list">{labels.map((label) => <label className="property-row" key={`${label.id}:${label.version}`}><span><span className="label-color-dot" style={{ background: label.color }} />{label.name}</span><select value={label.groupId ?? ""} disabled={busy || Boolean(label.archivedAt)} onChange={(event) => void write(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "update", version: label.version, groupId: event.target.value || null })}><option value="">Ungrouped</option>{activeGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>)}</div>
    </section>
    {archivedGroups.length > 0 && <details className="workflow-archived"><summary>Archived groups ({archivedGroups.length})</summary><div className="label-settings-list">{archivedGroups.map(renderGroup)}</div></details>}
  </Modal>;
}

export function LabelSettingsDialog({
  onClose,
  onLabels,
  onGroups,
  embedded = false,
}: {
  onClose: () => void;
  onLabels: (labels: LabelRecord[]) => void;
  onGroups?: (groups: LabelGroupRecord[]) => void;
  embedded?: boolean;
}) {
  const [labels, setLabels] = useState<LabelSettingsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const onLabelsRef = useRef(onLabels);

  useEffect(() => { onLabelsRef.current = onLabels; }, [onLabels]);
  const apply = useCallback((next: LabelSettingsRecord[]) => {
    setLabels(next);
    onLabelsRef.current(next);
  }, []);
  const request = useCallback(async (
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    actionId: string,
  ) => {
    setBusyId(actionId);
    setError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json() as { labels?: LabelSettingsRecord[]; error?: string };
      if (!response.ok || !value.labels) {
        if (response.status === 409) {
          const refreshedResponse = await fetch("/api/settings/labels", { cache: "no-store" });
          const refreshed = await refreshedResponse.json() as { labels?: LabelSettingsRecord[] };
          if (refreshedResponse.ok && refreshed.labels) apply(refreshed.labels);
        }
        throw new Error(value.error ?? "Label could not be saved");
      }
      apply(value.labels);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Label could not be saved");
      return false;
    } finally {
      setBusyId(null);
    }
  }, [apply]);

  useEffect(() => {
    let current = true;
    void fetch("/api/settings/labels", { cache: "no-store" })
      .then(async (response) => {
        const value = await response.json() as { labels?: LabelSettingsRecord[]; error?: string };
        if (!response.ok || !value.labels) throw new Error(value.error ?? "Labels could not be loaded");
        if (current) apply(value.labels);
      })
      .catch((requestError: unknown) => {
        if (current) setError(requestError instanceof Error ? requestError.message : "Labels could not be loaded");
      })
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [apply]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    void onGroups;
    if (await request("/api/settings/labels", "POST", values, "create")) form.reset();
  }

  function row(label: LabelSettingsRecord) {
    return <article className={`label-settings-row ${label.archivedAt ? "archived" : ""}`} key={`${label.id}:${label.version}`}><form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void request(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "update", version: label.version, name: values.name, color: values.color, description: values.description }, label.id); }}><input className="workflow-color" type="color" name="color" defaultValue={label.color} aria-label={`Color for ${label.name}`} disabled={Boolean(label.archivedAt) || busyId !== null} /><span className="label-settings-main"><input name="name" defaultValue={label.name} aria-label={`Name for ${label.name}`} disabled={Boolean(label.archivedAt) || busyId !== null} /><input name="description" defaultValue={label.description} placeholder="Usage guidance" aria-label={`Description for ${label.name}`} disabled={Boolean(label.archivedAt) || busyId !== null} /><small>{label.taskCount} Task{label.taskCount === 1 ? "" : "s"}</small></span>{!label.archivedAt && <button className="button ghost compact" disabled={busyId !== null}>Save</button>}</form><div className="label-settings-actions">{label.archivedAt ? <button className="button ghost compact" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "restore", version: label.version }, label.id)}><ArchiveRestore size={13} />Restore</button> : <button className="button ghost compact danger" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "archive", version: label.version }, label.id)}><Archive size={13} />Archive</button>}</div></article>;
  }

  const active = labels.filter((label) => !label.archivedAt);
  const archived = labels.filter((label) => label.archivedAt);
  const body = <>{!embedded && <DialogHeader title="Labels" icon={<Tag size={17} />} onClose={() => busyId === null && onClose()} />}<p className="dialog-copy">Labels belong to your catalog. Archiving blocks new assignments while preserving existing Task history.</p>{error && <p className="dialog-error" role="alert">{error}</p>}{loading ? <p className="dialog-copy">Loading labels…</p> : <div className="label-settings-list">{active.map(row)}</div>}<form className="label-settings-create" onSubmit={create}><input className="workflow-color" type="color" name="color" defaultValue="#6b7280" aria-label="New Label color" disabled={busyId !== null} /><input name="name" required maxLength={80} placeholder="New label" aria-label="New Label name" disabled={busyId !== null} /><input name="description" maxLength={2000} placeholder="Usage guidance" aria-label="New Label description" disabled={busyId !== null} /><button className="button primary" disabled={busyId !== null}><Plus size={14} />Add</button></form>{archived.length > 0 && <details className="workflow-archived"><summary>Archived labels ({archived.length})</summary><div className="label-settings-list">{archived.map(row)}</div></details>}</>;
  return embedded
    ? <section className="settings-catalog" aria-label="Label settings">{body}</section>
    : <Modal onClose={() => busyId === null && onClose()} className="workflow-settings-modal" ariaLabel="Label settings">{body}</Modal>;
}
