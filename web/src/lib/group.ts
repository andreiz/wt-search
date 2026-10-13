// Grouping a page of results for the cards (spec §5.3). The cards keep the API's order, and
// nothing is hidden or moved to another card: a card merges nothing but results that sit next to
// each other and belong to one episode. Inside a card the hits run in the order of the episode: by rank, a card
// of many hits read as a jumble of times (48:07, 31:25, 39:10).
import type { SearchResult } from "../../../worker/src/api-types";

export interface Card {
  episode: SearchResult["episode"];
  /** One or more hits, earliest in the episode first. */
  hits: SearchResult[];
}

/** Consecutive results from the same episode share a card, in time order. */
export function groupNeighbours(results: SearchResult[]): Card[] {
  const cards: Card[] = [];
  for (const hit of results) {
    const last = cards.at(-1);
    if (last && last.episode.id === hit.episode.id) last.hits.push(hit);
    else cards.push({ episode: hit.episode, hits: [hit] });
  }
  // The sort is stable, so hits at the same moment keep the API's order.
  for (const card of cards) card.hits.sort((a, b) => a.hit_ms - b.hit_ms);
  return cards;
}
