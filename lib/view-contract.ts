import {
  PRIORITIES,
  STATUS_CATEGORIES,
  ValidationError,
} from "./domain";
import type {
  CanonicalViewQuery,
  Priority,
  ViewDisplay,
  ViewFilterCondition,
  ViewFilterField,
  ViewFilterOperator,
  ViewFilterRelationValue,
  ViewQuery,
} from "./types";

type JsonObject = Record<string, unknown>;

const canonicalQueryKeys = new Set([
  "version",
  "op",
  "conditions",
  "search",
]);
const legacyQueryKeys = new Set([
  "search",
  "statusIds",
  "priorities",
  "projectId",
  "releaseId",
  "archived",
  "updatedWithinHours",
]);
const conditionKeys = new Set(["field", "operator", "value"]);
const filterFields: ViewFilterField[] = [
  "status",
  "status_category",
  "priority",
  "assignee",
  "project",
  "release",
  "label",
  "estimate",
  "due_date",
  "parent",
  "subtasks",
  "relation",
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "canceled_at",
  "archived",
];
const categoricalFields = new Set<ViewFilterField>([
  "status",
  "status_category",
  "priority",
  "assignee",
  "project",
  "release",
  "label",
  "parent",
]);
const categoricalOperators: ViewFilterOperator[] = [
  "is",
  "is_not",
  "in",
  "not_in",
  "is_empty",
];
const numberOperators: ViewFilterOperator[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_empty",
];
const dateOperators: ViewFilterOperator[] = [
  "on",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "is_empty",
];
const dateFields = new Set<ViewFilterField>([
  "due_date",
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "canceled_at",
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
    orderBy: "priority",
    direction: "asc",
    showEmptyGroups: true,
    visibleFields: [...visibleFields],
  };
}

export function emptyViewQuery(): CanonicalViewQuery {
  return { version: 1, op: "all", conditions: [] };
}

export function validateViewQuery(value: unknown): CanonicalViewQuery {
  if (value == null) return emptyViewQuery();
  const input = object(value, "Saved view query");
  if ("version" in input || "op" in input || "conditions" in input) {
    return validateCanonicalQuery(input);
  }
  rejectUnknownKeys(input, legacyQueryKeys, "Saved view query");
  const conditions: ViewFilterCondition[] = [];
  const query: CanonicalViewQuery = { ...emptyViewQuery(), conditions };

  if ("search" in input) {
    query.search = searchValue(input.search);
  }
  if ("statusIds" in input) {
    const values = stringArray(input.statusIds, "Saved view statusIds");
    if (values.length) conditions.push({ field: "status", operator: "in", value: values });
  }
  if ("priorities" in input) {
    if (!Array.isArray(input.priorities)) {
      throw new ValidationError("Saved view priorities must be an array");
    }
    const values = input.priorities.map((item) => {
      if (typeof item !== "string" || !PRIORITIES.includes(item as Priority)) {
        throw new ValidationError("Saved view priority is invalid");
      }
      return item as Priority;
    });
    if (values.length) conditions.push({ field: "priority", operator: "in", value: values });
  }
  if ("projectId" in input) {
    const value = nullableId(input.projectId, "Saved view projectId");
    conditions.push(value === null
      ? { field: "project", operator: "is_empty" }
      : { field: "project", operator: "is", value });
  }
  if ("releaseId" in input) {
    const value = nullableId(input.releaseId, "Saved view releaseId");
    conditions.push(value === null
      ? { field: "release", operator: "is_empty" }
      : { field: "release", operator: "is", value });
  }
  if ("archived" in input) {
    if (typeof input.archived !== "boolean") {
      throw new ValidationError("Saved view archived must be boolean");
    }
    conditions.push({ field: "archived", operator: "is", value: input.archived });
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
    conditions.push({
      field: "updated_at",
      operator: "recent",
      value: input.updatedWithinHours,
    });
  }
  return query;
}

function validateCanonicalQuery(input: JsonObject): CanonicalViewQuery {
  rejectUnknownKeys(input, canonicalQueryKeys, "Saved view query");
  if (input.version !== 1) {
    throw new ValidationError("Saved view query version is unsupported");
  }
  if (input.op !== "all") {
    throw new ValidationError("Saved view query operation is unsupported");
  }
  if (!Array.isArray(input.conditions) || input.conditions.length > 100) {
    throw new ValidationError("Saved view conditions must be an array of at most 100 items");
  }
  const conditions = input.conditions.map(validateCondition);
  const valueCount = conditions.reduce(
    (total, condition) => total + (Array.isArray(condition.value) ? condition.value.length : condition.value === undefined ? 0 : 1),
    0,
  );
  if (valueCount > 200) {
    throw new ValidationError("Saved view filter values are limited to 200 total items");
  }
  const query: CanonicalViewQuery = {
    version: 1,
    op: "all",
    conditions,
  };
  if ("search" in input) query.search = searchValue(input.search);
  return query;
}

