// Splitting and grouping a page of results for the cards (spec §5.3). The API's order is never
// changed: related hits are only moved out into the fold, and a card merges nothing but results
// that sit next to each other and belong to one episode.
import type { SearchResult } from "../../../worker/src/api-types";

export interface Card {
  episode: SearchResult["episode"];
  /** One or more hits, in the API's order. */
  hits: SearchResult[];
}

/** Keyword hits and meaning-only hits, each in the order the API sent them. */
export function splitRelated(results: SearchResult[]): { keyword: SearchResult[]; related: SearchResult[] } {
  return {
    keyword: results.filter((r) => r.match !== "related"),
    related: results.filter((r) => r.match === "related"),
  };
}

/** Consecutive results from the same episode share a card. */
export function groupNeighbours(results: SearchResult[]): Card[] {
  const cards: Card[] = [];
  for (const hit of results) {
    const last = cards.at(-1);
    if (last && last.episode.id === hit.episode.id) last.hits.push(hit);
    else cards.push({ episode: hit.episode, hits: [hit] });
  }
  return cards;
}
