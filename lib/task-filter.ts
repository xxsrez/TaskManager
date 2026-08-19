import type {
  CanonicalViewQuery,
  StatusCategory,
  TaskLabelAssignment,
  TaskRecord,
  TaskRelationRecord,
  ViewFilterCondition,
  ViewFilterField,
  ViewFilterLabelGroupValue,
  ViewFilterRelationValue,
  ViewQuery,
  WorkflowStatusRecord,
} from "./types";
import { emptyViewQuery, validateViewQuery } from "./view-contract";

export type TaskFilterSql = {
  sql: string;
  parameters: unknown[];
};

export type TaskFilterCompileOptions = {
  alias?: string;
  timezone?: string;
  referenceTime?: Date;
  searchMode?: "contains" | "prefix";
};

export function canonicalViewQuery(query: ViewQuery | null | undefined) {
  return validateViewQuery(query ?? emptyViewQuery());
}

export function mergeViewQueries(
  base: ViewQuery | null | undefined,
  temporary: ViewQuery | null | undefined,
): CanonicalViewQuery {
  const left = canonicalViewQuery(base);
  const right = canonicalViewQuery(temporary);
  return {
    version: 1,
    op: "all",
    conditions: [...left.conditions, ...right.conditions],
    ...((right.search ?? left.search) ? { search: right.search ?? left.search } : {}),
  };
}

export function taskFilterSql(
  query: ViewQuery,
  options: TaskFilterCompileOptions = {},
): TaskFilterSql {
  const canonical = canonicalViewQuery(query);
  const alias = options.alias ?? "v";
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid SQL alias");
  const timezone = safeTimezone(options.timezone);
  const referenceTime = options.referenceTime ?? new Date();
  const predicates: string[] = [];
  const parameters: unknown[] = [];

  for (const condition of canonical.conditions) {
    const compiled = compileCondition(condition, alias, timezone, referenceTime);
    predicates.push(compiled.sql);
    parameters.push(...compiled.parameters);
  }
  const search = canonical.search?.trim().toLocaleLowerCase();
  if (search) {
    if (options.searchMode === "prefix") {
      const [start, end] = prefixRange(search);
      predicates.push(`(
        (lower(${alias}.title) >= ? AND lower(${alias}.title) < ?)
        OR (lower(${alias}.identifier) >= ? AND lower(${alias}.identifier) < ?)
        OR EXISTS (
          SELECT 1 FROM task_identifier_aliases filter_alias
          WHERE filter_alias.task_id = ${alias}.id
            AND lower(filter_alias.identifier) >= ?
            AND lower(filter_alias.identifier) < ?
        )
      )`);
      parameters.push(start, end, start, end, start, end);
    } else {
      predicates.push(`(
        instr(lower(${alias}.identifier), ?) > 0
        OR EXISTS (
          SELECT 1 FROM task_identifier_aliases filter_alias
          WHERE filter_alias.task_id = ${alias}.id
            AND instr(lower(filter_alias.identifier), ?) > 0
        )
        OR instr(lower(${alias}.title), ?) > 0
        OR instr(lower(COALESCE(${alias}.description, '')), ?) > 0
      )`);
      parameters.push(search, search, search, search);
    }
  }
  return {
    sql: predicates.length ? predicates.join(" AND ") : "1 = 1",
    parameters,
  };
}

