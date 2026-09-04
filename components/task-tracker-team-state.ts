"use client";

import type {
  AccessRole,
  TeamGrantList,
  TeamGrantResourceType,
  TeamList,
} from "@/lib/types";

export type ShareTarget = {
  resourceType: "project" | "task" | "saved_view";
  resourceId: string;
  label: string;
  accessRole: AccessRole;
  ownerUserId: string;
  inherited: boolean;
};

export type TeamShareRoute = {
  key: string;
  resourceType: TeamGrantResourceType;
  resourceId: string;
  publicId: string;
  label: string;
  explanation: string;
  accessRole: AccessRole;
};

export type ShareContext = {
  key: string;
  label: string;
  directTarget: ShareTarget | null;
  teamRoutes: TeamShareRoute[];
  teamUnavailableCopy: string | null;
};

export type SharePersonOption = {
  kind: "person";
  key: string;
  displayName: string;
  email: string;
};

export type ShareTeamOption = {
  kind: "team";
  key: string;
  entry: TeamList["teams"][number];
};

export type SharePrincipalOption = SharePersonOption | ShareTeamOption;
export type TeamGrantMutationState = { routeKey: string; key: string } | null;
export type TeamGrantAlert = {
  routeKey: string;
  routePublicId: string;
  message: string;
} | null;
export type TeamMutationKind =
  | "create"
  | "rename"
  | "add"
  | "deactivate"
  | "reactivate"
  | "delete";
export type TeamMutationState = { kind: TeamMutationKind; key: string } | null;

export function filterTeamList(value: TeamList, query: string): TeamList["teams"] {
  const needle = query.trim().toLocaleLowerCase();
  return value.teams.filter((entry) =>
    !needle || entry.team.name.toLocaleLowerCase().includes(needle));
}

export function filterShareTeamOptions(
  value: TeamList,
  query: string,
): TeamList["teams"] {
  const needle = query.trim().toLocaleLowerCase();
  return value.teams
    .filter(({ team, currentMembership }) =>
      !team.archivedAt &&
      currentMembership.status === "active" &&
      (!needle || team.name.toLocaleLowerCase().includes(needle)))
    .sort((left, right) =>
      Number(right.currentMembership.role === "owner") -
        Number(left.currentMembership.role === "owner") ||
      left.team.name.localeCompare(right.team.name, undefined, { sensitivity: "base" }) ||
      left.team.publicId.localeCompare(right.team.publicId));
}

export function teamShareRequestIsCurrent(
  requestedGeneration: number,
  currentGeneration: number,
  requestedRouteKey: string,
  currentRouteKey: string,
  aborted: boolean,
) {
  return requestedGeneration === currentGeneration &&
    requestedRouteKey === currentRouteKey &&
    !aborted;
}

export function teamGrantResponseMatchesRoute(
  route: TeamShareRoute,
  value: TeamGrantList,
) {
  return value.target.resourceType === route.resourceType &&
    value.target.resourceId === route.resourceId &&
    value.target.publicId === route.publicId;
}

export function teamGrantConflictReadbackMessage(latestLoaded: boolean) {
  return latestLoaded
    ? "Team access changed in another session. The latest routes were loaded; review them and try again."
    : "Team access changed, but the latest routes could not be loaded. Retry.";
}

export function teamShareRouteIdentity(routes: readonly TeamShareRoute[]) {
  return routes.map((route) =>
    `${route.key}:${route.resourceType}:${route.publicId}:${route.accessRole}`).join("|");
}

export function teamRequestIsCurrent(
  requestedGeneration: number,
  currentGeneration: number,
  aborted: boolean,
) {
  return requestedGeneration === currentGeneration && !aborted;
}

export function teamConflictReadbackMessage(
  latestLoaded: boolean,
  unavailable: boolean,
) {
  if (unavailable) return "";
  return latestLoaded
    ? "This Team changed in another session. The latest details were loaded; review them and try again."
    : "This Team changed, but the latest details could not be loaded. Retry.";
}

export class TeamRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function requestTeamApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const value = await response.json() as T | { error: string };
  if (!response.ok || (value && typeof value === "object" && "error" in value)) {
    throw new TeamRequestError(
      value && typeof value === "object" && "error" in value
        ? String(value.error)
        : "Team request failed",
      response.status,
    );
  }
  return value as T;
}