function validateCondition(value: unknown, index: number): ViewFilterCondition {
  const input = object(value, `Saved view condition ${index + 1}`);
  rejectUnknownKeys(input, conditionKeys, `Saved view condition ${index + 1}`);
  const field = member(input.field, filterFields, "filter field");
  if (typeof input.operator !== "string") {
    throw new ValidationError("Saved view filter operator is invalid");
  }
  const operator = input.operator as ViewFilterOperator;
  const hasValue = Object.hasOwn(input, "value");

  if (categoricalFields.has(field)) {
    member(operator, categoricalOperators, "filter operator");
    if (operator === "is_empty") {
      rejectConditionValue(hasValue);
      return { field, operator };
    }
    if (operator === "in" || operator === "not_in") {
      const values = stringArray(input.value, `Saved view ${field} values`);
      if (!values.length) throw new ValidationError("Saved view filter values cannot be empty");
      validateCatalogValues(field, values);
      return { field, operator, value: values };
    }
    const scalar = boundedString(input.value, `Saved view ${field} value`);
    validateCatalogValues(field, [scalar]);
    return { field, operator, value: scalar };
  }

  if (field === "estimate") {
    member(operator, numberOperators, "filter operator");
    if (operator === "is_empty") {
      rejectConditionValue(hasValue);
      return { field, operator };
    }
    if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
      throw new ValidationError("Saved view estimate value must be a finite number");
    }
    return { field, operator, value: input.value };
  }

  if (dateFields.has(field)) {
    const allowed = [
      ...dateOperators,
      ...(field === "due_date" ? ["overdue", "next_7_days"] as const : []),
      ...(field === "updated_at" ? ["recent"] as const : []),
    ];
    member(operator, allowed, "filter operator");
    if (operator === "is_empty" || operator === "overdue" || operator === "next_7_days") {
      rejectConditionValue(hasValue);
      return { field, operator };
    }
    if (operator === "recent") {
      if (
        typeof input.value !== "number" ||
        !Number.isFinite(input.value) ||
        input.value <= 0 ||
        input.value > 87_600
      ) {
        throw new ValidationError("Saved view recent window is invalid");
      }
      return { field, operator, value: input.value };
    }
    const date = boundedString(input.value, `Saved view ${field} date`);
    const parsedDate = new Date(`${date}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== date
    ) {
      throw new ValidationError("Saved view date must use YYYY-MM-DD");
    }
    return { field, operator, value: date };
  }

  if (field === "subtasks" || field === "archived") {
    member(operator, ["is", "is_not"], "filter operator");
    if (typeof input.value !== "boolean") {
      throw new ValidationError(`Saved view ${field} value must be boolean`);
    }
    return { field, operator, value: input.value };
  }

  member(operator, ["is", "is_not", "is_empty"], "filter operator");
  if (operator === "is_empty") {
    rejectConditionValue(hasValue);
    return { field, operator };
  }
  const relation = object(input.value, "Saved view relation value");
  rejectUnknownKeys(relation, new Set(["type", "direction"]), "Saved view relation value");
  return {
    field,
    operator,
    value: {
      type: member(relation.type, ["any", "blocks", "related", "duplicate_of"], "relation type"),
      direction: member(relation.direction, ["outgoing", "incoming", "either"], "relation direction"),
    } satisfies ViewFilterRelationValue,
  };
}

function validateCatalogValues(field: ViewFilterField, values: string[]) {
  if (field === "priority" && values.some((value) => !PRIORITIES.includes(value as Priority))) {
    throw new ValidationError("Saved view priority is invalid");
  }
  if (field === "status_category" && values.some(
    (value) => !STATUS_CATEGORIES.includes(value as typeof STATUS_CATEGORIES[number]),
  )) {
    throw new ValidationError("Saved view status category is invalid");
  }
}

function rejectConditionValue(hasValue: boolean) {
  if (hasValue) throw new ValidationError("Saved view empty or relative filter must omit value");
}

function searchValue(value: unknown) {
  if (typeof value !== "string" || value.length > 500) {
    throw new ValidationError("Saved view search must be 500 characters or fewer");
  }
  return value;
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
    return emptyViewQuery();
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

function boundedString(value: unknown, label: string): string {
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
