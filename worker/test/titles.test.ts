// Title hits (spec §4.4): the episodes whose title matches the query, from episodes_fts
// (schema/0003_title_search.sql), and `episodes` in the search answer.
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { parseQuery } from "../src/query";
import { MAX_TITLE_HITS, titleHits, type EpisodeHit } from "../src/titles";
import { seed, type SeedChunk, type SeedEpisode } from "./seed";

// Episode 43 is the one the feature was made for: "Kregger" is in its title and not in its
// transcript. 44 has every platform id and offsets. 45 has no number. 50 to 56 share a title
// word, to show the limit and the order.
const EPISODES: SeedEpisode[] = [
  { id: 41, guid: "t41", number: 611, title: "Bench Dogs and Holdfasts", published_at: "2026-08-05T08:00:00+00:00", duration_s: 3600 },
  { id: 42, guid: "t42", number: 612, title: "A Workbench for Every Shop", published_at: "2026-08-12T08:00:00+00:00", duration_s: 3600 },
  { id: 43, guid: "t43", number: 613, title: "Shove a Kregger in the Hole", published_at: "2026-08-19T08:00:00+00:00", duration_s: 3600 },
  {
    id: 44,
    guid: "t44",
    number: 301,
    title: "Hide Glue Holiday",
    published_at: "2019-12-20T08:00:00+00:00",
    duration_s: 3600,
    page_url: "https://shows.acast.com/woodtalk/episodes/hide-glue-holiday",
    youtube_video_id: "yt44",
    apple_episode_id: "ap44",
    spotify_episode_id: "sp44",
    offset_youtube_s: 10,
    offset_apple_s: 20,
    offset_spotify_s: 30,
  },
  { id: 45, guid: "t45", number: null, title: "Bonus: Glue Questions", published_at: "2021-03-03T08:00:00+00:00", duration_s: 3600 },
  ...Array.from({ length: 7 }, (_, i): SeedEpisode => ({
    id: 50 + i,
    guid: `t${50 + i}`,
    number: 400 + i,
    title: `Sharpening Part ${i + 1}`,
    published_at: `201${i}-05-01T08:00:00+00:00`,
    duration_s: 3600,
  })),
];

const CHUNKS: SeedChunk[] = [
  { id: 4301, episode_id: 43, seq: 0, start_ms: 0, end_ms: 30_000, text: "You shove a Craig-er in there and call it a pocket hole" },
  { id: 4401, episode_id: 44, seq: 0, start_ms: 0, end_ms: 30_000, text: "Hide glue stays open longer in a warm shop" },
  { id: 4201, episode_id: 42, seq: 0, start_ms: 0, end_ms: 30_000, text: "Every shop needs a bench and some glue" },
];

