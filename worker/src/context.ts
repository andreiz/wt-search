// GET /api/context?chunk=<id>&radius=<n> (spec §4.4): the "More transcript" button. The hit
// chunk plus its neighbours in the same episode, so a listener reads about ±90 s around it
// (§5). Chunks are about 30 s each, so the default radius of 3 is that.
//
// The SQL is one fixed string; the chunk id and the radius are bound parameters.

import type { ContextResponse } from "./api-types";
import type { Env } from "./env";
import { highlightRanges, withoutStopwords } from "./highlight";
import { json, logError } from "./http";
import { cueTimes, deepLinks, PARAGRAPH_LEAD_S, type LinkEpisode } from "./links";
import { boundQuery, HIGHLIGHT_STOPWORDS, parseQuery } from "./query";
import { withoutHead, withoutTail, type Shown } from "./repeat";

/** Chunks either side of the hit when `radius` is missing or bad. */
export const DEFAULT_RADIUS = 3;
/** The most chunks either side a client can ask for; bigger is clamped. */
export const MAX_RADIUS = 6;

// The response shapes live in api-types.ts (import-free, so web/ can use them).
export type { ContextChunk, ContextResponse } from "./api-types";

/** One row of the query: the chunk and the episode columns the links need. */
interface Row extends LinkEpisode {
  id: number;
  episode_id: number;
  seq: number;
  start_ms: number;
  end_ms: number;
  text: string;
  word_times: string;
  is_boilerplate: number;
  number: number | null;
  title: string;
  published_at: string;
}

// The `hit` CTE finds the chunk's episode and position; the join then takes the chunks of
// that episode within the radius, so no other episode's chunks can come in. An unknown id
// makes `hit` empty and the answer no rows.
const SELECT_CONTEXT = `WITH hit AS (SELECT episode_id, seq FROM chunks WHERE id = ?)
SELECT c.id, c.episode_id, c.seq, c.start_ms, c.end_ms, c.text, c.word_times, c.is_boilerplate,
       e.number, e.title, e.published_at, e.guid, e.youtube_video_id, e.apple_episode_id,
       e.spotify_episode_id, e.page_url, e.offset_youtube_s, e.offset_apple_s, e.offset_spotify_s
FROM hit
JOIN chunks c ON c.episode_id = hit.episode_id AND c.seq BETWEEN hit.seq - ? AND hit.seq + ?
JOIN episodes e ON e.id = c.episode_id
ORDER BY c.seq`;

// The same `hit` window, so the highlight runs in the same batch as the select. `terms` are
// quoted FTS5 strings (query.ts `quote`), so MATCH cannot see user syntax.
const HIGHLIGHT_CONTEXT = `WITH hit AS (SELECT episode_id, seq FROM chunks WHERE id = ?)
SELECT chunks_fts.rowid AS id, highlight(chunks_fts, 0, char(1), char(2)) AS marked
FROM chunks_fts
WHERE chunks_fts MATCH ?
  AND chunks_fts.rowid IN (
    SELECT c.id FROM hit JOIN chunks c ON c.episode_id = hit.episode_id AND c.seq BETWEEN hit.seq - ? AND hit.seq + ?
  )`;

/** A plain non-negative integer, clamped to 0 to MAX_RADIUS; anything else is DEFAULT_RADIUS. */
export function parseRadius(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return DEFAULT_RADIUS;
  return Math.min(Number(value), MAX_RADIUS);
}

