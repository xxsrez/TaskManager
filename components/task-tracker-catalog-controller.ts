"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  fetchCompleteWorkspaceCatalog,
  mergeUnique,
  mergeWorkspaceCatalogPage,
} from "@/components/task-tracker-state";
import type {
  AppSnapshot,
  WorkspaceCatalogKind,
  WorkspaceCatalogPage,
} from "@/lib/types";

type SnapshotRef = { current: AppSnapshot };

export function useWorkspaceCatalogController({
  dataRef,
  setData,
  surface,
  search,
  workspaceScopeToken,
  onError,
}: {
  dataRef: SnapshotRef;
  setData: Dispatch<SetStateAction<AppSnapshot>>;
  surface: string;
  search: string;
  workspaceScopeToken: string;
  onError: (message: string) => void;
}) {
  const [pages, setPages] = useState<Partial<Record<
    WorkspaceCatalogKind,
    WorkspaceCatalogPage
  >>>({});
  const [loading, setLoading] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [order, setOrder] = useState<"updated" | "name">("updated");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const completeFlights = useRef<Partial<Record<
    WorkspaceCatalogKind,
    Promise<WorkspaceCatalogPage>
  >>>({});

  const ensureComplete = useCallback(async (
    kinds: readonly WorkspaceCatalogKind[],
    trackLoading = false,
  ) => {
    const requestedWorkspaceScope = workspaceScopeToken;
    if (trackLoading) setLoading(true);
    try {
      const loadedPages = await Promise.all(kinds.map(async (kind) => {
        if ((dataRef.current.catalogCoverage?.[kind] ?? "complete") === "complete") {
          return null;
        }
        let flight = completeFlights.current[kind];
        if (!flight) {
          flight = fetchCompleteWorkspaceCatalog(
            kind,
            fetch,
            workspaceScopeToken,
          ).finally(() => {
            delete completeFlights.current[kind];
          });
          completeFlights.current[kind] = flight;
        }
        return flight;
      }));
      if (workspaceScopeToken !== requestedWorkspaceScope) return;
      const loaded = loadedPages.filter((page): page is WorkspaceCatalogPage => page !== null);
      if (!loaded.length) return;
      setData((current) => {
        const next = loaded.reduce((result, page) => {
          const merged = mergeWorkspaceCatalogPage(result, page);
          return {
            ...merged,
            catalogCoverage: {
              ...(merged.catalogCoverage ?? {
                projects: "bounded",
                releases: "bounded",
                views: "bounded",
              }),
              [page.kind]: "complete",
            },
          };
        }, current);
        dataRef.current = next;
        return next;
      });
    } finally {
      if (trackLoading) setLoading(false);
    }
  }, [dataRef, setData, workspaceScopeToken]);

  const invalidate = useCallback((clearPages = false) => {
    if (clearPages) setPages({});
    setEpoch((current) => current + 1);
  }, []);

  const loadMore = useCallback(async (kind: WorkspaceCatalogKind) => {
    const currentPage = pages[kind];
    if (!currentPage?.page.hasMore || !currentPage.page.nextCursor) return;
    setLoading(true);
    onError("");
    try {
      const parameters = new URLSearchParams({
        kind,
        limit: "30",
        cursor: currentPage.page.nextCursor,
        order,
        direction,
      });
      if (workspaceScopeToken) parameters.set("workspace_scope", workspaceScopeToken);
      if (search.trim()) parameters.set("search", search.trim());
      const response = await fetch(`/api/catalog?${parameters}`, { cache: "no-store" });
      const value = await response.json() as WorkspaceCatalogPage | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Catalog could not be loaded");
      }
      const merged: WorkspaceCatalogPage = {
        ...value,
        projects: mergeUnique(value.projects, currentPage.projects, (item) => item.id),
        releases: mergeUnique(value.releases, currentPage.releases, (item) => item.id),
        views: mergeUnique(value.views, currentPage.views, (item) => item.id),
        total: currentPage.total,
      };
      setPages((current) => ({ ...current, [kind]: merged }));
      setData((current) => mergeWorkspaceCatalogPage(current, value));
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [direction, onError, order, pages, search, setData, workspaceScopeToken]);

  useEffect(() => {
    if (surface !== "shared") return;
    const handle = window.setTimeout(() => {
      void ensureComplete(["projects", "views"]).catch((requestError: unknown) => {
        onError(requestError instanceof Error
          ? requestError.message
          : "Shared resources could not be loaded");
      });
    }, 0);
    return () => window.clearTimeout(handle);
  }, [ensureComplete, onError, surface]);

  useEffect(() => {
    const kind = surface === "projects" || surface === "releases" || surface === "views"
      ? surface
      : null;
    if (!kind) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      const parameters = new URLSearchParams({ kind, limit: "30" });
      if (workspaceScopeToken) parameters.set("workspace_scope", workspaceScopeToken);
      parameters.set("order", order);
      parameters.set("direction", direction);
      if (search.trim()) parameters.set("search", search.trim());
      void fetch(`/api/catalog?${parameters}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const value = await response.json() as WorkspaceCatalogPage | { error: string };
          if (!response.ok || "error" in value) {
            throw new Error("error" in value ? value.error : "Catalog could not be loaded");
          }
          setPages((current) => ({ ...current, [kind]: value }));
          setData((current) => mergeWorkspaceCatalogPage(current, value));
        })
        .catch((requestError: unknown) => {
          if (requestError instanceof DOMException && requestError.name === "AbortError") return;
          onError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [direction, epoch, onError, order, search, setData, surface, workspaceScopeToken]);

  useEffect(() => {
    if (epoch === 0) return;
    const controller = new AbortController();
    void Promise.all(
      (["projects", "releases", "views"] as const).map(async (kind) => {
        const parameters = new URLSearchParams({
          kind,
          limit: "3",
          active_only: "1",
        });
        if (workspaceScopeToken) parameters.set("workspace_scope", workspaceScopeToken);
        const response = await fetch(`/api/catalog?${parameters}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const value = await response.json() as WorkspaceCatalogPage | { error: string };
        if (!response.ok || "error" in value) {
          throw new Error("error" in value ? value.error : "Navigation could not be refreshed");
        }
        return value;
      }),
    )
      .then((navigationPages) => {
        setData((current) => navigationPages.reduce(
          (next, page) => ({
            ...next,
            navigationCollections: {
              ...(next.navigationCollections ?? {
                projects: { items: [], total: 0, hasMore: false },
                releases: { items: [], total: 0, hasMore: false },
                views: { items: [], total: 0, hasMore: false },
              }),
              [page.kind]: {
                items: page[page.kind],
                total: page.total,
                hasMore: page.page.hasMore,
              },
            },
          }),
          current,
        ));
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        onError(requestError instanceof Error
          ? requestError.message
          : "Navigation could not be refreshed");
      });
    return () => controller.abort();
  }, [epoch, onError, setData, workspaceScopeToken]);

  return {
    pages,
    loading,
    order,
    direction,
    setOrder,
    setDirection,
    ensureComplete,
    invalidate,
    loadMore,
  };
}
