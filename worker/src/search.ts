// Exact (keyword) search over the chunks (spec §4.3 to §4.6): the FTS5 query, the filters,
// the sort, paging, and the result shape the API returns.
//
// The security rule (plan Review Focus 4): the SQL is built only from the fixed fragments
// below. The FTS5 expression from parseQuery and every filter value are bound parameters,
// never concatenated, so no part of the query string can change the statement.

import { highlightRanges, hitMs } from "./highlight";
import { cueTimes, deepLinks, type LinkEpisode } from "./links";
import type { ParsedQuery } from "./query";

export const PAGE_SIZE = 20;
/** Deeper pages are clamped to this one, so OFFSET stays bounded. */
export const MAX_EXACT_PAGE = 1000;
/** Hits in one episode less than this far apart are shown as one result (spec §4.4). */
export const COLLAPSE_MS = 120_000;

export type Sort = "relevance" | "newest" | "oldest";

export interface SearchResult {
  episode: {
    id: number;
    number: number | null;
    title: string;
    /** `YYYY-MM-DD`, from published_at. */
    date: string;
    links: ReturnType<typeof deepLinks>;
  };
  chunk_id: number;
  text: string;
  /** `[start, end)` offsets into `text` (UTF-16 code units) of the matched words. */
  ranges: [number, number][];
  hit_ms: number;
  cue_s: { youtube: number; apple: number; spotify: number };
  match: "keyword";
  /** Other hits from the same episode on this page, within COLLAPSE_MS of this one. */
  more_in_episode: number;
}

export interface SearchResponse {
  /** Matching chunks, before collapsing. */
  total: number;
  page: number;
  has_more: boolean;
  results: SearchResult[];
  /** Smart mode could not use meaning-based search and answered with keywords only. */
  smart_degraded?: true;
}

/** One row of the page query: the chunk, its highlighted text, and the episode columns the links need. */
interface Row extends LinkEpisode {
  id: number;
  episode_id: number;
  seq: number;
  start_ms: number;
  word_times: string;
  marked: string;
  number: number | null;
  title: string;
  published_at: string;
}

// The ORDER BY is chosen from this table, never from the request. The trailing ids make the
// order total, so a row cannot appear on two pages or on none. Within an episode the hits
// always run in the order of the episode, whichever way the dates are sorted.
const ORDER_BY: Record<Sort, string> = {
  relevance: "ORDER BY bm25(chunks_fts), c.id",
  newest: "ORDER BY e.published_at DESC, e.id, c.seq, c.id",
  oldest: "ORDER BY e.published_at ASC, e.id, c.seq, c.id",
};

const SELECT_COUNT = "SELECT count(*) AS n";
const SELECT_PAGE = `SELECT c.id, c.episode_id, c.seq, c.start_ms, c.word_times,
       highlight(chunks_fts, 0, char(1), char(2)) AS marked,
       e.number, e.title, e.published_at, e.youtube_video_id, e.apple_episode_id,
       e.spotify_episode_id, e.page_url, e.offset_youtube_s, e.offset_apple_s, e.offset_spotify_s`;

/** The FROM and WHERE shared by the count and the page, with the values to bind, in order. */
function matching(parsed: ParsedQuery & { fts: string }): { sql: string; params: (string | number)[] } {
  const { filters } = parsed;
  let sql = `FROM chunks_fts
JOIN chunks c ON c.id = chunks_fts.rowid
JOIN episodes e ON e.id = c.episode_id
WHERE chunks_fts MATCH ?`;
  const params: (string | number)[] = [parsed.fts];
  if (!parsed.includeAds) sql += " AND c.is_boilerplate = 0";
  if (filters.year !== undefined) {
    sql += " AND e.year = ?";
    params.push(filters.year);
  }
  // before: and after: are exclusive, so `after:2019` starts in 2020.
  if (filters.before !== undefined) {
    sql += " AND e.year < ?";
    params.push(filters.before);
  }
  if (filters.after !== undefined) {
    sql += " AND e.year > ?";
    params.push(filters.after);
  }
  if (filters.ep !== undefined) {
    sql += " AND e.number = ?";
    params.push(filters.ep);
  }
  return { sql, params };
}

function toResult(row: Row): SearchResult {
  const { text, ranges, firstToken } = highlightRanges(row.marked);
  const hit = hitMs(row, firstToken);
  return {
    episode: {
      id: row.episode_id,
      number: row.number,
      title: row.title,
      // published_at is always UTC ISO, so the first ten characters are the date.
      date: row.published_at.slice(0, 10),
      links: deepLinks(row, hit),
    },
    chunk_id: row.id,
    text,
    ranges,
    hit_ms: hit,
    cue_s: cueTimes(row, hit),
    match: "keyword",
    more_in_episode: 0,
  };
}

/**
 * Collapse hits of one episode that are close in time, per page: the first result in page
 * order is kept and counts the ones it absorbs. Only kept results are compared against, so
 * a long run of hits is not swallowed by a chain of near neighbours. A page can therefore
 * hold fewer than PAGE_SIZE results, and a hit on the next page is not merged into this one.
 */
function collapse(rows: Row[]): SearchResult[] {
  const kept: SearchResult[] = [];
  for (const row of rows) {
    const result = toResult(row);
    const near = kept.find(
      (k) => k.episode.id === result.episode.id && Math.abs(k.hit_ms - result.hit_ms) < COLLAPSE_MS,
    );
    if (near) near.more_in_episode++;
    else kept.push(result);
  }
  return kept;
}

/**
 * Keyword search: one D1 batch of two statements (the count, then the page), as the Free
 * plan allows 50 D1 queries per invocation. D1 errors propagate; the route answers 503.
 */
export async function exactSearch(
  db: D1Database,
  parsed: ParsedQuery,
  sort: Sort,
  page: number,
): Promise<SearchResponse> {
  // Nothing to match (empty, only filters, only exclusions): no D1 call at all.
  if (parsed.fts === null) return { total: 0, page, results: [], has_more: false };

  const { sql, params } = matching({ ...parsed, fts: parsed.fts });
  const [count, rows] = await db.batch([
    db.prepare(`${SELECT_COUNT} ${sql}`).bind(...params),
    db
      .prepare(`${SELECT_PAGE} ${sql} ${ORDER_BY[sort]} LIMIT ? OFFSET ?`)
      .bind(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE),
  ]);
  const total = (count?.results[0] as { n: number } | undefined)?.n ?? 0;
  return {
    total,
    page,
    has_more: page * PAGE_SIZE < total,
    results: collapse((rows?.results ?? []) as unknown as Row[]),
  };
}
