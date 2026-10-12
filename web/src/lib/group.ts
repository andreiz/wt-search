// Grouping a page of results for the cards (spec §5.3). The cards keep the API's order, and
// nothing is hidden or moved to another card: a card merges nothing but results that sit next to
// each other, belong to one episode and are of one kind (keyword, or related), so a card is all
// keyword or all related. Inside a card the hits run in the order of the episode: by rank, a card
// of many hits read as a jumble of times (48:07, 31:25, 39:10).
import type { SearchResult } from "../../../worker/src/api-types";

export interface Card {
  episode: SearchResult["episode"];
  /** A meaning-only card: every hit in it is a related hit. */
  related: boolean;
  /** One or more hits, earliest in the episode first. */
  hits: SearchResult[];
}

/** Consecutive results from the same episode and of the same kind share a card, in time order. */
export function groupNeighbours(results: SearchResult[]): Card[] {
  const cards: Card[] = [];
  for (const hit of results) {
    const related = hit.match === "related";
    const last = cards.at(-1);
    if (last && last.episode.id === hit.episode.id && last.related === related) last.hits.push(hit);
    else cards.push({ episode: hit.episode, related, hits: [hit] });
  }
  // The sort is stable, so hits at the same moment keep the API's order.
  for (const card of cards) card.hits.sort((a, b) => a.hit_ms - b.hit_ms);
  return cards;
}
