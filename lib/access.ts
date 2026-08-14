export type AccessRole = "owner" | "manager" | "editor" | "viewer";
export type GrantRole = Exclude<AccessRole, "owner">;
export type ShareableResourceType = "project" | "task" | "saved_view";

const roleRank: Record<AccessRole, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
  owner: 4,
};

export function hasMinimumRole(
  actual: AccessRole,
  required: AccessRole,
): boolean {
  return roleRank[actual] >= roleRank[required];
}

export function normalizeGrantRole(
  resourceType: ShareableResourceType,
  permission: unknown,
): GrantRole | null {
  if (permission === "viewer" || permission === "editor") return permission;
  if (permission === "manager" && resourceType === "project") return permission;
  if (permission === "full_access") {
    return resourceType === "project" ? "manager" : "editor";
  }
  return null;
}

export function canAssignRole(
  actorRole: AccessRole,
  resourceType: ShareableResourceType,
  targetRole: GrantRole,
): boolean {
  if (normalizeGrantRole(resourceType, targetRole) !== targetRole) return false;
  if (actorRole === "owner") return true;
  return (
    resourceType === "project" &&
    actorRole === "manager" &&
    (targetRole === "editor" || targetRole === "viewer")
  );
}

export function canManageGrant(
  actorRole: AccessRole,
  resourceType: ShareableResourceType,
  existingRole: GrantRole,
): boolean {
  return canAssignRole(actorRole, resourceType, existingRole);
}

export function canTransferOwnership(role: AccessRole): boolean {
  return role === "owner";
}

export function canEditContent(role: AccessRole): boolean {
  return hasMinimumRole(role, "editor");
}
