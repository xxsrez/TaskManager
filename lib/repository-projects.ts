import { projectEffectiveRoleRankSql } from "./access-sql";
import {
  ConflictError,
  optionalDate,
  optionalText,
  requireTitle,
  ValidationError,
} from "./domain";
import { normalizeProjectTaskCode } from "./project-task-code";
import {
  loadAccessibleProject,
  loadAccessibleRelease,
  requireContentEdit,
} from "./repository-access-loaders";
import {
  projectColor,
  projectIcon,
  projectStatus,
  releaseStatus,
} from "./repository-mappers";
import type { ProjectRecord, ReleaseRecord, UserRecord } from "./types";
import { getD1 } from "@/db";

export async function createProject(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  const code = normalizeProjectTaskCode(input.taskCode);
  const status = projectStatus(input.status ?? "planned");
  const leadUserId = input.leadUserId == null || input.leadUserId === ""
    ? currentUser.id
    : String(input.leadUserId);
  if (leadUserId !== currentUser.id) {
    throw new ValidationError("A new Project lead must be its owner");
  }
  const duplicate = await getD1()
    .prepare(
      `SELECT id FROM projects
       WHERE owner_user_id = ? AND task_code = ? AND archived_at IS NULL
       LIMIT 1`,
    )
    .bind(currentUser.id, code)
    .first();
  if (duplicate) throw new ValidationError("Project code is already in use");
  try {
    await getD1()
    .prepare(
      `INSERT INTO projects
        (id, public_id, owner_user_id, creator_user_id, name, task_code,
         summary, description, status, lead_user_id, start_date, target_date,
         icon, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `project_${crypto.randomUUID()}`,
      crypto.randomUUID(),
      currentUser.id,
      currentUser.id,
      requireTitle(input.name),
      code,
      optionalText(input.summary, 500),
      optionalText(input.description),
      status,
      leadUserId,
      optionalDate(input.startDate),
      optionalDate(input.targetDate),
      projectIcon(input.icon ?? "cube"),
      projectColor(input.color ?? "#8b7cf6"),
      now,
      now,
    )
    .run();
  } catch (error) {
    if (error instanceof Error && /task_code|unique/i.test(error.message)) {
      throw new ValidationError("Project code is already in use");
    }
    throw error;
  }
}
export async function updateProject(
  currentUser: UserRecord,
  projectId: string,
  input: Record<string, unknown>,
): Promise<ProjectRecord> {
  const project = await loadAccessibleProject(currentUser.id, projectId);
  requireContentEdit(project.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== project.version) {
    throw new ConflictError("Project was changed in another session");
  }

  const name = Object.hasOwn(input, "name")
    ? requireTitle(input.name)
    : project.name;
  const taskCode = Object.hasOwn(input, "taskCode")
    ? normalizeProjectTaskCode(input.taskCode)
    : project.taskCode;
  if (taskCode !== project.taskCode && (project.codeLockedAt || project.taskSequence > 0)) {
    throw new ValidationError("Project code is locked after the first Task number is allocated");
  }
  const summary = Object.hasOwn(input, "summary")
    ? optionalText(input.summary, 500)
    : project.summary;
  const description = Object.hasOwn(input, "description")
    ? optionalText(input.description)
    : project.description;
  const status = Object.hasOwn(input, "status")
    ? projectStatus(input.status)
    : project.status;
  const startDate = Object.hasOwn(input, "startDate")
    ? optionalDate(input.startDate)
    : project.startDate;
  const targetDate = Object.hasOwn(input, "targetDate")
    ? optionalDate(input.targetDate)
    : project.targetDate;
  const icon = Object.hasOwn(input, "icon")
    ? projectIcon(input.icon)
    : project.icon;
  const color = Object.hasOwn(input, "color")
    ? projectColor(input.color)
    : project.color;
  const leadUserId = Object.hasOwn(input, "leadUserId")
    ? input.leadUserId == null || input.leadUserId === ""
      ? null
      : String(input.leadUserId)
    : project.leadUserId;
  if (leadUserId) {
    const accessibleLead = await getD1().prepare(
      `SELECT 1 FROM projects p
       JOIN users lead ON lead.id = ?
       WHERE p.id = ?
         AND ${projectEffectiveRoleRankSql("p", "lead.id")} > 0`,
    ).bind(leadUserId, project.id).first();
    if (!accessibleLead) {
      throw new ValidationError("Project lead must have access to the Project");
    }
  }
  if (
    (status === "completed" || status === "canceled")
    && status !== project.status
    && input.confirmOpenTasks !== true
  ) {
    const open = await getD1().prepare(
      `SELECT COUNT(*) AS count
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
       WHERE t.project_id = ? AND t.archived_at IS NULL
         AND t.deleted_at IS NULL
         AND s.category NOT IN ('completed', 'canceled')`,
    ).bind(project.id).first<{ count: number }>();
    if (Number(open?.count ?? 0) > 0) {
      throw new ValidationError("Confirm the terminal transition while the Project has open Tasks");
    }
  }
  const archivedAt = Object.hasOwn(input, "archived")
    ? input.archived === true
      ? project.archivedAt ?? new Date().toISOString()
      : input.archived === false
        ? null
        : (() => { throw new ValidationError("Archived must be true or false"); })()
    : project.archivedAt ?? null;
  const now = new Date().toISOString();

  try {
    const result = await getD1().prepare(
      `UPDATE projects SET
         name = ?, task_code = ?, summary = ?, description = ?, status = ?,
         lead_user_id = ?, start_date = ?, target_date = ?, icon = ?, color = ?,
         archived_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM (SELECT ? AS id) mutation_actor
           WHERE ${projectEffectiveRoleRankSql(
             "projects",
             "mutation_actor.id",
           )} >= 2
         )
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM users lead
           WHERE lead.id = ?
             AND ${projectEffectiveRoleRankSql("projects", "lead.id")} > 0
         ))`,
    ).bind(
      name,
      taskCode,
      summary,
      description,
      status,
      leadUserId,
      startDate,
      targetDate,
      icon,
      color,
      archivedAt,
      now,
      project.id,
      expectedVersion,
      currentUser.id,
      leadUserId,
      leadUserId,
    ).run();
    if ((result.meta.changes ?? 0) < 1) {
      throw new ConflictError("Project access, lead, or version changed before the update committed");
    }
  } catch (error) {
    if (error instanceof ConflictError || error instanceof ValidationError) throw error;
    if (error instanceof Error && /locked Project task code/i.test(error.message)) {
      throw new ConflictError("Project code was locked before the update committed");
    }
    if (error instanceof Error && /task_code|unique/i.test(error.message)) {
      throw new ValidationError("Project code is already in use");
    }
    throw error;
  }
  return loadAccessibleProject(currentUser.id, project.id);
}
export async function createRelease(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<ReleaseRecord> {
  if (!input.projectId) throw new ValidationError("Project is required");
  const project = await loadAccessibleProject(
    currentUser.id,
    String(input.projectId),
  );
  requireContentEdit(project.accessRole);
  if (project.archivedAt || project.status === "canceled") {
    throw new ValidationError("Releases require an active Project");
  }
  const now = new Date().toISOString();
  const id = `release_${crypto.randomUUID()}`;
  const status = releaseStatus(input.status ?? "planned");
  await getD1()
    .prepare(
      `INSERT INTO releases
        (id, public_id, project_id, owner_user_id, creator_user_id, name, description,
         status, target_date, released_at, release_notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      crypto.randomUUID(),
      project.id,
      project.ownerUserId,
      currentUser.id,
      requireTitle(input.name),
      optionalText(input.description),
      status,
      optionalDate(input.targetDate),
      status === "released" ? now : null,
      optionalText(input.releaseNotes),
      now,
      now,
    )
    .run();
  return loadAccessibleRelease(currentUser.id, id);
}

