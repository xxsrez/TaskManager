"use client";

import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Boxes,
  Check,
  CircleHelp,
  CircleDot,
  Columns3,
  Copy,
  Database,
  Download,
  FolderKanban,
  LayoutList,
  ListFilter,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  Plus,
  Rocket,
  RotateCw,
  Save,
  Search,
  SlidersHorizontal,
  Sun,
  Tag,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  canAssignRole,
  canEditContent,
  canManageGrant,
} from "@/lib/access";
import {
  isProjectTaskCode,
  normalizeProjectTaskCodeDraft,
  PROJECT_TASK_CODE_INPUT_PATTERN,
  suggestProjectTaskCode,
} from "@/lib/project-task-code";
import {
  type Layout,
  type SettingsSection,
} from "@/lib/navigation";
import {
  filterCatalogOptions,
  filterConditionValues,
  unavailableFilterLabel,
  unavailableFilterReferences,
} from "@/lib/filter-catalog";
import {
  emptyViewQuery,
} from "@/lib/view-contract";
import {
  canonicalViewQuery,
} from "@/lib/task-filter";
import {
  applySystemBackupImport,
  backupJobIsTerminal,
  backupImportIsFullyValidated,
  canApplySystemBackupImport,
  createSystemBackupExport,
  getBackupJobStatus,
  readBackupCheckpoint,
  retainBackupCheckpoint,
  runSystemBackupJob,
  safeBackupMessage,
  safeSystemBackupDownloadUrl,
  systemBackupImportCheckpointKey,
  systemBackupMediaType,
  systemBackupSafetyExportCheckpointKey,
  uploadSystemBackupPackage,
  writeBackupCheckpoint,
  type SystemBackupCheckpoint,
} from "@/lib/system-backup-client";
import {
  ProjectBackupManager,
} from "@/components/project-backup-manager";
import {
  RecentlyDeletedManager,
} from "@/components/recently-deleted-manager";
import type {
  AppSnapshot,
  LabelGroupRecord,
  LabelRecord,
  ProjectRecord,
  ProjectStatus,
  ReleaseRecord,
  ReleaseStatus,
  SavedViewRecord,
  StatusCategory,
  SystemBackupJobStatus,
  TeamGrantList,
  TeamGrantPermission,
  TeamGrantRecord,
  TeamList,
  TaskRelationRecord,
  UserRecord,
  UserProfile,
  ViewFilterCondition,
  ViewFilterField,
  ViewFilterLabelGroupValue,
  ViewFilterOperator,
  ViewDisplay,
  ViewQuery,
  WorkflowStatusRecord,
} from "@/lib/types";
import {
  TASK_MANAGER_CLI_SETUP,
  TASK_MANAGER_DIAGNOSTIC_PROMPT,
  TASK_MANAGER_MARKETPLACE_URL,
  TeamRequestError,
  filterShareTeamOptions,
  groupByOptions,
  nextCodexSetupMode,
  requestTeamApi,
  teamGrantConflictReadbackMessage,
  teamGrantResponseMatchesRoute,
  teamRequestIsCurrent,
  teamShareRequestIsCurrent,
  teamShareRouteIdentity,
  toggleViewField,
  type AsyncValue,
  type CodexSetupMode,
  type ShareContext,
  type SharePersonOption,
  type SharePrincipalOption,
  type ShareTeamOption,
  type TeamGrantAlert,
  type TeamGrantMutationState,
  type TeamShareRoute,
  viewDisplayDependencies,
  viewFieldOptions,
  viewOrderOptions,
} from "@/components/task-tracker-state";

export const filterFieldOptions: Array<{ value: ViewFilterField; label: string }> = [
  { value: "status", label: "Status" },
  { value: "status_category", label: "Status category" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "project", label: "Project" },
  { value: "release", label: "Release" },
  { value: "label", label: "Label" },
  { value: "label_group", label: "Label group" },
  { value: "estimate", label: "Estimate" },
  { value: "due_date", label: "Due date" },
  { value: "parent", label: "Parent" },
  { value: "subtasks", label: "Subtasks" },
  { value: "relation", label: "Relation" },
  { value: "created_at", label: "Created date" },
  { value: "updated_at", label: "Updated date" },
  { value: "started_at", label: "Started date" },
  { value: "completed_at", label: "Completed date" },
  { value: "canceled_at", label: "Canceled date" },
  { value: "archived", label: "Archived" },
];

export const filterOperatorLabels: Record<ViewFilterOperator, string> = {
  is: "is",
  is_not: "is not",
  in: "is any of",
  not_in: "is not any of",
  is_empty: "is empty",
  eq: "equals",
  neq: "does not equal",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  on: "is on",
  before: "is before",
  after: "is after",
  on_or_before: "is on or before",
  on_or_after: "is on or after",
  overdue: "is overdue",
  next_7_days: "is in the next 7 days",
  recent: "was updated recently",
};

export function queryFilterCount(query: ViewQuery | undefined) {
  const canonical = canonicalViewQuery(query);
  return canonical.conditions.length + (canonical.search?.trim() ? 1 : 0);
}

export function FilterLayerSummary({ data, query, emptyCopy, scopeProjectId = null }: {
  data: AppSnapshot;
  query: ViewQuery;
  emptyCopy: string;
  scopeProjectId?: string | null;
}) {
  const canonical = canonicalViewQuery(query);
  if (!queryFilterCount(canonical)) {
    return <p className="filter-layer-empty">{emptyCopy}</p>;
  }
  return <div className="filter-layer-summary" aria-label="Filter formula summary">
    {canonical.search?.trim() && <span>Search contains “{canonical.search.trim()}”</span>}
    {canonical.conditions.map((condition, index) => (
      <span key={`${condition.field}:${index}`}>{filterConditionSummary(condition, data, scopeProjectId)}</span>
    ))}
  </div>;
}

export function SavedViewFilterLayers({
  data,
  savedView,
  temporaryQuery,
  onTemporaryQuery,
  onEditSaved,
  scopeProjectId = null,
  compact = false,
}: {
  data: AppSnapshot;
  savedView?: SavedViewRecord;
  temporaryQuery: ViewQuery;
  onTemporaryQuery: (query: ViewQuery) => void;
  onEditSaved?: () => void;
  scopeProjectId?: string | null;
  compact?: boolean;
}) {
  return <div className={`filter-layers ${compact ? "compact" : ""}`}>
    {savedView && <section className="filter-layer saved-filter-layer" aria-label={`Saved in ${savedView.name}`}>
      <header>
        <span><Save size={13} />Saved in {savedView.name}</span>
        {onEditSaved && <button type="button" className="button ghost compact" onClick={onEditSaved}>Edit</button>}
      </header>
      <FilterLayerSummary data={data} query={savedView.query} emptyCopy="No saved filters" scopeProjectId={savedView.scopeProjectId} />
    </section>}
    <section className="filter-layer temporary-filter-layer" aria-label="Temporary filters">
      <header><span><ListFilter size={13} />Temporary filters</span></header>
      <FilterLayerSummary data={data} query={temporaryQuery} emptyCopy="No temporary filters" scopeProjectId={scopeProjectId} />
      <FilterConditionEditor
        data={data}
        query={temporaryQuery}
        onQuery={onTemporaryQuery}
        compact={compact}
        scopeProjectId={scopeProjectId}
        clearLabel="Clear temporary"
      />
    </section>
  </div>;
}

export function FilterPopover({ data, savedView, temporaryQuery, onTemporaryQuery, onEditSaved, scopeProjectId = null, onClose }: {
  data: AppSnapshot;
  savedView?: SavedViewRecord;
  temporaryQuery: ViewQuery;
  onTemporaryQuery: (query: ViewQuery) => void;
  onEditSaved?: () => void;
  scopeProjectId?: string | null;
  onClose: () => void;
}) {
  return <Popover title="Filter" className="filter-popover" onClose={onClose}>
    <SavedViewFilterLayers
      data={data}
      savedView={savedView}
      temporaryQuery={temporaryQuery}
      onTemporaryQuery={onTemporaryQuery}
      onEditSaved={onEditSaved}
      scopeProjectId={scopeProjectId}
    />
  </Popover>;
}

export function handleFilterPickerEscape(
  event: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">,
  closePicker: () => void,
) {
  if (event.key !== "Escape") return false;
  event.preventDefault();
  event.stopPropagation();
  closePicker();
  return true;
}

