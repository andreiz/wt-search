// Merging and ordering search hits (spec §4.4): reciprocal rank fusion of the keyword and
// meaning-based lists, the date sort, and collapsing nearby hits of one episode.

/** The RRF constant (spec §4.4): large enough that rank 1 and rank 2 score almost alike. */
export const RRF_K = 60;
/** Hits in one episode less than this far apart are shown as one result (spec §4.4). */
export const COLLAPSE_MS = 120_000;

/**
 * Reciprocal rank fusion: each id scores the sum of 1 / (k + rank) over the lists it is in,
 * rank counted from 1. Highest score first. Ties keep the order of first appearance, reading
 * the lists one after the other, so on a tie the first list (keywords) wins. An id repeated
 * within one list counts only at its first rank.
 */
export function rrf<Id>(lists: readonly (readonly Id[])[], k: number = RRF_K): { id: Id; score: number }[] {
  const scores = new Map<Id, number>();
  for (const list of lists) {
    const seen = new Set<Id>();
    list.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  // Array.prototype.sort is stable, and a Map iterates in insertion order.
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/** What the date sort reads from a hit: the same keys as exact search's ORDER BY. */
export interface Dated {
  id: number;
  episode_id: number;
  seq: number;
  published_at: string;
}

/**
 * Hits by episode date (`newest` or `oldest`), then episode, then position in the episode,
 * then id, as exact search orders them. Within an episode hits always run in episode order,
 * so collapsing groups them by episode. Returns a new array.
 */
export function sortByDate<T extends Dated>(hits: readonly T[], sort: "newest" | "oldest"): T[] {
  const sign = sort === "newest" ? -1 : 1;
  return [...hits].sort(
    (a, b) =>
      sign * (a.published_at < b.published_at ? -1 : a.published_at > b.published_at ? 1 : 0) ||
      a.episode_id - b.episode_id ||
      a.seq - b.seq ||
      a.id - b.id,
  );
}

/** What collapsing reads from a result. */
export interface Collapsible {
  chunk_id: number;
  episode: { id: number };
  hit_ms: number;
  more_in_episode: number;
  /** The chunk ids folded into this result, in fold order; as many as `more_in_episode`. */
  folded: number[];
}

/**
 * Collapse hits of one episode that are close in time: the first result in list order is
 * kept and counts the ones it absorbs. Only kept results are compared against, so a long run
 * of hits is not swallowed by a chain of near neighbours. Mutates the kept results'
 * `more_in_episode` and `folded` (the absorbed chunk ids); returns the kept ones in order.
 */
export function collapse<T extends Collapsible>(results: readonly T[]): T[] {
  const kept: T[] = [];
  for (const result of results) {
    const near = kept.find(
      (k) => k.episode.id === result.episode.id && Math.abs(k.hit_ms - result.hit_ms) < COLLAPSE_MS,
    );
    if (near) {
      near.more_in_episode++;
      near.folded.push(result.chunk_id);
    } else {
      kept.push(result);
    }
  }
  return kept;
}
