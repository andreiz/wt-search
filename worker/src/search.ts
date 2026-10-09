// Search over the chunks (spec §4.3 to §4.6): exact (keyword) search, smart search (keywords
// fused with meaning-based hits from Vectorize), the filters, the sorts, paging, and the
// result shape the API returns.
//
// The security rule (plan Review Focus 4): the SQL is built only from the fixed fragments
// below. The FTS5 expressions from parseQuery, every filter value and every chunk id are bound
// parameters, never concatenated, so no part of the query string can change the statement.

import type {
  DegradedReason,
  ExactResponse,
  Match,
  SearchResult,
  SmartResponse,
  Sort,
} from "./api-types";
import type { Env } from "./env";
import { collapse, rrf, sortByDate } from "./fusion";
import { highlightRanges, hitMs, withoutStopwords } from "./highlight";
import { cueTimes, deepLinks, type LinkEpisode } from "./links";
import { HIGHLIGHT_STOPWORDS, type Filters, type ParsedQuery } from "./query";

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

/** Smart search fuses the top this many keyword hits and the top this many nearest vectors. */
export const SMART_LIST_SIZE = 50;
/** Smart search shows at most this many hits (before collapsing); deeper pages are clamped. */
export const MAX_SMART_RESULTS = 100;

/** The last smart page for a page size of `limit`: 5 at 20, 20 at 5. */
export function maxSmartPage(limit: number): number {
  return Math.ceil(MAX_SMART_RESULTS / limit);
}

/** The query embedding model; its vectors must match the Mac's (`pooling: "cls"`, spec §4.2). */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// The response shapes live in api-types.ts (import-free, so web/ can use them).
export type {
  DegradedReason,
  ExactResponse,
  Match,
  ResultDebug,
  SearchResult,
  SmartDebug,
  SmartResponse,
  Sort,
} from "./api-types";

/** Which binding failed when smart search fell back to keywords. */
export type SmartStage = "ai" | "vectorize";

/** One chunk row: the chunk, its (highlighted) text, and the episode columns the links need. */
interface Row extends LinkEpisode {
  id: number;
  episode_id: number;
  seq: number;
  start_ms: number;
  word_times: string;
  /** The text with FTS5 highlight markers, or the plain text for an unhighlighted chunk. */
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

const ROW_COLUMNS = `c.id, c.episode_id, c.seq, c.start_ms, c.word_times,
       e.number, e.title, e.published_at, e.youtube_video_id, e.apple_episode_id,
       e.spotify_episode_id, e.page_url, e.offset_youtube_s, e.offset_apple_s, e.offset_spotify_s`;

// The count reads at most COUNT_CAP + 1 matches: enough to tell "exactly 1000" from "more".
const countSql = (matchingSql: string): string => `SELECT count(*) AS n FROM (SELECT 1 ${matchingSql} LIMIT ?)`;
const SELECT_PAGE = `SELECT ${ROW_COLUMNS}, highlight(chunks_fts, 0, char(1), char(2)) AS marked`;

type Sql = { sql: string; params: (string | number)[] };

/** The SQL filters (spec §4.3) as ` AND …` clauses on `c` and `e`, with the values to bind. */
function filterSql(parsed: ParsedQuery): Sql {
  const filters: Filters = parsed.filters;
  let sql = "";
  const params: (string | number)[] = [];
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

/** The FROM and WHERE of a keyword search, with the values to bind, in order. */
function matching(parsed: ParsedQuery & { fts: string }): Sql {
  const filters = filterSql(parsed);
  return {
    sql: `FROM chunks_fts
JOIN chunks c ON c.id = chunks_fts.rowid
JOIN episodes e ON e.id = c.episode_id
WHERE chunks_fts MATCH ?${filters.sql}`,
    params: [parsed.fts, ...filters.params],
  };
}

/**
 * A row as an API result. Stopword highlights are dropped unless nothing else is marked
 * (`withoutStopwords`). Keyword hits cue at their first highlighted word. Related hits
 * highlight any query words they happen to contain, but cue at the chunk's start: the
 * passage as a whole is the hit (spec §4.5).
 */
function toResult(row: Row, match: Match): SearchResult {
  const { text, ranges, firstToken } = withoutStopwords(highlightRanges(row.marked), HIGHLIGHT_STOPWORDS);
  const hit = match === "keyword" ? hitMs(row, firstToken) : row.start_ms;
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
    match,
    more_in_episode: 0,
    folded: [],
  };
}

/**
 * Keyword search: one D1 batch of two statements (the count, then the page), as the Free
 * plan allows 50 D1 queries per invocation. D1 errors propagate; the route answers 503.
 *
 * Collapsing is per page: a hit on the next page is not merged into this one, so a page can
 * hold fewer than `limit` results.
 */
export async function exactSearch(
  db: D1Database,
  parsed: ParsedQuery,
  sort: Sort,
  page: number,
  limit: number = PAGE_SIZE,
): Promise<ExactResponse> {
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
    results: collapse(((rows?.results ?? []) as unknown as Row[]).map((row) => toResult(row, "keyword"))),
  };
}