export function FilterConditionEditor({ data, query, onQuery, scopeProjectId = null, compact = false, clearLabel = "Clear all" }: {
  data: AppSnapshot;
  query: ViewQuery;
  onQuery: (query: ViewQuery) => void;
  scopeProjectId?: string | null;
  compact?: boolean;
  clearLabel?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [propertySearch, setPropertySearch] = useState("");
  const [activeFieldIndex, setActiveFieldIndex] = useState(0);
  const [focusConditionIndex, setFocusConditionIndex] = useState<number | null>(null);
  const addFilterRef = useRef<HTMLButtonElement>(null);
  const fieldButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const builderRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const canonical = canonicalViewQuery(query);
  const needle = propertySearch.trim().toLocaleLowerCase();
  const availableFields = filterFieldOptions.filter((field) => field.value !== "label_group" || (data.labelGroups ?? []).length > 0);
  const fields = needle
    ? availableFields.filter((field) => field.label.toLocaleLowerCase().includes(needle))
    : availableFields;
  const replaceConditions = (conditions: ViewFilterCondition[]) => onQuery({
    version: 1,
    op: "all",
    conditions,
    ...(canonical.search?.trim() ? { search: canonical.search } : {}),
  });
  const replaceSearch = (search: string) => onQuery({
    version: 1,
    op: "all",
    conditions: canonical.conditions,
    ...(search.trim() ? { search } : {}),
  });
  const add = (field: ViewFilterField) => {
    const nextIndex = canonical.conditions.length;
    replaceConditions([...canonical.conditions, defaultFilterCondition(field, data, scopeProjectId)]);
    setPropertySearch("");
    setPickerOpen(false);
    setFocusConditionIndex(nextIndex);
  };
  const closePicker = () => {
    setPickerOpen(false);
    setPropertySearch("");
    setActiveFieldIndex(0);
    window.requestAnimationFrame(() => addFilterRef.current?.focus());
  };
  const focusField = (index: number) => {
    if (!fields.length) return;
    const next = (index + fields.length) % fields.length;
    setActiveFieldIndex(next);
    window.requestAnimationFrame(() => fieldButtonRefs.current[next]?.focus());
  };
  useEffect(() => {
    if (focusConditionIndex === null) return;
    const row = builderRef.current?.querySelectorAll<HTMLElement>("[data-filter-condition]")[focusConditionIndex];
    const nextControl = row?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!nextControl) return;
    nextControl.focus();
    setFocusConditionIndex(null);
  }, [canonical.conditions.length, focusConditionIndex]);
  return <div ref={builderRef} className={`filter-builder ${compact ? "compact" : ""}`}>
    {queryFilterCount(canonical) > 0 && <div className="filter-formula" aria-label="Active filter formula">
      <span className="filter-formula-operator">AND</span>
      {canonical.search?.trim() && <div className="filter-condition-row filter-search-row">
        <b>Search</b>
        <span className="filter-search-operator" aria-label="Search operator">contains</span>
        <input
          type="search"
          aria-label="Search text"
          maxLength={500}
          value={canonical.search}
          onChange={(event) => replaceSearch(event.target.value)}
        />
        <button type="button" className="icon-button quiet" aria-label="Remove search filter" onClick={() => replaceSearch("")}><X size={13} /></button>
      </div>}
      {canonical.conditions.map((condition, index) => <div className="filter-condition-row" data-filter-condition key={`${condition.field}:${index}`}>
        <b>{filterFieldOptions.find((field) => field.value === condition.field)?.label ?? condition.field}</b>
        <select aria-label={`${condition.field} operator`} value={condition.operator} onChange={(event) => {
          const operator = event.target.value as ViewFilterOperator;
          const next = [...canonical.conditions];
          next[index] = {
            field: condition.field,
            operator,
            ...filterConditionValue(condition.field, operator, data, condition.value, scopeProjectId),
          };
          replaceConditions(next);
        }}>{filterOperators(condition.field).map((operator) => <option key={operator} value={operator}>{filterOperatorLabels[operator]}</option>)}</select>
        <FilterValueEditor condition={condition} data={data} scopeProjectId={scopeProjectId} onChange={(value) => {
          const next = [...canonical.conditions];
          next[index] = value === undefined
            ? { field: condition.field, operator: condition.operator }
            : { ...condition, value };
          replaceConditions(next);
        }} />
        <button type="button" className="icon-button quiet" aria-label={`Remove ${condition.field} filter`} onClick={() => replaceConditions(canonical.conditions.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button>
      </div>)}
      <button className="button ghost popover-clear" type="button" onClick={() => onQuery({ version: 1, op: "all", conditions: [] })}>{clearLabel}</button>
    </div>}
    <button ref={addFilterRef} className="button ghost filter-add" type="button" aria-expanded={pickerOpen} aria-controls={pickerOpen ? menuId : undefined} onClick={() => { setPickerOpen((current) => !current); setActiveFieldIndex(0); }}><Plus size={13} />Add filter</button>
    {pickerOpen && <div className="filter-property-picker">
      <label className="filter-property-search"><Search size={13} /><input autoFocus type="search" value={propertySearch} onChange={(event) => { setPropertySearch(event.target.value); setActiveFieldIndex(0); }} onKeyDown={(event) => {
        if (handleFilterPickerEscape(event, closePicker)) return;
        if (event.key === "ArrowDown") { event.preventDefault(); focusField(activeFieldIndex); }
        if (event.key === "ArrowUp") { event.preventDefault(); focusField(activeFieldIndex - 1); }
        if (event.key === "Enter" && fields[activeFieldIndex]) { event.preventDefault(); add(fields[activeFieldIndex].value); }
      }} placeholder="Search properties…" aria-label="Search filter properties" aria-controls={menuId} /></label>
      <div id={menuId} className="filter-property-grid" role="menu" aria-label="Filter properties">
        {fields.map((field, index) => <button ref={(element) => { fieldButtonRefs.current[index] = element; }} type="button" role="menuitem" key={field.value} onClick={() => add(field.value)} onFocus={() => setActiveFieldIndex(index)} onKeyDown={(event) => {
          if (handleFilterPickerEscape(event, closePicker)) return;
          if (event.key === "ArrowDown") { event.preventDefault(); focusField(index + 1); }
          if (event.key === "ArrowUp") { event.preventDefault(); focusField(index - 1); }
        }}>{field.label}</button>)}
        {!fields.length && <p role="status">No matching properties.</p>}
      </div>
    </div>}
  </div>;
}

export function FilterValueEditor({ condition, data, scopeProjectId, onChange }: {
  condition: ViewFilterCondition;
  data: AppSnapshot;
  scopeProjectId: string | null;
  onChange: (value: ViewFilterCondition["value"] | undefined) => void;
}) {
  if (["is_empty", "overdue", "next_7_days"].includes(condition.operator)) return null;
  if (condition.field === "relation") {
    const value = condition.value as { type: TaskRelationRecord["type"] | "any"; direction: "outgoing" | "incoming" | "either" };
    return <span className="filter-relation-value"><select aria-label="Relation type" value={value.type} onChange={(event) => onChange({ ...value, type: event.target.value as typeof value.type })}><option value="any">Any relation</option><option value="blocks">Blocks</option><option value="related">Related</option><option value="duplicate_of">Duplicate of</option></select><select aria-label="Relation direction" value={value.direction} onChange={(event) => onChange({ ...value, direction: event.target.value as typeof value.direction })}><option value="either">Either direction</option><option value="outgoing">Outgoing</option><option value="incoming">Incoming</option></select></span>;
  }
  if (condition.field === "label_group") {
    const value = condition.value as ViewFilterLabelGroupValue;
    const groups = data.labelGroups ?? [];
    const availableLabels = data.labels.filter((label) => label.groupId === value.groupId);
    const groupAvailable = groups.some((group) => group.id === value.groupId);
    const displayedGroupId = groupAvailable ? value.groupId : "__unavailable_label_group";
    return <span className="filter-relation-value"><select aria-label="Label Group" value={displayedGroupId} onChange={(event) => onChange({ groupId: event.target.value, mode: "any" })}>{!groupAvailable && <option value="__unavailable_label_group" disabled>Unavailable label group</option>}{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select><select aria-label="Label Group match" value={value.mode} onChange={(event) => { const mode = event.target.value as ViewFilterLabelGroupValue["mode"]; onChange({ groupId: value.groupId, mode, ...(mode === "values" ? { labelIds: availableLabels[0] ? [availableLabels[0].id] : [] } : {}) }); }}><option value="any">Any value</option><option value="values">Selected values</option><option value="none">No value</option></select>{value.mode === "values" && <select multiple aria-label="Label Group values" value={value.labelIds ?? []} onChange={(event) => onChange({ ...value, labelIds: [...event.currentTarget.selectedOptions].map((option) => option.value) })}>{availableLabels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select>}</span>;
  }
  if (condition.field === "subtasks" || condition.field === "archived") {
    return <select aria-label={`${condition.field} value`} value={String(condition.value)} onChange={(event) => onChange(event.target.value === "true")}><option value="true">Yes</option><option value="false">No</option></select>;
  }
  if (condition.field === "estimate" || condition.operator === "recent") {
    return <input aria-label={`${condition.field} value`} type="number" min={condition.operator === "recent" ? 1 : undefined} step="1" value={Number(condition.value)} onChange={(event) => onChange(Number(event.target.value))} />;
  }
  if (["due_date", "created_at", "updated_at", "started_at", "completed_at", "canceled_at"].includes(condition.field)) {
    return <input aria-label={`${condition.field} date`} type="date" value={String(condition.value ?? "")} onChange={(event) => onChange(event.target.value)} />;
  }
  const options = filterCatalogOptions(condition.field, data, scopeProjectId);
  const selectedValues = filterConditionValues(condition);
  const missingValues = selectedValues.filter((value) => value && !options.some((option) => option.value === value));
  const unavailableOptions = missingValues.map((persistedValue, index) => ({
    value: `__unavailable_${condition.field}_${index}`,
    persistedValue,
    label: unavailableFilterLabel(condition.field),
    unavailable: true,
  }));
  const unavailableValues = new Map(
    unavailableOptions.map((option) => [option.value, option.persistedValue]),
  );
  const valueOptions = [
    ...unavailableOptions,
    ...options.map((option) => ({ ...option, persistedValue: option.value, unavailable: false })),
  ];
  if (condition.operator === "in" || condition.operator === "not_in") {
    const selected = new Set(Array.isArray(condition.value) ? condition.value : []);
    const displayed = [...selected].map((value) =>
      unavailableOptions.find((option) => option.persistedValue === value)?.value ?? String(value)
    );
    return <select multiple aria-label={`${condition.field} values`} value={displayed} onChange={(event) => onChange([...event.currentTarget.selectedOptions].map((option) => unavailableValues.get(option.value) ?? option.value))}>{valueOptions.map((option) => <option key={option.value} value={option.value} disabled={option.unavailable}>{option.label}</option>)}</select>;
  }
  const displayed = unavailableOptions[0]?.value ?? String(condition.value ?? "");
  return <select aria-label={`${condition.field} value`} value={displayed} onChange={(event) => onChange(unavailableValues.get(event.target.value) ?? event.target.value)}>{valueOptions.map((option) => <option key={option.value} value={option.value} disabled={option.unavailable}>{option.label}</option>)}</select>;
}

export function FilterChips({ data, query, scopeProjectId, onQuery, onEdit }: {
  data: AppSnapshot;
  query: ViewQuery;
  scopeProjectId?: string | null;
  onQuery: (query: ViewQuery) => void;
  onEdit: () => void;
}) {
  const canonical = canonicalViewQuery(query);
  const remove = (index: number) => onQuery({ version: 1, op: "all", conditions: canonical.conditions.filter((_, itemIndex) => itemIndex !== index), ...(canonical.search?.trim() ? { search: canonical.search } : {}) });
  return <div className="filter-chip-list temporary" aria-label="Temporary filters"><span className="filter-chip-layer-label">Temporary</span>{canonical.conditions.map((condition, index) => <span className="filter-chip" key={`${condition.field}:${index}`}><button type="button" onClick={onEdit}>{filterConditionSummary(condition, data, scopeProjectId)}</button><button type="button" aria-label={`Remove ${condition.field} filter`} onClick={() => remove(index)}><X size={11} /></button></span>)}<button className="filter-clear-all" type="button" onClick={() => onQuery(emptyViewQuery())}>Clear temporary</button></div>;
}

export function SavedFilterChips({ data, view, onEdit }: {
  data: AppSnapshot;
  view: SavedViewRecord;
  onEdit?: () => void;
}) {
  const canonical = canonicalViewQuery(view.query);
  if (!queryFilterCount(canonical)) return null;
  return <div className="filter-chip-list saved" aria-label={`Saved in ${view.name}`}>
    <span className="filter-chip-layer-label"><Save size={11} />Saved in {view.name}</span>
    {canonical.search?.trim() && <span className="filter-chip saved-filter-chip"><button type="button" onClick={onEdit}>Search contains “{canonical.search.trim()}”</button></span>}
    {canonical.conditions.map((condition, index) => <span className="filter-chip saved-filter-chip" key={`${condition.field}:${index}`}><button type="button" onClick={onEdit}>{filterConditionSummary(condition, data, view.scopeProjectId)}</button></span>)}
  </div>;
}

export function filterOperators(field: ViewFilterField): ViewFilterOperator[] {
  if (field === "estimate") return ["eq", "neq", "gt", "gte", "lt", "lte", "is_empty"];
  if (field === "due_date") return ["on", "before", "after", "on_or_before", "on_or_after", "overdue", "next_7_days", "is_empty"];
  if (["created_at", "started_at", "completed_at", "canceled_at"].includes(field)) return ["on", "before", "after", "on_or_before", "on_or_after", "is_empty"];
  if (field === "updated_at") return ["on", "before", "after", "on_or_before", "on_or_after", "recent", "is_empty"];
  if (field === "subtasks" || field === "archived") return ["is", "is_not"];
  if (field === "relation") return ["is", "is_not", "is_empty"];
  if (field === "label_group") return ["is", "is_not"];
  return ["is", "is_not", "in", "not_in", "is_empty"];
}

export function defaultFilterCondition(field: ViewFilterField, data: AppSnapshot, scopeProjectId: string | null): ViewFilterCondition {
  if (field === "label_group") {
    return { field, operator: "is", value: { groupId: (data.labelGroups ?? [])[0]?.id ?? "", mode: "any" } };
  }
  if (["status", "assignee", "project", "release", "label", "parent"].includes(field) && !filterCatalogOptions(field, data, scopeProjectId).length) {
    return { field, operator: "is_empty" };
  }
  const operator: ViewFilterOperator = field === "estimate" ? "eq" : ["due_date", "created_at", "updated_at", "started_at", "completed_at", "canceled_at"].includes(field) ? "on" : "is";
  return { field, operator, ...filterConditionValue(field, operator, data, undefined, scopeProjectId) };
}

export function filterConditionValue(field: ViewFilterField, operator: ViewFilterOperator, data: AppSnapshot, previous?: ViewFilterCondition["value"], scopeProjectId: string | null = null): Pick<ViewFilterCondition, "value"> | Record<string, never> {
  if (["is_empty", "overdue", "next_7_days"].includes(operator)) return {};
  if (field === "relation") return { value: typeof previous === "object" && previous && !Array.isArray(previous) ? previous : { type: "any", direction: "either" } };
  if (field === "label_group") {
    const existing = typeof previous === "object" && previous && !Array.isArray(previous) ? previous as ViewFilterLabelGroupValue : null;
    return { value: existing ?? { groupId: (data.labelGroups ?? [])[0]?.id ?? "", mode: "any" } };
  }
  if (field === "subtasks") return { value: typeof previous === "boolean" ? previous : true };
  if (field === "archived") return { value: typeof previous === "boolean" ? previous : false };
  if (field === "estimate") return { value: typeof previous === "number" ? previous : 0 };
  if (operator === "recent") return { value: typeof previous === "number" ? previous : 24 };
  if (["due_date", "created_at", "updated_at", "started_at", "completed_at", "canceled_at"].includes(field)) return { value: typeof previous === "string" ? previous : new Date().toISOString().slice(0, 10) };
  const options = filterCatalogOptions(field, data, scopeProjectId);
  if (operator === "in" || operator === "not_in") {
    const previousValues = Array.isArray(previous) ? previous : typeof previous === "string" ? [previous] : [];
    return { value: previousValues.length ? previousValues : options[0] ? [options[0].value] : [] };
  }
  return { value: typeof previous === "string" ? previous : options[0]?.value ?? "" };
}

export function filterConditionSummary(condition: ViewFilterCondition, data: AppSnapshot, scopeProjectId: string | null = null) {
  const field = filterFieldOptions.find((item) => item.value === condition.field)?.label ?? condition.field;
  if (["is_empty", "overdue", "next_7_days"].includes(condition.operator)) return `${field} ${filterOperatorLabels[condition.operator]}`;
  if (condition.field === "relation") {
    const value = condition.value as { type: string; direction: string };
    return `${field} ${filterOperatorLabels[condition.operator]} ${value.type}/${value.direction}`;
  }
  if (condition.field === "label_group") {
    const value = condition.value as ViewFilterLabelGroupValue;
    const group = (data.labelGroups ?? []).find((item) => item.id === value.groupId)?.name ?? "Unavailable label group";
    const labels = (value.labelIds ?? []).map((id) => data.labels.find((label) => label.id === id)?.name ?? "Unavailable label");
    return `${field} ${filterOperatorLabels[condition.operator]} ${group}: ${value.mode === "values" ? labels.join(", ") : value.mode}`;
  }
  const options = new Map(filterCatalogOptions(condition.field, data, scopeProjectId).map((item) => [item.value, item.label]));
  const values = Array.isArray(condition.value) ? condition.value : [String(condition.value)];
  return `${field} ${filterOperatorLabels[condition.operator]} ${values.map((value) => {
    const resolved = options.get(String(value));
    if (resolved) return resolved;
    return unavailableFilterLabel(condition.field);
  }).join(", ")}`;
}
export function DisplayPopover({ display, labelGroups, onLayout, onDisplay, onClose }: { display: ViewDisplay; labelGroups: LabelGroupRecord[]; onLayout: (value: Layout) => void; onDisplay: (changes: Partial<ViewDisplay>) => void; onClose: () => void }) {
  const dependencies = viewDisplayDependencies(display);
  return <Popover title="Display" onClose={onClose}><div className="display-option"><span>Layout</span><div className="segmented wide"><button className={display.layout === "list" ? "active" : ""} onClick={() => onLayout("list")}><LayoutList size={13} />List</button><button className={display.layout === "board" ? "active" : ""} onClick={() => onLayout("board")}><Columns3 size={13} />Board</button></div></div><label className="popover-field"><span>Group by</span><select value={display.groupBy} onChange={(event) => { const groupBy = event.target.value as ViewDisplay["groupBy"]; onDisplay({ groupBy, labelGroupId: groupBy === "label_group" ? display.labelGroupId ?? labelGroups.find((group) => !group.archivedAt)?.id ?? null : null }); }}>{groupByOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{display.groupBy === "label_group" && <label className="popover-field"><span>Label group</span><select value={display.labelGroupId ?? ""} onChange={(event) => onDisplay({ labelGroupId: event.target.value || null })}>{labelGroups.filter((group) => !group.archivedAt || group.id === display.labelGroupId).map((group) => <option key={group.id} value={group.id}>{group.name}{group.archivedAt ? " (archived)" : ""}</option>)}</select></label>}<label className="popover-field"><span>Order by</span><select value={display.orderBy} onChange={(event) => onDisplay({ orderBy: event.target.value as ViewDisplay["orderBy"] })}>{viewOrderOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label className="popover-field"><span>Direction</span><select value={display.direction} disabled={dependencies.directionDisabled} aria-describedby={dependencies.directionReason ? "display-direction-help" : undefined} onChange={(event) => onDisplay({ direction: event.target.value as ViewDisplay["direction"] })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>{dependencies.directionReason && <small id="display-direction-help" className="display-dependency-hint">{dependencies.directionReason}</small>}<fieldset className="display-properties"><legend>Properties</legend>{viewFieldOptions.map((option) => <label key={option.value}><input type="checkbox" checked={display.visibleFields.includes(option.value)} onChange={() => onDisplay({ visibleFields: toggleViewField(display.visibleFields, option.value) })} />{option.label}</label>)}</fieldset><label className="display-checkbox"><input type="checkbox" checked={display.showEmptyGroups} disabled={dependencies.emptyGroupsDisabled} aria-describedby={dependencies.emptyGroupsReason ? "display-empty-groups-help" : undefined} onChange={(event) => onDisplay({ showEmptyGroups: event.target.checked })} /><span>Show empty groups</span></label>{dependencies.emptyGroupsReason && <small id="display-empty-groups-help" className="display-dependency-hint">{dependencies.emptyGroupsReason}</small>}</Popover>;
}
export function Popover({ title, onClose, children, className = "" }: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) { return <div className={`popover ${className}`}><header><b>{title}</b><button onClick={onClose}><X size={13} /></button></header>{children}</div>; }

export type WorkflowSettingsStatus = WorkflowStatusRecord & {
  taskCount: number;
  savedViewCount: number;
};

export const workflowCategoryLabels: Record<StatusCategory, string> = {
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  completed: "Completed",
  canceled: "Canceled",
};

export function WorkflowSettingsDialog({
  initialStatuses,
  onClose,
  onStatuses,
  embedded = false,
}: {
  initialStatuses: WorkflowStatusRecord[];
  onClose: () => void;
  onStatuses: (statuses: WorkflowStatusRecord[]) => void;
  embedded?: boolean;
}) {
  const [statuses, setStatuses] = useState<WorkflowSettingsStatus[]>(
    initialStatuses.map((status) => ({ ...status, taskCount: 0, savedViewCount: 0 })),
  );
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  const onStatusesRef = useRef(onStatuses);

  useEffect(() => {
    onStatusesRef.current = onStatuses;
  }, [onStatuses]);

  const apply = useCallback((next: WorkflowSettingsStatus[]) => {
    setStatuses(next);
    onStatusesRef.current(next);
  }, []);

  const request = useCallback(async (
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    actionId: string,
  ) => {
    setBusyId(actionId);
    setError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json() as { statuses?: WorkflowSettingsStatus[]; error?: string };
      if (!response.ok || !value.statuses) {
        if (response.status === 409) {
          const refreshedResponse = await fetch("/api/settings/workflow-statuses", { cache: "no-store" });
          const refreshed = await refreshedResponse.json() as { statuses?: WorkflowSettingsStatus[] };
          if (refreshedResponse.ok && refreshed.statuses) apply(refreshed.statuses);
        }
        throw new Error(value.error ?? "Workflow status could not be saved");
      }
      apply(value.statuses);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Workflow status could not be saved");
      return false;
    } finally {
      setBusyId(null);
    }
  }, [apply]);

  useEffect(() => {
    let current = true;
    void fetch("/api/settings/workflow-statuses", { cache: "no-store" })
      .then(async (response) => {
        const value = await response.json() as { statuses?: WorkflowSettingsStatus[]; error?: string };
        if (!response.ok || !value.statuses) throw new Error(value.error ?? "Workflow statuses could not be loaded");
        if (current) apply(value.statuses);
      })
      .catch((requestError: unknown) => {
        if (current) setError(requestError instanceof Error ? requestError.message : "Workflow statuses could not be loaded");
      })
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [apply]);

  const active = statuses.filter((status) => !status.archivedAt);
  const archived = statuses.filter((status) => status.archivedAt);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (await request("/api/settings/workflow-statuses", "POST", values, "create")) form.reset();
  }

  function renderStatus(status: WorkflowSettingsStatus) {
    const categoryPeers = active.filter((candidate) =>
      candidate.category === status.category && candidate.id !== status.id,
    );
    const peerIndex = active.filter((candidate) => candidate.category === status.category)
      .sort((left, right) => left.position - right.position)
      .findIndex((candidate) => candidate.id === status.id);
    const orderedPeers = active.filter((candidate) => candidate.category === status.category)
      .sort((left, right) => left.position - right.position);
    const replacementRequired = status.isDefault || status.taskCount > 0 || status.savedViewCount > 0;
    const replacementId = replacements[status.id] ?? categoryPeers[0]?.id ?? "";
    return (
      <article className={`workflow-status-row ${status.archivedAt ? "archived" : ""}`} key={`${status.id}:${status.version}`}>
        <form onSubmit={(event) => {
          event.preventDefault();
          const values = Object.fromEntries(new FormData(event.currentTarget));
          void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", {
            action: "update",
            version: status.version,
            name: values.name,
            color: values.color,
          }, status.id);
        }}>
          <input className="workflow-color" type="color" name="color" defaultValue={status.color} aria-label={`Color for ${status.name}`} disabled={Boolean(status.archivedAt) || busyId !== null} />
          <span className="workflow-status-main">
            <input name="name" defaultValue={status.name} aria-label={`Name for ${status.name}`} disabled={Boolean(status.archivedAt) || status.systemRole === "duplicate" || busyId !== null} />
            <small>{workflowCategoryLabels[status.category]} · {status.taskCount} task{status.taskCount === 1 ? "" : "s"}{status.savedViewCount ? ` · ${status.savedViewCount} view${status.savedViewCount === 1 ? "" : "s"}` : ""}</small>
          </span>
          {!status.archivedAt && <button className="button ghost compact" disabled={busyId !== null} type="submit">Save</button>}
        </form>
        <div className="workflow-status-actions">
          {!status.archivedAt && <>
            <button className="icon-button" type="button" title="Move up" aria-label={`Move ${status.name} up`} disabled={busyId !== null || peerIndex <= 0} onClick={() => {
              const peer = orderedPeers[peerIndex - 1];
              if (peer) void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "move", direction: "up", version: status.version, peerVersion: peer.version }, status.id);
            }}><ArrowUp size={14} /></button>
            <button className="icon-button" type="button" title="Move down" aria-label={`Move ${status.name} down`} disabled={busyId !== null || peerIndex < 0 || peerIndex >= orderedPeers.length - 1} onClick={() => {
              const peer = orderedPeers[peerIndex + 1];
              if (peer) void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "move", direction: "down", version: status.version, peerVersion: peer.version }, status.id);
            }}><ArrowDown size={14} /></button>
            {status.isDefault ? <span className="workflow-default">Default</span> : (["backlog", "unstarted"] as StatusCategory[]).includes(status.category) && <button className="button ghost compact" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "update", version: status.version, isDefault: true }, status.id)}>Make default</button>}
            {status.systemRole === "duplicate" ? <span className="workflow-reserved">Reserved</span> : <>
              {replacementRequired && <select aria-label={`Replacement for ${status.name}`} value={replacementId} disabled={busyId !== null} onChange={(event) => setReplacements((current) => ({ ...current, [status.id]: event.target.value }))}><option value="" disabled>Replacement…</option>{categoryPeers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select>}
              <button className="button ghost compact danger" type="button" disabled={busyId !== null || categoryPeers.length === 0 || (replacementRequired && !replacementId)} onClick={() => void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "archive", version: status.version, replacementStatusId: replacementId || undefined }, status.id)}><Archive size={13} />Archive</button>
            </>}
          </>}
          {status.archivedAt && <button className="button ghost compact" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "restore", version: status.version }, status.id)}><ArchiveRestore size={13} />Restore</button>}
        </div>
      </article>
    );
  }

  const body = <>
      {!embedded && <DialogHeader title="Workflow statuses" icon={<SlidersHorizontal size={17} />} onClose={() => busyId === null && onClose()} />}
      <p className="dialog-copy">Statuses belong to your workflow. Their category is permanent because it controls task lifecycle timestamps.</p>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {loading ? <p className="dialog-copy">Loading workflow…</p> : <div className="workflow-status-list">{active.map(renderStatus)}</div>}
      <form className="workflow-status-create" onSubmit={create}>
        <input name="name" required maxLength={80} placeholder="New status" aria-label="New workflow status name" disabled={busyId !== null} />
        <select name="category" defaultValue="unstarted" aria-label="New workflow status category" disabled={busyId !== null}>{Object.entries(workflowCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <input className="workflow-color" type="color" name="color" defaultValue="#6b7280" aria-label="New workflow status color" disabled={busyId !== null} />
        <button className="button primary" disabled={busyId !== null}><Plus size={14} />Add</button>
      </form>
      {archived.length > 0 && <details className="workflow-archived"><summary>Archived statuses ({archived.length})</summary><div className="workflow-status-list">{archived.map(renderStatus)}</div></details>}
    </>;
  return embedded
    ? <section className="settings-catalog" aria-label="Workflow status settings">{body}</section>
    : <Modal onClose={() => busyId === null && onClose()} className="workflow-settings-modal" ariaLabel="Workflow status settings">{body}</Modal>;
}

export type LabelSettingsRecord = LabelRecord & { taskCount: number };
export type LabelGroupSettingsRecord = LabelGroupRecord & { taskCount: number; labelCount: number };

export function LabelGroupSettingsDialog({
  initialGroups,
  initialLabels,
  onClose,
  onGroups,
  onLabels,
}: {
  initialGroups: LabelGroupRecord[];
  initialLabels: LabelRecord[];
  onClose: () => void;
  onGroups: (groups: LabelGroupRecord[]) => void;
  onLabels: (labels: LabelRecord[]) => void;
}) {
  const [groups, setGroups] = useState<LabelGroupSettingsRecord[]>(
    initialGroups.map((group) => ({ ...group, taskCount: 0, labelCount: 0 })),
  );
  const [labels, setLabels] = useState<LabelRecord[]>(initialLabels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [groupResponse, labelResponse] = await Promise.all([
      fetch("/api/settings/label-groups", { cache: "no-store" }),
      fetch("/api/settings/labels", { cache: "no-store" }),
    ]);
    const groupValue = await groupResponse.json() as { labelGroups?: LabelGroupSettingsRecord[]; error?: string };
    const labelValue = await labelResponse.json() as { labels?: LabelSettingsRecord[]; error?: string };
    if (!groupResponse.ok || !groupValue.labelGroups) throw new Error(groupValue.error ?? "Label Groups could not be loaded");
    if (!labelResponse.ok || !labelValue.labels) throw new Error(labelValue.error ?? "Labels could not be loaded");
    setGroups(groupValue.labelGroups);
    setLabels(labelValue.labels);
    onGroups(groupValue.labelGroups);
    onLabels(labelValue.labels);
  }, [onGroups, onLabels]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Catalog could not be loaded"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function write(path: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "Catalog could not be saved");
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Catalog could not be saved");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const activeGroups = groups.filter((group) => !group.archivedAt);
  const archivedGroups = groups.filter((group) => group.archivedAt);
  const renderGroup = (group: LabelGroupSettingsRecord) => (
    <article className={`label-settings-row ${group.archivedAt ? "archived" : ""}`} key={`${group.id}:${group.version}`}>
      <form onSubmit={(event) => { event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget)); void write(`/api/settings/label-groups/${encodeURIComponent(group.id)}`, "PATCH", { action: "update", version: group.version, name: value.name, description: value.description, position: Number(value.position) }); }}>
        <span className="label-settings-main">
          <input name="name" defaultValue={group.name} disabled={busy || Boolean(group.archivedAt)} aria-label={`Name for ${group.name}`} />
          <input name="description" defaultValue={group.description} disabled={busy || Boolean(group.archivedAt)} placeholder="Usage guidance" />
          <input name="position" type="number" min="0" defaultValue={group.position} disabled={busy || Boolean(group.archivedAt)} aria-label={`Position for ${group.name}`} />
          <small>{group.labelCount} labels · {group.taskCount} tasks</small>
        </span>
        {!group.archivedAt && <button className="button ghost compact" disabled={busy}>Save</button>}
      </form>
      <div className="label-settings-actions">
        <button className={`button ghost compact ${group.archivedAt ? "" : "danger"}`} type="button" disabled={busy} onClick={() => void write(`/api/settings/label-groups/${encodeURIComponent(group.id)}`, "PATCH", { action: group.archivedAt ? "restore" : "archive", version: group.version })}>{group.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}{group.archivedAt ? "Restore" : "Archive"}</button>
      </div>
    </article>
  );

  return <Modal onClose={() => !busy && onClose()} className="workflow-settings-modal" ariaLabel="Label Group settings">
    <DialogHeader title="Label groups" icon={<Tag size={17} />} onClose={() => !busy && onClose()} />
    <p className="dialog-copy">Each Task can hold one value from a group. Ungrouped labels remain independently selectable.</p>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="label-settings-list">{activeGroups.map(renderGroup)}</div>
    <form className="label-settings-create" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const value = Object.fromEntries(new FormData(form)); if (await write("/api/settings/label-groups", "POST", value)) form.reset(); }}>
      <input name="name" required maxLength={80} placeholder="New label group" disabled={busy} />
      <input name="description" maxLength={2000} placeholder="Usage guidance" disabled={busy} />
      <button className="button primary" disabled={busy}><Plus size={14} />Add group</button>
    </form>
    <section className="details-section">
      <h2><Tag size={14} />Group membership</h2>
      <div className="label-settings-list">{labels.map((label) => <label className="property-row" key={`${label.id}:${label.version}`}><span><span className="label-color-dot" style={{ background: label.color }} />{label.name}</span><select value={label.groupId ?? ""} disabled={busy || Boolean(label.archivedAt)} onChange={(event) => void write(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "update", version: label.version, groupId: event.target.value || null })}><option value="">Ungrouped</option>{activeGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>)}</div>
    </section>
    {archivedGroups.length > 0 && <details className="workflow-archived"><summary>Archived groups ({archivedGroups.length})</summary><div className="label-settings-list">{archivedGroups.map(renderGroup)}</div></details>}
  </Modal>;
}

