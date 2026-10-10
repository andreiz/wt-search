import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { seed, type SeedChunk, type SeedEpisode } from "./seed";

const JSON_TYPE = "application/json; charset=utf-8";

interface ContextBody {
  chunk_id: number;
  episode: {
    id: number;
    number: number | null;
    title: string;
    date: string;
    links: Record<string, string>;
  };
  chunks: {
    chunk_id: number;
    seq: number;
    start_ms: number;
    end_ms: number;
    text: string;
    boilerplate: boolean;
    cue_s: { youtube: number; apple: number; spotify: number; page: number };
    links: Record<string, string>;
    ranges: [number, number][];
  }[];
}

// Episode 30 has nine chunks (seq 0 to 8) and no platform ids. Its chunk ids run against seq
// (3009 is seq 0), to catch an ORDER BY id. Episodes 31 and 32 have chunks with seqs next to
// 30's (31 has 8 and 0, 32 has 0 and 1), to catch a neighbour query that crosses into another
// episode, or that matches on seq alone. Episode 33 has
// every platform id, non-zero offsets and a boilerplate chunk.
const EPISODES: SeedEpisode[] = [
  { id: 30, guid: "g30", number: 300, title: "The Long One", published_at: "2020-05-04T08:00:00+00:00", duration_s: 3600 },
  { id: 31, guid: "g31", number: 299, title: "Before It", published_at: "2020-04-27T08:00:00+00:00", duration_s: 3600 },
  { id: 32, guid: "g32", number: null, title: "After It", published_at: "2020-05-11T08:00:00+00:00", duration_s: 3600 },
  {
    id: 33,
    guid: "g33",
    number: 301,
    title: "Links and Ads",
    published_at: "2021-01-02T08:00:00+00:00",
    duration_s: 3600,
    page_url: "https://example.com/ep/301",
    youtube_video_id: "yt33",
    apple_episode_id: "ap33",
    spotify_episode_id: "sp33",
    offset_youtube_s: 10,
    offset_apple_s: 20,
    offset_spotify_s: 30,
  },
  { id: 34, guid: "g34", number: 302, title: "Glue Talk", published_at: "2022-03-07T08:00:00+00:00", duration_s: 3600 },
];

function chunk(id: number, episode_id: number, seq: number, start_ms: number, text: string, extra: Partial<SeedChunk> = {}): SeedChunk {
  return { id, episode_id, seq, start_ms, end_ms: start_ms + 30_000, text, ...extra };
}

const CHUNKS: SeedChunk[] = [
  // Episode 31: seqs equal to episode 30's first and last, ids on either side of its range.
  chunk(3100, 31, 8, 240_000, "other episode, last chunk"),
  chunk(3000, 31, 0, 0, "other episode, first chunk"),
  // Episode 30: seq 0..8, 30 s apart; id = 3009 - seq.
  ...Array.from({ length: 9 }, (_, seq) => chunk(3009 - seq, 30, seq, seq * 30_000, `thirty chunk ${seq}`)),
  chunk(3200, 32, 0, 0, "after episode, first chunk"),
  chunk(3201, 32, 1, 30_000, "after episode, second chunk"),
  // Episode 33: the hit at 100 s, an ad after it.
  chunk(3301, 33, 0, 40_000, "link episode intro"),
  chunk(3302, 33, 1, 100_000, "link episode middle"),
  chunk(3303, 33, 2, 130_000, "this episode is brought to you by Sponsorly", { is_boilerplate: true }),
  // Episode 34: query words in some chunks, non-ASCII text before a match in the hit.
  chunk(3401, 34, 0, 0, "Today we were gluing the panel with hide glue"),
  chunk(3402, 34, 1, 30_000, "the café table is naïve about the glue joint"),
  chunk(3403, 34, 2, 60_000, "nothing relevant here at all"),
  chunk(3404, 34, 3, 90_000, "Once glued the tabletop and the dovetails are done"),
];

