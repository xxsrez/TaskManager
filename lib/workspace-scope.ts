import type {
  AppSnapshot,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  TaskRecord,
  WorkspaceScopeDescriptor,
} from "./types";

export const ALL_ACCESSIBLE_WORKSPACE_SCOPE = "wsa";
const OWNER_SCOPE_PREFIX = "wso_";
const OWNER_SCOPE_PATTERN = /^wso_[A-Za-z0-9_-]{43}$/;

export type ParsedWorkspaceScope =
  | { kind: "all"; token: typeof ALL_ACCESSIBLE_WORKSPACE_SCOPE }
  | { kind: "owner"; token: string };

export function parseWorkspaceScopeToken(value: unknown): ParsedWorkspaceScope | null {
  if (value === ALL_ACCESSIBLE_WORKSPACE_SCOPE) {
    return { kind: "all", token: ALL_ACCESSIBLE_WORKSPACE_SCOPE };
  }
  if (typeof value !== "string" || !OWNER_SCOPE_PATTERN.test(value)) return null;
  return { kind: "owner", token: value };
}

export async function opaqueWorkspaceOwnerToken(ownerUserId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`task-manager-workspace-owner\0${ownerUserId}`),
  );
  return `${OWNER_SCOPE_PREFIX}${base64Url(new Uint8Array(digest))}`;
}

export function resolveWorkspaceScopeMembership(
  requestedToken: unknown,
  options: readonly WorkspaceScopeDescriptor[],
  currentOwnerToken: string,
): { token: string; fallback: boolean } {
  const parsed = parseWorkspaceScopeToken(requestedToken);
  if (parsed && options.some((option) => option.token === parsed.token)) {
    return { token: parsed.token, fallback: false };
  }
  return {
    token: currentOwnerToken,
    fallback: requestedToken !== null && requestedToken !== undefined && requestedToken !== "",
  };
}

export function workspaceScopeContextLabel(
  token: string,
  options: readonly WorkspaceScopeDescriptor[],
): string {
  return options.find((option) => option.token === token)?.label ?? "My";
}

type WorkspaceOwnedRecord =
  | Pick<ProjectRecord, "id" | "ownerUserId">
  | Pick<ReleaseRecord, "projectId" | "ownerUserId">
  | Pick<TaskRecord, "projectId" | "ownerUserId">
  | Pick<SavedViewRecord, "scopeProjectId" | "ownerUserId">;

export function workspaceOwnerUserId(
  record: WorkspaceOwnedRecord,
  projects: ReadonlyMap<string, Pick<ProjectRecord, "ownerUserId">>,
): string | null {
  if ("scopeProjectId" in record) {
    return record.scopeProjectId
      ? projects.get(record.scopeProjectId)?.ownerUserId ?? null
      : record.ownerUserId;
  }
  if ("projectId" in record) {
    return record.projectId
      ? projects.get(record.projectId)?.ownerUserId ?? null
      : record.ownerUserId;
  }
  return record.ownerUserId;
}

export function workspaceScopeTokenForRecord(
  record: WorkspaceOwnedRecord,
  projects: ReadonlyMap<string, Pick<ProjectRecord, "ownerUserId">>,
  ownerTokens: ReadonlyMap<string, string>,
): string | null {
  const ownerUserId = workspaceOwnerUserId(record, projects);
  if (!ownerUserId) return null;
  return ownerTokens.get(ownerUserId) ?? null;
}

export function sharedWithMeRoots(snapshot: Pick<AppSnapshot, "projects" | "views">) {
  return {
    projects: snapshot.projects.filter((project) => project.accessRole !== "owner"),
    views: snapshot.views.filter(
      (view) => view.scopeProjectId === null && view.accessRole !== "owner",
    ),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === "function") {
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  throw new Error("Base64 encoding is not available");
}
