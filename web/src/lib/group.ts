// Grouping a page of results for the cards (spec §5.3). The API's order is never changed, and
// nothing is moved or hidden: a card merges nothing but results that sit next to each other, belong
// to one episode and are of one kind (keyword, or related), so a card is all keyword or all related.
import type { SearchResult } from "../../../worker/src/api-types";

export interface Card {
  episode: SearchResult["episode"];
  /** A meaning-only card: every hit in it is a related hit. */
  related: boolean;
  /** One or more hits, in the API's order. */
  hits: SearchResult[];
}

/** Consecutive results from the same episode and of the same kind share a card. */
export function groupNeighbours(results: SearchResult[]): Card[] {
  const cards: Card[] = [];
  for (const hit of results) {
    const related = hit.match === "related";
    const last = cards.at(-1);
    if (last && last.episode.id === hit.episode.id && last.related === related) last.hits.push(hit);
    else cards.push({ episode: hit.episode, related, hits: [hit] });
  }
  return cards;
}
