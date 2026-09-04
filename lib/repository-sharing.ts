import {
  canAssignRole,
  canManageGrant,
  canTransferOwnership,
  normalizeGrantRole,
  type GrantRole,
  type ShareableResourceType,
} from "./access";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";
import {
  loadAccessibleProject,
  loadAccessibleTask,
  loadAccessibleView,
} from "./repository-access-loaders";
import { clearLostAccessForUserStatements } from "./team-access-cleanup";
import type { UserRecord } from "./types";
import { getD1 } from "@/db";

export async function grantAccess(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const resourceType = shareableResourceType(input.resourceType);
  const resourceId = String(input.resourceId ?? "");
  const target = await loadShareTarget(currentUser.id, resourceType, resourceId);
  const permission = requestedGrantRole(input.permission);
  if (!canAssignRole(target.actorRole, resourceType, permission)) {
    throw new PermissionError("You cannot assign that role");
  }
  const email = String(input.email ?? "").trim().toLowerCase();
  const matches = await getD1()
    .prepare("SELECT id FROM users WHERE lower(email) = ? ORDER BY id LIMIT 2")
    .bind(email)
    .all<{ id: string }>();
  if (matches.results.length === 0) {
    throw new NotFoundError("That user must sign in once before you can share");
  }
  if (matches.results.length > 1) {
    throw new ValidationError("More than one account uses that email");
  }
  const grantee = matches.results[0]!;
  if (grantee.id === target.ownerUserId) {
    throw new ValidationError("The owner already has access");
  }
  const existing = await getD1()
    .prepare(
      `SELECT permission FROM access_grants
       WHERE resource_type = ? AND resource_id = ? AND grantee_user_id = ?
         AND revoked_at IS NULL`,
    )
    .bind(resourceType, resourceId, grantee.id)
    .first<{ permission: string }>();
  const existingRole = existing
    ? normalizeGrantRole(resourceType, existing.permission)
    : null;
  if (
    existingRole &&
    !canManageGrant(target.actorRole, resourceType, existingRole)
  ) {
    throw new PermissionError("You cannot change that participant");
  }
  await getD1()
    .prepare(
      `INSERT INTO access_grants
        (id, resource_type, resource_id, owner_user_id, grantee_user_id,
         granted_by_user_id, permission, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(resource_type, resource_id, grantee_user_id)
       DO UPDATE SET owner_user_id = excluded.owner_user_id,
         permission = excluded.permission, revoked_at = NULL,
         granted_by_user_id = excluded.granted_by_user_id`,
    )
    .bind(
      `grant_${crypto.randomUUID()}`,
      resourceType,
      resourceId,
      target.ownerUserId,
      grantee.id,
      currentUser.id,
      permission,
    )
    .run();
}
export async function revokeAccess(currentUser: UserRecord, grantId: string) {
  const grant = await loadGrantForManagement(currentUser.id, grantId);
  if (!canManageGrant(grant.actorRole, grant.resourceType, grant.permission)) {
    throw new PermissionError("You cannot remove that participant");
  }
  const db = getD1();
  const now = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE access_grants SET revoked_at = ?
         WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, grantId, grant.ownerUserId),
    ...clearLostAccessForUserStatements(db, grant.granteeUserId, now),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new NotFoundError("Grant not found");
  }
}