function compileCondition(
  condition: ViewFilterCondition,
  alias: string,
  timezone: string,
  referenceTime: Date,
): TaskFilterSql {
  const columns: Partial<Record<ViewFilterField, string>> = {
    status: `${alias}.status_id`,
    status_category: `${alias}.status_category`,
    priority: `${alias}.priority`,
    assignee: `${alias}.assignee_user_id`,
    project: `${alias}.project_id`,
    release: `${alias}.release_id`,
    estimate: `${alias}.estimate`,
    due_date: `${alias}.due_date`,
    parent: `${alias}.parent_task_id`,
    created_at: `${alias}.created_at`,
    updated_at: `${alias}.updated_at`,
    started_at: `${alias}.started_at`,
    completed_at: `${alias}.completed_at`,
    canceled_at: `${alias}.canceled_at`,
    archived: `${alias}.archived_at`,
  };
  const column = columns[condition.field];

  if (condition.field === "label") {
    return existenceCondition(
      `SELECT 1 FROM task_labels filter_label
       WHERE filter_label.task_id = ${alias}.id`,
      "filter_label.label_id",
      condition,
    );
  }
  if (condition.field === "label_group") {
    const value = condition.value as ViewFilterLabelGroupValue;
    const parameters: unknown[] = [value.groupId];
    let exists = `EXISTS (SELECT 1 FROM task_label_group_values filter_group
      WHERE filter_group.task_id = ${alias}.id AND filter_group.group_id = ?`;
    if (value.mode === "values") {
      const ids = value.labelIds ?? [];
      exists += ` AND filter_group.label_id IN (${ids.map(() => "?").join(", ")})`;
      parameters.push(...ids);
    }
    exists += ")";
    const positive = value.mode === "none" ? `NOT ${exists}` : exists;
    return { sql: condition.operator === "is_not" ? `NOT (${positive})` : positive, parameters };
  }
  if (condition.field === "subtasks") {
    const present = condition.value === true;
    const exists = `EXISTS (SELECT 1 FROM tasks filter_child WHERE filter_child.parent_task_id = ${alias}.id)`;
    const positive = condition.operator === "is" ? present : !present;
    return { sql: positive ? exists : `NOT ${exists}`, parameters: [] };
  }
  if (condition.field === "relation") {
    const base = relationPredicate(alias, condition.value as ViewFilterRelationValue | undefined);
    const positive = condition.operator === "is";
    return {
      sql: condition.operator === "is_empty" || !positive ? `NOT EXISTS (${base.sql})` : `EXISTS (${base.sql})`,
      parameters: base.parameters,
    };
  }
  if (condition.field === "archived") {
    const present = condition.value === true;
    const positive = condition.operator === "is" ? present : !present;
    return { sql: `${column} IS ${positive ? "NOT " : ""}NULL`, parameters: [] };
  }
  if (!column) throw new Error(`Unsupported task filter field: ${condition.field}`);

  if (condition.operator === "is_empty") {
    return { sql: `${column} IS NULL`, parameters: [] };
  }
  if (condition.operator === "overdue" || condition.operator === "next_7_days") {
    const today = localDate(referenceTime, timezone);
    if (condition.operator === "overdue") {
      return {
        sql: `${column} IS NOT NULL AND ${column} < ? AND ${alias}.completed_at IS NULL AND ${alias}.canceled_at IS NULL`,
        parameters: [today],
      };
    }
    return {
      sql: `${column} >= ? AND ${column} <= ?`,
      parameters: [today, addUtcDays(today, 7)],
    };
  }
  if (condition.operator === "recent") {
    const cutoff = new Date(referenceTime.getTime() - Number(condition.value) * 3_600_000);
    return { sql: `datetime(${column}) >= datetime(?)`, parameters: [cutoff.toISOString()] };
  }
  if (["on", "before", "after", "on_or_before", "on_or_after"].includes(condition.operator)) {
    return dateCondition(
      column,
      String(condition.value),
      condition.operator,
      condition.field === "due_date",
      timezone,
    );
  }
  if (["eq", "neq", "gt", "gte", "lt", "lte"].includes(condition.operator)) {
    const sqlOperators: Record<string, string> = {
      eq: "=",
      neq: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
    };
    const sqlOperator = sqlOperators[condition.operator]!;
    return {
      sql: condition.operator === "neq"
        ? `(${column} IS NULL OR ${column} ${sqlOperator} ?)`
        : `${column} ${sqlOperator} ?`,
      parameters: [condition.value],
    };
  }
  return scalarCondition(column, condition);
}

function scalarCondition(column: string, condition: ViewFilterCondition): TaskFilterSql {
  if (condition.operator === "in" || condition.operator === "not_in") {
    const values = condition.value as string[];
    const placeholders = values.map(() => "?").join(", ");
    return {
      sql: condition.operator === "in"
        ? `${column} IN (${placeholders})`
        : `(${column} IS NULL OR ${column} NOT IN (${placeholders}))`,
      parameters: values,
    };
  }
  return {
    sql: condition.operator === "is"
      ? `${column} = ?`
      : `(${column} IS NULL OR ${column} <> ?)`,
    parameters: [condition.value],
  };
}