/** The chunk id: digits only and small enough to be an exact integer, else null. */
export function parseChunkId(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** The ranges of a highlighted chunk, minus stopword marks (as search does); [] for no match. */
function rangesOf(text: string, markedText: string | undefined): [number, number][] {
  if (markedText === undefined) return [];
  const h = withoutStopwords(highlightRanges(markedText), HIGHLIGHT_STOPWORDS);
  // The ranges index h.text; they are only valid for `text` when the two are the same.
  return h.text === text ? h.ranges : [];
}

/**
 * `rows[index]` as the transcript shows it: without the sentence its neighbour on the hit's side
 * also holds (the end of a chunk before the hit, the start of one after it), so the reader meets
 * it once. The hit itself is whole, and so is a chunk whose neighbour is not the next of the
 * episode.
 */
function shownOf(rows: Row[], index: number, hitIndex: number, ranges: [number, number][]): Shown {
  const row = rows[index]!;
  const neighbour = rows[index < hitIndex ? index + 1 : index - 1];
  if (index === hitIndex || !neighbour || Math.abs(neighbour.seq - row.seq) !== 1) {
    return { text: row.text, start_ms: row.start_ms, end_ms: row.end_ms, ranges };
  }
  return index < hitIndex ? withoutTail(row, ranges, neighbour) : withoutHead(row, ranges, neighbour);
}

/**
 * The hit and its neighbours, or null when there is no such chunk. `q` (optional) marks its
 * words in each chunk's `ranges`; exclusions and filters in it are ignored. With terms, the
 * select and the highlight go in one batch; without, it is one statement. D1 errors propagate.
 */
export async function chunkContext(
  db: D1Database,
  chunkId: number,
  radius: number,
  q = "",
): Promise<ContextResponse | null> {
  // Parsed as search parses it: cut at the bound, then quoted into FTS5 strings. No terms
  // (empty, only stopwords or filters) means nothing to highlight, and MATCH '' is an error.
  const { terms } = parseQuery(boundQuery(q));
  const select = db.prepare(SELECT_CONTEXT).bind(chunkId, radius, radius);
  let results: Row[];
  const marked = new Map<number, string>();
  if (terms.length === 0) {
    results = (await select.all<Row>()).results;
  } else {
    const highlight = db.prepare(HIGHLIGHT_CONTEXT).bind(chunkId, terms.join(" OR "), radius, radius);
    const [rows, highlights] = await db.batch([select, highlight]);
    results = (rows?.results ?? []) as unknown as Row[];
    for (const h of (highlights?.results ?? []) as { id: number; marked: string }[]) marked.set(h.id, h.marked);
  }
  const hitIndex = results.findIndex((row) => row.id === chunkId);
  const hit = results[hitIndex];
  if (!hit) return null;
  return {
    chunk_id: hit.id,
    episode: {
      id: hit.episode_id,
      number: hit.number,
      title: hit.title,
      // published_at is always UTC ISO, so the first ten characters are the date.
      date: hit.published_at.slice(0, 10),
      links: deepLinks(hit, hit.start_ms),
    },
    chunks: results.map((row, index) => {
      const shown = shownOf(results, index, hitIndex, rangesOf(row.text, marked.get(row.id)));
      return {
        chunk_id: row.id,
        seq: row.seq,
        start_ms: shown.start_ms,
        end_ms: shown.end_ms,
        text: shown.text,
        boilerplate: row.is_boilerplate !== 0,
        // A paragraph starts at a sentence, so it plays from its first word, not 7 s before it.
        cue_s: cueTimes(row, shown.start_ms, PARAGRAPH_LEAD_S),
        links: deepLinks(row, shown.start_ms, PARAGRAPH_LEAD_S),
        ranges: shown.ranges,
      };
    }),
  };
}

/**
 * GET /api/context?chunk=<id>&radius=<n>&q=<query>. A missing or non-numeric chunk is 400, an unknown
 * one 404; a bad radius is the default. The only other error is D1 being down (503).
 */
export async function context(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const chunkId = parseChunkId(params.get("chunk"));
  if (chunkId === null) return json({ error: "bad_request" }, 400);

  let response: ContextResponse | null;
  try {
    response = await chunkContext(env.DB, chunkId, parseRadius(params.get("radius")), params.get("q") ?? "");
  } catch (err) {
    logError("d1_unavailable", request, err);
    return json({ error: "unavailable" }, 503);
  }
  if (!response) return json({ error: "not_found" }, 404);
  return json(response);
}
