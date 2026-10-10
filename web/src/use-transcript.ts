// The expanded transcript of one hit (spec §5.4): which view is open (radius 3 for More transcript,
// radius 6 for "+N nearby") and the answer for each radius, kept in the hit row's state. A radius
// is fetched once: reopening it, or going back to it from the other, reuses the answer. A request
// that is still running when the view collapses, or when the other radius is asked for, is
// aborted and not kept, so reopening fetches it again. A failed answer is not kept either.
//
// Only one view is open on a page (spec §5.4): which hit that is lives with the list (`OpenView`),
// so opening one collapses the other in the same render. A hit row outside a list keeps its own.
import { createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { context, type ApiResult, type ContextResponse } from "./lib/api";

export type Radius = 3 | 6;

/** The one open view of a list: whose it is and how wide. */
export interface Open {
  chunkId: number;
  radius: Radius;
}

export type OpenState = [Open | null, (next: Open | null) => void];

export const OpenView = createContext<OpenState | null>(null);

/** What a radius holds: the request running, or its answer. */
export type Entry = { kind: "loading" } | ApiResult<ContextResponse>;

export interface Transcript {
  /** The radius of the open view, or null when it is collapsed. */
  shown: Radius | null;
  /** Another hit's view is open: showing this one collapses it, and the page moves. */
  otherOpen: boolean;
  /** What the open view has to show. */
  entry: Entry | undefined;
  show(radius: Radius): void;
  hide(): void;
  /** Ask again for the open view. */
  retry(): void;
}

/**
 * `q` is the query of the search the hit came from; it marks the words in the nearby
 * paragraphs. It cannot change for a mounted hit (a new search remounts the list), so the
 * cache stays per radius.
 */
export function useTranscript(chunkId: number, q: string): Transcript {
  const own = useState<Open | null>(null);
  const [open, setOpen] = useContext(OpenView) ?? own;
  const shown = open?.chunkId === chunkId ? open.radius : null;
  const [entries, setEntries] = useState<Partial<Record<Radius, Entry>>>({});
  // The same entries for the handlers, which must not read a render-old copy.
  const held = useRef(entries);
  const running = useRef<{ radius: Radius; controller: AbortController } | null>(null);

  function put(radius: Radius, entry: Entry | undefined) {
    const next = { ...held.current };
    if (entry) next[radius] = entry;
    else delete next[radius];
    held.current = next;
    setEntries(next);
  }

  /** Abort the running request, if any, and forget that it was loading. */
  function abort() {
    const current = running.current;
    if (!current) return;
    running.current = null;
    current.controller.abort();
    if (held.current[current.radius]?.kind === "loading") put(current.radius, undefined);
  }

  function load(radius: Radius) {
    abort();
    const controller = new AbortController();
    running.current = { radius, controller };
    put(radius, { kind: "loading" });
    context(chunkId, radius, q, controller.signal).then(
      (answer) => {
        if (controller.signal.aborted) return;
        running.current = null;
        // An answer that cannot be shown (no chunks, or not the hit's) is a load error.
        const usable =
          answer.kind !== "ok" ||
          (Array.isArray(answer.data.chunks) && answer.data.chunks.some((chunk) => chunk?.chunk_id === chunkId));
        put(radius, usable ? answer : { kind: "unavailable" });
      },
      () => {
        // Only an abort throws, and an abort is handled above; show an error rather than load for ever.
        if (controller.signal.aborted) return;
        running.current = null;
        put(radius, { kind: "network" });
      },
    );
  }

  useEffect(
    () => () => {
      running.current?.controller.abort();
      running.current = null;
    },
    [],
  );

  // Collapsed by another hit's view opening: drop the request, as `hide` does. (Only on that
  // change: the effect of an older render can run after a `show` has started a request.)
  const wasShown = useRef(false);
  useEffect(() => {
    if (wasShown.current && shown === null) abort();
    wasShown.current = shown !== null;
  }, [shown]);

  return {
    shown,
    otherOpen: open !== null && open.chunkId !== chunkId,
    entry: shown === null ? undefined : entries[shown],
    show(radius) {
      setOpen({ chunkId, radius });
      if (running.current && running.current.radius !== radius) abort();
      const entry = held.current[radius];
      if (entry?.kind === "ok" || entry?.kind === "loading") return;
      load(radius);
    },
    hide() {
      abort();
      if (shown !== null) setOpen(null);
    },
    retry() {
      if (shown !== null) load(shown);
    },
  };
}
