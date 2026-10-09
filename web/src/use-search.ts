// The search lifecycle (spec §5.2, §5.6): the URL is the state. The initial load runs the URL's
// search; every search pushes a history entry; Back and Forward (`popstate`) re-run from the URL.
// One search is in flight: a new one aborts the old, and an answer is applied only if its
// request is still the latest (so a slow first answer never overwrites a newer one, even if
// something let it through the abort).
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { search, type Failure, type SearchData } from "./lib/api";
import { normalizeQuery, parse, serialize, type Mode, type SearchState, type SortOrder } from "./lib/url";

export type View =
  | { kind: "idle" }
  | { kind: "loading" }
  /** `id` is new for every answer, so the list can reset its focus position. */
  | { kind: "ok"; data: SearchData; id: number }
  | Failure;

export interface SearchApi {
  state: SearchState;
  view: View;
  /** Search for this text: page 1, a new history entry; empty text goes back to the bare path. */
  submit(q: string): void;
  setMode(mode: Mode): void;
  setSort(sort: SortOrder): void;
  goPage(page: number): void;
}

function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

export function useSearch(): SearchApi {
  const [state, setState] = useState<SearchState>(() => parse(window.location.search));
  const [view, setView] = useState<View>(() => (state.q === "" ? { kind: "idle" } : { kind: "loading" }));
  const stateRef = useRef(state);
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);

  /** Abort whatever is in flight and, for a non-empty q, start the search for `next`. */
  const run = useCallback((next: SearchState) => {
    controller.current?.abort();
    controller.current = null;
    const id = ++latest.current;
    if (next.q === "") {
      setView({ kind: "idle" });
      return;
    }
    const ac = new AbortController();
    controller.current = ac;
    setView({ kind: "loading" });
    search(next, ac.signal).then(
      (answer) => {
        if (id !== latest.current) return;
        setView(answer.kind === "ok" ? { kind: "ok", data: answer.data, id } : answer);
      },
      (err: unknown) => {
        if (id !== latest.current) return;
        // Only an abort throws, and an abort means a newer request exists, so this is not reached
        // in practice; if it ever is, show the error rather than loading forever.
        if ((err as { name?: unknown } | null)?.name === "AbortError") return;
        setView({ kind: "network" });
      },
    );
  }, []);

  const commit = useCallback(
    (next: SearchState, history: "push" | "replace", fetch: boolean) => {
      const url = window.location.pathname + serialize(next);
      // The same search again re-runs it, but is not a second Back step.
      if (history === "push" && url !== currentUrl()) window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
      stateRef.current = next;
      setState(next);
      if (fetch) run(next);
    },
    [run],
  );

  useEffect(() => {
    if (stateRef.current.q !== "") run(stateRef.current);
    const onPop = () => {
      const next = parse(window.location.search);
      stateRef.current = next;
      setState(next);
      run(next);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      latest.current++;
      controller.current?.abort();
    };
  }, [run]);

  return {
    state,
    view,
    submit: (q) => commit({ ...stateRef.current, q: normalizeQuery(q), page: 1 }, "push", true),
    // With nothing searched yet there is nothing to re-run: remember the choice for the next search.
    setMode: (mode) => {
      const next = { ...stateRef.current, mode, page: 1 };
      commit(next, next.q === "" ? "replace" : "push", next.q !== "");
    },
    setSort: (sort) => {
      const next = { ...stateRef.current, sort, page: 1 };
      commit(next, next.q === "" ? "replace" : "push", next.q !== "");
    },
    goPage: (page) => commit({ ...stateRef.current, page }, "push", true),
  };
}
