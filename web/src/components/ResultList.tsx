// The results (spec §5.3, §5.6): keyword hits grouped into cards, then the related fold (Smart).
// This is where the page's results are split and grouped; the API's order is never changed. A page
// with no keyword hits shows its related cards open under "No exact matches —".
//
// A "stop" for the arrow and j/k keys (lib/keys.ts) is one card, however many hits it holds: the
// cards (`data-result`) have a roving tabindex, so one is in the tab order and ArrowDown/ArrowUp
// and j/k move focus between them, on into the related cards while the fold is open. Whatever
// takes focus inside a card makes that card the one in the tab order.
//
// Fold state lives here, so it is per page: App keys this component by search, and a new
// search starts it closed.
import type { RefObject } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
import type { SearchResult } from "../../../worker/src/api-types";
import { groupNeighbours, splitRelated, type Card } from "../lib/group";
import type { HitActions } from "./HitRow";
import { RelatedFold } from "./RelatedFold";
import { ResultCard } from "./ResultCard";

const noop = () => {};

export function ResultList({
  results,
  listRef,
  onMore = noop,
  onNearby = noop,
  onReport = noop,
}: Partial<HitActions> & {
  results: SearchResult[];
  /** The element holding every list; its cards carry `data-result`. */
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const [active, setActive] = useState(0);
  const [foldOpen, setFoldOpen] = useState(false);

  const { keyword, related } = splitRelated(results);
  const keywordCards = groupNeighbours(keyword);
  const relatedCards = groupNeighbours(related);
  const onlyRelated = keyword.length === 0 && related.length > 0;
  const relatedShown = onlyRelated || foldOpen;
  const stops = keywordCards.length + (relatedShown ? relatedCards.length : 0);
  const current = Math.min(active, Math.max(stops - 1, 0));

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onFocus = (event: FocusEvent) => {
      const cards = [...list.querySelectorAll("[data-result]")];
      const at = cards.findIndex((card) => card.contains(event.target as Node));
      if (at !== -1) setActive(at);
    };
    // `focus` does not bubble, so listen in the capture phase.
    list.addEventListener("focus", onFocus, true);
    return () => list.removeEventListener("focus", onFocus, true);
  }, [listRef]);

  function cardsOf(cards: Card[], offset: number, isRelated: boolean) {
    return cards.map((card, index) => (
      <ResultCard
        key={card.hits[0]!.chunk_id}
        card={card}
        related={isRelated}
        tabIndex={offset + index === current ? 0 : -1}
        onMore={onMore}
        onNearby={onNearby}
        onReport={onReport}
      />
    ));
  }

  return (
    <div class="results-area" ref={listRef}>
      {onlyRelated && <p class="results-intro">No exact matches — passages about similar things:</p>}
      {(keywordCards.length > 0 || results.length === 0) && (
        <ol class="results" aria-label="Results">
          {cardsOf(keywordCards, 0, false)}
        </ol>
      )}
      {onlyRelated && (
        <ol class="results" aria-label="Results">
          {cardsOf(relatedCards, 0, true)}
        </ol>
      )}
      {!onlyRelated && related.length > 0 && (
        <RelatedFold count={related.length} open={foldOpen} onToggle={setFoldOpen}>
          <ol class="results" aria-label="Related results">
            {cardsOf(relatedCards, keywordCards.length, true)}
          </ol>
        </RelatedFold>
      )}
    </div>
  );
}
