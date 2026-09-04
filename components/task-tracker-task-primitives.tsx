"use client";

import {
taskPath,
} from "@/lib/navigation";
import type {
AppSnapshot,
LabelRecord,
TaskRecord
} from "@/lib/types";
import {
Boxes,
ChevronDown,
Plus,
Search,
Tag
} from "lucide-react";
import {
useState
} from "react";

import {
handleLocalLink
} from "@/components/task-tracker-dialogs";


export function PropertyValue({ label, value }: { label: string; value: string }) {
  return <div className="property-row read-only"><span>{label}</span><b>{value}</b></div>;
}

export function DetailsSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <section className="details-section"><h2>{icon}{title}</h2>{children}</section>; }
export function TaskReference({ label, task, onOpen }: { label: string; task: TaskRecord; onOpen: (id: string) => void }) { return <a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, () => onOpen(task.id))}><small>{label}</small><span>{task.identifier}</span><b>{task.title}</b></a>; }

export function PropertyRow({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) { return <label className="property-row"><span>{icon}{label}</span>{children}</label>; }
export function PropertySelect({ icon, value, onChange, children, disabled }: { icon: React.ReactNode; value: string; onChange: (value: string) => void; children: React.ReactNode; disabled?: boolean }) { return <label className="property-select">{icon}<select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>{children}</select><ChevronDown size={11} /></label>; }

export function LabelChip({ label }: { label: LabelRecord }) {
  return <span className={`label-chip ${label.archivedAt ? "archived" : ""}`} style={{ "--label-color": label.color } as React.CSSProperties} title={label.description || label.name}>{label.name}</span>;
}

export function toggleLabelSelection(
  current: ReadonlySet<string>,
  labelId: string,
  labels: readonly LabelRecord[],
): Set<string> {
  const next = new Set(current);
  if (next.has(labelId)) {
    next.delete(labelId);
    return next;
  }
  const selected = labels.find((label) => label.id === labelId);
  if (selected?.groupId) {
    for (const label of labels) if (label.groupId === selected.groupId) next.delete(label.id);
  }
  next.add(labelId);
  return next;
}

export function LabelPicker({ labels, selected, onToggle, disabled, label }: { labels: LabelRecord[]; selected: ReadonlySet<string>; onToggle: (labelId: string) => void; disabled?: boolean; label: string }) {
  const [query, setQuery] = useState("");
  const selectedLabels = labels.filter((item) => selected.has(item.id));
  const assignable = labels.filter((item) => !item.archivedAt || selected.has(item.id));
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle
    ? assignable.filter((item) => `${item.name}\n${item.description}`.toLocaleLowerCase().includes(needle))
    : assignable;
  return <div className="label-picker"><div className="label-chip-list">{selectedLabels.map((item) => <LabelChip key={item.id} label={item} />)}{selectedLabels.length === 0 && <span className="muted-value">No labels</span>}</div><details><summary aria-label={label}><Tag size={13} />{selected.size ? `${selected.size} selected` : "Add labels"}<ChevronDown size={11} /></summary><div className="label-picker-menu" role="listbox" aria-multiselectable="true"><label className="label-picker-search"><Search size={13} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search labels…" aria-label="Search labels" /></label>{visible.length ? visible.map((item) => <label key={item.id} title={item.description || item.name}><input type="checkbox" checked={selected.has(item.id)} disabled={disabled || Boolean(item.archivedAt && !selected.has(item.id))} onChange={() => onToggle(item.id)} /><span className="label-color-dot" style={{ background: item.color }} /> <span>{item.name}</span>{item.archivedAt && <small>Archived</small>}</label>) : <p>{assignable.length ? "No matching labels." : "No active labels in this catalog."}</p>}</div></details></div>;
}


export function EmptyState({ entity = "task", onCreate }: { entity?: "task" | "project" | "release"; onCreate?: () => void }) { const labels = { task: ["No tasks here", "There is no work in this view yet."], project: ["No projects yet", "Create a project to group work around an outcome."], release: ["No releases yet", "There are no releases in this scope yet."] }; return <div className="empty-state"><div className="empty-illustration"><span /><span /><span /></div><h2>{labels[entity][0]}</h2><p>{labels[entity][1]}</p>{onCreate && <button className="button primary" onClick={onCreate}><Plus size={14} />Create {entity}</button>}</div>; }

export type TaskHierarchySummary = {
  parent?: TaskRecord;
  subtaskCount: number;
};
export const EMPTY_TASK_HIERARCHY_SUMMARY: TaskHierarchySummary = { subtaskCount: 0 };

export function wouldCreateHierarchyCycle(
  taskId: string,
  candidateParentId: string,
  tasks: ReadonlyMap<string, TaskRecord>,
): boolean {
  const visited = new Set<string>();
  let current: string | null = candidateParentId;
  while (current) {
    if (current === taskId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    current = tasks.get(current)?.parentTaskId ?? null;
  }
  return false;
}

export function taskHierarchySummary(
  task: TaskRecord,
  tasks: readonly TaskRecord[],
): TaskHierarchySummary {
  return buildTaskHierarchySummaries(tasks).get(task.id)
    ?? EMPTY_TASK_HIERARCHY_SUMMARY;
}

export function buildTaskHierarchySummaries(
  tasks: readonly TaskRecord[],
): Map<string, TaskHierarchySummary> {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const subtaskCounts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    subtaskCounts.set(
      task.parentTaskId,
      (subtaskCounts.get(task.parentTaskId) ?? 0) + 1,
    );
  }
  return new Map(tasks.map((task) => [task.id, {
    parent: task.parentTaskId ? tasksById.get(task.parentTaskId) : undefined,
    subtaskCount: subtaskCounts.get(task.id) ?? 0,
  }]));
}

export function TaskHierarchyChip({ hierarchy }: { hierarchy: TaskHierarchySummary }) {
  if (hierarchy.parent) {
    return <span className="metadata-chip hierarchy-chip" title={`Subtask of ${hierarchy.parent.identifier} · ${hierarchy.parent.title}`}><Boxes size={12} />{hierarchy.parent.identifier}</span>;
  }
  if (hierarchy.subtaskCount > 0) {
    return <span className="metadata-chip hierarchy-chip" title={`${hierarchy.subtaskCount} direct subtask${hierarchy.subtaskCount === 1 ? "" : "s"}`}><Boxes size={12} />{hierarchy.subtaskCount}</span>;
  }
  return null;
}


export function labelsForTask(
  context: Pick<AppSnapshot, "labels" | "taskLabels">,
  taskId: string,
) {
  const ids = new Set(context.taskLabels
    .filter((assignment) => assignment.taskId === taskId)
    .map((assignment) => assignment.labelId));
  return context.labels.filter((label) => ids.has(label.id));
}
