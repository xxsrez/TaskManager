"use client";

import {
relationCandidateProjectLabel,
taskRelationGroupOrder,
taskRelationPresentations,
taskRelationSearchUiApiPath,
type RelativeRelationKind,
type TaskRelationPresentation
} from "@/components/task-tracker-state";
import {
canEditContent,
} from "@/lib/access";
import {
type TaskQueryDependency,
} from "@/lib/task-query-reconciliation";
import type {
AppSnapshot,
ProjectRecord,
TaskRecord
} from "@/lib/types";
import {
Link2,
Plus,
X
} from "lucide-react";
import {
useEffect,
useRef,
useState
} from "react";


import { TaskReference } from "@/components/task-tracker-task-primitives";

export function relationCandidateAllowedForKind(
  kind: RelativeRelationKind,
  anchor: TaskRecord,
  candidate: TaskRecord,
) {
  return kind !== "duplicate_of" || candidate.projectId === anchor.projectId;
}

export function relationSelectionAfterKindChange(
  kind: RelativeRelationKind,
  anchor: TaskRecord,
  candidates: TaskRecord[],
  selectedTaskId: string,
) {
  const selected = candidates.find((candidate) => candidate.id === selectedTaskId);
  return selected && relationCandidateAllowedForKind(kind, anchor, selected)
    ? selectedTaskId
    : "";
}