export function LabelSettingsDialog({
  onClose,
  onLabels,
  onGroups,
  embedded = false,
}: {
  onClose: () => void;
  onLabels: (labels: LabelRecord[]) => void;
  onGroups?: (groups: LabelGroupRecord[]) => void;
  embedded?: boolean;
}) {
  const [labels, setLabels] = useState<LabelSettingsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const onLabelsRef = useRef(onLabels);

  useEffect(() => { onLabelsRef.current = onLabels; }, [onLabels]);
  const apply = useCallback((next: LabelSettingsRecord[]) => {
    setLabels(next);
    onLabelsRef.current(next);
  }, []);
  const request = useCallback(async (
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    actionId: string,
  ) => {
    setBusyId(actionId);
    setError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json() as { labels?: LabelSettingsRecord[]; error?: string };
      if (!response.ok || !value.labels) {
        if (response.status === 409) {
          const refreshedResponse = await fetch("/api/settings/labels", { cache: "no-store" });
          const refreshed = await refreshedResponse.json() as { labels?: LabelSettingsRecord[] };
          if (refreshedResponse.ok && refreshed.labels) apply(refreshed.labels);
        }
        throw new Error(value.error ?? "Label could not be saved");
      }
      apply(value.labels);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Label could not be saved");
      return false;
    } finally {
      setBusyId(null);
    }
  }, [apply]);

  useEffect(() => {
    let current = true;
    void fetch("/api/settings/labels", { cache: "no-store" })
      .then(async (response) => {
        const value = await response.json() as { labels?: LabelSettingsRecord[]; error?: string };
        if (!response.ok || !value.labels) throw new Error(value.error ?? "Labels could not be loaded");
        if (current) apply(value.labels);
      })
      .catch((requestError: unknown) => {
        if (current) setError(requestError instanceof Error ? requestError.message : "Labels could not be loaded");
      })
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [apply]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    void onGroups;
    if (await request("/api/settings/labels", "POST", values, "create")) form.reset();
  }

  function row(label: LabelSettingsRecord) {
    return <article className={`label-settings-row ${label.archivedAt ? "archived" : ""}`} key={`${label.id}:${label.version}`}><form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void request(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "update", version: label.version, name: values.name, color: values.color, description: values.description }, label.id); }}><input className="workflow-color" type="color" name="color" defaultValue={label.color} aria-label={`Color for ${label.name}`} disabled={Boolean(label.archivedAt) || busyId !== null} /><span className="label-settings-main"><input name="name" defaultValue={label.name} aria-label={`Name for ${label.name}`} disabled={Boolean(label.archivedAt) || busyId !== null} /><input name="description" defaultValue={label.description} placeholder="Usage guidance" aria-label={`Description for ${label.name}`} disabled={Boolean(label.archivedAt) || busyId !== null} /><small>{label.taskCount} Task{label.taskCount === 1 ? "" : "s"}</small></span>{!label.archivedAt && <button className="button ghost compact" disabled={busyId !== null}>Save</button>}</form><div className="label-settings-actions">{label.archivedAt ? <button className="button ghost compact" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "restore", version: label.version }, label.id)}><ArchiveRestore size={13} />Restore</button> : <button className="button ghost compact danger" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "archive", version: label.version }, label.id)}><Archive size={13} />Archive</button>}</div></article>;
  }

  const active = labels.filter((label) => !label.archivedAt);
  const archived = labels.filter((label) => label.archivedAt);
  const body = <>{!embedded && <DialogHeader title="Labels" icon={<Tag size={17} />} onClose={() => busyId === null && onClose()} />}<p className="dialog-copy">Labels belong to your catalog. Archiving blocks new assignments while preserving existing Task history.</p>{error && <p className="dialog-error" role="alert">{error}</p>}{loading ? <p className="dialog-copy">Loading labels…</p> : <div className="label-settings-list">{active.map(row)}</div>}<form className="label-settings-create" onSubmit={create}><input className="workflow-color" type="color" name="color" defaultValue="#6b7280" aria-label="New Label color" disabled={busyId !== null} /><input name="name" required maxLength={80} placeholder="New label" aria-label="New Label name" disabled={busyId !== null} /><input name="description" maxLength={2000} placeholder="Usage guidance" aria-label="New Label description" disabled={busyId !== null} /><button className="button primary" disabled={busyId !== null}><Plus size={14} />Add</button></form>{archived.length > 0 && <details className="workflow-archived"><summary>Archived labels ({archived.length})</summary><div className="label-settings-list">{archived.map(row)}</div></details>}</>;
  return embedded
    ? <section className="settings-catalog" aria-label="Label settings">{body}</section>
    : <Modal onClose={() => busyId === null && onClose()} className="workflow-settings-modal" ariaLabel="Label settings">{body}</Modal>;
}

export const settingsNavigation: Array<{
  group: string;
  items: Array<{ section: SettingsSection; label: string; icon: React.ReactNode }>;
}> = [
  { group: "Personal", items: [
    { section: "profile", label: "Profile", icon: <UserRound size={15} /> },
    { section: "appearance", label: "Appearance", icon: <Palette size={15} /> },
  ] },
  { group: "Workspace", items: [
    { section: "workflow-statuses", label: "Workflow statuses", icon: <SlidersHorizontal size={15} /> },
    { section: "labels", label: "Labels", icon: <Tag size={15} /> },
  ] },
  { group: "Integrations", items: [
    { section: "integrations", label: "Codex setup", icon: <CircleHelp size={15} /> },
  ] },
  { group: "Data & backups", items: [
    { section: "project-backup", label: "Project backup", icon: <Database size={15} /> },
    { section: "recently-deleted", label: "Recently deleted", icon: <Trash2 size={15} /> },
  ] },
];

export function SettingsSurface({
  section,
  data,
  theme,
  sidebarCollapsed,
  signOutPath,
  onNavigate,
  onProfile,
  onAppearance,
  onStatuses,
  onLabels,
  onGroups,
  recentlyDeletedEpoch,
  onDeletionWorkspaceChanged,
}: {
  section: string;
  data: AppSnapshot;
  theme: "system" | "light" | "dark";
  sidebarCollapsed: boolean;
  signOutPath: string;
  onNavigate: (section: SettingsSection) => void;
  onProfile: (profile: UserProfile) => void;
  onAppearance: (changes: { theme?: "system" | "light" | "dark"; sidebarPreference?: "expanded" | "collapsed" }) => void;
  onStatuses: (statuses: WorkflowStatusRecord[]) => void;
  onLabels: (labels: LabelRecord[]) => void;
  onGroups?: (groups: LabelGroupRecord[]) => void;
  recentlyDeletedEpoch?: number;
  onDeletionWorkspaceChanged?: () => Promise<unknown> | unknown;
}) {
  const [labelGroupsOpen, setLabelGroupsOpen] = useState(false);
  const active = settingsNavigation.flatMap((group) => group.items)
    .find((item) => item.section === section)?.section ?? "profile";
  const profile = data.userProfile ?? {
    user: {
      ...data.user,
      version: data.user.version ?? 1,
      theme: data.user.theme ?? "system",
      sidebarPreference: data.user.sidebarPreference ?? "expanded",
    },
    identities: [{ provider: "chatgpt" as const, verifiedEmail: data.user.email }],
  };

  return <div className="settings-surface">
    <nav className="settings-navigation" aria-label="Settings sections">
      {settingsNavigation.map((group) => <section key={group.group}>
        <h2>{group.group}</h2>
        {group.items.map((item) => <a
          key={item.section}
          className={active === item.section ? "active" : ""}
          href={`/settings/${item.section}`}
          aria-current={active === item.section ? "page" : undefined}
          onClick={(event) => handleLocalLink(event, () => onNavigate(item.section))}
        >{item.icon}<span>{item.label}</span></a>)}
      </section>)}
    </nav>
    <article className="settings-content">
      {active === "profile" && <SettingsSectionHeader title="Profile" description="Your verified identity and personal date semantics." />}
      {active === "appearance" && <SettingsSectionHeader title="Appearance" description="Choose how Task Manager looks and how its navigation opens." />}
      {active === "workflow-statuses" && <SettingsSectionHeader title="Workflow statuses" description="Manage your account-owned workflow catalog." />}
      {active === "labels" && <SettingsSectionHeader title="Labels" description="Manage labels without losing archived assignments or history." />}
      {active === "integrations" && <SettingsSectionHeader title="Codex setup" description="Connect through the published plugin and OAuth-safe flow." />}
      {active === "project-backup" && <SettingsSectionHeader title="Project backup" description="Export or atomically restore Projects that you currently own." />}
      {active === "recently-deleted" && <SettingsSectionHeader title="Recently deleted" description="Restore deleted records or permanently remove owner-controlled data." />}

      {active === "profile" && <ProfileSettingsPanel key={profile.user.version} profile={profile} signOutPath={signOutPath} onProfile={onProfile} />}
      {active === "appearance" && <AppearanceSettingsPanel theme={theme} sidebarCollapsed={sidebarCollapsed} onChange={onAppearance} />}
      {active === "workflow-statuses" && <WorkflowSettingsDialog embedded initialStatuses={data.statuses.filter((status) => status.ownerUserId === data.user.id)} onClose={() => undefined} onStatuses={onStatuses} />}
      {active === "labels" && <>
        <div className="catalog-toolbar">
          <button className="button ghost compact" type="button" onClick={() => setLabelGroupsOpen(true)}>Manage label groups</button>
        </div>
        <LabelSettingsDialog embedded onClose={() => undefined} onLabels={onLabels} />
        {labelGroupsOpen && <LabelGroupSettingsDialog
          initialGroups={(data.labelGroups ?? []).filter((group) => group.ownerUserId === data.user.id)}
          initialLabels={data.labels.filter((label) => label.ownerUserId === data.user.id)}
          onClose={() => setLabelGroupsOpen(false)}
          onGroups={(groups) => onGroups?.(groups)}
          onLabels={onLabels}
        />}
      </>}
      {active === "integrations" && <CodexSetupDialog embedded onClose={() => undefined} />}
      {active === "project-backup" && <ProjectBackupManager embedded initialSnapshot={data} />}
      {active === "recently-deleted" && <RecentlyDeletedManager invalidationEpoch={recentlyDeletedEpoch} onWorkspaceChanged={onDeletionWorkspaceChanged} />}
    </article>
  </div>;
}

