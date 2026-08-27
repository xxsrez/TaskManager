import type {
  AppSnapshot,
  ViewFilterCondition,
  ViewFilterField,
  ViewFilterLabelGroupValue,
  ViewQuery,
} from "./types";
import { canonicalViewQuery } from "./task-filter";

export type FilterCatalogOption = {
  value: string;
  label: string;
};

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const statusCategories: FilterCatalogOption[] = [
  { value: "backlog", label: "Backlog" },
  { value: "unstarted", label: "Unstarted" },
  { value: "started", label: "Started" },
  { value: "completed", label: "Completed" },
  { value: "canceled", label: "Canceled" },
];

const priorities: FilterCatalogOption[] = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "No priority" },
];

function unique(options: FilterCatalogOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (!option.value || seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function natural(options: FilterCatalogOption[]) {
  return [...options].sort((left, right) =>
    collator.compare(left.label, right.label) || collator.compare(left.value, right.value));
}

/**
 * Builds the authoritative option catalog for one filter field. Project scope
 * is explicit: a Project condition in a global query never narrows this list.
 */
export function filterCatalogOptions(
  field: ViewFilterField,
  data: Pick<AppSnapshot, "user" | "users" | "statuses" | "projects" | "releases" | "labels" | "labelGroups" | "tasks" | "collaborators">,
  scopeProjectId: string | null = null,
): FilterCatalogOption[] {
  const scopedOwnerUserId = scopeProjectId
    ? data.projects.find((project) => project.id === scopeProjectId)?.ownerUserId ?? null
    : null;
  if (field === "status") {
    return unique(data.statuses
      .filter((item) => !scopedOwnerUserId || item.ownerUserId === scopedOwnerUserId)
      .slice()
      .sort((left, right) => left.position - right.position || collator.compare(left.name, right.name))
      .map((item) => ({ value: item.id, label: item.name })));
  }
  if (field === "status_category") return statusCategories;
  if (field === "priority") return priorities;
  if (field === "assignee") {
    const users = new Map([...data.users, data.user].map((user) => [user.id, user]));
    if (!scopeProjectId) {
      return natural(unique([...users.values()].map((item) => ({ value: item.id, label: item.displayName }))));
    }
    const memberIds = new Set<string>([data.user.id]);
    const project = data.projects.find((item) => item.id === scopeProjectId);
    if (project) memberIds.add(project.ownerUserId);
    for (const collaborator of data.collaborators) {
      if (collaborator.resourceType === "project" && collaborator.resourceId === scopeProjectId) {
        memberIds.add(collaborator.userId);
      }
    }
    return natural(unique([...memberIds]
      .map((id) => users.get(id))
      .filter((user): user is NonNullable<typeof user> => user !== undefined)
      .map((item) => ({ value: item.id, label: item.displayName }))));
  }
  if (field === "project") {
    return natural(unique(data.projects
      .filter((item) => !scopeProjectId || item.id === scopeProjectId)
      .map((item) => ({ value: item.id, label: `${item.taskCode} · ${item.name}` }))));
  }
  if (field === "release") {
    const projects = new Map<string, AppSnapshot["projects"][number]>();
    for (const project of data.projects) {
      if (!projects.has(project.id)) projects.set(project.id, project);
    }
    const statusRank = new Map([["active", 0], ["planned", 1], ["released", 2], ["canceled", 3]]);
    const releases = unique(data.releases
      .filter((item) => !scopeProjectId || item.projectId === scopeProjectId)
      .map((item) => ({
        value: item.id,
        label: `${projects.get(item.projectId)?.name ?? "Unavailable project"} · ${item.name}`,
      })));
    const releasesById = new Map<string, AppSnapshot["releases"][number]>();
    for (const release of data.releases) {
      if (!releasesById.has(release.id)) releasesById.set(release.id, release);
    }
    return releases.sort((left, right) => {
      const leftRelease = releasesById.get(left.value)!;
      const rightRelease = releasesById.get(right.value)!;
      const projectOrder = collator.compare(
        projects.get(leftRelease.projectId)?.name ?? "",
        projects.get(rightRelease.projectId)?.name ?? "",
      );
      if (projectOrder) return projectOrder;
      const lifecycleOrder = (statusRank.get(leftRelease.status) ?? 99) - (statusRank.get(rightRelease.status) ?? 99);
      if (lifecycleOrder) return lifecycleOrder;
      return collator.compare(rightRelease.name, leftRelease.name) || collator.compare(left.value, right.value);
    });
  }
  if (field === "label") {
    return natural(unique(data.labels
      .filter((item) => !scopedOwnerUserId || item.ownerUserId === scopedOwnerUserId)
      .map((item) => ({ value: item.id, label: item.name }))));
  }
  if (field === "label_group") {
    return unique((data.labelGroups ?? [])
      .filter((item) => !scopedOwnerUserId || item.ownerUserId === scopedOwnerUserId)
      .slice()
      .sort((left, right) => left.position - right.position || collator.compare(left.name, right.name))
      .map((item) => ({ value: item.id, label: item.name })));
  }
  if (field === "parent") {
    return natural(unique(data.tasks
      .filter((item) => !scopeProjectId || item.projectId === scopeProjectId)
      .map((item) => ({ value: item.id, label: `${item.identifier} · ${item.title}` }))));
  }
  return [];
}

export function filterConditionValues(condition: ViewFilterCondition) {
  if (Array.isArray(condition.value)) return condition.value.map(String);
  if (typeof condition.value === "string") return [condition.value];
  return [];
}

export function unavailableFilterReferences(
  query: ViewQuery,
  data: Pick<AppSnapshot, "user" | "users" | "statuses" | "projects" | "releases" | "labels" | "labelGroups" | "tasks" | "collaborators">,
  scopeProjectId: string | null = null,
) {
  return canonicalViewQuery(query).conditions.flatMap((condition, conditionIndex) => {
    if (condition.field === "label_group" && typeof condition.value === "object" && condition.value && !Array.isArray(condition.value)) {
      const value = condition.value as ViewFilterLabelGroupValue;
      const availableGroups = new Set(filterCatalogOptions("label_group", data, scopeProjectId).map((option) => option.value));
      const availableLabels = new Set(filterCatalogOptions("label", data, scopeProjectId).map((option) => option.value));
      return [
        ...(!availableGroups.has(value.groupId) ? [{ conditionIndex, field: condition.field, value: value.groupId }] : []),
        ...(value.mode === "values" ? (value.labelIds ?? [])
          .filter((labelId) => !availableLabels.has(labelId))
          .map((labelId) => ({ conditionIndex, field: condition.field, value: labelId })) : []),
      ];
    }
    if (!["status", "assignee", "project", "release", "label", "label_group", "parent"].includes(condition.field)) {
      return [];
    }
    const available = new Set(filterCatalogOptions(condition.field, data, scopeProjectId).map((option) => option.value));
    return filterConditionValues(condition)
      .filter((value) => value && !available.has(value))
      .map((value) => ({ conditionIndex, field: condition.field, value }));
  });
}

export function unavailableFilterLabel(field: ViewFilterField) {
  if (field === "release") return "Unavailable release";
  if (field === "project") return "Unavailable project";
  if (field === "parent") return "Unavailable parent task";
  if (field === "assignee") return "Unavailable assignee";
  if (field === "status") return "Unavailable status";
  if (field === "label_group") return "Unavailable label group";
  return "Unavailable label";
}
