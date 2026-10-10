// Title hits (spec §4.4): the episodes whose title matches the query. Search reads the
// transcripts, so a word that is only in a title found nothing ("kregger": episode 613 is "Shove
// a Kregger in the Hole", and the transcript says "Craigers"). The titles have their own FTS5
// index (schema/0003_title_search.sql), tokenized like the transcripts', and get the same FTS
// expression: all the words, stemmed, phrases, OR and exclusions.
//
// The SQL is one fixed string plus the filter clauses from search.ts; every value is bound.

import type { EpisodeHit } from "./api-types";
import { deepLinks, type LinkEpisode } from "./links";
import type { ParsedQuery } from "./query";
import { episodeFilterSql } from "./search";

export type { EpisodeHit } from "./api-types";

/** The most episodes a search lists by title. */
export const MAX_TITLE_HITS = 5;

interface Row extends LinkEpisode {
  id: number;
  number: number | null;
  title: string;
  published_at: string;
}

const SELECT_TITLES = `SELECT e.id, e.number, e.title, e.published_at, e.youtube_video_id, e.apple_episode_id,
       e.spotify_episode_id, e.page_url, e.offset_youtube_s, e.offset_apple_s, e.offset_spotify_s
FROM episodes_fts
JOIN episodes e ON e.id = episodes_fts.rowid
WHERE episodes_fts MATCH ?`;

// The best title match first, then the newest episode; the id makes the order total.
const ORDER_TITLES = "ORDER BY bm25(episodes_fts), e.published_at DESC, e.id LIMIT ?";

/**
 * The episodes whose title matches, with the query's year and `ep:` filters, at most
 * MAX_TITLE_HITS. A query with nothing to match makes no statement. D1 errors propagate: the
 * route answers with no title hits rather than fail the search.
 */
export async function titleHits(db: D1Database, parsed: ParsedQuery): Promise<EpisodeHit[]> {
  if (parsed.fts === null) return [];
  const filters = episodeFilterSql(parsed.filters);
  const { results } = await db
    .prepare(`${SELECT_TITLES}${filters.sql} ${ORDER_TITLES}`)
    .bind(parsed.fts, ...filters.params, MAX_TITLE_HITS)
    .all<Row>();
  return results.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    // published_at is always UTC ISO, so the first ten characters are the date.
    date: row.published_at.slice(0, 10),
    // From the episode's start: each platform's offset, and no lead-in.
    links: deepLinks(row, 0, 0),
  }));
}