export function SettingsSectionHeader({ title, description }: { title: string; description: string }) {
  return <header className="settings-section-header"><h1>{title}</h1><p>{description}</p></header>;
}

export function ProfileSettingsPanel({
  profile,
  signOutPath,
  onProfile,
}: {
  profile: UserProfile;
  signOutPath: string;
  onProfile: (profile: UserProfile) => void;
}) {
  const [displayName, setDisplayName] = useState(profile.user.displayName);
  const [timezone, setTimezone] = useState(profile.user.timezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const timezones = supportedTimeZones(profile.user.timezone);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/settings/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: profile.user.version, displayName, timezone }),
      });
      const value = await response.json() as UserProfile | { error: string };
      if (!response.ok || "error" in value) {
        if (response.status === 409) {
          const refreshed = await fetch("/api/settings/profile", { cache: "no-store" });
          const latest = await refreshed.json() as UserProfile | { error: string };
          if (refreshed.ok && !("error" in latest)) onProfile(latest);
        }
        throw new Error("error" in value ? value.error : "Profile could not be saved");
      }
      onProfile(value);
      setSaved(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Profile could not be saved");
    } finally {
      setBusy(false);
    }
  }

  return <form className="settings-form" onSubmit={save}>
    <div className="settings-form-row"><span><label htmlFor="settings-display-name">Display name</label><small>Shown on your tasks, comments, and shared resources.</small></span><input id="settings-display-name" required maxLength={120} value={displayName} onChange={(event) => { setDisplayName(event.target.value); setSaved(false); }} /></div>
    <div className="settings-form-row"><span><label htmlFor="settings-verified-email">Verified email</label><small>Managed by the authenticated provider.</small></span><input id="settings-verified-email" readOnly value={profile.user.email} aria-readonly="true" /></div>
    <div className="settings-form-row"><span><label htmlFor="settings-timezone">Timezone</label><small>Used for calendar dates, filters, and displayed timestamps.</small></span><select id="settings-timezone" value={timezone} onChange={(event) => { setTimezone(event.target.value); setSaved(false); }}>{timezones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></div>
    <section className="settings-provider-list" aria-labelledby="linked-provider-heading"><div><h2 id="linked-provider-heading">Linked providers</h2><p>Provider identity is projected by the server and cannot be changed by this form.</p></div>{profile.identities.map((identity) => <div className="settings-provider-row" key={`${identity.provider}:${identity.verifiedEmail}`}><span className="avatar small">{identity.provider === "chatgpt" ? "C" : "G"}</span><span><b>{identity.provider === "chatgpt" ? "ChatGPT" : "Google"}</b><small>{identity.verifiedEmail}</small></span><strong>Verified</strong></div>)}</section>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="settings-form-actions"><span role="status">{saved ? "Saved" : ""}</span><button className="button primary" disabled={busy || !displayName.trim()}>{busy ? "Saving…" : "Save profile"}</button></div>
    <div className="settings-signout"><span><b>Session</b><small>Sign out through the Sites-managed session.</small></span><a className="button secondary" href={signOutPath}><LogOut size={14} />Sign out</a></div>
  </form>;
}

export function AppearanceSettingsPanel({
  theme,
  sidebarCollapsed,
  onChange,
}: {
  theme: "system" | "light" | "dark";
  sidebarCollapsed: boolean;
  onChange: (changes: { theme?: "system" | "light" | "dark"; sidebarPreference?: "expanded" | "collapsed" }) => void;
}) {
  return <div className="settings-form">
    <section className="settings-choice-row"><div className="settings-choice-label"><b>Theme</b><small>Synced to your Task Manager account.</small></div><div role="group" aria-label="Theme preference">{(["system", "light", "dark"] as const).map((value) => <button key={value} type="button" className={theme === value ? "active" : ""} aria-pressed={theme === value} onClick={() => onChange({ theme: value })}>{value === "system" ? <Monitor size={15} /> : value === "light" ? <Sun size={15} /> : <Moon size={15} />}{displayLabel(value)}</button>)}</div></section>
    <section className="settings-choice-row"><div className="settings-choice-label"><b>Sidebar</b><small>Choose the default navigation state for this account.</small></div><div role="group" aria-label="Sidebar preference"><button type="button" className={!sidebarCollapsed ? "active" : ""} aria-pressed={!sidebarCollapsed} onClick={() => onChange({ sidebarPreference: "expanded" })}><PanelLeftOpen size={15} />Expanded</button><button type="button" className={sidebarCollapsed ? "active" : ""} aria-pressed={sidebarCollapsed} onClick={() => onChange({ sidebarPreference: "collapsed" })}><PanelLeftClose size={15} />Collapsed</button></div></section>
  </div>;
}

export function supportedTimeZones(current: string): string[] {
  const values = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] })
    .supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(["UTC", current, ...values])].sort((left, right) => left.localeCompare(right));
}

export function ProjectDialog({ project, currentUser, leadOptions, openTaskCount, onClose, onSubmit, onArchive, busy }: { project?: ProjectRecord; currentUser: UserRecord; leadOptions: UserRecord[]; openTaskCount: number; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; onArchive?: () => Promise<void>; busy: boolean }) {
  const [name, setName] = useState(project?.name ?? "");
  const [taskCode, setTaskCode] = useState(project?.taskCode ?? "PR");
  const [codeEdited, setCodeEdited] = useState(Boolean(project));
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "planned");
  const terminalWarning = Boolean(project && openTaskCount > 0 && (status === "completed" || status === "canceled") && status !== project.status);
  const codeLocked = Boolean(project?.codeLockedAt || (project?.taskSequence ?? 0) > 0);
  return <Modal onClose={onClose} className="project-dialog" ariaLabel={project ? `Edit ${project.name}` : "Create project"}><form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void onSubmit({ ...values, leadUserId: values.leadUserId || null, confirmOpenTasks: values.confirmOpenTasks === "on" }); }}><DialogHeader title={project ? "Edit project" : "Create project"} icon={<ProjectIcon project={project} size={17} />} onClose={onClose} /><div className="form-stack project-form-stack"><label><span>Project name</span><input name="name" required autoFocus value={name} onChange={(event) => { const next = event.target.value; setName(next); if (!codeEdited) setTaskCode(suggestProjectTaskCode(next)); }} /></label><div className="project-form-grid"><label><span>Task code</span><input name="taskCode" required minLength={1} pattern={PROJECT_TASK_CODE_INPUT_PATTERN} value={taskCode} readOnly={codeLocked} className={codeLocked ? "read-only-control" : undefined} onChange={(event) => { setCodeEdited(true); setTaskCode(normalizeProjectTaskCodeDraft(event.target.value)); }} aria-describedby="project-code-help" /></label><label><span>Status</span><select name="status" value={status} onChange={(event) => setStatus(event.target.value as ProjectStatus)}>{projectStatusOptions.map((value) => <option key={value} value={value}>{projectStatusLabel(value)}</option>)}</select></label></div><small id="project-code-help" className="dialog-copy">{codeLocked ? `Locked after ${project?.taskSequence ?? 0} allocated Task number${project?.taskSequence === 1 ? "" : "s"}.` : "1–12 characters: Latin letters, digits, and internal hyphens. The code locks after this Project receives its first Task."}</small><label><span>Short summary</span><input name="summary" maxLength={500} defaultValue={project?.summary ?? ""} /></label><label><span>Markdown description</span><textarea name="description" rows={7} defaultValue={project?.description ?? ""} placeholder="Project context, outcome, and constraints…" /></label><div className="project-form-grid"><label><span>Lead</span><select name="leadUserId" defaultValue={project?.leadUserId ?? currentUser.id}><option value="">No lead</option>{leadOptions.map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select></label><label><span>Icon</span><select name="icon" defaultValue={project?.icon ?? "cube"}><option value="cube">Cube</option><option value="folder">Folder</option><option value="target">Target</option><option value="rocket">Rocket</option></select></label><label><span>Color</span><input name="color" type="color" defaultValue={project?.color ?? "#8b7cf6"} /></label></div><div className="project-form-grid"><label><span>Start date</span><input name="startDate" type="date" defaultValue={project?.startDate ?? ""} /></label><label><span>Target date</span><input name="targetDate" type="date" defaultValue={project?.targetDate ?? ""} /></label></div>{terminalWarning && <label className="project-terminal-warning"><input name="confirmOpenTasks" type="checkbox" required /><span>This Project has {openTaskCount} open Task{openTaskCount === 1 ? "" : "s"}. Confirm the terminal transition.</span></label>}</div><div className="project-dialog-footer">{project && onArchive && <button className={`button ghost ${project.archivedAt ? "" : "danger"}`} type="button" disabled={busy} onClick={() => void onArchive()}>{project.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}{project.archivedAt ? "Restore project" : "Archive project"}</button>}<div><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || !isProjectTaskCode(taskCode)}>{busy ? "Saving…" : project ? "Save changes" : "Create"}</button></div></div></form></Modal>;
}
export const releaseStatusOptions: ReleaseStatus[] = ["planned", "active", "released", "canceled"];

export function ReleaseDialog({ release, projects, initialProjectId, openTaskCount, onClose, onSubmit, onDelete, busy }: { release?: ReleaseRecord; projects: ProjectRecord[]; initialProjectId: string | null; openTaskCount: number; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; onDelete?: () => void; busy: boolean }) {
  const [name, setName] = useState(release?.name ?? "");
  const [status, setStatus] = useState<ReleaseStatus>(release?.status ?? "planned");
  const terminalWarning = status === "released" && release?.status !== "released" && openTaskCount > 0;
  const reopenWarning = release?.status === "released" && status !== "released";
  return <Modal onClose={onClose} className="project-dialog release-dialog" ariaLabel={release ? `Edit ${release.name}` : "Create release"}>
    <form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void onSubmit({ ...values, confirmOpenTasks: values.confirmOpenTasks === "on" }); }}>
      <DialogHeader title={release ? "Edit release" : "Create release"} icon={<Rocket size={17} />} onClose={onClose} />
      <div className="form-stack project-form-stack">
        <label><span>Release name / version</span><input name="name" required autoFocus placeholder="v1.0" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="project-form-grid"><label><span>Project</span><select name="projectId" required disabled={Boolean(release)} defaultValue={release?.projectId ?? initialProjectId ?? ""}><option value="" disabled>Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label><span>Status</span><select name="status" value={status} onChange={(event) => setStatus(event.target.value as ReleaseStatus)}>{releaseStatusOptions.map((value) => <option key={value} value={value}>{projectStatusLabel(value)}</option>)}</select></label><label><span>Target date</span><input name="targetDate" type="date" defaultValue={release?.targetDate ?? ""} /></label></div>
        <label><span>Markdown description</span><textarea name="description" rows={6} defaultValue={release?.description ?? ""} placeholder="Release outcome and scope…" /></label>
        <label><span>Release notes</span><textarea name="releaseNotes" rows={7} defaultValue={release?.releaseNotes ?? ""} placeholder="Published changes, migration notes, and known limitations…" /></label>
        {terminalWarning && <label className="project-terminal-warning"><input name="confirmOpenTasks" type="checkbox" required /><span>This Release has {openTaskCount} open Task{openTaskCount === 1 ? "" : "s"}. Confirm publishing without changing their statuses.</span></label>}
        {reopenWarning && <p className="release-transition-note">Leaving Released clears the server release timestamp; Tasks remain unchanged.</p>}
      </div>
      {!projects.length && <p className="inline-note">Create a project before adding a release.</p>}
      <div className="project-dialog-footer">
        {release && onDelete ? <button className="button ghost danger" type="button" disabled={busy} onClick={onDelete}><Trash2 size={14} />Delete release…</button> : <span />}
        <div><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || !projects.length}>{busy ? "Saving…" : release ? "Save changes" : "Create release"}</button></div>
      </div>
    </form>
  </Modal>;
}
export function viewDialogDraftQuery(
  editing: boolean,
  view: SavedViewRecord | undefined,
  query: ViewQuery,
) {
  return canonicalViewQuery(editing ? view?.query : query);
}

export type ViewDialogDraft = {
  name: string;
  scopeProjectId: string | null;
  query: ViewQuery;
  display: ViewDisplay;
};

export function comparableViewDialogDraft(draft: ViewDialogDraft) {
  return JSON.stringify({
    name: draft.name.trim(),
    scopeProjectId: draft.scopeProjectId || null,
    query: canonicalViewQuery(draft.query),
    display: {
      ...draft.display,
      labelGroupId: draft.display.labelGroupId ?? null,
      visibleFields: [...draft.display.visibleFields],
    },
  });
}

export function viewDialogDraftIsDirty(initial: ViewDialogDraft, current: ViewDialogDraft) {
  return comparableViewDialogDraft(initial) !== comparableViewDialogDraft(current);
}