beforeAll(async () => {
  await seed(env.DB, EPISODES, CHUNKS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const hits = (q: string) => titleHits(env.DB, parseQuery(q));
const numbers = async (q: string) => (await hits(q)).map((e) => e.number);

describe("titleHits", () => {
  it("finds an episode by a word that is only in its title", async () => {
    expect(await hits("kregger")).toEqual([
      {
        id: 43,
        number: 613,
        title: "Shove a Kregger in the Hole",
        date: "2026-08-19",
        links: { page: "https://shows.acast.com/woodtalk/episodes/t43?seek=0" },
      },
    ]);
  });

  it("stems like the transcripts do, in both directions", async () => {
    expect(await numbers("kreggers")).toEqual([613]);
    expect(await numbers("workbenches")).toEqual([612]);
    expect(await numbers("sharpen")).toHaveLength(MAX_TITLE_HITS);
  });

  it("needs all the words, in any order", async () => {
    expect(await numbers("hole kregger")).toEqual([613]);
    expect(await numbers("kregger glue")).toEqual([]);
  });

  it("takes a phrase, OR and an exclusion", async () => {
    expect(await numbers('"hide glue"')).toEqual([301]);
    expect(await numbers('"glue hide"')).toEqual([]);
    expect((await numbers("kregger OR holdfasts")).sort()).toEqual([611, 613]);
    expect(await numbers("glue -hide")).toEqual([null]);
  });

  it("applies the year and ep: filters", async () => {
    expect(await numbers("glue year:2019")).toEqual([301]);
    expect(await numbers("glue after:2019")).toEqual([null]);
    expect(await numbers("glue before:2020")).toEqual([301]);
    expect(await numbers("sharpening ep:403")).toEqual([403]);
    expect(await numbers("kregger year:2019")).toEqual([]);
  });

  it(`lists at most ${MAX_TITLE_HITS}, the newest first among equal matches`, async () => {
    // Seven "Sharpening Part N" titles match alike; 406 is from 2016, 400 from 2010.
    expect(await numbers("sharpening")).toEqual([406, 405, 404, 403, 402]);
  });

  it("links to the episode's start: each platform's offset, no lead-in", async () => {
    const [hit] = await hits("holiday");
    expect(hit?.links).toEqual({
      youtube: "https://www.youtube.com/watch?v=yt44&t=10s",
      apple: "https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480?i=ap44&t=20",
      spotify: "https://open.spotify.com/episode/sp44?t=30",
      // Under the guid, not the feed's slug; that link is the Acast page, so there are no notes.
      page: "https://shows.acast.com/woodtalk/episodes/t44?seek=0",
    });
  });

  it("makes no statement for a query with nothing to match", async () => {
    const prepare = vi.spyOn(env.DB, "prepare");
    for (const q of ["", "year:2019", "-glue", "ep:613"]) expect(await hits(q)).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("follows a title changed the way wts publish writes it: the new words match, the old do not", async () => {
    await env.DB.prepare(
      `INSERT INTO episodes (id, guid, number, title, published_at, year, duration_s)
       VALUES (41, 't41', 611, 'Planing Stops Revisited', '2026-08-05T08:00:00+00:00', 2026, 3600)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title`,
    ).run();
    expect(await numbers("planing")).toEqual([611]);
    expect(await numbers("holdfasts")).toEqual([]);
    expect(await numbers("dogs")).toEqual([]);
  });

  it("forgets a deleted episode", async () => {
    await env.DB.prepare(
      `INSERT INTO episodes (id, guid, number, title, published_at, year, duration_s)
       VALUES (49, 't49', 699, 'Marquetry Madness', '2026-09-01T08:00:00+00:00', 2026, 3600)`,
    ).run();
    expect(await numbers("marquetry")).toEqual([699]);
    await env.DB.prepare("DELETE FROM episodes WHERE id = 49").run();
    expect(await numbers("marquetry")).toEqual([]);
  });
});

interface Body {
  mode: string;
  results: { chunk_id: number }[];
  episodes: EpisodeHit[];
  total?: number;
}

async function search(params: Record<string, string>, e?: Env): Promise<{ response: Response; body: Body }> {
  const url = new URL("https://example.com/api/search");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = e ? await worker.fetch(new Request(url.toString()), e) : await exports.default.fetch(url.toString());
  return { response, body: (await response.json()) as Body };
}

describe("episodes in the search answer", () => {
  it("is there in exact mode, beside no passages: the total counts passages only", async () => {
    const { body } = await search({ q: "kregger", mode: "exact" });
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.episodes.map((e) => e.number)).toEqual([613]);
  });

  it("is there beside passages, and does not change them", async () => {
    const { body } = await search({ q: "glue", mode: "exact" });
    expect(body.results.map((r) => r.chunk_id).sort()).toEqual([4201, 4401]);
    expect(body.total).toBe(2);
    expect(body.episodes.map((e) => e.number).sort()).toEqual([301, null]);
  });

  it("is there in smart mode", async () => {
    const { body } = await search({ q: "kregger", mode: "smart" });
    expect(body.mode).toBe("smart");
    expect(body.episodes.map((e) => e.number)).toEqual([613]);
  });

  it("is [] after page 1, and for a query with no words", async () => {
    expect((await search({ q: "glue", mode: "exact", page: "2" })).body.episodes).toEqual([]);
    expect((await search({ q: "year:2019", mode: "exact" })).body.episodes).toEqual([]);
  });

  it("is [] with a logged error, and the search still answers, when the title query fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // A database from before migration 0003: any statement on episodes_fts fails.
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop, target) as unknown;
        return (sql: string) => {
          if (sql.includes("episodes_fts")) throw new Error("D1_ERROR: no such table: episodes_fts");
          return target.prepare(sql);
        };
      },
    });
    const { response, body } = await search({ q: "glue", mode: "exact" }, { ...env, DB: db } as Env);
    expect(response.status).toBe(200);
    expect(body.episodes).toEqual([]);
    expect(body.results.map((r) => r.chunk_id).sort()).toEqual([4201, 4401]);
    const events = consoleError.mock.calls.map((call) => (JSON.parse(String(call[0])) as { event: string }).event);
    expect(events).toEqual(["titles_unavailable"]);
  });
});