function existenceCondition(
  baseSql: string,
  valueColumn: string,
  condition: ViewFilterCondition,
): TaskFilterSql {
  if (condition.operator === "is_empty") {
    return { sql: `NOT EXISTS (${baseSql})`, parameters: [] };
  }
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  const placeholders = values.map(() => "?").join(", ");
  const exists = `EXISTS (${baseSql} AND ${valueColumn} IN (${placeholders}))`;
  return {
    sql: condition.operator === "is" || condition.operator === "in" ? exists : `NOT ${exists}`,
    parameters: values,
  };
}

function relationPredicate(alias: string, value?: ViewFilterRelationValue) {
  const predicates = [
    value?.direction === "outgoing"
      ? `filter_relation.source_task_id = ${alias}.id`
      : value?.direction === "incoming"
        ? `filter_relation.target_task_id = ${alias}.id`
        : `(filter_relation.source_task_id = ${alias}.id OR filter_relation.target_task_id = ${alias}.id)`,
  ];
  const parameters: unknown[] = [];
  if (value?.type && value.type !== "any") {
    predicates.push("filter_relation.type = ?");
    parameters.push(value.type);
  }
  return {
    sql: `SELECT 1 FROM task_relations filter_relation WHERE ${predicates.join(" AND ")}`,
    parameters,
  };
}

function dateCondition(
  column: string,
  date: string,
  operator: ViewFilterCondition["operator"],
  calendarColumn: boolean,
  timezone: string,
): TaskFilterSql {
  if (calendarColumn) {
    const sqlOperators: Record<string, string> = {
      on: "=",
      before: "<",
      after: ">",
      on_or_before: "<=",
      on_or_after: ">=",
    };
    const sqlOperator = sqlOperators[operator]!;
    return { sql: `${column} ${sqlOperator} ?`, parameters: [date] };
  }
  const start = zonedDateBoundary(date, timezone);
  const end = zonedDateBoundary(addUtcDays(date, 1), timezone);
  if (operator === "on") {
    return { sql: `datetime(${column}) >= datetime(?) AND datetime(${column}) < datetime(?)`, parameters: [start, end] };
  }
  if (operator === "before") return { sql: `datetime(${column}) < datetime(?)`, parameters: [start] };
  if (operator === "after") return { sql: `datetime(${column}) >= datetime(?)`, parameters: [end] };
  if (operator === "on_or_before") return { sql: `datetime(${column}) < datetime(?)`, parameters: [end] };
  return { sql: `datetime(${column}) >= datetime(?)`, parameters: [start] };
}

function safeTimezone(value: string | undefined) {
  const timezone = value || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return "UTC";
  }
}

function prefixRange(value: string): [string, string] {
  return [value, `${value}\uffff`];
}

function localDate(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addUtcDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function zonedDateBoundary(date: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  let guess = Date.UTC(year!, month! - 1, day!);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(rendered.find((item) => item.type === type)?.value ?? 0);
    const represented = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    guess += Date.UTC(year!, month! - 1, day!) - represented;
  }
  return new Date(guess).toISOString();
}

export function queryExplicitlyFiltersArchived(query: ViewQuery) {
  return canonicalViewQuery(query).conditions.some((condition) => condition.field === "archived");
}