export function ViewDisplayEditor({ display, data, scopeProjectId, onDisplay }: {
  display: ViewDisplay;
  data: AppSnapshot;
  scopeProjectId: string | null;
  onDisplay: (changes: Partial<ViewDisplay>) => void;
}) {
  const dependencies = viewDisplayDependencies(display);
  const labelGroups = filterCatalogOptions("label_group", data, scopeProjectId);
  return <div className="view-display-editor">
    <div className="display-option"><span>Layout</span><div className="segmented wide"><button type="button" className={display.layout === "list" ? "active" : ""} onClick={() => onDisplay({ layout: "list" })}><LayoutList size={13} />List</button><button type="button" className={display.layout === "board" ? "active" : ""} onClick={() => onDisplay({ layout: "board" })}><Columns3 size={13} />Board</button></div></div>
    <label className="popover-field"><span>Group by</span><select value={display.groupBy} onChange={(event) => { const groupBy = event.target.value as ViewDisplay["groupBy"]; onDisplay({ groupBy, labelGroupId: groupBy === "label_group" ? display.labelGroupId ?? labelGroups[0]?.value ?? null : null }); }}>{groupByOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    {display.groupBy === "label_group" && <label className="popover-field"><span>Label group</span><select value={display.labelGroupId ?? ""} onChange={(event) => onDisplay({ labelGroupId: event.target.value || null })}>{labelGroups.map((group) => <option key={group.value} value={group.value}>{group.label}</option>)}</select></label>}
    <label className="popover-field"><span>Order by</span><select value={display.orderBy} onChange={(event) => onDisplay({ orderBy: event.target.value as ViewDisplay["orderBy"] })}>{viewOrderOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <label className="popover-field"><span>Direction</span><select value={display.direction} disabled={dependencies.directionDisabled} aria-describedby={dependencies.directionReason ? "view-direction-help" : undefined} onChange={(event) => onDisplay({ direction: event.target.value as ViewDisplay["direction"] })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
    {dependencies.directionReason && <small id="view-direction-help" className="display-dependency-hint">{dependencies.directionReason}</small>}
    <fieldset className="display-properties"><legend>Properties</legend>{viewFieldOptions.map((option) => <label key={option.value}><input type="checkbox" checked={display.visibleFields.includes(option.value)} onChange={() => onDisplay({ visibleFields: toggleViewField(display.visibleFields, option.value) })} />{option.label}</label>)}</fieldset>
    <label className="display-checkbox"><input type="checkbox" checked={display.showEmptyGroups} disabled={dependencies.emptyGroupsDisabled} aria-describedby={dependencies.emptyGroupsReason ? "view-empty-groups-help" : undefined} onChange={(event) => onDisplay({ showEmptyGroups: event.target.checked })} /><span>Show empty groups</span></label>
    {dependencies.emptyGroupsReason && <small id="view-empty-groups-help" className="display-dependency-hint">{dependencies.emptyGroupsReason}</small>}
  </div>;
}

export function ViewDialog({ view, editing, query, display, data, initialScopeProjectId, temporaryFilterCount = 0, submissionError = "", onClose, onSubmit, busy }: { view?: SavedViewRecord; editing: boolean; query: ViewQuery; display: ViewDisplay; data: AppSnapshot; initialScopeProjectId: string | null; temporaryFilterCount?: number; submissionError?: string; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<boolean | void>; busy: boolean }) {
  const [initialDraft] = useState<ViewDialogDraft>(() => ({
    name: editing ? view?.name ?? "" : view ? `${view.name} copy` : "",
    scopeProjectId: initialScopeProjectId || null,
    query: viewDialogDraftQuery(editing, view, query),
    display: { ...display, visibleFields: [...display.visibleFields] },
  }));
  const [name, setName] = useState(initialDraft.name);
  const [scopeProjectId, setScopeProjectId] = useState(initialDraft.scopeProjectId ?? "");
  const [savedQueryDraft, setSavedQueryDraft] = useState<ViewQuery>(initialDraft.query);
  const [displayDraft, setDisplayDraft] = useState<ViewDisplay>(initialDraft.display);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [localError, setLocalError] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const canMoveScope = !editing || view?.accessRole === "owner";
  const projects = data.projects.filter((project) => !project.archivedAt && canEditContent(project.accessRole));
  const currentDraft = { name, scopeProjectId: scopeProjectId || null, query: savedQueryDraft, display: displayDraft };
  const dirty = viewDialogDraftIsDirty(initialDraft, currentDraft);
  const unavailableReferences = unavailableFilterReferences(savedQueryDraft, data, scopeProjectId || null);
  const invalid = !name.trim() || unavailableReferences.length > 0;
  const canSubmit = !invalid && (!editing || dirty) && !busy && !submitting;
  const dependencies = viewDisplayDependencies(displayDraft);
  const changeDisplayDraft = (changes: Partial<ViewDisplay>) => setDisplayDraft((current) => ({ ...current, ...changes }));
  const requestClose = () => {
    if (submitting || busy) return;
    if (confirmDiscard) {
      setConfirmDiscard(false);
      return;
    }
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setLocalError("");
    try {
      const result = await onSubmit({ name: name.trim(), query: canonicalViewQuery(savedQueryDraft), display: displayDraft, scopeProjectId: scopeProjectId || null });
      if (result === false) setLocalError("The view could not be saved. Your draft is still here.");
    } catch (requestError) {
      setLocalError(requestError instanceof Error ? requestError.message : "The view could not be saved. Your draft is still here.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  return <Modal onClose={requestClose} className="project-dialog view-dialog" ariaLabel={editing ? `Edit ${view?.name ?? "Saved View"}` : "Save as view"}>
    <form onSubmit={submit}>
      <DialogHeader className="view-dialog-header" title={editing ? "Edit view" : "Save as view"} icon={<Zap size={17} />} onClose={requestClose} />
      <div className="view-dialog-body form-stack project-form-stack">
        <div className="view-dialog-general"><label><span>View name</span><input ref={nameInputRef} name="name" required autoFocus placeholder="e.g. Upcoming launch" value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>Scope</span><select name="scopeProjectId" value={scopeProjectId} disabled={!canMoveScope} onChange={(event) => setScopeProjectId(event.target.value)}><option value="">Workspace (global)</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.taskCode} · {project.name}</option>)}</select></label></div>
        {editing && temporaryFilterCount > 0 && <p className="view-temporary-warning" role="note"><ListFilter size={14} /><span><b>{temporaryFilterCount} temporary filter{temporaryFilterCount === 1 ? " is" : "s are"} not part of this Saved View.</b> Saving keeps {temporaryFilterCount === 1 ? "it" : "them"} active only in the current URL until you choose Clear temporary.</span></p>}
        <section className="view-dialog-section" aria-labelledby="saved-view-filter-heading"><header><h3 id="saved-view-filter-heading">Saved filters</h3><span>{queryFilterCount(savedQueryDraft)} active</span></header><FilterConditionEditor data={data} query={savedQueryDraft} scopeProjectId={scopeProjectId || null} onQuery={setSavedQueryDraft} clearLabel="Clear saved filters" /></section>
        <section className="view-dialog-section" aria-labelledby="saved-view-display-heading"><header><h3 id="saved-view-display-heading">Display</h3></header><ViewDisplayEditor display={displayDraft} data={data} scopeProjectId={scopeProjectId || null} onDisplay={changeDisplayDraft} /></section>
        {scopeProjectId ? <p className="dialog-copy">This view is limited to the selected Project and inherits its access.</p> : <p className="dialog-copy">A global view only returns Tasks the reader can already access.</p>}
        {unavailableReferences.length > 0 && <p className="dialog-warning" role="alert">Choose an available value for {unavailableReferences.length} filter reference{unavailableReferences.length === 1 ? "" : "s"} before saving. Stored references were not replaced.</p>}
        {(localError || submissionError) && <p className="error-banner" role="alert">{localError || submissionError}</p>}
      </div>
      <div className="view-dialog-footer project-dialog-footer"><span>{editing && !dirty ? "No changes" : dependencies.directionReason ?? ""}</span><div><button className="button ghost" type="button" disabled={busy || submitting} onClick={requestClose}>Cancel</button><button className="button primary" disabled={!canSubmit}>{busy || submitting ? "Saving…" : editing ? "Save changes" : "Save view"}</button></div></div>
      {confirmDiscard && <div className="view-discard-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="discard-view-title"><h3 id="discard-view-title">Discard changes?</h3><p>Your unsaved view changes will be lost.</p><div><button autoFocus className="button ghost" type="button" onClick={() => { setConfirmDiscard(false); window.requestAnimationFrame(() => nameInputRef.current?.focus()); }}>Keep editing</button><button className="button danger" type="button" onClick={onClose}>Discard</button></div></div>}
    </form>
  </Modal>;
}

export function emptyAsyncValue<T>(): AsyncValue<T> {
  return { status: "idle", value: null, error: "" };
}

export function teamRouteRoles(route: TeamShareRoute): TeamGrantPermission[] {
  return (["manager", "editor", "viewer"] as const).filter((permission) => {
    if (permission === "manager" && route.resourceType !== "project") return false;
    return canAssignRole(route.accessRole, route.resourceType, permission);
  });
}

export function canManageTeamRouteGrant(
  route: TeamShareRoute,
  permission: TeamGrantPermission,
) {
  return canManageGrant(route.accessRole, route.resourceType, permission);
}

export function normalizedTeamSharePermission(
  selected: TeamGrantPermission | "",
  allowed: readonly TeamGrantPermission[],
): TeamGrantPermission | "" {
  return selected && allowed.includes(selected) ? selected : "";
}

export function validShareEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function sharePersonOptions({ query, directTarget, directGrants, ownerEmail, currentUser, users, collaborators }: {
  query: string;
  directTarget: ShareContext["directTarget"];
  directGrants: AppSnapshot["collaborators"];
  ownerEmail?: string;
  currentUser: AppSnapshot["user"];
  users: AppSnapshot["users"];
  collaborators: AppSnapshot["collaborators"];
}): SharePersonOption[] {
  if (!directTarget || !query.trim()) return [];
  const needle = query.trim().toLocaleLowerCase();
  const existingEmails = new Set(directGrants.map((grant) => grant.email.toLocaleLowerCase()));
  if (ownerEmail) existingEmails.add(ownerEmail.toLocaleLowerCase());
  existingEmails.add(currentUser.email.toLocaleLowerCase());
  const candidates = new Map<string, SharePersonOption>();
  for (const user of users) {
    const email = user.email.toLocaleLowerCase();
    if (existingEmails.has(email)) continue;
    if (!user.displayName.toLocaleLowerCase().includes(needle) && !email.includes(needle)) continue;
    candidates.set(email, { kind: "person", key: `person:${email}`, displayName: user.displayName, email: user.email });
  }
  for (const grant of collaborators) {
    const email = grant.email.toLocaleLowerCase();
    if (existingEmails.has(email) || candidates.has(email)) continue;
    if (!grant.displayName.toLocaleLowerCase().includes(needle) && !email.includes(needle)) continue;
    candidates.set(email, { kind: "person", key: `person:${email}`, displayName: grant.displayName, email: grant.email });
  }
  if (validShareEmail(needle) && !existingEmails.has(needle) && !candidates.has(needle)) {
    candidates.set(needle, { kind: "person", key: `person:${needle}`, displayName: `Add ${needle}`, email: needle });
  }
  return [...candidates.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }) ||
    left.email.localeCompare(right.email));
}

export function TeamGrantAccessRow({ route, grant, catalogEntry, busy, routeReady, onRoleChange, onRevoke }: {
  route: TeamShareRoute;
  grant: TeamGrantRecord;
  catalogEntry?: TeamList["teams"][number];
  busy: boolean;
  routeReady: boolean;
  onRoleChange: (permission: TeamGrantPermission) => void;
  onRevoke: () => void;
}) {
  const roles = teamRouteRoles(route);
  const active = grant.revokedAt === null;
  const manageable = canManageTeamRouteGrant(route, grant.permission);
  const availableRoles = manageable ? roles : [grant.permission];
  return <div className={`access-row team-grant-row ${active ? "" : "revoked"}`}><span className="team-option-icon"><UsersRound size={15} /></span><span><b>{grant.teamName}</b><small>{catalogEntry ? `${catalogEntry.activeMemberCount} active · Your role: ${catalogEntry.currentMembership.role}` : active ? "Team route" : "Revoked Team route"}</small></span><span className="team-route-root">{active ? route.label : "Revoked"}</span><select aria-label={`Role for Team ${grant.teamName}`} value={grant.permission} disabled={busy || !active || !manageable || !routeReady || Boolean(grant.teamArchivedAt)} onChange={(event) => { if (manageable) onRoleChange(event.target.value as TeamGrantPermission); }}>{availableRoles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select><div className="access-actions">{active && manageable && <button type="button" disabled={busy || !routeReady} onClick={onRevoke}>Revoke</button>}</div></div>;
}

export function ShareDialog({ context, currentUser, users, collaborators, onClose, onShare, onRoleChange, onRevoke, onTransfer, busy }: { context: ShareContext; currentUser: AppSnapshot["user"]; users: AppSnapshot["users"]; collaborators: AppSnapshot["collaborators"]; onClose: () => void; onShare: (input: Record<string, unknown>) => Promise<boolean>; onRoleChange: (grantId: string, permission: "manager" | "editor" | "viewer") => Promise<boolean>; onRevoke: (grantId: string) => Promise<boolean>; onTransfer: (projectId: string, targetUserId: string) => Promise<boolean>; busy: boolean }) {
  const [query, setQuery] = useState("");
  const [comboOpen, setComboOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [selectedPrincipal, setSelectedPrincipal] = useState<SharePrincipalOption | null>(null);
  const [selectedPermission, setSelectedPermission] = useState<TeamGrantPermission | "">("");
  const [selectedRouteKey, setSelectedRouteKey] = useState("");
  const [directError, setDirectError] = useState("");
  const [teamAlert, setTeamAlert] = useState<TeamGrantAlert>(null);
  const [teamMutation, setTeamMutation] = useState<TeamGrantMutationState>(null);
  const [teamCatalog, setTeamCatalog] = useState<AsyncValue<TeamList>>(() => emptyAsyncValue<TeamList>());
  const teamCatalogRef = useRef(teamCatalog);
  const [routeStates, setRouteStates] = useState<Record<string, AsyncValue<TeamGrantList>>>(() =>
    Object.fromEntries(context.teamRoutes.map((route) => [route.key, emptyAsyncValue<TeamGrantList>()])),
  );
  const routeStatesRef = useRef(routeStates);
  const catalogGenerationRef = useRef(0);
  const routeGenerationRef = useRef<Record<string, number>>({});
  const contextKeyRef = useRef(context.key);
  const mountedRef = useRef(true);
  const teamMutationRef = useRef(false);
  const listboxId = useId();
  const routeIdentity = teamShareRouteIdentity(context.teamRoutes);
  const routesRef = useRef(context.teamRoutes);

  const setCatalogState = useCallback((next: AsyncValue<TeamList>) => {
    teamCatalogRef.current = next;
    setTeamCatalog(next);
  }, []);

  const setRouteState = useCallback((routeKey: string, next: AsyncValue<TeamGrantList>) => {
    const states = { ...routeStatesRef.current, [routeKey]: next };
    routeStatesRef.current = states;
    setRouteStates(states);
  }, []);

  const loadTeamCatalog = useCallback(async (signal?: AbortSignal) => {
    const generation = ++catalogGenerationRef.current;
    const retained = teamCatalogRef.current.value;
    setCatalogState({ status: "loading", value: retained, error: "" });
    try {
      const value = await requestTeamApi<TeamList>("/api/teams", { signal });
      if (!mountedRef.current || !teamRequestIsCurrent(
        generation,
        catalogGenerationRef.current,
        signal?.aborted ?? false,
      )) return null;
      setCatalogState({ status: "ready", value, error: "" });
      return value;
    } catch (requestError) {
      if (!mountedRef.current || signal?.aborted || generation !== catalogGenerationRef.current) return null;
      setCatalogState({
        status: "error",
        value: retained,
        error: requestError instanceof Error ? requestError.message : "Teams could not be loaded",
      });
      return null;
    }
  }, [setCatalogState]);

  const loadTeamGrantRoute = useCallback(async (
    route: TeamShareRoute,
    signal?: AbortSignal,
  ) => {
    const generation = (routeGenerationRef.current[route.key] ?? 0) + 1;
    routeGenerationRef.current[route.key] = generation;
    const retained = routeStatesRef.current[route.key]?.value ?? null;
    setRouteState(route.key, { status: "loading", value: retained, error: "" });
    const requestKey = `${contextKeyRef.current}|${route.key}`;
    try {
      const parameters = new URLSearchParams({
        resource_type: route.resourceType,
        resource_id: route.publicId,
      });
      const value = await requestTeamApi<TeamGrantList>(`/api/shares/teams?${parameters}`, { signal });
      if (!mountedRef.current || !teamShareRequestIsCurrent(
        generation,
        routeGenerationRef.current[route.key] ?? 0,
        requestKey,
        `${contextKeyRef.current}|${route.key}`,
        signal?.aborted ?? false,
      )) return null;
      if (!teamGrantResponseMatchesRoute(route, value)) {
        throw new Error("Team access response did not match this route");
      }
      setRouteState(route.key, { status: "ready", value, error: "" });
      return value;
    } catch (requestError) {
      if (
        !mountedRef.current ||
        signal?.aborted ||
        !teamShareRequestIsCurrent(
          generation,
          routeGenerationRef.current[route.key] ?? 0,
          requestKey,
          `${contextKeyRef.current}|${route.key}`,
          false,
        )
      ) return null;
      const unavailable = requestError instanceof TeamRequestError &&
        (requestError.status === 403 || requestError.status === 404);
      setRouteState(route.key, {
        status: "error",
        value: unavailable ? null : retained,
        error: unavailable
          ? "Team access unavailable"
          : requestError instanceof Error
            ? requestError.message
            : "Team access could not be loaded",
      });
      return null;
    }
  }, [setRouteState]);

  useEffect(() => () => {
    mountedRef.current = false;
    catalogGenerationRef.current += 1;
    for (const route of routesRef.current) {
      routeGenerationRef.current[route.key] = (routeGenerationRef.current[route.key] ?? 0) + 1;
    }
  }, []);

  useEffect(() => {
    const nextRoutes = context.teamRoutes;
    const nextRouteIdentities = new Set(nextRoutes.map((route) => `${route.key}:${route.publicId}`));
    for (const previousRoute of routesRef.current) {
      if (nextRouteIdentities.has(`${previousRoute.key}:${previousRoute.publicId}`)) continue;
      routeGenerationRef.current[previousRoute.key] =
        (routeGenerationRef.current[previousRoute.key] ?? 0) + 1;
    }
    routesRef.current = nextRoutes;
    contextKeyRef.current = context.key;
  }, [context.key, context.teamRoutes]);

  useEffect(() => {
    if (!routesRef.current.length) return;
    const catalogController = new AbortController();
    const routeControllers = routesRef.current.map(() => new AbortController());
    void loadTeamCatalog(catalogController.signal);
    routesRef.current.forEach((route, index) => {
      void loadTeamGrantRoute(route, routeControllers[index]?.signal);
    });
    return () => {
      catalogController.abort();
      routeControllers.forEach((controller) => controller.abort());
    };
  }, [loadTeamCatalog, loadTeamGrantRoute, routeIdentity]);

  const directTarget = context.directTarget;
  const directGrants = directTarget
    ? collaborators.filter((grant) =>
        grant.resourceType === directTarget.resourceType &&
        grant.resourceId === directTarget.resourceId)
    : [];
  const owner = directTarget?.ownerUserId === currentUser.id
    ? currentUser
    : users.find((user) => user.id === directTarget?.ownerUserId);
  const ownerName = owner?.displayName ?? "Resource owner";
  const directRoles = directTarget
    ? (["manager", "editor", "viewer"] as const).filter((role) =>
        canAssignRole(directTarget.accessRole, directTarget.resourceType, role))
    : [];

  const personOptions = sharePersonOptions({ query, directTarget, directGrants, ownerEmail: owner?.email, currentUser, users, collaborators });

  const teamOptions = context.teamRoutes.length && teamCatalog.value
    ? filterShareTeamOptions(teamCatalog.value, query).map<ShareTeamOption>((entry) => ({
        kind: "team",
        key: `team:${entry.team.id}`,
        entry,
      }))
    : [];
  const principalOptions: SharePrincipalOption[] = [...personOptions, ...teamOptions];
  const activeOptionIndex = principalOptions.length
    ? Math.min(highlighted, principalOptions.length - 1)
    : -1;
  const selectableTeamRoutes = context.teamRoutes.filter((route) => teamRouteRoles(route).length > 0);
  const selectedRoute = selectedPrincipal?.kind === "team"
    ? selectableTeamRoutes.find((route) =>
        route.key === (context.teamRoutes.length === 1
          ? selectableTeamRoutes[0]?.key
          : selectedRouteKey)) ?? null
    : null;
  const selectedRouteState = selectedRoute ? routeStates[selectedRoute.key] : null;
  const existingTeamGrant = selectedPrincipal?.kind === "team" && selectedRouteState?.value
    ? selectedRouteState.value.grants.find((grant) =>
        grant.teamId === selectedPrincipal.entry.team.id) ?? null
    : null;
  const selectedRoles = selectedPrincipal?.kind === "team"
    ? selectedRoute
      ? teamRouteRoles(selectedRoute)
      : []
    : directRoles;
  const selectedPermissionValue = normalizedTeamSharePermission(selectedPermission, selectedRoles);
  const selectedPermissionAllowed = selectedPermissionValue !== "";
  const addDisabled = busy || Boolean(teamMutation) || !selectedPrincipal || !selectedPermissionAllowed ||
    (selectedPrincipal.kind === "person" && !directTarget) ||
    (selectedPrincipal.kind === "team" && (
      !selectedRoute ||
      selectedRouteState?.status !== "ready" ||
      existingTeamGrant?.revokedAt === null
    ));
  const hasTeamRoutes = context.teamRoutes.length > 0;

  function choosePrincipal(option: SharePrincipalOption) {
    setSelectedPrincipal(option);
    setSelectedPermission("");
    setSelectedRouteKey(option.kind === "team" && context.teamRoutes.length === 1
      ? selectableTeamRoutes[0]?.key ?? ""
      : "");
    setQuery(option.kind === "person" ? option.email : option.entry.team.name);
    setComboOpen(false);
    setHighlighted(0);
    setDirectError("");
    setTeamAlert(null);
  }

  async function mutateTeamGrantRoute(
    route: TeamShareRoute,
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown>,
    mutationKey: string,
  ) {
    if (teamMutationRef.current) return false;
    teamMutationRef.current = true;
    routeGenerationRef.current[route.key] = (routeGenerationRef.current[route.key] ?? 0) + 1;
    setTeamMutation({ routeKey: route.key, key: mutationKey });
    setTeamAlert(null);
    const routeIsCurrent = () => routesRef.current.some((currentRoute) =>
      currentRoute.key === route.key &&
      currentRoute.resourceType === route.resourceType &&
      currentRoute.publicId === route.publicId);
    try {
      const value = await requestTeamApi<TeamGrantList>("/api/shares/teams", {
        method,
        body: JSON.stringify(body),
      });
      if (!mountedRef.current || contextKeyRef.current !== context.key || !routeIsCurrent()) return false;
      if (!teamGrantResponseMatchesRoute(route, value)) {
        throw new Error("Team access response did not match this route");
      }
      setRouteState(route.key, { status: "ready", value, error: "" });
      return true;
    } catch (requestError) {
      if (!mountedRef.current || contextKeyRef.current !== context.key || !routeIsCurrent()) return false;
      if (requestError instanceof TeamRequestError && requestError.status === 409) {
        const latest = await loadTeamGrantRoute(route);
        if (!mountedRef.current || contextKeyRef.current !== context.key || !routeIsCurrent()) return false;
        setTeamAlert({
          routeKey: route.key,
          routePublicId: route.publicId,
          message: teamGrantConflictReadbackMessage(latest !== null),
        });
        return false;
      }
      const retained = routeStatesRef.current[route.key]?.value ?? null;
      const forbidden = requestError instanceof TeamRequestError && requestError.status === 403;
      setRouteState(route.key, {
        status: "error",
        value: retained,
        error: forbidden
          ? "Your role cannot manage this Team grant"
          : requestError instanceof Error
            ? requestError.message
            : "Team access could not be updated",
      });
      setTeamAlert({
        routeKey: route.key,
        routePublicId: route.publicId,
        message: forbidden
          ? "Your role cannot change or revoke this Team grant. Reload the route if your access changed."
          : "Team access may have changed. Reload this route before trying again.",
      });
      return false;
    } finally {
      teamMutationRef.current = false;
      if (mountedRef.current && contextKeyRef.current === context.key) setTeamMutation(null);
    }
  }

  async function submitPrincipal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (addDisabled || !selectedPrincipal || !selectedPermission || !selectedPermissionAllowed) return;
    if (selectedPrincipal.kind === "person") {
      if (!directTarget) return;
      setDirectError("");
      const ok = await onShare({
        resourceType: directTarget.resourceType,
        resourceId: directTarget.resourceId,
        email: selectedPrincipal.email,
        permission: selectedPermission,
      });
      if (!mountedRef.current) return;
      if (!ok) {
        setDirectError("Person access could not be added. Review the email and try again.");
        return;
      }
    } else {
      if (!selectedRoute) return;
      const body: Record<string, unknown> = {
        teamId: selectedPrincipal.entry.team.publicId,
        resourceType: selectedRoute.resourceType,
        resourceId: selectedRoute.publicId,
        permission: selectedPermission,
      };
      if (existingTeamGrant?.revokedAt) body.version = existingTeamGrant.version;
      const ok = await mutateTeamGrantRoute(
        selectedRoute,
        "POST",
        body,
        `add:${selectedPrincipal.entry.team.id}`,
      );
      if (!ok) return;
    }
    setSelectedPrincipal(null);
    setSelectedPermission("");
    setSelectedRouteKey("");
    setQuery("");
  }

  function handleComboboxKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && comboOpen) {
      event.preventDefault();
      event.stopPropagation();
      setComboOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setComboOpen(true);
      if (!principalOptions.length) return;
      setHighlighted((current) => event.key === "ArrowDown"
        ? (current + 1) % principalOptions.length
        : (current - 1 + principalOptions.length) % principalOptions.length);
      return;
    }
    if (event.key === "Enter" && comboOpen && activeOptionIndex >= 0) {
      event.preventDefault();
      choosePrincipal(principalOptions[activeOptionIndex]!);
    }
  }

  const inheritanceCopy = directTarget?.inherited
    ? "Direct People access applies to the Project and all inherited records."
    : directTarget?.resourceType === "task"
      ? "Direct People access applies only to this standalone Task."
      : "A directly shared global View still shows only Tasks the person can already access.";
  const visibleTeamAlert = teamAlert && context.teamRoutes.some((route) =>
    route.key === teamAlert.routeKey && route.publicId === teamAlert.routePublicId)
    ? teamAlert.message
    : "";

  return <Modal onClose={onClose} className="share-dialog" ariaLabel={`Members & access · ${context.label}`}>
    <DialogHeader title={`Members & access · ${context.label}`} icon={<UsersRound size={17} />} onClose={onClose} />
    <div className="share-dialog-body">
      <p className="dialog-copy">{hasTeamRoutes ? "Choose a Person or one of your active Teams, then choose a role." : "Choose a Person, then choose a role."} Typing alone never grants access.</p>
      <form className="share-principal-form" onSubmit={(event) => void submitPrincipal(event)} aria-busy={busy || Boolean(teamMutation) || undefined}>
        <div className="share-combobox">
          <label htmlFor={`${listboxId}-input`}>{hasTeamRoutes ? <>People &amp; Teams</> : "People"}</label>
          <div className="share-combobox-control"><Search size={14} aria-hidden="true" /><input
            id={`${listboxId}-input`}
            type="search"
            value={query}
            placeholder={hasTeamRoutes ? "Search People or Teams…" : "Search People…"}
            role="combobox"
            aria-expanded={comboOpen}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-activedescendant={comboOpen && activeOptionIndex >= 0 ? `${listboxId}-option-${activeOptionIndex}` : undefined}
            autoComplete="off"
            autoFocus
            disabled={busy || Boolean(teamMutation)}
            onFocus={() => setComboOpen(true)}
            onKeyDown={handleComboboxKey}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedPrincipal(null);
              setSelectedPermission("");
              setSelectedRouteKey("");
              setHighlighted(0);
              setComboOpen(true);
            }}
          /></div>
          {comboOpen && <div className="share-combobox-list" id={listboxId} role="listbox" aria-label={hasTeamRoutes ? "People and Teams" : "People"}>
            {personOptions.length > 0 && <div className="share-option-group" role="group" aria-label="People"><span>People</span>{personOptions.map((option) => {
              const index = principalOptions.indexOf(option);
              return <button id={`${listboxId}-option-${index}`} className={index === activeOptionIndex ? "highlighted" : ""} type="button" role="option" aria-selected={index === activeOptionIndex} key={option.key} onMouseEnter={() => setHighlighted(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choosePrincipal(option)}><span className="avatar">{initials(option.displayName)}</span><span><b>{option.displayName}</b><small>{option.email}</small></span><em>Person</em></button>;
            })}</div>}
            {teamOptions.length > 0 && <div className="share-option-group" role="group" aria-label="Teams"><span>Teams</span>{teamOptions.map((option) => {
              const index = principalOptions.indexOf(option);
              return <button id={`${listboxId}-option-${index}`} className={index === activeOptionIndex ? "highlighted" : ""} type="button" role="option" aria-selected={index === activeOptionIndex} key={option.key} onMouseEnter={() => setHighlighted(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choosePrincipal(option)}><span className="team-option-icon"><UsersRound size={15} /></span><span><b>{option.entry.team.name}</b><small>{option.entry.activeMemberCount} active · Your role: {option.entry.currentMembership.role}</small></span><em>Team</em></button>;
            })}</div>}
            {context.teamRoutes.length > 0 && (teamCatalog.status === "idle" || (teamCatalog.status === "loading" && !teamCatalog.value)) && <div className="share-combobox-state" aria-live="polite">Loading your Teams…</div>}
            {context.teamRoutes.length > 0 && teamCatalog.status === "error" && !teamCatalog.value && <div className="share-combobox-state" role="alert"><span>Teams could not be loaded.</span><button type="button" className="button ghost compact" disabled={busy || Boolean(teamMutation)} onClick={() => void loadTeamCatalog()}>Retry</button></div>}
            {teamCatalog.status === "ready" && !query.trim() && teamOptions.length === 0 && <div className="share-combobox-state">No active Teams available.</div>}
            {query.trim() && principalOptions.length === 0 && teamCatalog.status !== "loading" && <div className="share-combobox-state">{hasTeamRoutes ? "No matching People or Teams." : "No matching People."}</div>}
          </div>}
        </div>

        {selectedPrincipal?.kind === "team" && context.teamRoutes.length > 1 && selectableTeamRoutes.length > 0 && <fieldset className="team-route-choice"><legend>Choose where this Team gets access</legend>{selectableTeamRoutes.map((route, index) => {
          const routeInputId = `${listboxId}-route-${index}`;
          return <label key={route.key} htmlFor={routeInputId} aria-label={`${route.label}: ${route.explanation}`}><input id={routeInputId} type="radio" name="teamRoute" value={route.key} checked={selectedRouteKey === route.key} disabled={busy || Boolean(teamMutation)} onChange={() => { setSelectedRouteKey(route.key); setSelectedPermission(""); }} /><span><b>{route.label}</b><small>{route.explanation}</small></span></label>;
        })}</fieldset>}

        <label className="share-role-select" htmlFor={`${listboxId}-role`}><span>Role</span><select id={`${listboxId}-role`} aria-label="Role" value={selectedPermissionValue} disabled={busy || Boolean(teamMutation) || !selectedPrincipal || (selectedPrincipal.kind === "team" && !selectedRoute)} onChange={(event) => setSelectedPermission(event.target.value as TeamGrantPermission | "")}><option value="">Choose role…</option>{selectedRoles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label>
        <button className="button primary share-add-button" disabled={addDisabled}>{busy || teamMutation ? "Saving…" : existingTeamGrant?.revokedAt ? "Restore access" : "Add access"}</button>
        {selectedPrincipal?.kind === "team" && existingTeamGrant?.revokedAt === null && <p className="share-selection-note" role="status">This Team already has active access through the selected route.</p>}
      </form>

      {(directError || visibleTeamAlert) && <div className="team-local-alert" role="alert">{directError || visibleTeamAlert}</div>}
      <p className="share-route-caveat" role="note"><b>Strongest route wins.</b> Direct People access, Project inheritance, explicit Task routes, and other Teams can preserve access after one route is changed or revoked.</p>

      {directTarget && <section className="share-access-section" aria-labelledby={`${listboxId}-people-heading`}><header><div><h3 id={`${listboxId}-people-heading`}>People</h3><p>{inheritanceCopy}</p></div><span className="count-pill">{directGrants.length + 1}</span></header><div className="access-list people-access-list"><div className="access-row"><span className="avatar">{initials(ownerName)}</span><span><b>{ownerName}</b><small>{owner?.email ?? "Current resource owner"}</small></span><em>Owner</em></div>{directGrants.map((grant) => {
        const manageable = canManageGrant(directTarget.accessRole, directTarget.resourceType, grant.permission);
        return <div className="access-row" key={grant.grantId}><span className="avatar">{initials(grant.displayName)}</span><span><b>{grant.displayName}</b><small>{grant.email}</small></span><select aria-label={`Role for ${grant.displayName}`} value={grant.permission} disabled={busy || !manageable} onChange={(event) => void (async () => { setDirectError(""); const ok = await onRoleChange(grant.grantId, event.target.value as "manager" | "editor" | "viewer"); if (!ok) setDirectError("Person access could not be changed. Try again."); })()}><option value={grant.permission}>{roleLabel(grant.permission)}</option>{directRoles.filter((role) => role !== grant.permission).map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select><div className="access-actions">{directTarget.resourceType === "project" && directTarget.accessRole === "owner" && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Transfer ownership of ${directTarget.label} to ${grant.displayName}? You will become Manager.`)) void onTransfer(directTarget.resourceId, grant.userId); }}>Make owner</button>}{manageable && <button type="button" disabled={busy} onClick={() => void (async () => { setDirectError(""); const ok = await onRevoke(grant.grantId); if (!ok) setDirectError("Person access could not be removed. Try again."); })()}>Remove</button>}</div></div>;
      })}</div></section>}

      <section className="share-access-section team-access-section" aria-labelledby={`${listboxId}-teams-heading`}><header><div><h3 id={`${listboxId}-teams-heading`}>Teams</h3><p>Team routes are managed separately from direct People access.</p></div></header>{context.teamUnavailableCopy ? <div className="team-route-unavailable" role="note">{context.teamUnavailableCopy}</div> : context.teamRoutes.map((route) => {
        const state = routeStates[route.key] ?? emptyAsyncValue<TeamGrantList>();
        const grants = state.value?.grants ?? [];
        return <article className="team-route-panel" key={route.key} aria-busy={state.status === "idle" || state.status === "loading" || undefined}><header><div><h4>{route.label}</h4><p>{route.explanation}</p></div>{state.value && <span className="count-pill">{grants.filter((grant) => grant.revokedAt === null).length}</span>}</header>{(state.status === "idle" || state.status === "loading") && !state.value && <div className="team-route-state" aria-live="polite">Loading Team access…</div>}{state.status === "error" && <div className="team-local-alert" role="alert"><span>{state.error}</span><button type="button" className="button ghost compact" disabled={busy || Boolean(teamMutation)} onClick={() => void loadTeamGrantRoute(route)}>Retry</button></div>}{state.status === "ready" && grants.length === 0 && <div className="team-route-state">No Team access through this route.</div>}{grants.length > 0 && <div className="access-list team-grant-list">{grants.map((grant) => {
          const catalogEntry = teamCatalog.value?.teams.find((entry) => entry.team.id === grant.teamId);
          return <TeamGrantAccessRow key={grant.id} route={route} grant={grant} catalogEntry={catalogEntry} busy={busy || Boolean(teamMutation)} routeReady={state.status === "ready"} onRoleChange={(permission) => void mutateTeamGrantRoute(route, "PATCH", { grantId: grant.id, version: grant.version, action: "role", permission }, `role:${grant.id}`)} onRevoke={() => void mutateTeamGrantRoute(route, "DELETE", { grantId: grant.id, version: grant.version }, `revoke:${grant.id}`)} />;
        })}</div>}</article>;
      })}</section>
    </div>
  </Modal>;
}

export function roleLabel(role: "owner" | "manager" | "editor" | "viewer") {
  return role === "owner" ? "Owner" : role === "manager" ? "Manager" : role === "editor" ? "Editor" : "Viewer";
}

export function browserSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function backupPhaseLabel(phase: string) {
  const labels: Record<string, string> = {
    freezing_d1: "Фиксация D1",
    inventory_r2: "Инвентаризация файлов",
    hash_objects: "Проверка файлов",
    build_rows: "Упаковка таблиц",
    build_object_parts: "Упаковка файлов",
    state_digest_rows: "Контрольная сумма D1",
    state_digest_objects: "Контрольная сумма R2",
    finalize_export: "Завершение экспорта",
    uploading: "Загрузка частей",
    validating_parts: "Проверка частей",
    validating_objects: "Проверка файлов",
    preflight: "Полная проверка состояния",
    revalidate_r2: "Повторная проверка R2",
    apply_revalidate_rows: "Проверка D1 перед заменой",
    apply_revalidate_objects: "Проверка R2 перед заменой",
    prepare_rollback: "Подготовка страховочного снимка",
    waiting_rollback: "Ожидание страховочного снимка",
    materializing: "Подготовка новых объектов",
    d1_cutover: "Атомарная замена D1",
    verifying_d1: "Проверка восстановленной D1",
    verification_failed: "D1 заменена, проверка не пройдена",
    verifying_objects: "Проверка восстановленного R2",
    cleanup: "Очистка прежних объектов",
    ready: "Готово",
    applied: "Восстановлено",
    failed: "Остановлено",
    expired: "Срок задания истёк",
  };
  return labels[phase] ?? "Обработка";
}

export function backupByteSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount.toLocaleString("ru-RU", { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
}

export function backupOriginLabel(origin: string) {
  try {
    return new URL(origin).host;
  } catch {
    return "текущий Site";
  }
}

export function rememberBackupStatus(
  key: string,
  status: SystemBackupJobStatus,
  extra: Pick<SystemBackupCheckpoint, "file" | "relatedJobId"> = {},
) {
  const storage = browserSessionStorage();
  if (!storage) return;
  writeBackupCheckpoint(
    storage,
    key,
    retainBackupCheckpoint(status)
      ? { jobId: status.jobId, kind: status.kind, ...extra }
      : null,
  );
}

export function clearBackupStatus(key: string) {
  const storage = browserSessionStorage();
  if (storage) writeBackupCheckpoint(storage, key, null);
}

export function SystemBackupProgress({ status }: { status: SystemBackupJobStatus }) {
  return <div className="system-backup-progress" role="status" aria-live="polite">
    <span className={`system-backup-state ${status.status}`}>{backupPhaseLabel(status.phase)}</span>
    <dl>
      <div><dt>Строки</dt><dd>{status.progress.rows.toLocaleString("ru-RU")}</dd></div>
      <div><dt>Данные</dt><dd>{backupByteSize(status.progress.bytes)}</dd></div>
      <div><dt>Части</dt><dd>{status.progress.parts.toLocaleString("ru-RU")}</dd></div>
      <div><dt>Контрольная точка</dt><dd>{longDateTime(status.updatedAt)}</dd></div>
    </dl>
  </div>;
}

export function SystemBackupPreview({ status }: { status: SystemBackupJobStatus }) {
  const counts = Object.entries(status.counts).sort(([left], [right]) => left.localeCompare(right));
  const namespaces = Object.entries(status.r2.namespaces).sort(([left], [right]) => left.localeCompare(right));
  const policies = [
    ["Точно сохраняются", status.policies.exact],
    ["Перестраиваются", status.policies.rebuild],
    ["Сбрасываются", status.policies.reset],
    ["Отзываются", status.policies.revoke],
    ["Не входят", status.policies.excluded],
  ] as const;
  return <div className="system-backup-preview">
    <div className="system-import-valid"><Check size={15} /><span><b>Полная проверка пройдена</b><small>{status.exportedAt ? `Снимок от ${longDateTime(status.exportedAt)}` : "Дата снимка уточняется"}</small></span></div>
    <dl className="system-backup-metadata">
      <div><dt>Формат</dt><dd>{status.format.name} v{status.format.version}</dd></div>
      <div><dt>Схема</dt><dd>{status.schemaVersion}</dd></div>
      <div><dt>Site</dt><dd>{backupOriginLabel(status.siteOrigin)}</dd></div>
      <div><dt>Среда</dt><dd>{status.environmentScope}</dd></div>
      <div className="wide"><dt>Fingerprint схемы</dt><dd><code>{status.schemaFingerprint}</code></dd></div>
      <div className="wide"><dt>Root SHA-256</dt><dd><code>{status.rootSha256 ?? "—"}</code></dd></div>
      <div className="wide"><dt>State SHA-256</dt><dd><code>{status.stateSha256 ?? "—"}</code></dd></div>
    </dl>
    <details className="system-backup-details" open>
      <summary>Все таблицы · {counts.length}</summary>
      <dl className="system-import-counts">
        {counts.map(([name, count]) => <div key={name}><dt>{name}</dt><dd>{count.toLocaleString("ru-RU")}</dd></div>)}
      </dl>
    </details>
    <details className="system-backup-details" open>
      <summary>Файлы R2</summary>
      <dl className="system-backup-r2">
        <div><dt>Объекты</dt><dd>{status.r2.objects.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Объём</dt><dd>{backupByteSize(status.r2.bytes)}</dd></div>
        <div><dt>Связанные</dt><dd>{status.r2.bound.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Несвязанные</dt><dd>{status.r2.unbound.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Сироты</dt><dd>{status.r2.orphan.toLocaleString("ru-RU")}</dd></div>
      </dl>
      {namespaces.length > 0 && <dl className="system-backup-namespaces">{namespaces.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value.objects.toLocaleString("ru-RU")} · {backupByteSize(value.bytes)}</dd></div>)}</dl>}
    </details>
    <details className="system-backup-details">
      <summary>Политики восстановления</summary>
      <dl className="system-backup-policies">{policies.map(([label, values]) => <div key={label}><dt>{label}</dt><dd>{values.length > 0 ? values.join(", ") : "—"}</dd></div>)}</dl>
    </details>
    {(status.rollbackJobId || status.cleanupPending || status.error) && <dl className="system-backup-operational">
      {status.rollbackJobId && <div><dt>Страховочный job</dt><dd>{status.rollbackJobId}</dd></div>}
      {status.cleanupPending && <div><dt>Очистка</dt><dd>Замена завершена; очистка прежних объектов ещё идёт.</dd></div>}
      {status.error && <div><dt>Состояние ошибки</dt><dd>{safeBackupMessage(status.error)}</dd></div>}
    </dl>}
    {status.warnings.length > 0 && <div className="system-backup-messages warning" role="status"><b>Предупреждения</b><ul>{status.warnings.map((warning, index) => <li key={`${warning}:${index}`}>{safeBackupMessage(warning)}</li>)}</ul></div>}
    {status.validationErrors.length > 0 && <div className="system-backup-messages error" role="alert"><b>Ошибки проверки</b><ul>{status.validationErrors.map((error, index) => <li key={`${error}:${index}`}>{safeBackupMessage(error)}</li>)}</ul></div>}
  </div>;
}

export function SystemBackupExportDialog({
  status,
  busy,
  waitingForNetwork,
  error,
  onClose,
  onStart,
  onResume,
}: {
  status: SystemBackupJobStatus | null;
  busy: boolean;
  waitingForNetwork: boolean;
  error: string;
  onClose: () => void;
  onStart: (fresh?: boolean) => void;
  onResume: () => void;
}) {
  const [downloadStartedForJobId, setDownloadStartedForJobId] = useState<string | null>(null);
  const downloadStarted = downloadStartedForJobId === status?.jobId;
  const downloadUrl = safeSystemBackupDownloadUrl(status?.downloadUrl ?? null);
  const terminalFailure = status?.status === "failed" || status?.status === "expired";
  const resumable = Boolean(status && !backupJobIsTerminal(status) && !busy);
  const stateLabel = status?.status === "ready"
    ? "Экспорт готов"
    : terminalFailure
      ? "Экспорт остановлен"
      : waitingForNetwork
        ? "Ожидается сеть — можно возобновить"
        : busy
          ? "Экспорт выполняется"
          : resumable
            ? "Экспорт можно возобновить"
            : "Подготовка экспорта";
  return <Modal onClose={onClose} className="system-import-modal system-export-modal">
    <DialogHeader title="Экспорт полного состояния" icon={<Download size={17} />} onClose={onClose} />
    <div className="system-import-body">
      <p>Снимок включает состояние всех пользователей, проектов, задач, представлений и оригиналы файлов. Он содержит чувствительные данные — храните его как секрет.</p>
      <div className={`system-export-runtime ${waitingForNetwork ? "waiting" : status?.status ?? "idle"}`} role="status" aria-live="polite">
        <b>{stateLabel}</b>
        <span>Пока Task Manager открыт, экспорт продолжает работу независимо от этого окна. При полностью закрытой вкладке он безопасно приостановится и продолжится после следующего открытия Administration.</span>
      </div>
      {status && <SystemBackupProgress status={status} />}
      {status?.status === "ready" && <SystemBackupPreview status={status} />}
      {error && <p className="system-import-error" role="alert">{error}</p>}
    </div>
    <div className="dialog-footer system-backup-footer">
      <span>{downloadStarted ? "Загрузка передана браузеру" : status?.status === "ready" ? "Файл готов и не кэшируется" : "Состояние задания хранится на сервере"}</span>
      <div>
        <button className="button ghost" type="button" onClick={onClose}>Закрыть окно</button>
        {!status && !busy && <button className="button primary" type="button" onClick={() => onStart()}><Download size={14} />Начать экспорт</button>}
        {terminalFailure && <button className="button ghost" type="button" disabled={busy} onClick={() => onStart()}><RotateCw size={14} />Начать заново</button>}
        {resumable && <button className="button primary" type="button" onClick={onResume}><RotateCw size={14} />Продолжить</button>}
        {status?.status === "ready" && <button className="button ghost" type="button" onClick={() => onStart(true)}><RotateCw size={14} />Новый экспорт</button>}
        {downloadUrl && <a className="button primary" href={downloadUrl} download onClick={() => setDownloadStartedForJobId(status?.jobId ?? null)}><Download size={14} />Скачать .tmbak</a>}
      </div>
    </div>
  </Modal>;
}

export function SystemImportDialog({
  onClose,
  onBusyChange,
  onApplied,
}: {
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onApplied: (result: SystemBackupJobStatus) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<SystemBackupJobStatus | null>(null);
  const [safetyStatus, setSafetyStatus] = useState<SystemBackupJobStatus | null>(null);
  const [safetyDownloaded, setSafetyDownloaded] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const booted = useRef(false);
  const safetyBootedFor = useRef<string | null>(null);

  const setImportBusy = useCallback((value: boolean) => {
    setBusy(value);
    onBusyChange(value);
  }, [onBusyChange]);

  const updateImportStatus = useCallback((next: SystemBackupJobStatus, selectedFile?: File | null) => {
    setStatus(next);
    const source = selectedFile ?? file;
    rememberBackupStatus(systemBackupImportCheckpointKey, next, source ? {
      file: { name: source.name, size: source.size, lastModified: source.lastModified },
    } : {});
  }, [file]);

  const finishResumedImport = useCallback(async (initial: SystemBackupJobStatus) => {
    setImportBusy(true);
    setError("");
    try {
      const result = await runSystemBackupJob(initial, { onProgress: updateImportStatus, stepDelayMs: 0 });
      updateImportStatus(result);
      if (result.status === "applied") {
        clearBackupStatus(systemBackupImportCheckpointKey);
        clearBackupStatus(systemBackupSafetyExportCheckpointKey);
        onApplied(result);
      } else if (result.phase === "verification_failed") {
        setError("D1 уже заменена, но post-restore проверка не прошла. Не запускайте замену повторно вслепую.");
      } else if (result.status === "failed" || result.status === "expired") {
        setError("Сервер остановил операцию до подтверждённого восстановления.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось продолжить операцию.");
    } finally {
      setImportBusy(false);
    }
  }, [onApplied, setImportBusy, updateImportStatus]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const storage = browserSessionStorage();
    const checkpoint = storage ? readBackupCheckpoint(storage, systemBackupImportCheckpointKey) : null;
    if (!checkpoint) return;
    void getBackupJobStatus(checkpoint.jobId).then((current) => {
      setStatus(current);
      if (current.status === "uploading") return;
      if (current.status !== "ready" && current.status !== "failed" && current.status !== "expired" && current.status !== "applied") {
        void finishResumedImport(current);
      } else if (current.status === "applied") {
        clearBackupStatus(systemBackupImportCheckpointKey);
        onApplied(current);
      }
    }).catch((requestError: unknown) => {
      clearBackupStatus(systemBackupImportCheckpointKey);
      setError(requestError instanceof Error ? requestError.message : "Сохранённый импорт недоступен.");
    });
  }, [finishResumedImport, onApplied]);

  useEffect(() => {
    if (!status || !backupImportIsFullyValidated(status) || safetyBootedFor.current === status.jobId) return;
    const importJobId = status.jobId;
    safetyBootedFor.current = importJobId;
    const storage = browserSessionStorage();
    const checkpoint = storage ? readBackupCheckpoint(storage, systemBackupSafetyExportCheckpointKey) : null;
    if (!checkpoint || checkpoint.relatedJobId !== importJobId) {
      if (checkpoint) clearBackupStatus(systemBackupSafetyExportCheckpointKey);
      return;
    }
    void getBackupJobStatus(checkpoint.jobId).then((current) => {
      setSafetyStatus(current);
      if (current.status !== "ready" && current.status !== "failed" && current.status !== "expired") {
        setImportBusy(true);
        void runSystemBackupJob(current, {
          onProgress: (next) => {
            setSafetyStatus(next);
            rememberBackupStatus(systemBackupSafetyExportCheckpointKey, next, { relatedJobId: importJobId });
          },
          stepDelayMs: 0,
        }).finally(() => setImportBusy(false));
      }
    }).catch(() => clearBackupStatus(systemBackupSafetyExportCheckpointKey));
  }, [setImportBusy, status]);

  async function validateFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setImportBusy(true);
    setError("");
    setSafetyDownloaded(false);
    setSafetyStatus(null);
    setConfirmation("");
    clearBackupStatus(systemBackupSafetyExportCheckpointKey);
    const storage = browserSessionStorage();
    const checkpoint = storage ? readBackupCheckpoint(storage, systemBackupImportCheckpointKey) : null;
    try {
      const result = await uploadSystemBackupPackage(file, {
        checkpoint,
        onCheckpoint: (next) => {
          if (storage) writeBackupCheckpoint(storage, systemBackupImportCheckpointKey, next);
        },
        onProgress: (next) => updateImportStatus(next, file),
      });
      updateImportStatus(result, file);
      if (result.status === "failed" || result.status === "expired") {
        setError("Backup не прошёл проверку. Рабочие данные не менялись.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось проверить backup-файл.");
    } finally {
      setImportBusy(false);
    }
  }

  async function createSafetyBackup() {
    if (!status || !backupImportIsFullyValidated(status)) return;
    setImportBusy(true);
    setError("");
    setSafetyDownloaded(false);
    try {
      const created = await createSystemBackupExport(fetch, { fresh: true });
      setSafetyStatus(created);
      rememberBackupStatus(systemBackupSafetyExportCheckpointKey, created, { relatedJobId: status.jobId });
      const result = await runSystemBackupJob(created, {
        onProgress: (next) => {
          setSafetyStatus(next);
          rememberBackupStatus(systemBackupSafetyExportCheckpointKey, next, { relatedJobId: status.jobId });
        },
        stepDelayMs: 0,
      });
      setSafetyStatus(result);
      rememberBackupStatus(systemBackupSafetyExportCheckpointKey, result, { relatedJobId: status.jobId });
      if (result.status !== "ready") setError("Не удалось подготовить текущий страховочный снимок.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось подготовить текущий backup.");
    } finally {
      setImportBusy(false);
    }
  }

  async function applyImport() {
    if (!status || !canApplySystemBackupImport(status, safetyDownloaded, confirmation)) return;
    setImportBusy(true);
    setError("");
    try {
      const applying = await applySystemBackupImport(status);
      updateImportStatus(applying);
      const result = await runSystemBackupJob(applying, { onProgress: updateImportStatus, stepDelayMs: 0 });
      updateImportStatus(result);
      if (result.status !== "applied") {
        setError(result.phase === "verification_failed"
          ? "D1 уже заменена, но post-restore проверка не прошла. Не запускайте замену повторно вслепую."
          : "Восстановление не подтверждено сервером как завершённое.");
        return;
      }
      clearBackupStatus(systemBackupImportCheckpointKey);
      clearBackupStatus(systemBackupSafetyExportCheckpointKey);
      onApplied(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось завершить восстановление.");
    } finally {
      setImportBusy(false);
    }
  }

  function chooseAnotherFile() {
    clearBackupStatus(systemBackupImportCheckpointKey);
    clearBackupStatus(systemBackupSafetyExportCheckpointKey);
    setStatus(null);
    setSafetyStatus(null);
    setSafetyDownloaded(false);
    setConfirmation("");
    setFile(null);
    setError("");
  }

  const validated = backupImportIsFullyValidated(status);
  const committedVerificationFailure = status?.phase === "verification_failed";
  const safetyUrl = safeSystemBackupDownloadUrl(safetyStatus?.downloadUrl ?? null);
  return <Modal onClose={() => !busy && onClose()} className="system-import-modal">
    <DialogHeader title="Импорт полного состояния" icon={<Upload size={17} />} onClose={() => !busy && onClose()} />
    {!validated ? <form onSubmit={validateFile}>
      <div className="system-import-body">
        <p>{committedVerificationFailure
          ? "Атомарная замена D1 уже выполнена, но post-restore проверка обнаружила расхождение. Повторный apply не выполняйте до разбора причины."
          : "Импорт полностью заменит состояние всех пользователей. До завершения проверки сервер не меняет рабочие таблицы и файлы."}</p>
        {status && <SystemBackupProgress status={status} />}
        {status?.status === "uploading" && !file && <div className="system-backup-resume"><RotateCw size={14} /><span>Незавершённая загрузка найдена. Выберите тот же файл — уже принятые части повторно не отправятся.</span></div>}
        {!committedVerificationFailure && <label className="system-import-file">
          <span>Файл полного backup</span>
          <input
            type="file"
            accept={`.tmbak,${systemBackupMediaType}`}
            required
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError("");
            }}
          />
          <small>Файл читается построчно; общий размер не ограничен 10 МБ.</small>
        </label>}
        {status && (status.validationErrors.length > 0 || status.warnings.length > 0 || status.error) && <SystemBackupPreview status={status} />}
        {error && <p className="system-import-error" role="alert">{error}</p>}
      </div>
      <div className="dialog-footer system-backup-footer">
        <span>{committedVerificationFailure
          ? "D1 replace уже committed; сохраните diagnostics ошибки проверки"
          : "Повреждённый или неполный файл не меняет live state"}</span>
        <div>
          {committedVerificationFailure
            ? <button className="button primary" type="button" onClick={onClose}>Закрыть</button>
            : <>
                {status && (status.status === "uploading" || status.status === "failed" || status.status === "expired") && <button className="button ghost" type="button" disabled={busy} onClick={chooseAnotherFile}>Сбросить загрузку</button>}
                <button className="button primary" disabled={!file || busy}>{busy ? "Проверяем…" : status?.status === "uploading" ? "Продолжить проверку" : "Загрузить и проверить"}</button>
              </>}
        </div>
      </div>
    </form> : <div>
      <div className="system-import-body">
        {status && <SystemBackupPreview status={status} />}
        <div className="system-import-warning">
          <b>Следующий шаг заменит всё рабочее состояние.</b>
          <span>Сначала создайте и скачайте новый снимок текущего Site. Замена выполняется целиком; частичного восстановления нет.</span>
        </div>
        {!safetyStatus && <button className="button secondary system-import-download" type="button" disabled={busy} onClick={() => void createSafetyBackup()}><Database size={14} />Создать текущий backup</button>}
        {safetyStatus && <SystemBackupProgress status={safetyStatus} />}
        {safetyUrl && <a className={`button secondary system-import-download ${safetyDownloaded ? "confirmed" : ""}`} href={safetyUrl} download onClick={() => setSafetyDownloaded(true)}>{safetyDownloaded ? <Check size={14} /> : <Download size={14} />}{safetyDownloaded ? "Скачивание текущего backup запущено" : "Скачать текущий backup"}</a>}
        <label className="system-import-confirmation">
          <span>Введите <b>RESTORE</b>, чтобы заменить состояние</span>
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
        </label>
        {error && <p className="system-import-error" role="alert">{error}</p>}
      </div>
      <div className="dialog-footer system-backup-footer">
        <button className="button ghost" type="button" disabled={busy} onClick={chooseAnotherFile}>Другой файл</button>
        <button className="button primary system-import-apply" type="button" disabled={busy || !canApplySystemBackupImport(status, safetyDownloaded, confirmation)} onClick={() => void applyImport()}>{busy ? "Восстанавливаем…" : "Заменить всё состояние"}</button>
      </div>
    </div>}
  </Modal>;
}

export function CodexSetupDialog({ onClose, initialMode = "desktop", embedded = false }: { onClose: () => void; initialMode?: CodexSetupMode; embedded?: boolean }) {
  const [mode, setMode] = useState<CodexSetupMode>(initialMode);
  const [copied, setCopied] = useState<"marketplace" | "commands" | "diagnostic" | null>(null);

  function selectCodexSetupMode(nextMode: CodexSetupMode) {
    setMode((currentMode) => nextCodexSetupMode(currentMode, { type: "select", mode: nextMode }));
    setCopied(null);
  }

  function openCodexCliFallback() {
    setMode((currentMode) => nextCodexSetupMode(currentMode, { type: "open_cli_fallback" }));
    setCopied(null);
  }

  async function copySetup(value: string, target: "marketplace" | "commands" | "diagnostic") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch {
      setCopied(null);
    }
  }

  const body = <>
      {!embedded && <DialogHeader title="Connect Task Manager to Codex" icon={<CircleHelp size={17} />} onClose={onClose} />}
      <div className="codex-setup-body">
        <aside className="codex-mobile-handoff">
          <b>Installing from a phone?</b>
          <span>Continue on ChatGPT/Codex Desktop or with Codex CLI. Mobile ChatGPT can use Task Manager after the plugin is installed on the same account.</span>
        </aside>
        <p className="codex-setup-intro">
          Adding the marketplace, installing the plugin, and connecting your Task Manager account are separate checkpoints. Complete each success check before continuing.
        </p>
        <div className="codex-setup-tabs" role="tablist" aria-label="Codex client">
          <button
            id="codex-setup-tab-desktop"
            type="button"
            role="tab"
            aria-selected={mode === "desktop"}
            aria-controls="codex-setup-desktop"
            className={mode === "desktop" ? "active" : ""}
            onClick={() => selectCodexSetupMode("desktop")}
          >
            Codex Desktop
          </button>
          <button
            id="codex-setup-tab-cli"
            type="button"
            role="tab"
            aria-selected={mode === "cli"}
            aria-controls="codex-setup-cli"
            className={mode === "cli" ? "active" : ""}
            onClick={() => selectCodexSetupMode("cli")}
          >
            Codex CLI
          </button>
        </div>

        {mode === "desktop" ? (
          <section id="codex-setup-desktop" role="tabpanel" aria-labelledby="codex-setup-tab-desktop">
            <ol className="codex-setup-steps">
              <SetupStep
                number={1}
                title="Add Srez Marketplace"
                location="Codex Desktop · Plugins"
                success="Srez Marketplace is visible under Personal."
              >
                Open <b>Plugins → Add → Add a marketplace</b>, then paste this address into <b>Source</b>:
                <SetupCopyBlock
                  value={TASK_MANAGER_MARKETPLACE_URL}
                  label="Copy marketplace address"
                  copied={copied === "marketplace"}
                  onCopy={() => void copySetup(TASK_MANAGER_MARKETPLACE_URL, "marketplace")}
                />
                Leave <b>Git ref</b> and <b>Sparse paths</b> empty, then choose <b>Add marketplace</b>.
              </SetupStep>
              <SetupStep
                number={2}
                title="Install Task Manager plugin"
                location="Codex Desktop · Plugins → Personal"
                success="Task Manager appears under Installed."
              >
                <b>Personal</b> contains personal marketplaces. Open <b>Srez Marketplace → Task Manager</b>, then choose <b>Install</b> once.
              </SetupStep>
              <SetupStep
                number={3}
                title="Authenticate / Connect Task Manager account"
                location="Codex Desktop + browser"
                success="Task Manager consent completes; return to Codex for the Installed check."
              >
                Choose <b>Authenticate</b> or <b>Connect</b>. In the browser, confirm you are signed in to the same ChatGPT account and workspace as Desktop. On the Task Manager consent page, check the account and choose <b>Connect</b>.
              </SetupStep>
              <SetupStep
                number={4}
                title="Return to Codex and open Installed"
                location="Codex Desktop · Plugins → Installed"
                success="Installed shows Task Manager present and enabled."
              >
                Return to Desktop yourself if the browser remains open. <b>Installed</b> is where already installed plugins are checked; confirm <b>Task Manager</b> is present and enabled there.
              </SetupStep>
              <SetupStep
                number={5}
                title="Start a new task and run smoke"
                location="Codex Desktop · New task"
                success="Codex returns your Task Manager task summaries without making a write."
              >
                Start a <b>New task</b> so Codex loads the new plugin snapshot, then ask: <q>Show my tasks in Task Manager.</q> A successful response proves the account connection. Do not start a bulk migration or write flow before this read check passes.
              </SetupStep>
            </ol>

            <details className="codex-setup-troubleshooting">
              <summary>Redirected to web ChatGPT, but Task Manager is not installed?</summary>
              <div>
                <p><b>Stop after one failed Install attempt.</b> Repeated clicks do not add diagnostic information.</p>
                <ol>
                  <li>Confirm the browser and Desktop use the same ChatGPT account and workspace.</li>
                  <li>Back in Desktop, check <b>Plugins → Personal</b> for Srez Marketplace and <b>Plugins → Installed</b> for Task Manager.</li>
                  <li>Restart Desktop once, then check <b>Personal</b> and <b>Installed</b> again.</li>
                  <li>Use the Codex CLI fallback below if the plugin is still missing.</li>
                </ol>
                <button className="button secondary codex-cli-fallback" type="button" onClick={openCodexCliFallback}>
                  Open CLI fallback
                </button>
                <p>If it still fails, give an agent this bounded diagnostic prompt:</p>
                <SetupCopyBlock
                  value={TASK_MANAGER_DIAGNOSTIC_PROMPT}
                  label="Copy diagnostic prompt"
                  copied={copied === "diagnostic"}
                  multiline
                  onCopy={() => void copySetup(TASK_MANAGER_DIAGNOSTIC_PROMPT, "diagnostic")}
                />
                <p className="codex-install-bug-boundary">These checks do not fix the platform install redirect bug. They identify the failed stage and produce a reproducible report without exposing credentials.</p>
              </div>
            </details>
          </section>
        ) : (
          <section id="codex-setup-cli" role="tabpanel" aria-labelledby="codex-setup-tab-cli">
            <p className="codex-cli-copy-intro">Copy the complete fallback sequence, then verify each stage below:</p>
            <SetupCopyBlock
              value={TASK_MANAGER_CLI_SETUP}
              label="Copy CLI commands"
              copied={copied === "commands"}
              multiline
              onCopy={() => void copySetup(TASK_MANAGER_CLI_SETUP, "commands")}
            />
            <ol className="codex-setup-steps">
              <SetupStep
                number={1}
                title="Add Srez Marketplace"
                location="Terminal"
                success="codex plugin marketplace list includes Srez Marketplace."
              >
                Run <code>codex plugin marketplace add xxsrez/marketplace</code>.
              </SetupStep>
              <SetupStep
                number={2}
                title="Install Task Manager plugin"
                location="Terminal"
                success="codex plugin list includes task-manager@srez-marketplace."
              >
                Run <code>codex plugin add task-manager@srez-marketplace</code>.
              </SetupStep>
              <SetupStep
                number={3}
                title="Authenticate / Connect Task Manager account"
                location="Codex CLI + browser"
                success="Task Manager no longer shows an Authenticate action."
              >
                Run <code>codex</code>, then open <code>/plugins → Task Manager → Authenticate</code>. In the browser, use the same ChatGPT account/workspace, check the Task Manager consent, and choose <b>Connect</b>.
              </SetupStep>
              <SetupStep
                number={4}
                title="Return to Codex and start a new task"
                location="Codex CLI"
                success="A fresh task opens with the installed plugin snapshot."
              >
                Return to Codex and enter <code>/new</code>.
              </SetupStep>
              <SetupStep
                number={5}
                title="Run the read smoke"
                location="Fresh Codex task"
                success="Codex returns Task Manager task summaries without making a write."
              >
                Ask: <q>Show my tasks in Task Manager.</q> Only after this passes should you consider creating one test Task; do not begin with a bulk migration.
              </SetupStep>
            </ol>
          </section>
        )}

        <p className="codex-setup-note">
          Developer mode, a manual MCP URL, client ID, secret, and personal API token are not required for normal setup.
        </p>
      </div>
    </>;
  return embedded
    ? <section className="settings-integration" aria-label="Connect Task Manager to Codex">{body}</section>
    : <Modal onClose={onClose} className="codex-setup-modal" ariaLabel="Connect Task Manager to Codex">{body}</Modal>;
}

export function SetupStep({ number, title, location, success, children }: { number: number; title: string; location: string; success: string; children: React.ReactNode }) {
  return <li data-setup-stage={number}><span className="codex-step-number">{number}</span><div><strong>{title}</strong><span className="codex-step-location">{location}</span><div className="codex-step-content">{children}</div><p className="codex-step-success"><Check size={13} aria-hidden="true" /> <span><b>Success:</b> {success}</span></p></div></li>;
}

export function SetupCopyBlock({ value, label, copied, multiline = false, onCopy }: { value: string; label: string; copied: boolean; multiline?: boolean; onCopy: () => void }) {
  return (
    <div className={`codex-copy-block ${multiline ? "multiline" : ""}`}>
      {multiline ? <pre><code>{value}</code></pre> : <code>{value}</code>}
      <button type="button" aria-label={label} title={label} onClick={onCopy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

export function DialogHeader({ title, icon, onClose, className = "" }: { title: string; icon: React.ReactNode; onClose: () => void; className?: string }) { return <div className={`dialog-header ${className}`}><div>{icon}<h2>{title}</h2></div><button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><X size={15} /></button></div>; }
export function DialogFooter({ busy, label, disabled }: { busy: boolean; label: string; disabled?: boolean }) { return <div className="dialog-footer"><span>Press Esc to close</span><button className="button primary" disabled={busy || disabled}>{busy ? "Saving…" : label}</button></div>; }
export const FOCUSABLE_SELECTOR = "button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";
export function trapFocus(event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
export function Modal({ onClose, children, className = "", ariaLabel }: { onClose: () => void; children: React.ReactNode; className?: string; ariaLabel?: string }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    trapFocus(event, modalRef.current);
  };
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (!modal || modal.contains(document.activeElement)) return;
      modal.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  // The focus-trapped dialog intentionally owns Escape after nested controls have handled it.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div ref={modalRef} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={ariaLabel} tabIndex={-1} onKeyDown={handleKey}>{children}</div></div>;
}


export const projectStatusOptions: ProjectStatus[] = ["planned", "active", "paused", "completed", "canceled"];

export function projectStatusLabel(status: ProjectStatus | ReleaseStatus) {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

export function releasedCompositionNeedsConfirmation(
  currentReleaseId: string | null,
  nextReleaseId: string | null,
  releases: ReleaseRecord[],
) {
  if (currentReleaseId === nextReleaseId) return false;
  return releases.some(
    (release) =>
      (release.id === currentReleaseId || release.id === nextReleaseId)
      && release.status === "released",
  );
}

export function confirmReleasedCompositionChange() {
  return window.confirm(
    "This changes the Task composition of a released Release. Continue?",
  );
}

export function ProjectIcon({ project, size = 18 }: { project?: Pick<ProjectRecord, "icon" | "color">; size?: number }) {
  if (project?.icon === "rocket") return <Rocket size={size} />;
  if (project?.icon === "target") return <CircleDot size={size} />;
  if (project?.icon === "folder") return <FolderKanban size={size} />;
  return <Boxes size={size} />;
}


export function handleLocalLink(event: ReactMouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  navigate();
}


export function displayLabel(value: string) {
  const labels: Record<string, string> = {
    none: "No grouping",
    due: "Due date",
    dueDate: "Due date",
  };
  return labels[value] ?? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

export function initials(value: string) { return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
export function shortDate(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`)); }
export function longDate(value: string, timeZone: string) { try { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone }).format(new Date(value)); } catch { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value)); } }
export function longDateTime(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
export function zonedDateTime(value: string, timeZone: string) { try { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(value)); } catch { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(value)); } }
export function isOverdue(value: string, category: string) { return new Date(`${value}T23:59:59`) < new Date() && category !== "completed" && category !== "canceled"; }
