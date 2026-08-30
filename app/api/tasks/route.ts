import { readJson, withUser } from "@/lib/http";
import { canEditContent } from "@/lib/access";
import { PermissionError, ValidationError } from "@/lib/domain";
import {
  createTask,
  getSnapshot,
  getTaskDetail,
  loadAccessibleProject,
  searchTaskSummaries,
} from "@/lib/repository";

const RELATION_SEARCH_LIMIT = 20;
const relationSearchKinds = new Set([
  "blocks",
  "blocked_by",
  "related",
  "duplicate_of",
  "duplicates",
]);

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const search = parameters.get("search") ?? "";
  return withUser(async (user) => {
    const relationSearch = parameters.get("relation_search") === "true";
    if (relationSearch) {
      const anchorTaskId = parameters.get("relation_anchor") ?? "";
      const relationKind = parameters.get("relation_kind") ?? "";
      if (!anchorTaskId || !relationSearchKinds.has(relationKind)) {
        throw new ValidationError("Relation search requires a Task and relation kind");
      }
      const anchor = await getTaskDetail(user, anchorTaskId);
      if (!canEditContent(anchor.task.accessRole)) {
        throw new PermissionError("Editor access is required on both Tasks");
      }
      const existingPeerIds = new Set(anchor.relations.map((relation) =>
        relation.sourceTaskId === anchor.task.id
          ? relation.targetTaskId
          : relation.sourceTaskId,
      ));
      const matches = await searchTaskSummaries(user, search);
      const tasks = matches
        .filter((task) =>
          task.id !== anchor.task.id &&
          task.projectId !== null &&
          canEditContent(task.accessRole) &&
          !existingPeerIds.has(task.id) &&
          (relationKind !== "duplicate_of" ||
            task.projectId === anchor.task.projectId),
        )
        .slice(0, RELATION_SEARCH_LIMIT);
      const projectIds = [...new Set(tasks.flatMap((task) =>
        task.projectId ? [task.projectId] : [],
      ))];
      const projects = await Promise.all(
        projectIds.map((projectId) => loadAccessibleProject(user.id, projectId)),
      );
      return { taskIds: tasks.map((task) => task.id), tasks, projects };
    }
    const matches = await searchTaskSummaries(user, search, {
      workspaceScope: parameters.has("workspace_scope")
        ? parameters.get("workspace_scope")
        : undefined,
    });
    return { taskIds: matches.map((task) => task.id), tasks: matches };
  });
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    const createdTask = await createTask(user, input);
    return {
      ...(await getSnapshot(user, {
        workspaceScope: new URL(request.url).searchParams.get("workspace_scope"),
      })),
      createdTask,
    };
  });
}
