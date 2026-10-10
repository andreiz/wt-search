// The expanded transcript of one hit (spec §5.4): which view is open (radius 3 for More transcript,
// radius 6 for "+N nearby") and the answer for each radius, kept in the hit row's state. A radius
// is fetched once: reopening it, or going back to it from the other, reuses the answer. A request
// that is still running when the view collapses, or when the other radius is asked for, is
// aborted and not kept, so reopening fetches it again. A failed answer is not kept either.
import { useEffect, useRef, useState } from "preact/hooks";
import { context, type ApiResult, type ContextResponse } from "./lib/api";

export type Radius = 3 | 6;

/** What a radius holds: the request running, or its answer. */
export type Entry = { kind: "loading" } | ApiResult<ContextResponse>;

export interface Transcript {
  /** The radius of the open view, or null when it is collapsed. */
  shown: Radius | null;
  /** What the open view has to show. */
  entry: Entry | undefined;
  show(radius: Radius): void;
  hide(): void;
  /** Ask again for the open view. */
  retry(): void;
}

export function useTranscript(chunkId: number): Transcript {
  const [shown, setShown] = useState<Radius | null>(null);
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
    context(chunkId, radius, controller.signal).then(
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

  return {
    shown,
    entry: shown === null ? undefined : entries[shown],
    show(radius) {
      setShown(radius);
      if (running.current && running.current.radius !== radius) abort();
      const entry = held.current[radius];
      if (entry?.kind === "ok" || entry?.kind === "loading") return;
      load(radius);
    },
    hide() {
      abort();
      setShown(null);
    },
    retry() {
      if (shown !== null) load(shown);
    },
  };
}
