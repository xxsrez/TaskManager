"use client";

import {
groupByOptions,
toggleViewField,
viewDisplayDependencies,
viewFieldOptions,
viewOrderOptions
} from "@/components/task-tracker-state";
import {
filterCatalogOptions,
filterConditionValues,
unavailableFilterLabel
} from "@/lib/filter-catalog";
import {
type Layout
} from "@/lib/navigation";
import {
canonicalViewQuery,
} from "@/lib/task-filter";
import type {
AppSnapshot,
LabelGroupRecord,
SavedViewRecord,
TaskRelationRecord,
ViewDisplay,
ViewFilterCondition,
ViewFilterField,
ViewFilterLabelGroupValue,
ViewFilterOperator,
ViewQuery
} from "@/lib/types";
import {
emptyViewQuery,
} from "@/lib/view-contract";
import {
Columns3,
LayoutList,
ListFilter,
Plus,
Save,
Search,
X
} from "lucide-react";
import {
useEffect,
useId,
useRef,
useState
} from "react";

import {
FOCUSABLE_SELECTOR,
Popover,
} from "@/components/task-tracker-dialog-primitives";

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
