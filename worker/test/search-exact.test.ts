import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { SearchResponse } from "../src/search";
import { seed, type SeedChunk, type SeedEpisode } from "./seed";

const JSON_TYPE = "application/json; charset=utf-8";

type Body = SearchResponse & { mode: string; sort: string };

// Five episodes over three years. Episode 12 has every platform id and non-zero offsets; 14 has
// no number. Ids are the test's own, so a clash with seed.ts's defaults would show up as an error.
const EPISODES: SeedEpisode[] = [
  { id: 10, guid: "g10", number: 100, title: "Early Days", published_at: "2014-03-01T08:00:00+00:00", duration_s: 3600 },
  { id: 11, guid: "g11", number: 200, title: "Glue and Blades", published_at: "2019-06-15T08:00:00+00:00", duration_s: 3600 },
  {
    id: 12,
    guid: "g12",
    number: 201,
    title: "Saws and Cues",
    published_at: "2019-09-20T08:00:00+00:00",
    duration_s: 3600,
    page_url: "https://example.com/ep/201",
    youtube_video_id: "yt12",
    apple_episode_id: "ap12",
    spotify_episode_id: "sp12",
    offset_youtube_s: 10,
    offset_apple_s: 20,
    offset_spotify_s: 30,
  },
  { id: 13, guid: "g13", number: 300, title: "Winter Shop", published_at: "2023-01-10T08:00:00+00:00", duration_s: 3600 },
  { id: 14, guid: "g14", number: null, title: "Bonus Episode", published_at: "2023-11-05T08:00:00+00:00", duration_s: 3600 },
];

function chunk(
  id: number,
  episode_id: number,
  seq: number,
  start_ms: number,
  text: string,
  extra: Partial<SeedChunk> = {},
): SeedChunk {
  return { id, episode_id, seq, start_ms, end_ms: start_ms + 30_000, text, ...extra };
}

const CHUNKS: SeedChunk[] = [
  // Episode 10 (2014).
  chunk(1001, 10, 0, 0, "We love a good dovetail joint on every drawer"),
  chunk(1002, 10, 1, 300_000, "Hand cut dovetails look better than machine ones"),
  chunk(1003, 10, 2, 600_000, "We compared hide glue against fish glue on the bench"),
  chunk(1004, 10, 3, 900_000, "Unrelated chatter about the weather and coffee"),
  // Episode 11 (2019).
  chunk(1101, 11, 0, 0, "The chisel was dull so we went to sharpen it on the stones"),
  chunk(1102, 11, 1, 300_000, "Another dovetail jig review and a router bit rant"),
  chunk(1103, 11, 2, 600_000, "Glue up panels with hide glue and plenty of clamps"),
  chunk(1104, 11, 3, 900_000, "The fish tank leaks and I need glue for it"),
  chunk(1105, 11, 4, 1_200_000, "This episode is brought to you by Sponsorly so use code WOOD", { is_boilerplate: true }),
  chunk(1106, 11, 5, 1_600_000, "spokeshave tuning today"),
  // Episode 12 (2019, links and offsets). Ids run against seq, to catch a sort by id alone.
  // 1210: "dovetail" is the 6th word, so hit_ms is start_ms + 5 * 400 (the seeded default).
  chunk(1210, 12, 0, 1_000_000, "So today we talk about dovetail saws and why they matter"),
  // 1209: irregular word times; "dovetail" is the 3rd word, 1000 + 5000 ms after the start.
  chunk(1209, 12, 1, 1_300_000, "The second dovetail mention in this episode comes later", {
    word_times: "0,1000,5000,400,400,400,400,400,400",
  }),
  chunk(1211, 12, 2, 1_600_000, "spokeshave setup guide"),
  // Episode 13 (2023). 1301 says "chisel" four times in a short chunk, 1101 once in a long one.
  chunk(1301, 13, 0, 0, "chisel chisel chisel sharpen the chisel"),
  chunk(1302, 13, 1, 300_000, "Epoxy glue is great for outdoor furniture"),
  chunk(1303, 13, 2, 600_000, "A dovetail is not always the right answer"),
  // Collapsing: the same episode, the first word of each chunk is the hit.
  chunk(1311, 13, 20, 3_000_000, "tenon at the start"),
  chunk(1312, 13, 21, 3_119_000, "tenon again later"), // 119 s after 1311: collapses
  chunk(1313, 13, 22, 4_000_000, "rabbet at the start"),
  chunk(1314, 13, 23, 4_121_000, "rabbet again later"), // 121 s after 1313: kept
  chunk(1315, 13, 24, 5_000_000, "mortise first one"),
  chunk(1316, 13, 25, 5_100_000, "mortise second one"), // 100 s after 1315: collapses
  chunk(1317, 13, 26, 5_200_000, "mortise third one"), // 100 s after 1316 but 200 s after 1315, the kept one: kept
  // Episode 14 (2023, no number).
  chunk(1401, 14, 0, 0, "Last thoughts on dovetails and then router tables"),
  // 25 matches for one word, to page through: 200 s apart, so none of them collapse.
  ...Array.from({ length: 25 }, (_, i) =>
    chunk(2001 + i, 11, 10 + i, i * 200_000, `The bandsaw blade drifts again on cut ${i + 1}`),
  ),
];

