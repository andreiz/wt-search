// GET /api/context?chunk=<id>&radius=<n> (spec §4.4): the "More transcript" button. The hit
// chunk plus its neighbours in the same episode, so a listener reads about ±90 s around it
// (§5). Chunks are about 30 s each, so the default radius of 3 is that.
//
// The SQL is one fixed string; the chunk id and the radius are bound parameters.

import type { Env } from "./env";
import { json, logError } from "./http";
import { cueTimes, deepLinks, type LinkEpisode } from "./links";

/** Chunks either side of the hit when `radius` is missing or bad. */
export const DEFAULT_RADIUS = 3;
/** The most chunks either side a client can ask for; bigger is clamped. */
export const MAX_RADIUS = 6;

export interface ContextChunk {
  chunk_id: number;
  seq: number;
  start_ms: number;
  end_ms: number;
  text: string;
  /** A sponsor read or other repeated ad. Still part of the transcript, so it is included. */
  boilerplate: boolean;
  /** Where each platform should start to play this chunk (the cue at the chunk's start). */
  cue_s: ReturnType<typeof cueTimes>;
  links: ReturnType<typeof deepLinks>;
}

export interface ContextResponse {
  chunk_id: number;
  episode: {
    id: number;
    number: number | null;
    title: string;
    /** `YYYY-MM-DD`, from published_at. */
    date: string;
    /** Deep links at the hit chunk's start. */
    links: ReturnType<typeof deepLinks>;
  };
  /** The hit and its neighbours, in the order of the episode. */
  chunks: ContextChunk[];
}

/** One row of the query: the chunk and the episode columns the links need. */
interface Row extends LinkEpisode {
  id: number;
  episode_id: number;
  seq: number;
  start_ms: number;
  end_ms: number;
  text: string;
  is_boilerplate: number;
  number: number | null;
  title: string;
  published_at: string;
}

// The `hit` CTE finds the chunk's episode and position; the join then takes the chunks of
// that episode within the radius, so no other episode's chunks can come in. An unknown id
// makes `hit` empty and the answer no rows.
const SELECT_CONTEXT = `WITH hit AS (SELECT episode_id, seq FROM chunks WHERE id = ?)
SELECT c.id, c.episode_id, c.seq, c.start_ms, c.end_ms, c.text, c.is_boilerplate,
       e.number, e.title, e.published_at, e.youtube_video_id, e.apple_episode_id,
       e.spotify_episode_id, e.page_url, e.offset_youtube_s, e.offset_apple_s, e.offset_spotify_s
FROM hit
JOIN chunks c ON c.episode_id = hit.episode_id AND c.seq BETWEEN hit.seq - ? AND hit.seq + ?
JOIN episodes e ON e.id = c.episode_id
ORDER BY c.seq`;

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

/** The hit and its neighbours, or null when there is no such chunk. D1 errors propagate. */
export async function chunkContext(db: D1Database, chunkId: number, radius: number): Promise<ContextResponse | null> {
  const { results } = await db.prepare(SELECT_CONTEXT).bind(chunkId, radius, radius).all<Row>();
  const hit = results.find((row) => row.id === chunkId);
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
    chunks: results.map((row) => ({
      chunk_id: row.id,
      seq: row.seq,
      start_ms: row.start_ms,
      end_ms: row.end_ms,
      text: row.text,
      boilerplate: row.is_boilerplate !== 0,
      cue_s: cueTimes(row, row.start_ms),
      links: deepLinks(row, row.start_ms),
    })),
  };
}

/**
 * GET /api/context?chunk=<id>&radius=<n>. A missing or non-numeric chunk is 400, an unknown
 * one 404; a bad radius is the default. The only other error is D1 being down (503).
 */
export async function context(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const chunkId = parseChunkId(params.get("chunk"));
  if (chunkId === null) return json({ error: "bad_request" }, 400);

  let response: ContextResponse | null;
  try {
    response = await chunkContext(env.DB, chunkId, parseRadius(params.get("radius")));
  } catch (err) {
    logError("d1_unavailable", request, err);
    return json({ error: "unavailable" }, 503);
  }
  if (!response) return json({ error: "not_found" }, 404);
  return json(response);
}
