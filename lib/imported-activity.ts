export type PlannedHistoricalActivityEvent = {
  id: string;
  taskId: string;
  eventType: "status_changed";
  actorName: string;
  payloadJson: string;
  sourceRecordId: string;
  sourceEventId: string | null;
  sourceIndex: number;
  createdAt: string;
};

export type PlannedActivityMigrationOutcome = {
  id: string;
  taskId: string;
  source: "linear";
  sourceRecordId: string;
  sourceEventId: string | null;
  sourceIndex: number;
  outcome: "migrated" | "exception";
  reason: string | null;
  activityEventId: string | null;
  rawJson: string;
  reconciledAt: string;
};

export function planImportedActivity(input: {
  taskId: string;
  sourceRecordId: string;
  stateHistory: unknown;
  reconciledAt: string;
}) {
  if (!Array.isArray(input.stateHistory)) {
    return {
      events: [] as PlannedHistoricalActivityEvent[],
      outcomes: [exception(input, -1, null, "invalid_activity_collection", input.stateHistory)],
    };
  }
  const events: PlannedHistoricalActivityEvent[] = [];
  const outcomes: PlannedActivityMigrationOutcome[] = [];
  for (const [sourceIndex, value] of input.stateHistory.entries()) {
    const parsed = parseHistoricalStatus(value);
    if ("reason" in parsed) {
      outcomes.push(exception(
        input,
        sourceIndex,
        parsed.sourceEventId,
        parsed.reason,
        value,
      ));
      continue;
    }
    const id = eventId(input.sourceRecordId, sourceIndex);
    const actorName = parsed.actorName ?? "Unknown Linear user";
    events.push({
      id,
      taskId: input.taskId,
      eventType: "status_changed",
      actorName,
      payloadJson: JSON.stringify({
        changes: {
          status: { before: parsed.previousStateName, after: parsed.stateName },
        },
        sourceTimestamp: parsed.sourceTimestamp,
      }),
      sourceRecordId: input.sourceRecordId,
      sourceEventId: parsed.sourceEventId,
      sourceIndex,
      createdAt: parsed.createdAt,
    });
    outcomes.push({
      id: outcomeId(input.sourceRecordId, sourceIndex),
      taskId: input.taskId,
      source: "linear",
      sourceRecordId: input.sourceRecordId,
      sourceEventId: parsed.sourceEventId,
      sourceIndex,
      outcome: "migrated",
      reason: parsed.actorName ? null : "actor_name_missing",
      activityEventId: id,
      rawJson: safeJson(value),
      reconciledAt: input.reconciledAt,
    });
  }
  return { events, outcomes };
}

function parseHistoricalStatus(value: unknown): {
  sourceEventId: string | null;
  stateName: string;
  previousStateName: string | null;
  actorName: string | null;
  sourceTimestamp: string;
  createdAt: string;
} | { reason: string; sourceEventId: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "activity_not_object", sourceEventId: null };
  }
  const row = value as Record<string, unknown>;
  const sourceEventId = boundedString(row.id, 500);
  const stateName = nestedName(row.state) ?? nestedName(row.toState) ?? nestedName(row.to);
  if (!stateName) return { reason: "status_name_missing", sourceEventId };
  const sourceTimestamp = stringValue(row.createdAt) ?? stringValue(row.updatedAt)
    ?? stringValue(row.timestamp);
  if (!sourceTimestamp) return { reason: "activity_timestamp_missing", sourceEventId };
  const milliseconds = Date.parse(sourceTimestamp);
  if (!Number.isFinite(milliseconds)) {
    return { reason: "activity_timestamp_invalid", sourceEventId };
  }
  return {
    sourceEventId,
    stateName,
    previousStateName: nestedName(row.fromState) ?? nestedName(row.from)
      ?? nestedName(row.previousState),
    actorName: nestedName(row.actor) ?? nestedName(row.user) ?? nestedName(row.creator),
    sourceTimestamp,
    createdAt: new Date(milliseconds).toISOString(),
  };
}

function exception(
  input: { taskId: string; sourceRecordId: string; reconciledAt: string },
  sourceIndex: number,
  sourceEventId: string | null,
  reason: string,
  raw: unknown,
): PlannedActivityMigrationOutcome {
  return {
    id: outcomeId(input.sourceRecordId, sourceIndex),
    taskId: input.taskId,
    source: "linear",
    sourceRecordId: input.sourceRecordId,
    sourceEventId,
    sourceIndex,
    outcome: "exception",
    reason,
    activityEventId: null,
    rawJson: safeJson(raw),
    reconciledAt: input.reconciledAt,
  };
}

function eventId(sourceRecordId: string, sourceIndex: number) {
  return `linear:activity:${sourceRecordId}:${sourceIndex}`;
}

function outcomeId(sourceRecordId: string, sourceIndex: number) {
  return `linear:activity-outcome:${sourceRecordId}:${sourceIndex}`;
}

function nestedName(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? boundedString((value as Record<string, unknown>).name, 500)
    : null;
}

function boundedString(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim() && value.length <= maximum
    ? value.trim()
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ unstringifiable: true });
  }
}