beforeAll(async () => {
  await seed(env.DB, EPISODES, CHUNKS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function search(params: Record<string, string>): Promise<{ response: Response; body: Body }> {
  const url = new URL("https://example.com/api/search");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await exports.default.fetch(url.toString());
  return { response, body: (await response.json()) as Body };
}

/** Exact mode, so the assertions are about the keyword results only. */
async function exact(q: string, extra: Record<string, string> = {}): Promise<Body> {
  const { response, body } = await search({ q, mode: "exact", ...extra });
  expect(response.status).toBe(200);
  return body;
}

const ids = (body: SearchResponse): number[] => body.results.map((r) => r.chunk_id);
const sortedIds = (body: SearchResponse): number[] => ids(body).sort((a, b) => a - b);

/** The seeded `dovetail` chunks, in id order. */
const DOVETAIL = [1001, 1002, 1102, 1209, 1210, 1303, 1401];

/** A D1 stand-in that counts what is run against the real test database. */
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

describe("matching", () => {
  it("returns JSON with the result shape from spec §4.4", async () => {
    const { response, body } = await search({ q: "dovetail", mode: "exact" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    const first = body.results.find((r) => r.chunk_id === 1001);
    expect(first).toEqual({
      episode: { id: 10, number: 100, title: "Early Days", date: "2014-03-01", links: {} },
      chunk_id: 1001,
      text: "We love a good dovetail joint on every drawer",
      ranges: [[15, 23]],
      hit_ms: 1600,
      cue_s: { youtube: 0, apple: 0, spotify: 0 },
      match: "keyword",
      more_in_episode: 0,
    });
  });

  it("stems: dovetails finds a chunk that says dovetail, and the reverse", async () => {
    expect(sortedIds(await exact("dovetails"))).toEqual(DOVETAIL);
    expect(sortedIds(await exact("dovetail"))).toEqual(DOVETAIL);
  });

  it("matches a phrase only when the words are adjacent", async () => {
    expect(sortedIds(await exact("fish glue"))).toEqual([1003, 1104]);
    expect(sortedIds(await exact('"fish glue"'))).toEqual([1003]);
  });

  it("excludes a word with a minus sign", async () => {
    expect(sortedIds(await exact("glue -fish"))).toEqual([1103, 1302]);
    expect(sortedIds(await exact('glue -"hide glue"'))).toEqual([1104, 1302]);
  });

  it("matches either side of OR", async () => {
    expect(sortedIds(await exact("chisel OR epoxy"))).toEqual([1101, 1301, 1302]);
  });

  it("matches a prefix with a star, and only with the star", async () => {
    expect(sortedIds(await exact("dovet*"))).toEqual(DOVETAIL);
    expect((await exact("dovet")).total).toBe(0);
  });

  it("puts the matched text in `ranges`, so a slice gives the matched word", async () => {
    const body = await exact("dovetail", { sort: "oldest" });
    const slices = body.results.map((r) => r.ranges.map(([a, b]) => r.text.slice(a, b)));
    expect(slices).toEqual([["dovetail"], ["dovetails"], ["dovetail"], ["dovetail"], ["dovetail"], ["dovetail"], ["dovetails"]]);

    const both = (await exact("chisel OR epoxy")).results.find((r) => r.chunk_id === 1302);
    expect(both?.ranges.map(([a, b]) => both.text.slice(a, b))).toEqual(["Epoxy"]);
  });
});

describe("filters", () => {
  it("year: keeps one year", async () => {
    expect(sortedIds(await exact("dovetail year:2019"))).toEqual([1102, 1209, 1210]);
    expect(sortedIds(await exact("dovetail year:2014"))).toEqual([1001, 1002]);
    expect((await exact("dovetail year:2000")).total).toBe(0);
  });

  it("before: is exclusive", async () => {
    expect(sortedIds(await exact("dovetail before:2019"))).toEqual([1001, 1002]);
    expect(sortedIds(await exact("dovetail before:2023"))).toEqual([1001, 1002, 1102, 1209, 1210]);
  });

  it("after: is exclusive", async () => {
    expect(sortedIds(await exact("dovetail after:2019"))).toEqual([1303, 1401]);
    expect(sortedIds(await exact("dovetail after:2014"))).toEqual([1102, 1209, 1210, 1303, 1401]);
  });

  it("combines after: and before: into a range", async () => {
    expect(sortedIds(await exact("dovetail after:2014 before:2023"))).toEqual([1102, 1209, 1210]);
  });

  it("ep: keeps one episode number", async () => {
    expect(sortedIds(await exact("dovetail ep:200"))).toEqual([1102]);
    expect(sortedIds(await exact("dovetail ep:201"))).toEqual([1209, 1210]);
    expect((await exact("dovetail ep:999")).total).toBe(0);
  });

  it("hides boilerplate unless include:ads", async () => {
    expect((await exact("sponsorly")).total).toBe(0);
    expect(ids(await exact("sponsorly include:ads"))).toEqual([1105]);
    // Ordinary chunks are unaffected.
    expect(sortedIds(await exact("dovetail include:ads"))).toEqual(DOVETAIL);
  });
});

describe("sort", () => {
  it("relevance: a chunk with the word several times ranks above one with it once", async () => {
    // 1101 has the lower id and the older date, so neither tiebreak explains this order.
    expect(ids(await exact("chisel"))).toEqual([1301, 1101]);
    expect(ids(await exact("chisel", { sort: "relevance" }))).toEqual([1301, 1101]);
  });

  it("newest: latest episode first, then position in the episode ascending", async () => {
    // 1210 is seq 0 and 1209 is seq 1 of the same episode, with the ids the other way round.
    expect(ids(await exact("dovetail", { sort: "newest" }))).toEqual([1401, 1303, 1210, 1209, 1102, 1001, 1002]);
  });

  it("oldest: earliest episode first, then position in the episode ascending", async () => {
    expect(ids(await exact("dovetail", { sort: "oldest" }))).toEqual([1001, 1002, 1102, 1210, 1209, 1303, 1401]);
  });
});

describe("total and paging", () => {
  it("reports total and has_more for a single page", async () => {
    const body = await exact("dovetail");
    expect(body.total).toBe(7);
    expect(body.page).toBe(1);
    expect(body.has_more).toBe(false);
    expect(body.results).toHaveLength(7);
  });

  it("pages by 20: page 2 continues page 1 with no overlap", async () => {
    const one = await exact("bandsaw");
    const two = await exact("bandsaw", { page: "2" });
    expect(one.total).toBe(25);
    expect(one.page).toBe(1);
    expect(one.results).toHaveLength(20);
    expect(one.has_more).toBe(true);
    expect(two.total).toBe(25);
    expect(two.page).toBe(2);
    expect(two.results).toHaveLength(5);
    expect(two.has_more).toBe(false);

    const all = [...ids(one), ...ids(two)];
    expect(new Set(all).size).toBe(25);
    // Equal scores fall back to the chunk id, so even relevance order is stable.
    expect(all).toEqual(Array.from({ length: 25 }, (_, i) => 2001 + i));
  });

  it("pages stably in date order too", async () => {
    const one = await exact("bandsaw", { sort: "newest" });
    const two = await exact("bandsaw", { sort: "newest", page: "2" });
    // One episode, so position in the episode (seq) is the order.
    expect([...ids(one), ...ids(two)]).toEqual(Array.from({ length: 25 }, (_, i) => 2001 + i));
  });

  it("returns an empty page, with the right total, past the end", async () => {
    const body = await exact("bandsaw", { page: "3" });
    expect(body).toMatchObject({ total: 25, page: 3, results: [], has_more: false });
  });
});

describe("collapsing (per page)", () => {
  it("merges hits less than 120 s apart in one episode and counts them", async () => {
    // Oldest first, so the earlier chunk is the one kept (relevance would favour the shorter text).
    const body = await exact("tenon", { sort: "oldest" });
    expect(body.total).toBe(2);
    expect(body.results.map((r) => [r.chunk_id, r.more_in_episode])).toEqual([[1311, 1]]);
  });

  it("keeps hits 121 s apart", async () => {
    const body = await exact("rabbet", { sort: "oldest" });
    expect(body.total).toBe(2);
    expect(body.results.map((r) => [r.chunk_id, r.more_in_episode, r.hit_ms])).toEqual([
      [1313, 0, 4_000_000],
      [1314, 0, 4_121_000],
    ]);
  });

  it("compares with kept results only, not with dropped ones", async () => {
    const body = await exact("mortise", { sort: "oldest" });
    expect(body.total).toBe(3);
    expect(body.results.map((r) => [r.chunk_id, r.more_in_episode])).toEqual([
      [1315, 1],
      [1317, 0],
    ]);
  });

  it("never collapses hits in different episodes, even at the same time", async () => {
    const body = await exact("spokeshave", { sort: "oldest" });
    expect(body.results.map((r) => [r.episode.id, r.hit_ms, r.more_in_episode])).toEqual([
      [11, 1_600_000, 0],
      [12, 1_600_000, 0],
    ]);
  });

  it("always has more_in_episode", async () => {
    const body = await exact("dovetail");
    expect(body.results.every((r) => r.more_in_episode === 0)).toBe(true);
  });
});

describe("hit time and links", () => {
  it("hit_ms is the highlighted word's time", async () => {
    const body = await exact("dovetail ep:201", { sort: "oldest" });
    // 1210: 6th word of a chunk starting at 1_000_000, 400 ms per word.
    // 1209: word times "0,1000,5000": the 3rd word is 6000 ms after the start.
    expect(body.results.map((r) => [r.chunk_id, r.hit_ms])).toEqual([
      [1210, 1_002_000],
      [1209, 1_306_000],
    ]);
  });

  it("cue_s and links use the episode's offsets and ids", async () => {
    const body = await exact("dovetail ep:201", { sort: "oldest" });
    const first = body.results[0];
    // floor(1002 s) - 7 = 995, plus each platform's offset.
    expect(first?.cue_s).toEqual({ youtube: 1005, apple: 1015, spotify: 1025 });
    expect(first?.episode).toEqual({
      id: 12,
      number: 201,
      title: "Saws and Cues",
      date: "2019-09-20",
      links: {
        youtube: "https://www.youtube.com/watch?v=yt12&t=1005s",
        apple: "https://podcasts.apple.com/podcast/id251471480?i=ap12",
        spotify: "https://open.spotify.com/episode/sp12?t=1025",
        page: "https://example.com/ep/201",
      },
    });
    // floor(1306 s) - 7 = 1299.
    expect(body.results[1]?.cue_s).toEqual({ youtube: 1309, apple: 1319, spotify: 1329 });
    expect(body.results[1]?.episode.links.youtube).toBe("https://www.youtube.com/watch?v=yt12&t=1309s");
  });

  it("allows a null episode number", async () => {
    const body = await exact("dovetails year:2023");
    expect(body.results.find((r) => r.chunk_id === 1401)?.episode.number).toBeNull();
  });
});

describe("queries with nothing to match", () => {
  it("returns no results for only an exclusion, only filters, or nothing", async () => {
    for (const q of ["-fish", "year:2019", "ep:200 include:ads", "", "   ", '""', "***"]) {
      const body = await exact(q);
      expect(body, q).toMatchObject({ total: 0, page: 1, results: [], has_more: false });
    }
    const { response, body } = await search({ mode: "exact" });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ total: 0, results: [] });
  });

  it("makes no D1 call for them", async () => {
    const { db, sql } = countingDb(env.DB);
    const response = await worker.fetch(new Request("https://example.com/api/search?q=-fish"), { DB: db } as Env);
    expect(response.status).toBe(200);
    expect(sql).toEqual([]);
  });
});

describe("hostile input", () => {
  it("answers 200 for syntax that FTS5 would reject", async () => {
    const queries = [
      "text:foo",
      "NEAR(a b)",
      '"unbalanced',
      "a".repeat(500),
      "foo AND",
      "OR OR OR",
      "(((",
      "*",
      "-",
      "a' OR 1=1 --",
      "\u0000dovetail\u0001",
      "dovetail \ud800",
    ];
    for (const q of queries) {
      const { response } = await search({ q, mode: "exact" });
      expect(response.status, q).toBe(200);
    }
  });

  it("treats a column filter as plain words", async () => {
    expect((await exact("text:dovetail")).total).toBe(0);
  });

  it("does not take filter values from outside the query syntax", async () => {
    const body = await exact("dovetail", { year: "2019", before: "2000", ep: "200" });
    expect(body.total).toBe(7);
  });
});

describe("parameters", () => {
  it("falls back to relevance for an unknown sort, and echoes mode and sort", async () => {
    const bad = await exact("chisel", { sort: "popular" });
    expect(bad.sort).toBe("relevance");
    expect(ids(bad)).toEqual([1301, 1101]);
    expect(bad.mode).toBe("exact");
    expect((await exact("chisel", { sort: "newest" })).sort).toBe("newest");
    expect((await exact("chisel", { sort: "oldest" })).sort).toBe("oldest");
    expect((await exact("chisel", { sort: "RELEVANCE" })).sort).toBe("relevance");
  });

  it("treats a missing, non-numeric or too small page as page 1", async () => {
    for (const page of ["0", "abc", "-3", "", "1.5", "2e1"]) {
      const body = await exact("bandsaw", { page });
      expect(body.page, page).toBe(1);
      expect(body.results, page).toHaveLength(20);
    }
    expect((await exact("bandsaw")).page).toBe(1);
  });

  it("clamps a huge page to 10", async () => {
    for (const page of ["10", "11", "99999999999999999999"]) {
      const body = await exact("bandsaw", { page });
      expect(body, page).toMatchObject({ total: 25, page: 10, results: [], has_more: false });
    }
  });

  it("treats any mode but exact as smart", async () => {
    const { body } = await search({ q: "chisel", mode: "bogus" });
    expect(body.mode).toBe("smart");
  });
});

describe("smart mode (until Task 14)", () => {
  it("returns the exact results with smart_degraded, whether mode is smart or missing", async () => {
    const exactBody = await exact("dovetail", { sort: "newest" });
    expect(exactBody).not.toHaveProperty("smart_degraded");
    expect(exactBody.mode).toBe("exact");

    const variants: Record<string, string>[] = [
      { q: "dovetail", sort: "newest" },
      { q: "dovetail", sort: "newest", mode: "smart" },
    ];
    for (const params of variants) {
      const { response, body } = await search(params);
      expect(response.status).toBe(200);
      expect(body.mode).toBe("smart");
      expect(body.smart_degraded).toBe(true);
      const { smart_degraded: _flag, mode: _mode, ...rest } = body;
      const { mode: _exactMode, ...exactRest } = exactBody;
      expect(rest).toEqual(exactRest);
    }
  });
});

describe("D1 use", () => {
  it("runs exactly one batch of two statements per request", async () => {
    const { db, sql } = countingDb(env.DB);
    const response = await worker.fetch(new Request("https://example.com/api/search?q=dovetail&mode=exact"), {
      DB: db,
    } as Env);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Body).total).toBe(7);
    // Two prepared statements (count, page), then the single batch that runs them.
    expect(sql).toHaveLength(3);
    expect(sql[0]).toMatch(/count\(\*\)/);
    expect(sql[1]).toMatch(/highlight\(chunks_fts/);
    expect(sql[2]).toBe("<batch>");
  });

  it("never puts user text in the SQL", async () => {
    const { db, sql } = countingDb(env.DB);
    await worker.fetch(
      new Request("https://example.com/api/search?q=" + encodeURIComponent("zzmarker year:2019 ep:77 before:2001")),
      { DB: db } as Env,
    );
    for (const statement of sql) expect(statement).not.toMatch(/zzmarker|2019|77|2001/);
  });

  it("returns 503 unavailable, with one log line, when D1 fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
        };
      },
      batch: () => Promise.reject(new Error("D1_ERROR: database unavailable")),
    };
    const response = await worker.fetch(new Request("https://example.com/api/search?q=secret-query"), {
      DB: failingDb,
    } as unknown as Env);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = String(consoleError.mock.calls[0]?.[0]);
    expect(line).toContain("d1_unavailable");
    expect(line).not.toContain("secret-query");
  });
});
