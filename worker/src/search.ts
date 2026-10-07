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
/**
 * Exact search shows at most this many results; deeper pages are clamped. Nobody reads
 * further, so a broad query gets the best 200 and a notice to narrow it (`truncated`).
 */
export const MAX_EXACT_RESULTS = 200;
/** The last page at the default page size. */
export const MAX_EXACT_PAGE = MAX_EXACT_RESULTS / PAGE_SIZE;

/** The last page for a page size of `limit` (`?limit=`, 1–PAGE_SIZE): 10 at 20, 40 at 5. */
export function maxExactPage(limit: number): number {
  return Math.ceil(MAX_EXACT_RESULTS / limit);
}
/**
 * The count stops here ("1,000+", `total_capped`), so a common word doesn't read every
 * matching row just to be counted. D1 bills rows read.
 */
export const COUNT_CAP = 1000;
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
  /** Matching chunks, before collapsing, up to COUNT_CAP. */
  total: number;
  /** There are more than COUNT_CAP matches: show the total as "1,000+". */
  total_capped: boolean;
  /** There are more matches than the pages show (MAX_EXACT_RESULTS): suggest narrowing the query. */
  truncated: boolean;
  page: number;
  /** The page size (`?limit=`, 1–PAGE_SIZE). */
  limit: number;
  /** Another page can be shown (never past MAX_EXACT_RESULTS). */
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

// The count reads at most COUNT_CAP + 1 matches: enough to tell "exactly 1000" from "more".
const countSql = (matchingSql: string): string => `SELECT count(*) AS n FROM (SELECT 1 ${matchingSql} LIMIT ?)`;
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
 * hold fewer than `limit` results, and a hit on the next page is not merged into this one.
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
  limit: number = PAGE_SIZE,
): Promise<SearchResponse> {
  // Nothing to match (empty, only filters, only exclusions): no D1 call at all.
  if (parsed.fts === null) {
    return { total: 0, total_capped: false, truncated: false, page, limit, results: [], has_more: false };
  }

  // The route clamps page to maxExactPage(limit), so offset < MAX_EXACT_RESULTS; the last page
  // stops at result 200 even when limit doesn't divide it.
  const offset = (page - 1) * limit;
  const rowLimit = Math.max(0, Math.min(limit, MAX_EXACT_RESULTS - offset));
  const { sql, params } = matching({ ...parsed, fts: parsed.fts });
  const [count, rows] = await db.batch([
    db.prepare(countSql(sql)).bind(...params, COUNT_CAP + 1),
    db
      .prepare(`${SELECT_PAGE} ${sql} ${ORDER_BY[sort]} LIMIT ? OFFSET ?`)
      .bind(...params, rowLimit, offset),
  ]);
  const matches = (count?.results[0] as { n: number } | undefined)?.n ?? 0;
  return {
    total: Math.min(matches, COUNT_CAP),
    total_capped: matches > COUNT_CAP,
    truncated: matches > MAX_EXACT_RESULTS,
    page,
    limit,
    has_more: page * limit < Math.min(matches, MAX_EXACT_RESULTS),
    results: collapse((rows?.results ?? []) as unknown as Row[]),
  };
}
