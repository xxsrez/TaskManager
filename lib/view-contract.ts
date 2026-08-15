import { PRIORITIES, ValidationError } from "./domain";
import type { Priority, ViewDisplay, ViewQuery } from "./types";

type JsonObject = Record<string, unknown>;

const queryKeys = new Set([
  "search",
  "statusIds",
  "priorities",
  "projectId",
  "releaseId",
  "archived",
  "updatedWithinHours",
]);
const displayKeys = new Set([
  "layout",
  "groupBy",
  "orderBy",
  "direction",
  "showEmptyGroups",
  "visibleFields",
]);
const groupings: ViewDisplay["groupBy"][] = [
  "status",
  "priority",
  "assignee",
  "project",
  "release",
  "none",
];
const orderings: ViewDisplay["orderBy"][] = [
  "manual",
  "priority",
  "created",
  "updated",
  "due",
  "title",
];
const visibleFields: ViewDisplay["visibleFields"] = [
  "priority",
  "project",
  "release",
  "dueDate",
  "assignee",
];

export function defaultViewDisplay(): ViewDisplay {
  return {
    layout: "list",
    groupBy: "status",
    orderBy: "manual",
    direction: "asc",
    showEmptyGroups: true,
    visibleFields: [...visibleFields],
  };
}

export function validateViewQuery(value: unknown): ViewQuery {
  if (value == null) return {};
  const input = object(value, "Saved view query");
  rejectUnknownKeys(input, queryKeys, "Saved view query");
  const query: ViewQuery = {};

  if ("search" in input) {
    if (typeof input.search !== "string" || input.search.length > 500) {
      throw new ValidationError("Saved view search must be 500 characters or fewer");
    }
    query.search = input.search;
  }
  if ("statusIds" in input) {
    query.statusIds = stringArray(input.statusIds, "Saved view statusIds");
  }
  if ("priorities" in input) {
    if (!Array.isArray(input.priorities)) {
      throw new ValidationError("Saved view priorities must be an array");
    }
    query.priorities = input.priorities.map((item) => {
      if (typeof item !== "string" || !PRIORITIES.includes(item as Priority)) {
        throw new ValidationError("Saved view priority is invalid");
      }
      return item as Priority;
    });
  }
  if ("projectId" in input) {
    query.projectId = nullableId(input.projectId, "Saved view projectId");
  }
  if ("releaseId" in input) {
    query.releaseId = nullableId(input.releaseId, "Saved view releaseId");
  }
  if ("archived" in input) {
    if (typeof input.archived !== "boolean") {
      throw new ValidationError("Saved view archived must be boolean");
    }
    query.archived = input.archived;
  }
  if ("updatedWithinHours" in input) {
    if (
      typeof input.updatedWithinHours !== "number" ||
      !Number.isFinite(input.updatedWithinHours) ||
      input.updatedWithinHours <= 0 ||
      input.updatedWithinHours > 87_600
    ) {
      throw new ValidationError("Saved view updatedWithinHours is invalid");
    }
    query.updatedWithinHours = input.updatedWithinHours;
  }
  return query;
}

export function validateViewDisplay(value: unknown): ViewDisplay {
  const fallback = defaultViewDisplay();
  if (value == null) return fallback;
  const input = object(value, "Saved view display");
  rejectUnknownKeys(input, displayKeys, "Saved view display");

  if ("layout" in input) {
    fallback.layout = member(input.layout, ["list", "board"], "layout");
  }
  if ("groupBy" in input) {
    fallback.groupBy = member(input.groupBy, groupings, "groupBy");
  }
  if ("orderBy" in input) {
    fallback.orderBy = member(input.orderBy, orderings, "orderBy");
  }
  if ("direction" in input) {
    fallback.direction = member(input.direction, ["asc", "desc"], "direction");
  }
  if ("showEmptyGroups" in input) {
    if (typeof input.showEmptyGroups !== "boolean") {
      throw new ValidationError("Saved view showEmptyGroups must be boolean");
    }
    fallback.showEmptyGroups = input.showEmptyGroups;
  }
  if ("visibleFields" in input) {
    if (!Array.isArray(input.visibleFields)) {
      throw new ValidationError("Saved view visibleFields must be an array");
    }
    const fields = input.visibleFields.map((item) =>
      member(item, visibleFields, "visible field"),
    );
    if (new Set(fields).size !== fields.length) {
      throw new ValidationError("Saved view visibleFields must be unique");
    }
    fallback.visibleFields = fields;
  }
  return fallback;
}

export function parseStoredViewQuery(value: unknown): ViewQuery {
  try {
    return validateViewQuery(parseJson(value));
  } catch {
    return {};
  }
}

export function parseStoredViewDisplay(value: unknown): ViewDisplay {
  try {
    return validateViewDisplay(parseJson(value));
  } catch {
    return defaultViewDisplay();
  }
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function rejectUnknownKeys(input: JsonObject, allowed: Set<string>, label: string) {
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new ValidationError(`${label} field ${unknown} is unsupported`);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new ValidationError(`${label} must be an array of at most 200 ids`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item || item.length > 200) {
      throw new ValidationError(`${label} contains an invalid id`);
    }
    return item;
  });
}

function nullableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 200) {
    throw new ValidationError(`${label} is invalid`);
  }
  return value;
}

function member<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(`Saved view ${label} is invalid`);
  }
  return value as T;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new ValidationError("Saved view JSON is missing");
  return JSON.parse(value) as unknown;
}