export function TaskRelations({
  task,
  data,
  onOpenTask,
  onRefresh,
  onMutation,
  canWrite,
  busy,
}: {
  task: TaskRecord;
  data: AppSnapshot;
  onOpenTask: (id: string) => void;
  onRefresh: (taskId: string) => Promise<TaskRecord | null>;
  onMutation: (tasks: TaskRecord[], dependencies: TaskQueryDependency[]) => void;
  canWrite: boolean;
  busy: boolean;
}) {
  const presentations = taskRelationPresentations(task, data);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<RelativeRelationKind>("related");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<TaskRecord[]>(data.tasks);
  const [candidateProjects, setCandidateProjects] = useState<ProjectRecord[]>(data.projects);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [searching, setSearching] = useState(false);
  const [pendingRelationId, setPendingRelationId] = useState<string | null>(null);
  const [relationError, setRelationError] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const existingTargetIds = new Set(presentations.map((item) => item.target.id));
  const availableCandidates = candidates
    .filter((candidate) =>
      candidate.id !== task.id &&
      candidate.projectId !== null &&
      canEditContent(candidate.accessRole) &&
      relationCandidateAllowedForKind(kind, task, candidate) &&
      !existingTargetIds.has(candidate.id) &&
      (!query.trim() || `${candidate.identifier} ${candidate.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
    .slice(0, 8);

  function searchCandidates(nextQuery: string) {
    setQuery(nextQuery);
    setSelectedTaskId("");
    setCandidates(data.tasks);
    setCandidateProjects(data.projects);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!nextQuery.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      void fetch(taskRelationSearchUiApiPath(nextQuery.trim(), task.id, kind), {
        cache: "no-store",
      })
        .then(async (response) => {
          const value = await response.json() as {
            tasks?: TaskRecord[];
            projects?: ProjectRecord[];
            error?: string;
          };
          if (!response.ok || value.error) throw new Error(value.error ?? "Task search failed");
          setCandidates(value.tasks ?? []);
          setCandidateProjects(value.projects ?? []);
          setRelationError("");
        })
        .catch((requestError: unknown) => {
          setRelationError(requestError instanceof Error ? requestError.message : "Task search failed");
        })
        .finally(() => setSearching(false));
    }, 180);
  }

  function changeKind(nextKind: RelativeRelationKind) {
    setKind(nextKind);
    setSelectedTaskId(relationSelectionAfterKindChange(
      nextKind,
      task,
      candidates,
      selectedTaskId,
    ));
  }

  async function sendRelationMutation(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    input: Record<string, unknown>,
    pendingId: string,
    affectedTaskIds: string[],
  ) {
    setPendingRelationId(pendingId);
    setRelationError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const value = await response.json() as { error?: string };
      if (!response.ok || value.error) throw new Error(value.error ?? "Relation could not be saved");
      const refreshed = await onRefresh(task.id);
      const affected = new Map(
        data.tasks
          .filter((candidate) => affectedTaskIds.includes(candidate.id))
          .map((candidate) => [candidate.id, candidate]),
      );
      if (refreshed) affected.set(refreshed.id, refreshed);
      onMutation(
        [...affected.values()],
        input.type === "duplicate_of" && method !== "DELETE"
          ? ["relation", "status", "status_category"]
          : ["relation"],
      );
      return true;
    } catch (requestError) {
      setRelationError(requestError instanceof Error ? requestError.message : "Relation could not be saved");
      return false;
    } finally {
      setPendingRelationId(null);
    }
  }

  async function createRelation() {
    if (!selectedTaskId || kind === "duplicates") return;
    const semantic = relativeRelationSemantic(kind);
    const saved = await sendRelationMutation(
      `/api/tasks/${encodeURIComponent(task.id)}/relations`,
      "POST",
      {
        targetTaskId: selectedTaskId,
        ...semantic,
        taskVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      },
      "new",
      [task.id, selectedTaskId],
    );
    if (saved) {
      setAdding(false);
      setQuery("");
      setSelectedTaskId("");
    }
  }

  async function updateRelation(item: TaskRelationPresentation, nextKind: RelativeRelationKind) {
    if (nextKind === "duplicates") return;
    await sendRelationMutation(
      `/api/tasks/${encodeURIComponent(task.id)}/relations/${encodeURIComponent(item.relation.id)}`,
      "PATCH",
      {
        version: item.relation.version,
        ...relativeRelationSemantic(nextKind),
        taskVersion: task.version,
      },
      item.relation.id,
      [task.id, item.target.id],
    );
  }

  async function removeRelation(item: TaskRelationPresentation) {
    await sendRelationMutation(
      `/api/tasks/${encodeURIComponent(task.id)}/relations/${encodeURIComponent(item.relation.id)}`,
      "DELETE",
      { version: item.relation.version },
      item.relation.id,
      [task.id, item.target.id],
    );
  }

  if (!canWrite && presentations.length === 0) return null;
  const grouped = taskRelationGroupOrder
    .map((group) => ({ group, items: presentations.filter((item) => item.group === group) }))
    .filter(({ items }) => items.length > 0);
  const relationBusy = busy || pendingRelationId !== null;

  return <section className="details-section task-relations" aria-label="Task relations">
    <div className="task-relations-header">
      <h2><Link2 size={14} />Relations</h2>
      {canWrite && task.projectId && <button className="button ghost" type="button" disabled={relationBusy} onClick={() => { setAdding((current) => !current); setRelationError(""); }}><Plus size={13} />Add relation</button>}
    </div>
    {!task.projectId && canWrite && <p className="inline-note">Add this Task to a Project before creating relations.</p>}
    {grouped.map(({ group, items }) => <div className="task-relation-group" key={group}>
      <h3>{group}</h3>
      <div className="details-links">
        {items.map((item) => <div className="task-relation-row" key={item.relation.id} aria-busy={pendingRelationId === item.relation.id}>
          <TaskReference
            label={data.projects.some((project) => project.id === item.target.projectId)
              ? `${item.label} · ${relationCandidateProjectLabel(item.target, data.projects)}`
              : item.label}
            task={item.target}
            onOpen={onOpenTask}
          />
          {canWrite && <div className="task-relation-actions">
            <select aria-label={`Change relation to ${item.target.identifier}`} value={relativeRelationKind(item)} disabled={relationBusy} onChange={(event) => void updateRelation(item, event.target.value as RelativeRelationKind)}>
              <option value="related">Related</option>
              <option value="blocks">Blocks</option>
              <option value="blocked_by">Blocked by</option>
              {item.target.projectId === task.projectId && <option value="duplicate_of">Duplicate of</option>}
              {relativeRelationKind(item) === "duplicates" && <option value="duplicates" disabled>Duplicate</option>}
            </select>
            <button className="icon-button" type="button" aria-label={`Remove relation to ${item.target.identifier}`} disabled={relationBusy} onClick={() => void removeRelation(item)}><X size={13} /></button>
          </div>}
        </div>)}
      </div>
    </div>)}
    {adding && <div className="task-relation-composer">
      <div>
        <select aria-label="Relation type" value={kind} disabled={relationBusy} onChange={(event) => changeKind(event.target.value as RelativeRelationKind)}>
          <option value="related">Related</option>
          <option value="blocks">Blocks</option>
          <option value="blocked_by">Blocked by</option>
          <option value="duplicate_of">Duplicate of</option>
        </select>
        <input aria-label="Search Tasks for relation" value={query} disabled={relationBusy} placeholder="Search by identifier or title…" onChange={(event) => searchCandidates(event.target.value)} />
      </div>
      <div className="task-relation-candidates" aria-busy={searching}>
        {searching && <span>Searching…</span>}
        {!searching && availableCandidates.length === 0 && <span>No editable project Tasks found.</span>}
        {!searching && availableCandidates.map((candidate) => <button type="button" key={candidate.id} className={selectedTaskId === candidate.id ? "selected" : ""} onClick={() => setSelectedTaskId(candidate.id)}><span>{candidate.identifier}</span><b>{relationCandidateProjectLabel(candidate, candidateProjects)} · {candidate.title}</b></button>)}
      </div>
      <div className="task-relation-composer-actions">
        <button className="button ghost" type="button" disabled={relationBusy} onClick={() => setAdding(false)}>Cancel</button>
        <button className="button secondary" type="button" disabled={relationBusy || !selectedTaskId} onClick={() => void createRelation()}>{pendingRelationId === "new" ? "Adding…" : kind === "duplicate_of" ? "Mark duplicate" : "Add relation"}</button>
      </div>
    </div>}
    {relationError && <p className="task-relation-error" role="alert">{relationError}</p>}
  </section>;
}

export function relativeRelationSemantic(kind: Exclude<RelativeRelationKind, "duplicates">) {
  if (kind === "blocked_by") return { type: "blocks" as const, direction: "incoming" as const };
  return {
    type: kind,
    direction: "outgoing" as const,
  };
}

export function relativeRelationKind(item: TaskRelationPresentation): RelativeRelationKind {
  if (item.relation.type === "related") return "related";
  if (item.relation.type === "duplicate_of") {
    return item.direction === "outgoing" ? "duplicate_of" : "duplicates";
  }
  return item.direction === "outgoing" ? "blocks" : "blocked_by";
}
