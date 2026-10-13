// The results (spec §5.3, §5.6): one list of cards for the whole page, in the order the API sent
// them (nothing is folded or moved). Neighbouring hits of one episode share a card
// (lib/group.ts). Page 1 of the Related tab starts with an intro line; later pages never do.
//
// A "stop" for the arrow and j/k keys (lib/keys.ts) is one card, however many hits it holds: the
// cards (`data-result`) have a roving tabindex, so one is in the tab order and ArrowDown/ArrowUp
// and j/k move focus between them. Whatever takes focus inside a card makes that card the one in
// the tab order.
import type { RefObject } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
import type { SearchResult } from "../../../worker/src/api-types";
import { groupNeighbours } from "../lib/group";
import { OpenReport } from "../use-forms";
import { OpenView, type Open } from "../use-transcript";
import type { HitActions } from "./HitRow";
import { ResultCard } from "./ResultCard";

const noop = () => {};

export function ResultList({
  results,
  page,
  related = false,
  listRef,
  q = "",
  onReport = noop,
  onSearchEpisode = noop,
}: Partial<HitActions> & {
  results: SearchResult[];
  /** The Related tab: page 1 starts with the intro line. */
  related?: boolean;
  /** The query these results answer; the expanded transcript marks its words. */
  q?: string;
  /** The page number, from 1; the intro line is for page 1 only. */
  page: number;
  /** The element holding the list; its cards carry `data-result`. */
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const [active, setActive] = useState(0);
  // The one expanded transcript of the page: opening another hit's collapses it.
  const openView = useState<Open | null>(null);
  // Likewise the one open report form (spec §5.5): the chunk id of its hit.
  const openReport = useState<number | null>(null);

  const cards = groupNeighbours(results);
  const current = Math.min(active, Math.max(cards.length - 1, 0));

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onFocus = (event: FocusEvent) => {
      const stops = [...list.querySelectorAll("[data-result]")];
      const at = stops.findIndex((card) => card.contains(event.target as Node));
      if (at !== -1) setActive(at);
    };
    // `focus` does not bubble, so listen in the capture phase.
    list.addEventListener("focus", onFocus, true);
    return () => list.removeEventListener("focus", onFocus, true);
  }, [listRef]);

  return (
    <div class="results-area" ref={listRef}>
      {page === 1 && related && results.length > 0 && <p class="results-intro">Passages about the same thing that don't contain all your words:</p>}
      <ol class="results" aria-label="Results">
        <OpenView.Provider value={openView}>
          <OpenReport.Provider value={openReport}>
            {cards.map((card, index) => (
              <ResultCard
                key={card.hits[0]!.chunk_id}
                card={card}
                tabIndex={index === current ? 0 : -1}
                q={q}
                onReport={onReport}
                onSearchEpisode={onSearchEpisode}
              />
            ))}
          </OpenReport.Provider>
        </OpenView.Provider>
      </ol>
    </div>
  );
}