export function encodeTemporaryViewQuery(query: ViewQuery) {
  const canonical = canonicalViewQuery(query);
  if (!canonical.conditions.length && !canonical.search) return "";
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeTemporaryViewQuery(value: string | null) {
  if (!value || value.length > 12_000) return emptyViewQuery();
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return validateViewQuery(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch {
    return emptyViewQuery();
  }
}

export function taskMatchesViewQuery(
  task: TaskRecord,
  query: ViewQuery,
  context: {
    statuses?: WorkflowStatusRecord[];
    taskLabels?: TaskLabelAssignment[];
    relations?: TaskRelationRecord[];
    tasks?: TaskRecord[];
    referenceTime?: Date;
    timezone?: string;
  } = {},
) {
  const canonical = canonicalViewQuery(query);
  const needle = canonical.search?.trim().toLocaleLowerCase();
  if (needle && !`${task.identifier}\n${task.title}\n${task.description ?? ""}`.toLocaleLowerCase().includes(needle)) {
    return false;
  }
  const status = context.statuses?.find((item) => item.id === task.statusId);
  const values: Partial<Record<ViewFilterCondition["field"], unknown>> = {
    status: task.statusId,
    status_category: status?.category as StatusCategory | undefined,
    priority: task.priority,
    assignee: task.assigneeUserId,
    project: task.projectId,
    release: task.releaseId,
    estimate: task.estimate,
    due_date: task.dueDate,
    parent: task.parentTaskId,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt,
    completed_at: task.completedAt,
    canceled_at: task.canceledAt,
    archived: Boolean(task.archivedAt),
  };
  return canonical.conditions.every((condition) => {
    if (condition.field === "label") {
      const labels = context.taskLabels?.filter((item) => item.taskId === task.id).map((item) => item.labelId) ?? [];
      return matchCollection(labels, condition);
    }
    if (condition.field === "subtasks") {
      const has = context.tasks?.some((item) => item.parentTaskId === task.id) ?? false;
      return condition.operator === "is" ? has === condition.value : has !== condition.value;
    }
    if (condition.field === "relation") {
      const has = context.relations?.some((relation) => relationMatches(task.id, relation, condition.value as ViewFilterRelationValue | undefined)) ?? false;
      return condition.operator === "is" ? has : !has;
    }
    return matchScalar(values[condition.field], condition, task, context);
  });
}

function matchCollection(values: string[], condition: ViewFilterCondition) {
  if (condition.operator === "is_empty") return values.length === 0;
  const wanted = Array.isArray(condition.value) ? condition.value : [condition.value as string];
  const intersects = wanted.some((value) => values.includes(value));
  return condition.operator === "is" || condition.operator === "in" ? intersects : !intersects;
}

function matchScalar(
  actual: unknown,
  condition: ViewFilterCondition,
  task: TaskRecord,
  context: { referenceTime?: Date; timezone?: string },
) {
  if (condition.operator === "is_empty") return actual == null;
  if (condition.operator === "in" || condition.operator === "not_in") {
    const includes = (condition.value as string[]).includes(String(actual));
    return condition.operator === "in" ? includes : !includes;
  }
  if (condition.operator === "is" || condition.operator === "is_not") {
    const equal = actual === condition.value;
    return condition.operator === "is" ? equal : !equal;
  }
  if (["eq", "neq", "gt", "gte", "lt", "lte"].includes(condition.operator)) {
    if (actual == null) return condition.operator === "neq";
    const left = Number(actual);
    const right = Number(condition.value);
    return { eq: left === right, neq: left !== right, gt: left > right, gte: left >= right, lt: left < right, lte: left <= right }[condition.operator as "eq"];
  }
  if (actual == null) return false;
  const reference = context.referenceTime ?? new Date();
  const date = condition.field === "due_date"
    ? String(actual ?? "")
    : actual ? localDate(new Date(String(actual)), safeTimezone(context.timezone)) : "";
  const target = String(condition.value ?? "");
  if (condition.operator === "overdue") return Boolean(date && date < localDate(reference, safeTimezone(context.timezone)) && !task.completedAt && !task.canceledAt);
  if (condition.operator === "next_7_days") {
    const today = localDate(reference, safeTimezone(context.timezone));
    return date >= today && date <= addUtcDays(today, 7);
  }
  if (condition.operator === "recent") return Boolean(actual && new Date(String(actual)).getTime() >= reference.getTime() - Number(condition.value) * 3_600_000);
  return { on: date === target, before: date < target, after: date > target, on_or_before: date <= target, on_or_after: date >= target }[condition.operator as "on"];
}

function relationMatches(taskId: string, relation: TaskRelationRecord, value?: ViewFilterRelationValue) {
  const direction = relation.sourceTaskId === taskId ? "outgoing" : relation.targetTaskId === taskId ? "incoming" : null;
  return Boolean(direction && (!value || value.direction === "either" || value.direction === direction) && (!value || value.type === "any" || value.type === relation.type));
}