export async function updateAccessRole(
  currentUser: UserRecord,
  grantId: string,
  input: Record<string, unknown>,
) {
  const grant = await loadGrantForManagement(currentUser.id, grantId);
  const permission = requestedGrantRole(input.permission);
  if (
    !canManageGrant(grant.actorRole, grant.resourceType, grant.permission) ||
    !canAssignRole(grant.actorRole, grant.resourceType, permission)
  ) {
    throw new PermissionError("You cannot change that participant");
  }
  const result = await getD1()
    .prepare(
      `UPDATE access_grants
       SET permission = ?, granted_by_user_id = ?
       WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(permission, currentUser.id, grantId, grant.ownerUserId)
    .run();
  if ((result.meta.changes ?? 0) < 1) throw new NotFoundError("Grant not found");
}

export async function transferProjectOwnership(
  currentUser: UserRecord,
  projectId: string,
  targetUserId: string,
) {
  const project = await loadAccessibleProject(currentUser.id, projectId);
  if (!canTransferOwnership(project.accessRole)) {
    throw new PermissionError("Only the project owner can transfer ownership");
  }
  const targetGrant = await getD1()
    .prepare(
      `SELECT id FROM access_grants
       WHERE resource_type = 'project' AND resource_id = ?
         AND grantee_user_id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(project.id, targetUserId, currentUser.id)
    .first<{ id: string }>();
  if (!targetGrant) {
    throw new ValidationError("Ownership can only be transferred to a project member");
  }
  const codeConflict = await getD1()
    .prepare(
      `SELECT id FROM projects
       WHERE owner_user_id = ? AND task_code = ? AND archived_at IS NULL
         AND id <> ? LIMIT 1`,
    )
    .bind(targetUserId, project.taskCode, project.id)
    .first();
  if (codeConflict) {
    throw new ValidationError("The new owner already has a Project with this code");
  }

  const now = new Date().toISOString();
  const db = getD1();
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `UPDATE projects
         SET owner_user_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
      )
      .bind(targetUserId, now, project.id, currentUser.id),
      db.prepare(
        `UPDATE access_grants SET owner_user_id = ?
         WHERE resource_type = 'project' AND resource_id = ?
           AND owner_user_id = ?`,
      )
      .bind(targetUserId, project.id, currentUser.id),
      db.prepare(
        `UPDATE access_grants SET revoked_at = ?
         WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, targetGrant.id, targetUserId),
      db.prepare(
        `INSERT INTO access_grants
          (id, resource_type, resource_id, owner_user_id, grantee_user_id,
           granted_by_user_id, permission, revoked_at, created_at)
         SELECT ?, 'project', ?, ?, ?, ?, 'manager', NULL, ?
         FROM projects WHERE id = ? AND owner_user_id = ?
         ON CONFLICT(resource_type, resource_id, grantee_user_id)
         DO UPDATE SET owner_user_id = excluded.owner_user_id,
           permission = 'manager', revoked_at = NULL,
           granted_by_user_id = excluded.granted_by_user_id`,
      )
      .bind(
        `grant_${crypto.randomUUID()}`,
        project.id,
        targetUserId,
        currentUser.id,
        currentUser.id,
        now,
        project.id,
        targetUserId,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && /task_code|unique/i.test(error.message)) {
      throw new ValidationError("The new owner already has a Project with this code");
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new ConflictError("Project ownership changed in another session");
  }
}

function shareableResourceType(value: unknown): ShareableResourceType {
  if (value === "project" || value === "task" || value === "saved_view") {
    return value;
  }
  throw new ValidationError("Unsupported share target");
}

function requestedGrantRole(value: unknown): GrantRole {
  if (value === "manager" || value === "editor" || value === "viewer") {
    return value;
  }
  throw new ValidationError("Choose a valid access role");
}

async function loadShareTarget(
  userId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
) {
  if (resourceType === "project") {
    const project = await loadAccessibleProject(userId, resourceId);
    return {
      ownerUserId: project.ownerUserId,
      actorRole: project.accessRole,
    };
  }
  if (resourceType === "task") {
    const task = await loadAccessibleTask(userId, resourceId);
    if (task.projectId) {
      throw new ValidationError("Manage access on the project instead");
    }
    return { ownerUserId: task.ownerUserId, actorRole: task.accessRole };
  }
  const view = await loadAccessibleView(userId, resourceId);
  if (view.scopeProjectId) {
    throw new ValidationError("Manage access on the project instead");
  }
  return { ownerUserId: view.ownerUserId, actorRole: view.accessRole };
}

async function loadGrantForManagement(userId: string, grantId: string) {
  const row = await getD1()
    .prepare(
      `SELECT resource_type, resource_id, owner_user_id, grantee_user_id, permission
       FROM access_grants WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(grantId)
    .first<{
      resource_type: string;
      resource_id: string;
      owner_user_id: string;
      grantee_user_id: string;
      permission: string;
    }>();
  if (!row) throw new NotFoundError("Grant not found");
  const resourceType = shareableResourceType(row.resource_type);
  const permission = normalizeGrantRole(resourceType, row.permission);
  if (!permission) throw new PermissionError("Grant role is invalid");
  const target = await loadShareTarget(userId, resourceType, row.resource_id);
  return {
    resourceType,
    resourceId: row.resource_id,
    ownerUserId: target.ownerUserId,
    granteeUserId: row.grantee_user_id,
    actorRole: target.actorRole,
    permission,
  };
}