/**
 * The year filters as a Vectorize metadata filter (spec §4.2: `year` has a metadata index).
 * Vectorize allows `$eq` alone or a `$gt`/`$lt` range, not both, so with `year:` only `$eq` is
 * sent; D1 applies every filter again when the hits are loaded.
 */
export function vectorFilter(filters: Filters): VectorizeVectorMetadataFilter | undefined {
  if (filters.year !== undefined) return { year: { $eq: filters.year } };
  const range: { $lt?: number; $gt?: number } = {};
  if (filters.before !== undefined) range.$lt = filters.before;
  if (filters.after !== undefined) range.$gt = filters.after;
  return Object.keys(range).length > 0 ? { year: range } : undefined;
}

/** The single embedding of a one-text request, or an error for any other response shape. */
function embedding(output: Ai_Cf_Baai_Bge_Base_En_V1_5_Output): number[] {
  const vector = "data" in output ? output.data?.[0] : undefined;
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every((v) => typeof v === "number")) {
    throw new Error("Workers AI returned no embedding");
  }
  return vector;
}

/**
 * The nearest chunks to the query's meaning, best first, with Vectorize's similarity; null
 * when Workers AI or Vectorize failed (reported through `onDegraded`). Ids that are not chunk
 * ids are dropped, and so is anything past `topK`.
 */
async function nearestChunks(
  env: Pick<Env, "AI" | "VEC">,
  parsed: ParsedQuery,
  onDegraded: (stage: SmartStage, err: unknown) => void,
): Promise<{ id: number; score: number }[] | null> {
  let vector: number[];
  try {
    vector = embedding(await env.AI.run(EMBEDDING_MODEL, { text: [parsed.semantic], pooling: "cls" }));
  } catch (err) {
    onDegraded("ai", err);
    return null;
  }
  try {
    const filter = vectorFilter(parsed.filters);
    const { matches } = await env.VEC.query(vector, {
      topK: SMART_LIST_SIZE,
      returnValues: false,
      returnMetadata: "none",
      ...(filter ? { filter } : {}),
    });
    return matches
      .slice(0, SMART_LIST_SIZE)
      .filter((m) => /^\d+$/.test(m.id))
      .map((m) => ({ id: Number(m.id), score: m.score }));
  } catch (err) {
    onDegraded("vectorize", err);
    return null;
  }
}

/**
 * Load the chunks only meaning-based search found, in one D1 batch: the rows, with the SQL
 * filters and the exclusions applied (a vector hit has no keyword test of its own), and the
 * highlights of any query words they contain. A chunk that is gone (a publish in progress)
 * simply isn't returned.
 */
async function loadRelated(db: D1Database, parsed: ParsedQuery, ids: number[]): Promise<Map<number, Row>> {
  const filters = filterSql(parsed);
  let rowsSql = `SELECT ${ROW_COLUMNS}, c.text AS marked
FROM chunks c
JOIN episodes e ON e.id = c.episode_id
WHERE c.id IN (SELECT value FROM json_each(?))${filters.sql}`;
  const rowParams: (string | number)[] = [JSON.stringify(ids), ...filters.params];
  if (parsed.exclude !== null) {
    rowsSql += " AND c.id NOT IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?)";
    rowParams.push(parsed.exclude);
  }
  const statements = [db.prepare(rowsSql).bind(...rowParams)];
  // No terms (every query word a stopword): nothing to highlight, and MATCH '' is an error.
  if (parsed.terms.length > 0) {
    statements.push(
      db
        .prepare(
          `SELECT rowid AS id, highlight(chunks_fts, 0, char(1), char(2)) AS marked FROM chunks_fts
WHERE chunks_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`,
        )
        .bind(parsed.terms.join(" OR "), JSON.stringify(ids)),
    );
  }
  const [rows, highlights] = await db.batch(statements);
  const marked = new Map(
    ((highlights?.results ?? []) as { id: number; marked: string }[]).map((h) => [h.id, h.marked]),
  );
  const loaded = new Map<number, Row>();
  for (const row of (rows?.results ?? []) as unknown as Row[]) {
    loaded.set(row.id, { ...row, marked: marked.get(row.id) ?? row.marked });
  }
  return loaded;
}

