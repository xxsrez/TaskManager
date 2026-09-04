"use client";

import {
TeamRequestError,
filterShareTeamOptions,
requestTeamApi,
teamGrantConflictReadbackMessage,
teamGrantResponseMatchesRoute,
teamRequestIsCurrent,
teamShareRequestIsCurrent,
teamShareRouteIdentity,
type AsyncValue,
type ShareContext,
type SharePersonOption,
type SharePrincipalOption,
type ShareTeamOption,
type TeamGrantAlert,
type TeamGrantMutationState,
type TeamShareRoute
} from "@/components/task-tracker-state";
import {
canAssignRole,
canManageGrant
} from "@/lib/access";
import type {
AppSnapshot,
TeamGrantList,
TeamGrantPermission,
TeamGrantRecord,
TeamList
} from "@/lib/types";
import {
Search,
UsersRound
} from "lucide-react";
import {
FormEvent,
KeyboardEvent as ReactKeyboardEvent,
useCallback,
useEffect,
useId,
useRef,
useState
} from "react";

import {
DialogHeader,
Modal,
initials,
} from "@/components/task-tracker-dialog-primitives";

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
