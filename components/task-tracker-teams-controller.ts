"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  TeamRequestError,
  requestTeamApi,
  teamConflictReadbackMessage,
  teamRequestIsCurrent,
  type AsyncValue,
  type TeamMutationKind,
  type TeamMutationState,
} from "@/components/task-tracker-state";
import type {
  TeamDetail,
  TeamList,
  TeamMembershipRecord,
} from "@/lib/types";

export function useTeamsController({
  activeTeamPublicId,
  listVisible,
  onCreated,
  onConflict,
}: {
  activeTeamPublicId: string | null;
  listVisible: boolean;
  onCreated: (teamPublicId: string) => void;
  onConflict: () => void;
}) {
  const [listState, setListState] = useState<AsyncValue<TeamList>>({
    status: "idle",
    value: null,
    error: "",
  });
  const [detailState, setDetailState] = useState<AsyncValue<TeamDetail>>({
    status: "idle",
    value: null,
    error: "",
  });
  const [mutation, setMutation] = useState<TeamMutationState>(null);
  const [alert, setAlert] = useState("");
  const [memberForDelete, setMemberForDelete] = useState<TeamMembershipRecord | null>(null);
  const listGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const detailStateRef = useRef(detailState);
  const activeTeamPublicIdRef = useRef(activeTeamPublicId);
  activeTeamPublicIdRef.current = activeTeamPublicId;
  detailStateRef.current = detailState;

  const loadList = useCallback(async (signal?: AbortSignal) => {
    const generation = ++listGenerationRef.current;
    setListState((current) => ({
      status: "loading",
      value: current.value,
      error: "",
    }));
    try {
      const value = await requestTeamApi<TeamList>("/api/teams", { signal });
      if (!teamRequestIsCurrent(
        generation,
        listGenerationRef.current,
        signal?.aborted ?? false,
      )) return null;
      setListState({ status: "ready", value, error: "" });
      return value;
    } catch (requestError) {
      if (signal?.aborted || !teamRequestIsCurrent(
        generation,
        listGenerationRef.current,
        false,
      )) return null;
      setListState((current) => ({
        status: "error",
        value: current.value,
        error: requestError instanceof Error
          ? requestError.message
          : "Teams could not be loaded",
      }));
      return null;
    }
  }, []);

  const loadDetail = useCallback(async (
    teamPublicId: string,
    signal?: AbortSignal,
  ) => {
    const generation = ++detailGenerationRef.current;
    const retained = detailStateRef.current.value?.team.publicId === teamPublicId
      ? detailStateRef.current.value
      : null;
    const loadingState: AsyncValue<TeamDetail> = {
      status: "loading",
      value: retained,
      error: "",
    };
    detailStateRef.current = loadingState;
    setDetailState(loadingState);
    try {
      const value = await requestTeamApi<TeamDetail>(
        `/api/teams/${encodeURIComponent(teamPublicId)}`,
        { signal },
      );
      if (
        activeTeamPublicIdRef.current !== teamPublicId ||
        !teamRequestIsCurrent(
          generation,
          detailGenerationRef.current,
          signal?.aborted ?? false,
        )
      ) return null;
      const readyState: AsyncValue<TeamDetail> = {
        status: "ready",
        value,
        error: "",
      };
      detailStateRef.current = readyState;
      setDetailState(readyState);
      return value;
    } catch (requestError) {
      if (
        signal?.aborted ||
        activeTeamPublicIdRef.current !== teamPublicId ||
        !teamRequestIsCurrent(generation, detailGenerationRef.current, false)
      ) return null;
      const unavailable = requestError instanceof TeamRequestError &&
        (requestError.status === 403 || requestError.status === 404);
      const errorState: AsyncValue<TeamDetail> = {
        status: "error",
        value: unavailable ? null : retained,
        error: unavailable
          ? "Team unavailable"
          : requestError instanceof Error
            ? requestError.message
            : "Team could not be loaded",
      };
      detailStateRef.current = errorState;
      setDetailState(errorState);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!listVisible) return;
    const controller = new AbortController();
    void loadList(controller.signal);
    return () => controller.abort();
  }, [listVisible, loadList]);

  useEffect(() => {
    if (!activeTeamPublicId) return;
    const controller = new AbortController();
    setAlert("");
    void loadDetail(activeTeamPublicId, controller.signal);
    return () => controller.abort();
  }, [activeTeamPublicId, loadDetail]);

  async function createTeam(name: string) {
    if (mutation) return false;
    setMutation({ kind: "create", key: "new" });
    setAlert("");
    try {
      const detail = await requestTeamApi<TeamDetail>("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      const nextState: AsyncValue<TeamDetail> = {
        status: "ready",
        value: detail,
        error: "",
      };
      detailStateRef.current = nextState;
      setDetailState(nextState);
      activeTeamPublicIdRef.current = detail.team.publicId;
      onCreated(detail.team.publicId);
      void loadList();
      return true;
    } catch (requestError) {
      setAlert(requestError instanceof Error
        ? requestError.message
        : "Team could not be created");
      return false;
    } finally {
      setMutation(null);
    }
  }

  async function mutateActiveTeam(
    kind: Exclude<TeamMutationKind, "create">,
    key: string,
    path: string,
    method: "PATCH" | "POST" | "DELETE",
    body: Record<string, unknown>,
  ) {
    const teamPublicId = activeTeamPublicIdRef.current;
    if (!teamPublicId || mutation) return false;
    setMutation({ kind, key });
    setAlert("");
    try {
      const detail = await requestTeamApi<TeamDetail>(path, {
        method,
        body: JSON.stringify(body),
      });
      void loadList();
      if (activeTeamPublicIdRef.current !== teamPublicId) return true;
      const nextState: AsyncValue<TeamDetail> = {
        status: "ready",
        value: detail,
        error: "",
      };
      detailStateRef.current = nextState;
      setDetailState(nextState);
      return true;
    } catch (requestError) {
      if (activeTeamPublicIdRef.current !== teamPublicId) return false;
      if (requestError instanceof TeamRequestError && requestError.status === 409) {
        const latest = await loadDetail(teamPublicId);
        if (activeTeamPublicIdRef.current !== teamPublicId) return false;
        onConflict();
        setMemberForDelete(null);
        const unavailable = detailStateRef.current.status === "error" &&
          detailStateRef.current.error === "Team unavailable";
        setAlert(teamConflictReadbackMessage(latest !== null, unavailable));
        return false;
      }
      if (requestError instanceof TeamRequestError &&
        (requestError.status === 403 || requestError.status === 404)) {
        const unavailableState: AsyncValue<TeamDetail> = {
          status: "error",
          value: null,
          error: "Team unavailable",
        };
        detailStateRef.current = unavailableState;
        setDetailState(unavailableState);
        return false;
      }
      setAlert(requestError instanceof Error
        ? requestError.message
        : "Team could not be updated");
      return false;
    } finally {
      setMutation(null);
    }
  }

  async function renameTeam(name: string) {
    const detail = detailStateRef.current.value;
    if (!detail) return false;
    return mutateActiveTeam(
      "rename",
      detail.team.id,
      `/api/teams/${encodeURIComponent(detail.team.publicId)}`,
      "PATCH",
      { name, version: detail.team.version },
    );
  }

  async function addMember(email: string) {
    const detail = detailStateRef.current.value;
    if (!detail) return false;
    return mutateActiveTeam(
      "add",
      detail.team.id,
      `/api/teams/${encodeURIComponent(detail.team.publicId)}/members`,
      "POST",
      { email, teamVersion: detail.team.version },
    );
  }

  async function changeMembership(
    membership: TeamMembershipRecord,
    action: "deactivate" | "reactivate",
  ) {
    const detail = detailStateRef.current.value;
    if (!detail) return false;
    return mutateActiveTeam(
      action,
      membership.id,
      `/api/teams/${encodeURIComponent(detail.team.publicId)}/members/${encodeURIComponent(membership.id)}`,
      "PATCH",
      {
        action,
        teamVersion: detail.team.version,
        version: membership.version,
      },
    );
  }

  async function deleteMembership(membership: TeamMembershipRecord) {
    const detail = detailStateRef.current.value;
    if (!detail) return false;
    return mutateActiveTeam(
      "delete",
      membership.id,
      `/api/teams/${encodeURIComponent(detail.team.publicId)}/members/${encodeURIComponent(membership.id)}`,
      "DELETE",
      {
        teamVersion: detail.team.version,
        version: membership.version,
      },
    );
  }

  return {
    listState,
    detailState,
    mutation,
    alert,
    memberForDelete,
    activeDetail: activeTeamPublicId && detailState.value?.team.publicId === activeTeamPublicId
      ? detailState.value
      : null,
    clearAlert: () => setAlert(""),
    setMemberForDelete,
    loadList,
    loadDetail,
    createTeam,
    renameTeam,
    addMember,
    changeMembership,
    deleteMembership,
  };
}
