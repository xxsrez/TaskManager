import { ValidationError } from "./domain";

export const PROJECT_TASK_CODE_PATTERN =
  /^[A-Z0-9](?:[A-Z0-9-]{0,10}[A-Z0-9])?$/;
export const PROJECT_TASK_CODE_PATTERN_SOURCE =
  "^[A-Z0-9](?:[A-Z0-9-]{0,10}[A-Z0-9])?$";
export const PROJECT_TASK_CODE_INPUT_PATTERN =
  "[A-Z0-9](?:[A-Z0-9-]{0,10}[A-Z0-9])?";
export const PROJECT_TASK_CODE_ERROR =
  "Project code must use 1 to 12 Latin letters, digits, or internal hyphens";

export function isProjectTaskCode(value: unknown): value is string {
  return typeof value === "string" && PROJECT_TASK_CODE_PATTERN.test(value);
}

export function normalizeProjectTaskCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("Project code is required");
  }
  const normalized = value.trim().toUpperCase();
  if (!isProjectTaskCode(normalized)) {
    throw new ValidationError(PROJECT_TASK_CODE_ERROR);
  }
  return normalized;
}

export function suggestProjectTaskCode(value: string): string {
  const words = value.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  if (words.length === 0) return "PR";
  if (words.length === 1) return words[0]!.slice(0, 12);
  return words.map((word) => word[0]).join("").slice(0, 12);
}
