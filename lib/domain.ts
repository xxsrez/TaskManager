import type { Priority, StatusCategory } from "./types";

export const PRIORITIES: Priority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];

export const STATUS_CATEGORIES: StatusCategory[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
];

export function requireTitle(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Title is required");
  const title = value.trim();
  if (!title) throw new ValidationError("Title is required");
  if (title.length > 500) {
    throw new ValidationError("Title must be 500 characters or fewer");
  }
  return title;
}

export function optionalText(value: unknown, maximum = 50_000): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new ValidationError("Expected text");
  if (value.length > maximum) {
    throw new ValidationError(`Text must be ${maximum} characters or fewer`);
  }
  return value;
}

export function optionalDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError("Date must use YYYY-MM-DD");
  }
  return value;
}

export function priority(value: unknown): Priority {
  if (typeof value !== "string" || !PRIORITIES.includes(value as Priority)) {
    throw new ValidationError("Unknown priority");
  }
  return value as Priority;
}

export function statusTimestamps(
  category: StatusCategory,
  current: {
    startedAt: string | null;
    completedAt: string | null;
    canceledAt: string | null;
  },
  now: string,
) {
  return {
    startedAt:
      category === "started" && current.startedAt == null
        ? now
        : current.startedAt,
    completedAt: category === "completed" ? now : null,
    canceledAt: category === "canceled" ? now : null,
  };
}

export function assertReleaseProject(
  taskProjectId: string | null,
  releaseProjectId: string | null,
) {
  if (releaseProjectId && taskProjectId !== releaseProjectId) {
    throw new ValidationError("Release must belong to the task project");
  }
}

export class ValidationError extends Error {
  readonly status = 400;
}

export class NotFoundError extends Error {
  readonly status = 404;
}

export class PermissionError extends Error {
  readonly status = 403;
}

export class ConflictError extends Error {
  readonly status = 409;
}