export async function updateRelease(
  currentUser: UserRecord,
  releaseId: string,
  input: Record<string, unknown>,
): Promise<ReleaseRecord> {
  const release = await loadAccessibleRelease(currentUser.id, releaseId);
  requireContentEdit(release.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== release.version) {
    throw new ConflictError("Release was changed in another session");
  }

  const name = Object.hasOwn(input, "name")
    ? requireTitle(input.name)
    : release.name;
  const description = Object.hasOwn(input, "description")
    ? optionalText(input.description)
    : release.description;
  const status = Object.hasOwn(input, "status")
    ? releaseStatus(input.status)
    : release.status;
  const targetDate = Object.hasOwn(input, "targetDate")
    ? optionalDate(input.targetDate)
    : release.targetDate;
  const releaseNotes = Object.hasOwn(input, "releaseNotes")
    ? optionalText(input.releaseNotes)
    : release.releaseNotes;
  const enteringReleased = status === "released" && release.status !== "released";
  if (enteringReleased && input.confirmOpenTasks !== true) {
    const open = await getD1().prepare(
      `SELECT COUNT(*) AS count
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
       WHERE t.release_id = ? AND t.archived_at IS NULL
         AND t.deleted_at IS NULL
         AND s.category NOT IN ('completed', 'canceled')`,
    ).bind(release.id).first<{ count: number }>();
    if (Number(open?.count ?? 0) > 0) {
      throw new ValidationError("Confirm the terminal transition while the Release has open Tasks");
    }
  }

  const now = new Date().toISOString();
  const releasedAt = status === "released"
    ? release.releasedAt ?? now
    : null;
  const confirmedOpenTasks = input.confirmOpenTasks === true ? 1 : 0;
  const result = await getD1().prepare(
    `UPDATE releases SET
       name = ?, description = ?, status = ?, target_date = ?, released_at = ?,
       release_notes = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND deleted_at IS NULL
       AND (
         ? = 0 OR ? = 1 OR status = 'released' OR NOT EXISTS (
           SELECT 1 FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
           WHERE t.release_id = releases.id AND t.archived_at IS NULL
             AND t.deleted_at IS NULL
             AND s.category NOT IN ('completed', 'canceled')
         )
       )
       AND EXISTS (
         SELECT 1 FROM projects p
         CROSS JOIN (SELECT ? AS id) mutation_actor
         WHERE p.id = releases.project_id
           AND p.deleted_at IS NULL
           AND ${projectEffectiveRoleRankSql("p", "mutation_actor.id")} >= 2
       )`,
  ).bind(
    name,
    description,
    status,
    targetDate,
    releasedAt,
    releaseNotes,
    now,
    release.id,
    expectedVersion,
    enteringReleased ? 1 : 0,
    confirmedOpenTasks,
    currentUser.id,
  ).run();
  if ((result.meta.changes ?? 0) < 1) {
    throw new ConflictError("Release access, open Tasks, or version changed before the update committed");
  }
  return loadAccessibleRelease(currentUser.id, release.id);
}
