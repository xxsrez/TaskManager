"use client";

import {
emptyGlobalSearchResponse,
flattenGlobalSearchResults,
mergeGlobalSearchResponses,
nextGlobalSearchHighlight,
type GlobalSearchEntityType,
type GlobalSearchResponse,
type GlobalSearchResult,
} from "@/lib/global-search";
import {
type Layout,
type ResolvedNavigation
} from "@/lib/navigation";
import type {
AppSnapshot
} from "@/lib/types";
import {
CircleDot,
CircleHelp,
FolderKanban,
Rocket,
Search,
X,
Zap
} from "lucide-react";
import {
KeyboardEvent as ReactKeyboardEvent,
useEffect,
useRef,
useState,
} from "react";

import {
handleLocalLink
} from "@/components/task-tracker-dialogs";


export type BreadcrumbItem = {
  label: string;
  surface?: string;
  layout?: Layout;
};

export const globalSearchSections: Array<{
  key: keyof GlobalSearchResponse["groups"];
  type: GlobalSearchEntityType;
  label: string;
}> = [
  { key: "tasks", type: "task", label: "Tasks" },
  { key: "projects", type: "project", label: "Projects" },
  { key: "releases", type: "release", label: "Releases" },
  { key: "views", type: "view", label: "Views" },
];

export function GlobalSearchResultIcon({ type }: { type: GlobalSearchEntityType }) {
  if (type === "task") return <CircleDot size={15} />;
  if (type === "project") return <FolderKanban size={15} />;
  if (type === "release") return <Rocket size={15} />;
  return <Zap size={15} />;
}
export function resolveGlobalSearchNavigation(
  result: GlobalSearchResult,
  data: Pick<AppSnapshot, "projects" | "releases" | "views">,
  current: ResolvedNavigation,
): ResolvedNavigation | null {
  if (result.type === "task") {
    return { ...current, taskId: result.id };
  }
  if (result.type === "project") {
    return data.projects.some((project) => project.id === result.id)
      ? { surface: `project:${result.id}`, layout: "list", taskId: null }
      : null;
  }
  if (result.type === "release") {
    return data.releases.some((release) => release.id === result.id)
      ? { surface: `release:${result.id}`, layout: "list", taskId: null }
      : null;
  }
  const view = data.views.find((item) => item.id === result.id && !item.archivedAt);
  return view
    ? { surface: `view:${view.id}`, layout: view.display.layout, taskId: null }
    : null;
}

