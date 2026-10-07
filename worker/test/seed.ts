// Small seeded corpus for endpoint tests, inserted through the real tables so the FTS5
// triggers in schema/0001_init.sql fire (the same way `wts publish` writes). Later tasks
// grow this: more episodes and chunks for the search, context and report endpoints.

export interface SeedEpisode {
  id: number;
  guid: string;
  number: number | null;
  title: string;
  published_at: string;
  duration_s: number;
  // Platform ids and cue offsets, for the link tests: null and 0 unless given.
  page_url?: string | null;
  youtube_video_id?: string | null;
  apple_episode_id?: string | null;
  spotify_episode_id?: string | null;
  offset_youtube_s?: number;
  offset_apple_s?: number;
  offset_spotify_s?: number;
}

export interface SeedChunk {
  id: number;
  episode_id: number;
  seq: number;
  start_ms: number;
  end_ms: number;
  text: string;
  /** Encoded word times; defaults to wordTimes(text), 400 ms per word. */
  word_times?: string;
  is_boilerplate?: boolean;
}

export const EPISODES: SeedEpisode[] = [
  {
    id: 1,
    guid: "guid-ep-001",
    number: 1,
    title: "Welcome to Wood Talk",
    published_at: "2014-03-01T08:00:00Z",
    duration_s: 3600,
  },
  {
    id: 2,
    guid: "guid-ep-002",
    number: 2,
    title: "Joinery and Glue",
    published_at: "2019-06-15T08:00:00Z",
    duration_s: 4200,
  },
];

export const CHUNKS: SeedChunk[] = [
  {
    id: 101,
    episode_id: 1,
    seq: 0,
    start_ms: 0,
    end_ms: 20_000,
    text: "Welcome everybody to the show where we talk about woodworking",
  },
  {
    id: 201,
    episode_id: 2,
    seq: 0,
    start_ms: 0,
    end_ms: 20_000,
    text: "Today we are gluing dovetails and arguing about hide glue",
  },
  {
    id: 202,
    episode_id: 2,
    seq: 1,
    start_ms: 20_000,
    end_ms: 40_000,
    text: "Then a long tangent about router tables and dust collection",
  },
];

/** One delta-encoded word offset per space-separated token (chunker.py's format), 400 ms apart. */
export function wordTimes(text: string): string {
  return text
    .split(" ")
    .map((_, i) => (i === 0 ? 0 : 400))
    .join(",");
}

/** Insert the seed episodes and chunks. Throws if the rows already exist (ids are fixed). */
export async function seed(
  db: D1Database,
  episodes: SeedEpisode[] = EPISODES,
  chunks: SeedChunk[] = CHUNKS,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const e of episodes) {
    statements.push(
      db
        .prepare(
          `INSERT INTO episodes (id, guid, number, title, published_at, year, duration_s, page_url,
                                 youtube_video_id, apple_episode_id, spotify_episode_id,
                                 offset_youtube_s, offset_apple_s, offset_spotify_s)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          e.id,
          e.guid,
          e.number,
          e.title,
          e.published_at,
          Number(e.published_at.slice(0, 4)),
          e.duration_s,
          e.page_url ?? null,
          e.youtube_video_id ?? null,
          e.apple_episode_id ?? null,
          e.spotify_episode_id ?? null,
          e.offset_youtube_s ?? 0,
          e.offset_apple_s ?? 0,
          e.offset_spotify_s ?? 0,
        ),
    );
  }
  for (const c of chunks) {
    statements.push(
      db
        .prepare(
          `INSERT INTO chunks (id, episode_id, seq, start_ms, end_ms, text, word_times, is_boilerplate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          c.id,
          c.episode_id,
          c.seq,
          c.start_ms,
          c.end_ms,
          c.text,
          c.word_times ?? wordTimes(c.text),
          c.is_boilerplate ? 1 : 0,
        ),
    );
  }
  await db.batch(statements);
}
