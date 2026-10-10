// The results (spec §5.3, §5.6): one list of cards for the whole page, keyword and related hits
// interleaved exactly as the API sent them (nothing is folded or moved). Neighbouring hits of one
// episode and one kind share a card (lib/group.ts). Page 1 with no keyword hit on it starts with
// "No exact matches —"; later pages never do.
//
// A "stop" for the arrow and j/k keys (lib/keys.ts) is one card, however many hits it holds: the
// cards (`data-result`) have a roving tabindex, so one is in the tab order and ArrowDown/ArrowUp
// and j/k move focus between them. Whatever takes focus inside a card makes that card the one in
// the tab order.
import type { RefObject } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
import type { SearchResult } from "../../../worker/src/api-types";
import { groupNeighbours } from "../lib/group";
import type { HitActions } from "./HitRow";
import { ResultCard } from "./ResultCard";

const noop = () => {};

export function ResultList({
  results,
  page,
  listRef,
  onMore = noop,
  onNearby = noop,
  onReport = noop,
}: Partial<HitActions> & {
  results: SearchResult[];
  /** The page number, from 1; the intro line is for page 1 only. */
  page: number;
  /** The element holding the list; its cards carry `data-result`. */
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const [active, setActive] = useState(0);

  const cards = groupNeighbours(results);
  const noKeyword = results.length > 0 && results.every((r) => r.match === "related");
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
      {page === 1 && noKeyword && <p class="results-intro">No exact matches — passages about similar things:</p>}
      <ol class="results" aria-label="Results">
        {cards.map((card, index) => (
          <ResultCard
            key={card.hits[0]!.chunk_id}
            card={card}
            tabIndex={index === current ? 0 : -1}
            onMore={onMore}
            onNearby={onNearby}
            onReport={onReport}
          />
        ))}
      </ol>
    </div>
  );
}
