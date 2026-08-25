import { ValidationError } from "./domain";
import type { BackupRow } from "./system-backup-contract";
import type { BackupTables } from "./system-backup-format";

export function upgradeLegacySystemWorkflow(source: BackupTables): BackupTables {
  const statuses: BackupRow[] = source.workflow_statuses.map((status): BackupRow => ({
    ...status,
    system_role: null,
    archived_at: null,
    version: 1,
  }));
  for (const user of source.users) {
    const ownerId = String(user.id);
    const owned = statuses
      .filter((status) => status.owner_user_id === ownerId)
      .sort((left, right) => Number(left.position) - Number(right.position) || String(left.id).localeCompare(String(right.id)));
    const duplicate = owned.find((status) => status.name === "Duplicate")
      ?? owned.find((status) => String(status.name).toLocaleLowerCase() === "duplicate");
    if (duplicate) {
      duplicate.name = "Duplicate";
      duplicate.category = "canceled";
      duplicate.is_default = 0;
      duplicate.system_role = "duplicate";
    } else {
      const maxPosition = owned.reduce((maximum, status) => Math.max(maximum, Number(status.position)), -1);
      statuses.push({
        id: `status:${ownerId}:duplicate`,
        owner_user_id: ownerId,
        name: "Duplicate",
        category: "canceled",
        color: "#9ca3af",
        position: maxPosition + 1,
        is_default: 0,
        system_role: "duplicate",
        archived_at: null,
        version: 1,
        created_at: user.created_at,
        updated_at: user.updated_at,
      });
    }
    if (!owned.some((status) => status.is_default === 1)) {
      const fallback = owned.find((status) => status.category === "unstarted")
        ?? owned.find((status) => status.category === "backlog");
      if (fallback) fallback.is_default = 1;
    }
  }
  return { ...source, workflow_statuses: statuses };
}

export function upgradeLegacySystemUsers(source: BackupTables): BackupTables {
  return {
    ...source,
    users: source.users.map((user): BackupRow => ({
      ...user,
      theme: user.theme ?? "system",
      sidebar_preference: user.sidebar_preference ?? "expanded",
      version: user.version ?? 1,
    })),
  };
}

export function upgradeLegacySystemRelations(source: BackupTables): BackupTables {
  return {
    ...source,
    task_relations: source.task_relations.map((relation): BackupRow => ({
      id: legacyRelationId(relation),
      source_task_id: relation.source_task_id,
      target_task_id: relation.target_task_id,
      type: relation.type,
      creator_user_id: relation.creator_user_id,
      idempotency_key: `legacy:${relation.source_task_id}:${relation.target_task_id}:${relation.type}`,
      version: 1,
      created_at: relation.created_at,
      updated_at: relation.created_at,
    })),
  };
}

export function upgradeLegacySystemLabels(source: BackupTables): BackupTables {
  return {
    ...source,
    labels: source.labels.map((label): BackupRow => ({
      ...label,
      description: "",
      archived_at: null,
      version: 1,
      updated_at: label.created_at,
    })),
  };
}

export function upgradeLegacySystemLabelGroups(source: BackupTables): BackupTables {
  return {
    ...source,
    label_groups: [],
    labels: source.labels.map((label): BackupRow => ({ ...label, group_id: null })),
  };
}

export function upgradeLegacySystemSavedViews(source: BackupTables): BackupTables {
  return {
    ...source,
    saved_views: source.saved_views.map((view): BackupRow => ({
      ...view,
      archived_at: null,
    })),
  };
}

export function upgradeLegacySystemComments(source: BackupTables): BackupTables {
  return {
    ...source,
    comments: source.comments.map((comment): BackupRow => ({
      ...comment,
      source: "native",
      source_record_id: null,
      source_comment_id: null,
      source_parent_comment_id: null,
      historical_author_name: null,
      historical_created_at: null,
      historical_updated_at: null,
      historical_quoted_text: null,
    })),
    comment_migration_outcomes: [],
  };
}

export function upgradeLegacySystemIdentifiers(source: BackupTables): BackupTables {
  const usedByOwner = new Map<string, Set<string>>();
  const projects = [...source.projects]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((project): BackupRow => {
      const ownerId = String(project.owner_user_id);
      const used = usedByOwner.get(ownerId) ?? new Set<string>();
      usedByOwner.set(ownerId, used);
      const taskCode = allocateLegacyProjectCode(String(project.name), used);
      used.add(taskCode);
      const projectTasks = source.tasks.filter((task) => task.project_id === project.id);
      const taskSequence = projectTasks.reduce(
        (maximum, task) => Math.max(maximum, Number(task.sequence_number)),
        0,
      );
      const codeLockedAt = projectTasks
        .map((task) => String(task.created_at))
        .sort()[0] ?? null;
      return { ...project, task_code: taskCode, task_sequence: taskSequence, code_locked_at: codeLockedAt };
    });
  const projectsById = new Map(projects.map((project) => [String(project.id), project]));
  const aliases: BackupRow[] = [];
  const tasks = source.tasks.map((task): BackupRow => {
    if (task.project_id === null) {
      throw new ValidationError(
        "Legacy backup Tasks without Project require an explicit Project mapping",
      );
    }
    const project = projectsById.get(String(task.project_id));
    if (!project) throw new ValidationError("Task references a missing Project");
    aliases.push({
      id: `task_alias_legacy_${String(task.id)}`,
      task_id: task.id,
      identifier: task.identifier,
      created_at: task.created_at,
    });
    return {
      ...task,
      identifier: `${String(project.task_code)}-${String(task.sequence_number)}`,
    };
  });
  return { ...source, projects, tasks, task_identifier_aliases: aliases };
}

function legacyRelationId(relation: BackupRow) {
  return `relation_legacy:${relation.source_task_id}:${relation.target_task_id}:${relation.type}`;
}

function allocateLegacyProjectCode(name: string, used: Set<string>) {
  const known: Record<string, string> = {
    "task manager": "TM",
    "mind diary": "MD",
    "scorched earth": "SE",
    homeostat: "HO",
  };
  const knownCode = known[name.trim().toLowerCase()];
  if (knownCode && !used.has(knownCode)) return knownCode;
  const letters = name.toUpperCase().replace(/[^A-Z]/g, "");
  const suggested = (letters.slice(0, 3) || "PR").padEnd(2, "X");
  if (!used.has(suggested)) return suggested;
  for (let index = 0; index < 26 * 26; index += 1) {
    const candidate = `Z${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new ValidationError("Could not allocate a unique legacy Project code");
}