/**
 * Smart search (spec §4.4): the FTS5 top SMART_LIST_SIZE and the Vectorize top
 * SMART_LIST_SIZE, merged by reciprocal rank fusion, filtered, re-sorted by date if asked,
 * collapsed, then paged.
 *
 * D1: one query for the keyword hits (run while the query is embedded), then one batch of two
 * for the chunks only Vectorize found. D1 errors propagate (the route answers 503). If Workers
 * AI or Vectorize fail, the keyword hits alone are returned with `smart_degraded:
 * "unavailable"`; `skipMeaning` asks for that answer up front, with its own reason, and calls
 * neither. `debug` adds why each result ranked where it did (ResultDebug, SmartDebug); the
 * order is the same.
 */
export async function smartSearch(
  env: Pick<Env, "DB" | "AI" | "VEC">,
  parsed: ParsedQuery,
  sort: Sort,
  page: number,
  options: {
    limit?: number;
    onDegraded?: (stage: SmartStage, err: unknown) => void;
    debug?: boolean;
    /** Answer with the keyword hits only, for this reason, without asking AI or Vectorize. */
    skipMeaning?: Exclude<DegradedReason, "unavailable">;
  } = {},
): Promise<SmartResponse> {
  const { limit = PAGE_SIZE, onDegraded = () => {}, debug = false, skipMeaning } = options;
  // Nothing to match means nothing to embed either: `semantic` holds the same positive terms.
  if (parsed.fts === null) return { page, limit, has_more: false, results: [] };

  const { sql, params } = matching({ ...parsed, fts: parsed.fts });
  const [keywordRows, nearest] = await Promise.all([
    env.DB.prepare(`${SELECT_PAGE} ${sql} ${ORDER_BY.relevance} LIMIT ?`)
      .bind(...params, SMART_LIST_SIZE)
      .all()
      .then((r) => r.results as unknown as Row[]),
    skipMeaning ? Promise.resolve(null) : nearestChunks(env, parsed, onDegraded),
  ]);
  const vectorIds = nearest?.map((n) => n.id) ?? [];

  const keyword = new Map(keywordRows.map((row) => [row.id, row]));
  const fusedScores = rrf([keywordRows.map((row) => row.id), vectorIds]).slice(0, MAX_SMART_RESULTS);
  const fused = fusedScores.map((f) => f.id);
  const relatedIds = fused.filter((id) => !keyword.has(id));
  const related = relatedIds.length > 0 ? await loadRelated(env.DB, parsed, relatedIds) : new Map<number, Row>();

  let hits = fused.flatMap((id): (Row & { match: Match })[] => {
    const k = keyword.get(id);
    if (k) return [{ ...k, match: "keyword" }];
    const r = related.get(id);
    return r ? [{ ...r, match: "related" }] : [];
  });
  if (sort !== "relevance") hits = sortByDate(hits, sort);

  let all = hits.map((hit) => toResult(hit, hit.match));
  if (debug) {
    // 1-based ranks in each list, for the debug fields only.
    const keywordRank = new Map(keywordRows.map((row, i) => [row.id, i + 1]));
    const vectorRank = new Map((nearest ?? []).map((n, i) => [n.id, { rank: i + 1, score: n.score }]));
    const rrfScore = new Map(fusedScores.map((f) => [f.id, f.score]));
    all = all.map((r) => ({
      ...r,
      debug: {
        keyword_rank: keywordRank.get(r.chunk_id) ?? null,
        vector_rank: vectorRank.get(r.chunk_id)?.rank ?? null,
        vector_score: vectorRank.get(r.chunk_id)?.score ?? null,
        rrf_score: rrfScore.get(r.chunk_id) ?? 0,
      },
    }));
  }
  const results = collapse(all);
  const offset = (page - 1) * limit;
  const response: SmartResponse = {
    page,
    limit,
    has_more: offset + limit < results.length,
    results: results.slice(offset, offset + limit),
  };
  if (nearest === null) response.smart_degraded = skipMeaning ?? "unavailable";
  if (debug) {
    response.debug = {
      keyword_hits: keywordRows.length,
      vector_hits: nearest === null ? null : nearest.length,
      dropped: vectorIds.filter((id) => !keyword.has(id) && !related.has(id)),
    };
  }
  return response;
}