beforeAll(async () => {
  await seed(env.DB, EPISODES, CHUNKS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function context(query: string): Promise<{ response: Response; body: ContextBody }> {
  const response = await exports.default.fetch(new Request(`https://example.com/api/context${query}`));
  return { response, body: (await response.json()) as ContextBody };
}

const seqs = (body: ContextBody): number[] => body.chunks.map((c) => c.seq);
const ids = (body: ContextBody): number[] => body.chunks.map((c) => c.chunk_id);

/** Wraps a real D1 and records every statement prepared, as in search-exact.test.ts. */
function countingDb(real: D1Database): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare(query: string) {
      sql.push(query);
      return real.prepare(query);
    },
    batch(statements: D1PreparedStatement[]) {
      sql.push("<batch>");
      return real.batch(statements);
    },
  } as unknown as D1Database;
  return { db, sql };
}

describe("neighbours", () => {
  it("returns the hit and three chunks each side, in seq order", async () => {
    // 3005 is seq 4, the middle of nine.
    const { response, body } = await context("?chunk=3005");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    expect(body.chunk_id).toBe(3005);
    expect(seqs(body)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Ids run against seq, so this also shows the order is by seq.
    expect(ids(body)).toEqual([3008, 3007, 3006, 3005, 3004, 3003, 3002]);
  });

  it("has the shape from spec §4.4: episode once, then the chunks", async () => {
    const { body } = await context("?chunk=3005&radius=0");
    expect(body).toEqual({
      chunk_id: 3005,
      episode: { id: 30, number: 300, title: "The Long One", date: "2020-05-04", links: {} },
      chunks: [
        {
          chunk_id: 3005,
          seq: 4,
          start_ms: 120_000,
          end_ms: 150_000,
          text: "thirty chunk 4",
          boilerplate: false,
          cue_s: { youtube: 113, apple: 113, spotify: 113, page: 113 },
          links: {},
          ranges: [],
        },
      ],
    });
  });

  it("returns fewer neighbours at the start of an episode, and none from another episode", async () => {
    const { body } = await context("?chunk=3009");
    expect(seqs(body)).toEqual([0, 1, 2, 3]);
    expect(ids(body)).toEqual([3009, 3008, 3007, 3006]);
    expect(body.chunks.every((c) => c.text.startsWith("thirty"))).toBe(true);
  });

  it("returns fewer neighbours at the end of an episode, and none from another episode", async () => {
    // 3001 is seq 8, the last.
    const { body } = await context("?chunk=3001");
    expect(seqs(body)).toEqual([5, 6, 7, 8]);
    expect(body.chunks.every((c) => c.text.startsWith("thirty"))).toBe(true);
  });

  it("radius 0 is only the hit", async () => {
    const { body } = await context("?chunk=3005&radius=0");
    expect(ids(body)).toEqual([3005]);
  });

  it("uses a radius of 1 to 6 as given", async () => {
    expect(seqs((await context("?chunk=3005&radius=1")).body)).toEqual([3, 4, 5]);
    expect(seqs((await context("?chunk=3005&radius=2")).body)).toEqual([2, 3, 4, 5, 6]);
  });

  it("clamps a radius above 6 to 6", async () => {
    // From seq 4, six each side would be seq -2..10, so the whole episode.
    expect(seqs((await context("?chunk=3005&radius=7")).body)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // From seq 0 the clamp shows: 6 is seq 0..6, not 0..7.
    expect(seqs((await context("?chunk=3009&radius=7")).body)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seqs((await context("?chunk=3009&radius=99999999999999999999")).body)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("falls back to 3 for a radius that is not a plain non-negative integer", async () => {
    for (const radius of ["abc", "", "-1", "1.5", "2e1", "+2", " 2"]) {
      const { response, body } = await context(`?chunk=3009&radius=${encodeURIComponent(radius)}`);
      expect(response.status, radius).toBe(200);
      expect(seqs(body), radius).toEqual([0, 1, 2, 3]);
    }
  });
});

describe("links and flags", () => {
  it("gives each chunk its own cue_s and links, and the episode the hit's", async () => {
    const { body } = await context("?chunk=3302&radius=1");
    expect(body.episode).toEqual({
      id: 33,
      number: 301,
      title: "Links and Ads",
      date: "2021-01-02",
      // Cue at the hit's start, 100 s: 100 - 7 + offset.
      links: {
        youtube: "https://www.youtube.com/watch?v=yt33&t=103s",
        apple: "https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480?i=ap33&t=113",
        spotify: "https://open.spotify.com/episode/sp33?t=123",
        page: "https://example.com/ep/301",
      },
    });
    expect(body.chunks.map((c) => [c.chunk_id, c.cue_s])).toEqual([
      [3301, { youtube: 43, apple: 53, spotify: 63, page: 33 }], // starts at 40 s
      [3302, { youtube: 103, apple: 113, spotify: 123, page: 93 }],
      [3303, { youtube: 133, apple: 143, spotify: 153, page: 123 }], // starts at 130 s
    ]);
    expect(body.chunks[0]?.links).toEqual({
      youtube: "https://www.youtube.com/watch?v=yt33&t=43s",
      apple: "https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480?i=ap33&t=53",
      spotify: "https://open.spotify.com/episode/sp33?t=63",
      page: "https://example.com/ep/301",
    });
    expect(body.chunks[2]?.links.spotify).toBe("https://open.spotify.com/episode/sp33?t=153");
  });

  it("never cues before 0", async () => {
    // Episode 30's first chunk starts at 0 with no offsets: max(0, 0 - 7).
    const { body } = await context("?chunk=3009&radius=0");
    expect(body.chunks[0]?.cue_s).toEqual({ youtube: 0, apple: 0, spotify: 0, page: 0 });
  });

  it("includes boilerplate chunks and flags them as booleans", async () => {
    const { body } = await context("?chunk=3302");
    expect(body.chunks.map((c) => c.boilerplate)).toEqual([false, false, true]);
  });

  it("serves an episode with no number and no links", async () => {
    const { body } = await context("?chunk=3201&radius=1");
    expect(body.episode).toEqual({ id: 32, number: null, title: "After It", date: "2020-05-11", links: {} });
  });
});

/** The text each chunk marks, by chunk id: ranges sliced out of the returned text. */
function marked(body: ContextBody): Record<number, string[]> {
  return Object.fromEntries(body.chunks.map((c) => [c.chunk_id, c.ranges.map(([s, e]) => c.text.slice(s, e))]));
}

describe("ranges (q)", () => {
  it("marks the query words in the hit and in neighbours that have them, stemmed like search", async () => {
    const { body } = await context("?chunk=3402&q=glue");
    expect(ids(body)).toEqual([3401, 3402, 3403, 3404]);
    expect(marked(body)).toEqual({ 3401: ["gluing", "glue"], 3402: ["glue"], 3403: [], 3404: ["glued"] });
  });

  it("indexes the returned text, also after non-ASCII characters", async () => {
    const { body } = await context("?chunk=3402&radius=0&q=glue");
    const hit = body.chunks[0];
    expect(hit?.text).toBe("the café table is naïve about the glue joint");
    expect(hit?.ranges).toEqual([[36, 40]]);
    // The text the FTS5 highlight marks is the text returned, markers aside.
    const row = await env.DB.prepare(
      `SELECT highlight(chunks_fts, 0, char(1), char(2)) AS marked FROM chunks_fts WHERE chunks_fts MATCH '"glue"' AND rowid = 3402`,
    ).first<{ marked: string }>();
    expect(row?.marked.replace(/[\u0001\u0002]/g, "")).toBe(hit?.text);
  });

  it("drops stopword marks when something else is marked", async () => {
    const { body } = await context("?chunk=3402&radius=0&q=the*%20glue");
    expect(marked(body)).toEqual({ 3402: ["glue"] });
  });

  it("marks the words of a phrase", async () => {
    const { body } = await context('?chunk=3401&radius=0&q=%22hide%20glue%22');
    expect(marked(body)).toEqual({ 3401: ["hide", "glue"] });
  });

  it("ignores exclusions and filters in q", async () => {
    const plain = await context("?chunk=3402&q=glue");
    const { body } = await context(`?chunk=3402&q=${encodeURIComponent("glue -panel year:2015 ep:5 before:2000-01-01")}`);
    expect(body.chunks).toEqual(plain.body.chunks);
    expect(marked(body)[3401]).toEqual(["gluing", "glue"]);
  });

  it("gives [] everywhere, and makes no extra statement, with no q, an empty q, only stopwords or only filters", async () => {
    for (const query of ["", "&q=", "&q=the%20and%20of", "&q=year%3A2015", "&q=-glue", "&q=%20%20"]) {
      const { db, sql } = countingDb(env.DB);
      const response = await worker.fetch(new Request(`https://example.com/api/context?chunk=3402${query}`), { DB: db } as Env);
      const body = (await response.json()) as ContextBody;
      expect(response.status, query).toBe(200);
      expect(body.chunks.map((c) => c.ranges), query).toEqual([[], [], [], []]);
      expect(sql, query).toHaveLength(1);
    }
  });

  it("cuts q at 200 code points, as search does", async () => {
    const long = `${"a ".repeat(100)}glue`;
    expect(long.length).toBeGreaterThan(200);
    const { body } = await context(`?chunk=3402&q=${encodeURIComponent(long)}`);
    expect(body.chunks.map((c) => c.ranges)).toEqual([[], [], [], []]);
    const within = await context(`?chunk=3402&q=${encodeURIComponent(`${"a ".repeat(90)}glue`)}`);
    expect(marked(within.body)[3402]).toEqual(["glue"]);
  });

  it("makes one batch of the select and the highlight, with the terms bound", async () => {
    const { db, sql } = countingDb(env.DB);
    const response = await worker.fetch(new Request("https://example.com/api/context?chunk=3402&q=glue"), { DB: db } as Env);
    expect(response.status).toBe(200);
    expect(sql).toHaveLength(3);
    expect(sql[2]).toBe("<batch>");
    expect(sql.join("\n")).not.toMatch(/glue|3402/);
  });

  it("answers 503 when the batch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = {
      prepare: () => ({ bind: () => ({}) }),
      batch: () => Promise.reject(new Error("D1_ERROR: boom")),
    } as unknown as D1Database;
    const response = await worker.fetch(new Request("https://example.com/api/context?chunk=3402&q=glue"), {
      DB: failingDb,
    } as Env);
    expect(response.status).toBe(503);
  });

  it("is not stopped by FTS5 syntax in q", async () => {
    for (const q of ['"', "glue AND", "glue NEAR(", "col:glue", "(glue", "glue*", "'; DROP"]) {
      const { response } = await context(`?chunk=3402&q=${encodeURIComponent(q)}`);
      expect(response.status, q).toBe(200);
    }
  });
});

describe("bad requests", () => {
  it("answers 400 for a missing or malformed chunk", async () => {
    const chunks = ["", "?chunk=", "?chunk=abc", "?chunk=-5", "?chunk=1.5", "?chunk=12abc", "?chunk=%203005", "?chunk=1e3"];
    for (const query of chunks) {
      const { response, body } = await context(query);
      expect(response.status, query).toBe(400);
      expect(body, query).toEqual({ error: "bad_request" });
    }
  });

  it("answers 400 for a chunk id too big to be an id", async () => {
    const { response, body } = await context("?chunk=99999999999999999999");
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "bad_request" });
  });

  it("answers 404 for a chunk that does not exist", async () => {
    for (const query of ["?chunk=999999", "?chunk=0"]) {
      const { response, body } = await context(query);
      expect(response.status, query).toBe(404);
      expect(body, query).toEqual({ error: "not_found" });
    }
  });

  it("treats leading zeros as the same id", async () => {
    expect((await context("?chunk=003005&radius=0")).body.chunk_id).toBe(3005);
  });

  it("answers 404 to other methods", async () => {
    const response = await exports.default.fetch(new Request("https://example.com/api/context?chunk=3005", { method: "POST" }));
    expect(response.status).toBe(404);
  });
});

describe("D1", () => {
  it("makes one statement, with the values bound and not in the SQL", async () => {
    const { db, sql } = countingDb(env.DB);
    const response = await worker.fetch(new Request("https://example.com/api/context?chunk=3005&radius=2"), {
      DB: db,
    } as Env);
    expect(response.status).toBe(200);
    expect(sql).toHaveLength(1);
    expect(sql[0]).not.toMatch(/3005|\b2\b/);
  });

  it("makes one statement for an unknown chunk too", async () => {
    const { db, sql } = countingDb(env.DB);
    const response = await worker.fetch(new Request("https://example.com/api/context?chunk=999999"), { DB: db } as Env);
    expect(response.status).toBe(404);
    expect(sql).toHaveLength(1);
  });

  it("makes no statement for a bad chunk id", async () => {
    const { db, sql } = countingDb(env.DB);
    const response = await worker.fetch(new Request("https://example.com/api/context?chunk=abc"), { DB: db } as Env);
    expect(response.status).toBe(400);
    expect(sql).toEqual([]);
  });

  it("returns 503 unavailable, with one log line, when D1 fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = {
      prepare() {
        throw new Error("D1_ERROR: network connection lost");
      },
    } as unknown as D1Database;
    const response = await worker.fetch(new Request("https://example.com/api/context?chunk=3005"), {
      DB: failingDb,
    } as Env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(consoleError.mock.calls[0]?.[0])) as Record<string, string>;
    expect(line).toMatchObject({ level: "error", event: "d1_unavailable", method: "GET", path: "/api/context" });
  });

  it("returns 503 when the statement fails on execution", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = {
      prepare() {
        return {
          bind() {
            return { all: () => Promise.reject(new Error("D1_ERROR: boom")) };
          },
        };
      },
    } as unknown as D1Database;
    const response = await worker.fetch(new Request("https://example.com/api/context?chunk=3005"), {
      DB: failingDb,
    } as Env);
    expect(response.status).toBe(503);
  });
});