export function GlobalSearchContinuationWarning({
  busy,
  onRetry,
}: {
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="global-search-partial continuation" role="alert">
      <span>Couldn’t load more results. Loaded matches are still available.</span>
      <button className="button ghost" type="button" disabled={busy} onClick={onRetry}>
        {busy ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

export function GlobalSearchOverlay({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (result: GlobalSearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<GlobalSearchResponse>(() => emptyGlobalSearchResponse());
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const [continuationError, setContinuationError] = useState<{
    query: string;
    cursor: string;
  } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef("");
  const results = flattenGlobalSearchResults(response);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      // A blank overlay is a prompt, not a request for an unbounded suggestion set.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResponse(emptyGlobalSearchResponse());
      setStatus("idle");
      setContinuationError(null);
      setHighlighted(0);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus("loading");
      void fetch(`/api/search?query=${encodeURIComponent(trimmed)}&limit=8`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (searchResponse) => {
        const value = await searchResponse.json() as GlobalSearchResponse | { error?: string };
        if (!searchResponse.ok || !("groups" in value)) {
          throw new Error("Workspace search is temporarily unavailable");
        }
        setResponse(value);
        setStatus(value.partialErrors.length === globalSearchSections.length ? "error" : "ready");
        setContinuationError(null);
        setHighlighted(0);
      }).catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setResponse(emptyGlobalSearchResponse(trimmed));
        setStatus("error");
        setContinuationError(null);
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function loadMore(cursor = response.nextCursor) {
    if (!cursor || loadingMore) return;
    const requestedQuery = response.query;
    const requestedCursor = cursor;
    setContinuationError(null);
    setLoadingMore(true);
    try {
      const next = await fetch(
        `/api/search?query=${encodeURIComponent(requestedQuery)}&limit=8&cursor=${encodeURIComponent(requestedCursor)}`,
        { cache: "no-store" },
      );
      const value = await next.json() as GlobalSearchResponse | { error?: string };
      if (!next.ok || !("groups" in value)) throw new Error("Search continuation failed");
      if (queryRef.current === requestedQuery) {
        setResponse((current) => current.query === requestedQuery
          ? mergeGlobalSearchResponses(current, value)
          : current);
        setContinuationError(null);
      }
    } catch {
      if (queryRef.current === requestedQuery) {
        setContinuationError({ query: requestedQuery, cursor: requestedCursor });
      }
    } finally {
      setLoadingMore(false);
    }
  }

  function handleKey(event: ReactKeyboardEvent<HTMLDialogElement>) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => nextGlobalSearchHighlight(current, "next", results.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => nextGlobalSearchHighlight(current, "previous", results.length));
      return;
    }
    if (event.key === "Enter" && results[highlighted]) {
      event.preventDefault();
      onOpen(results[highlighted]);
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'input, a[href], button:not([disabled])',
      ) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  let resultIndex = -1;
  return (
    <div className="global-search-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <dialog ref={dialogRef} className="global-search-dialog" aria-modal="true" aria-label="Global search" open onKeyDown={handleKey}>
        <header className="global-search-input-row">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              queryRef.current = nextQuery.trim().toLowerCase();
              setResponse(emptyGlobalSearchResponse(queryRef.current));
              setStatus(nextQuery.trim() ? "loading" : "idle");
              setContinuationError(null);
              setHighlighted(0);
            }}
            placeholder="Search tasks, projects, releases, and views…"
            aria-label="Global search query"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="global-search-results"
            aria-activedescendant={results[highlighted] ? `global-search-result-${results[highlighted].type}-${results[highlighted].id}` : undefined}
            autoComplete="off"
          />
          {query && <button className="icon-button" type="button" aria-label="Clear global search" onClick={() => setQuery("")}><X size={15} /></button>}
          <kbd>Esc</kbd>
        </header>
        <div className="global-search-results" id="global-search-results" role="listbox" aria-label="Global search results">
          {status === "idle" && <div className="global-search-state"><Search size={22} /><b>Search your workspace</b><span>Tasks, Projects, Releases, and Views</span></div>}
          {status === "loading" && <div className="global-search-state" aria-live="polite"><span className="global-search-spinner" /><b>Searching…</b></div>}
          {status === "error" && <div className="global-search-state" role="alert"><CircleHelp size={22} /><b>Search is temporarily unavailable</b><span>Try again without changing your current view.</span></div>}
          {status === "ready" && results.length === 0 && <div className="global-search-state"><Search size={22} /><b>No accessible results</b><span>Try another title or Task identifier.</span></div>}
          {status === "ready" && response.partialErrors.length > 0 && <p className="global-search-partial" role="status">Some results could not be loaded. Available matches are shown below.</p>}
          {status === "ready" && continuationError?.query === response.query && (
            <GlobalSearchContinuationWarning
              busy={loadingMore}
              onRetry={() => void loadMore(continuationError.cursor)}
            />
          )}
          {status === "ready" && globalSearchSections.map((section) => {
            const items = response.groups[section.key] as GlobalSearchResult[];
            if (!items.length) return null;
            return (
              <section className="global-search-group" role="group" aria-label={section.label} key={section.key}>
                <h2>{section.label}</h2>
                {items.map((item) => {
                  resultIndex += 1;
                  const index = resultIndex;
                  return (
                    <a
                      id={`global-search-result-${item.type}-${item.id}`}
                      key={`${item.type}:${item.id}`}
                      className={`global-search-result ${index === highlighted ? "highlighted" : ""}`}
                      href={item.href}
                      role="option"
                      aria-selected={index === highlighted}
                      onMouseEnter={() => setHighlighted(index)}
                      onClick={(event) => handleLocalLink(event, () => onOpen(item))}
                    >
                      <span className="global-search-result-icon"><GlobalSearchResultIcon type={item.type} /></span>
                      <span className="global-search-result-copy">
                        <b>{item.type === "task" ? <><code>{item.identifier}</code><span>{item.title}</span></> : item.title}</b>
                        <small>{item.context}</small>
                      </span>
                      <kbd>↵</kbd>
                    </a>
                  );
                })}
              </section>
            );
          })}
        </div>
        <footer className="global-search-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          {response.nextCursor && <button className="button ghost" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button>}
          <span><kbd>↵</kbd> Open</span>
        </footer>
      </dialog>
    </div>
  );
}
