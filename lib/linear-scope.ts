import { ValidationError } from "./domain";

export type LinearScope = {
  mode: "workspace" | "projects" | "assignees";
  ids: string[];
};

export type LinearScopeSnapshot = {
  issues: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
  labels: Record<string, unknown>[];
  views: Record<string, unknown>[];
};

export function selectLinearScope(snapshot: LinearScopeSnapshot, scope: LinearScope) {
  const selected = new Set(scope.ids);
  const issues = snapshot.issues.filter((issue) => {
    if (scope.mode === "workspace") return true;
    if (scope.mode === "projects") return selected.has(String(objectOrNull(issue.project)?.id ?? ""));
    return selected.has(String(objectOrNull(issue.assignee)?.id ?? ""));
  });
  const issueIdentifiers = new Set(issues.map((issue) => String(issue.identifier)));
  const projectIds = new Set(
    issues.map((issue) => objectOrNull(issue.project)?.id).filter((id): id is string => typeof id === "string"),
  );
  if (scope.mode === "projects") scope.ids.forEach((id) => projectIds.add(id));
  const projects = snapshot.projects.filter((project) => projectIds.has(String(project.id)));
  const statusIds = new Set(issues.map((issue) => String(objectOrNull(issue.state)?.id ?? "")));
  const labelIds = new Set(issues.flatMap((issue) => connectionNodes(issue.labels).map((label) => String(label.id))));
  const views = scope.mode === "workspace"
    ? snapshot.views
    : scope.mode === "projects"
      ? snapshot.views.filter((view) => connectionNodes(view.projects).some((project) => projectIds.has(String(project.id))))
      : [];
  const warnings: string[] = [];
  let externalParents = 0;
  let externalRelations = 0;
  for (const issue of issues) {
    const parent = objectOrNull(issue.parent);
    if (parent && !issueIdentifiers.has(String(parent.identifier))) externalParents += 1;
    for (const relation of connectionNodes(issue.relations)) {
      const target = objectOrNull(relation.relatedIssue);
      if (target && !issueIdentifiers.has(String(target.identifier))) externalRelations += 1;
    }
  }
  if (externalParents) warnings.push(`${externalParents} parent link(s) point outside the selected scope and will remain provenance-only.`);
  if (externalRelations) warnings.push(`${externalRelations} relation(s) point outside the selected scope and will remain provenance-only.`);
  if (scope.mode === "assignees" && snapshot.views.length) warnings.push("Linear custom views are not imported for assignee-only scope because their filters are workspace/project based.");
  return {
    issues,
    projects,
    statuses: uniqueBy(
      snapshot.statuses.filter((status) => statusIds.has(String(status.id))),
      (status) => `${String(status.name).toLowerCase()}\u0000${String(status.type)}`,
    ),
    labels: uniqueBy(
      snapshot.labels.filter((label) => labelIds.has(String(label.id))),
      (label) => String(label.name).toLowerCase(),
    ),
    views,
    warnings,
  };
}

export function assertLinearScopeIds(
  scope: LinearScope,
  projects: Record<string, unknown>[],
  users: Record<string, unknown>[],
) {
  const available = new Set((scope.mode === "projects" ? projects : users).map((row) => String(row.id)));
  for (const id of scope.ids) if (!available.has(id)) throw new ValidationError("Linear scope contains an unknown project or user");
}

function connectionNodes(value: unknown): Record<string, unknown>[] {
  const connection = objectOrNull(value);
  return Array.isArray(connection?.nodes)
    ? connection.nodes.filter((node): node is Record<string, unknown> => Boolean(objectOrNull(node)))
    : [];
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function uniqueBy<T>(values: T[], key: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
