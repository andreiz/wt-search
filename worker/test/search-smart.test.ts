import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { EMBEDDING_MODEL, type SmartResponse, vectorFilter } from "../src/search";
import { seed, type SeedChunk, type SeedEpisode } from "./seed";

// Smart search (spec §4.4): the FTS5 top 50 and the Vectorize top 50, fused by RRF. Workers AI
// and Vectorize are fakes handed to worker.fetch() in the env (the unit style of Cloudflare's
// ai-vectorize recipe): the fake Vectorize returns whichever chunk ids a test names, so the
// tests choose the meaning-based hits and check what the Worker does with them.

type Body = SmartResponse & { mode: string; sort: string };

const EPISODES: SeedEpisode[] = [
  { id: 30, guid: "g30", number: 100, title: "Old Shop", published_at: "2014-03-01T08:00:00+00:00", duration_s: 3600 },
  { id: 31, guid: "g31", number: 200, title: "Joinery", published_at: "2019-06-15T08:00:00+00:00", duration_s: 3600 },
  {
    id: 32,
    guid: "g32",
    number: 300,
    title: "New Shop",
    published_at: "2023-01-10T08:00:00+00:00",
    duration_s: 3600,
    youtube_video_id: "yt32",
    offset_youtube_s: 10,
  },
  // For the caps: 50 short "veneer" chunks in 2015, one long one in 2024, 50 meaning-only ones.
  { id: 40, guid: "g40", number: 400, title: "Veneer Day", published_at: "2015-05-05T08:00:00+00:00", duration_s: 3600 },
  { id: 41, guid: "g41", number: 401, title: "Veneer Again", published_at: "2024-05-05T08:00:00+00:00", duration_s: 3600 },
  { id: 42, guid: "g42", number: 402, title: "Filler", published_at: "2016-05-05T08:00:00+00:00", duration_s: 3600 },
];

function chunk(id: number, episode_id: number, seq: number, start_ms: number, text: string, extra: Partial<SeedChunk> = {}): SeedChunk {
  return { id, episode_id, seq, start_ms, end_ms: start_ms + 30_000, text, ...extra };
}

const CHUNKS: SeedChunk[] = [
  // The three "dovetail" keyword hits, one per episode.
  chunk(3001, 30, 0, 0, "dovetail dovetail on the drawer"),
  chunk(3101, 31, 0, 0, "we cut a dovetail by hand today with a saw and a chisel"),
  chunk(3201, 32, 0, 0, "a long story that eventually mentions one dovetail near the very end of a long chunk of talk"),
  // Hits only meaning-based search finds (no "dovetail"). 3203 is 60 s after 3201.
  chunk(3002, 30, 1, 600_000, "hand cut joinery for drawer boxes"),
  chunk(3102, 31, 1, 600_000, "a router jig makes the pins and tails"),
  chunk(3203, 32, 1, 60_000, "half blind joints for drawers"),
  chunk(3202, 32, 2, 600_000, "biscuit joints are quick"),
  chunk(3103, 31, 2, 1_200_000, "this joinery segment is brought to you by a sponsor", { is_boilerplate: true }),
  chunk(3003, 30, 3, 1_800_000, "then I spray lacquer on the cabinet doors"),
  // Caps. 4000..4049 tie on bm25 (same length), so they rank by id; 4100 is long and ranks last.
  ...Array.from({ length: 50 }, (_, i) => chunk(4000 + i, 40, i, i * 200_000, `veneer take ${i}`)),
  chunk(4100, 41, 0, 0, "and after a very long ramble about many other things we finally glue some veneer down"),
  ...Array.from({ length: 50 }, (_, i) => chunk(4200 + i, 42, i, i * 200_000, `filler talk ${i}`)),
];

const VECTOR = Array.from({ length: 768 }, (_, i) => (i % 7) / 7);

function fakeAi(output: unknown = { shape: [1, VECTOR.length], data: [VECTOR], pooling: "cls" }) {
  return { run: vi.fn(async (_model: string, _inputs: unknown) => output) };
}

/** A Vectorize index that returns `ids`, best first, whatever the query and filter. */
function fakeVec(ids: (number | string)[]) {
  return {
    query: vi.fn(async (_vector: number[], _options: unknown) => ({
      count: ids.length,
      matches: ids.map((id, i) => ({ id: String(id), score: 0.9 - i / 1000 })),
    })),
  };
}

function url(params: Record<string, string>): string {
  const u = new URL("https://example.com/api/search");
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
  return u.toString();
}

async function smart(
  params: Record<string, string>,
  bindings: { ai?: unknown; vec?: unknown; db?: D1Database } = {},
): Promise<{ response: Response; body: Body }> {
  const response = await worker.fetch(new Request(url({ mode: "smart", ...params })), {
    DB: bindings.db ?? env.DB,
    AI: bindings.ai ?? fakeAi(),
    VEC: bindings.vec ?? fakeVec([]),
  } as unknown as Env);
  return { response, body: (await response.json()) as Body };
}

/** Smart search that must succeed; only the body. */
async function body(params: Record<string, string>, vecIds: (number | string)[] = []): Promise<Body> {
  const { response, body } = await smart(params, { vec: fakeVec(vecIds) });
  expect(response.status).toBe(200);
  expect(body).not.toHaveProperty("smart_degraded");
  return body;
}

/** The keyword ranking of `q`, from exact mode (bm25, then id). */
async function keywordOrder(q: string): Promise<number[]> {
  const res = await exports.default.fetch(url({ q, mode: "exact" }));
  return ((await res.json()) as Body).results.map((r) => r.chunk_id);
}

const ids = (b: Body): number[] => b.results.map((r) => r.chunk_id);
const tagged = (b: Body): [number, string][] => b.results.map((r) => [r.chunk_id, r.match]);

beforeAll(async () => {
  await seed(env.DB, EPISODES, CHUNKS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fusion", () => {
  it("merges the keyword and meaning-based lists by RRF, tagging meaning-only hits related", async () => {
    const k = await keywordOrder("dovetail");
    expect([...k].sort()).toEqual([3001, 3101, 3201]);
    // Meaning: 3002, k[2], 3102. Scores: k[2] 1/63 + 1/62; k[0] 1/61; 3002 1/61 (ties k[0],
    // which the keyword list put first); k[1] 1/62; 3102 1/63.
    const b = await body({ q: "dovetail" }, [3002, k[2]!, 3102]);
    expect(tagged(b)).toEqual([
      [k[2], "keyword"],
      [k[0], "keyword"],
      [3002, "related"],
      [k[1], "keyword"],
      [3102, "related"],
    ]);
  });

  it("answers with the smart response shape: no total, no caps flags", async () => {
    const b = await body({ q: "dovetail" }, [3002]);
    expect(Object.keys(b).sort()).toEqual(["has_more", "limit", "mode", "page", "results", "sort"]);
    expect(b).toMatchObject({ mode: "smart", sort: "relevance", page: 1, limit: 20, has_more: false });
  });

  it("is the default mode", async () => {
    const ai = fakeAi();
    const response = await worker.fetch(new Request(url({ q: "dovetail" })), {
      DB: env.DB,
      AI: ai,
      VEC: fakeVec([3002]),
    } as unknown as Env);
    const b = (await response.json()) as Body;
    expect(b.mode).toBe("smart");
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(tagged(b)).toContainEqual([3002, "related"]);
  });
});

describe("Workers AI and Vectorize calls", () => {
  it("embeds the query's positive words with pooling cls, and asks Vectorize for the top 50", async () => {
    const ai = fakeAi();
    const vec = fakeVec([]);
    await smart({ q: '"hand cut" dovetail -biscuit ep:200 include:ads' }, { ai, vec });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run).toHaveBeenCalledWith(EMBEDDING_MODEL, { text: ["hand cut dovetail"], pooling: "cls" });
    expect(EMBEDDING_MODEL).toBe("@cf/baai/bge-base-en-v1.5");
    expect(vec.query).toHaveBeenCalledTimes(1);
    expect(vec.query).toHaveBeenCalledWith(VECTOR, { topK: 50, returnValues: false, returnMetadata: "none" });
  });

  it("passes the year filters to Vectorize", async () => {
    const cases: [string, unknown][] = [
      ["dovetail year:2019", { year: { $eq: 2019 } }],
      ["dovetail before:2020", { year: { $lt: 2020 } }],
      ["dovetail after:2015", { year: { $gt: 2015 } }],
      ["dovetail after:2015 before:2020", { year: { $lt: 2020, $gt: 2015 } }],
      // A range is inclusive: 2011-2012 is after 2010, before 2013. A single year is $eq.
      ["dovetail year:2011-2012", { year: { $gt: 2010, $lt: 2013 } }],
      ["dovetail year:2012–2011", { year: { $gt: 2010, $lt: 2013 } }],
      ["dovetail year:2012-2012", { year: { $eq: 2012 } }],
      ["dovetail year:2010-2012 after:2011", { year: { $gt: 2011, $lt: 2013 } }],
    ];
    for (const [q, filter] of cases) {
      const vec = fakeVec([]);
      await smart({ q }, { vec });
      expect(vec.query, q).toHaveBeenCalledWith(VECTOR, {
        topK: 50,
        returnValues: false,
        returnMetadata: "none",
        filter,
      });
    }
  });

  it("sends only $eq with year:, since Vectorize can't combine it with a range", () => {
    expect(vectorFilter({ year: 2019, before: 2018, after: 2010 })).toEqual({ year: { $eq: 2019 } });
    expect(vectorFilter({ ep: 200 })).toBeUndefined();
    expect(vectorFilter({})).toBeUndefined();
  });

  it("calls neither when there is nothing to match", async () => {
    for (const q of ["", "-dovetail", "year:2019", "  "]) {
      const ai = fakeAi();
      const vec = fakeVec([3002]);
      const { response, body: b } = await smart({ q }, { ai, vec });
      expect(response.status, q).toBe(200);
      expect(b, q).toMatchObject({ results: [], has_more: false, page: 1 });
      expect(b, q).not.toHaveProperty("smart_degraded");
      expect(ai.run, q).not.toHaveBeenCalled();
      expect(vec.query, q).not.toHaveBeenCalled();
    }
  });
});

describe("meaning-only hits", () => {
  it("highlight the query words they contain, and cue at the chunk's start", async () => {
    // No chunk has both words, so there is no keyword hit; 3102 says "jig".
    const b = await body({ q: "dovetail jig" }, [3102]);
    expect(b.results).toHaveLength(1);
    const r = b.results[0]!;
    expect(r).toMatchObject({ chunk_id: 3102, match: "related", text: "a router jig makes the pins and tails" });
    expect(r.ranges.map(([s, e]) => r.text.slice(s, e))).toEqual(["jig"]);
    expect(r.hit_ms).toBe(600_000);
    expect(r.cue_s).toEqual({ youtube: 593, apple: 593, spotify: 593 });
  });

  it("highlight stemmed words, phrase words and prefixes too", async () => {
    const b = await body({ q: '"pins and tails" joint* drawer' }, [3102, 3203]);
    const marked = Object.fromEntries(b.results.map((r) => [r.chunk_id, r.ranges.map(([s, e]) => r.text.slice(s, e))]));
    // Word by word, leaving out the stopword "and".
    expect(marked[3102]).toEqual(["pins", "tails"]);
    expect(marked[3203]).toEqual(["joints", "drawers"]);
  });

  it("highlight each word of a quoted phrase, wherever it appears", async () => {
    // Nobody says "lacquer spray", so the phrase has no keyword hit; the meaning hit says
    // "spray lacquer" and shows both words.
    const b = await body({ q: '"lacquer spray"' }, [3003]);
    expect(tagged(b)).toEqual([[3003, "related"]]);
    const r = b.results[0]!;
    expect(r.ranges.map(([s, e]) => r.text.slice(s, e))).toEqual(["spray", "lacquer"]);
    expect(r.hit_ms).toBe(1_800_000);
  });

  it("don't highlight stopwords", async () => {
    // "I" and "the" are in both the query and the chunk; only the shop words are marked.
    const b = await body({ q: "how do I spray the lacquer" }, [3003]);
    const r = b.results[0]!;
    expect(r).toMatchObject({ chunk_id: 3003, match: "related" });
    expect(r.ranges.map(([s, e]) => r.text.slice(s, e))).toEqual(["spray", "lacquer"]);
  });

  it("have no ranges when no query word appears, and carry the episode's links", async () => {
    const related = (await body({ q: "zzunmatched" }, [3202])).results;
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({ chunk_id: 3202, match: "related", ranges: [], hit_ms: 600_000 });
    expect(related[0]!.episode.links).toEqual({ youtube: "https://www.youtube.com/watch?v=yt32&t=603s" });
  });

  it("are dropped when they contain an excluded word", async () => {
    // 3202 says "biscuit joints", 3203 "joints": the keyword list has 3203 only.
    const b = await body({ q: "joints -biscuit" }, [3202, 3002]);
    expect(tagged(b)).toEqual([
      [3203, "keyword"],
      [3002, "related"],
    ]);
  });

  it("are dropped when outside the episode and year filters, even if Vectorize let them through", async () => {
    expect(tagged(await body({ q: "dovetail ep:200" }, [3002, 3102]))).toEqual([
      [3101, "keyword"],
      [3102, "related"],
    ]);
    expect(tagged(await body({ q: "dovetail year:2019" }, [3002, 3102]))).toEqual([
      [3101, "keyword"],
      [3102, "related"],
    ]);
    expect(ids(await body({ q: "dovetail after:2019" }, [3002, 3102]))).toEqual([3201]);
  });

  it("are dropped when they are boilerplate, unless include:ads", async () => {
    expect(ids(await body({ q: "zzunmatched" }, [3103]))).toEqual([]);
    expect(ids(await body({ q: "zzunmatched include:ads" }, [3103]))).toEqual([3103]);
  });

  it("are dropped when the chunk no longer exists or the id is not a chunk id", async () => {
    const b = await body({ q: "zzunmatched" }, [999_999, "abc", "", "3002.5", 3002]);
    expect(tagged(b)).toEqual([[3002, "related"]]);
  });

  it("count only up to Vectorize's top 50", async () => {
    const past = [...Array.from({ length: 50 }, (_, i) => 900_000 + i), 3002];
    expect(ids(await body({ q: "zzunmatched" }, past))).toEqual([]);
  });
});

describe("collapsing", () => {
  it("folds a nearby hit into the better-ranked one, keyword or related", async () => {
    // 3203 (related) starts 60 s into episode 32; 3201's "dovetail" is 2.8 s in (8th word).
    const b = await body({ q: "dovetail" }, [3203]);
    const inEpisode = b.results.filter((r) => r.episode.id === 32);
    expect(inEpisode).toHaveLength(1);
    expect(inEpisode[0]!.more_in_episode).toBe(1);
    // 3203 scores 1/61; 3201 is the keyword list's last (1/63), so 3203 is kept.
    expect(await keywordOrder("dovetail")).toEqual([3001, 3101, 3201]);
    expect(ids(b)).toEqual([3001, 3203, 3101]);
    expect(inEpisode[0]!.chunk_id).toBe(3203);
  });

  it("lists the folded chunk ids on every result, with or without debug", async () => {
    for (const debug of [undefined, "1"]) {
      const b = await body({ q: "dovetail", ...(debug ? { debug } : {}) }, [3203]);
      expect(b.results.map((r) => [r.chunk_id, r.folded]), String(debug)).toEqual([
        [3001, []],
        [3203, [3201]],
        [3101, []],
      ]);
      for (const r of b.results) expect(r.folded).toHaveLength(r.more_in_episode);
    }
  });

  it("has folded on degraded results too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const vec = { query: vi.fn(async () => Promise.reject(new Error("VECTOR_QUERY_ERROR"))) };
    const { body: b } = await smart({ q: "dovetail" }, { vec });
    expect(b.smart_degraded).toBe("unavailable");
    expect(b.results.length).toBeGreaterThan(0);
    for (const r of b.results) expect(r.folded).toHaveLength(r.more_in_episode);
  });
});

describe("date sorts", () => {
  it("re-sort the fused hits by episode date, hits in episode order", async () => {
    const vec = [3002, 3102];
    expect(ids(await body({ q: "dovetail", sort: "newest" }, vec))).toEqual([3201, 3101, 3102, 3001, 3002]);
    expect(ids(await body({ q: "dovetail", sort: "oldest" }, vec))).toEqual([3001, 3002, 3101, 3102, 3201]);
    expect((await body({ q: "dovetail", sort: "newest" }, vec)).sort).toBe("newest");
  });

  it("sort only the best hits, not every match", async () => {
    // 51 chunks say "veneer"; the newest (4100, 2024) is the worst by bm25, so not in the top 50.
    const exactNewest = await exports.default.fetch(url({ q: "veneer", mode: "exact", sort: "newest" }));
    expect(((await exactNewest.json()) as Body).results[0]!.chunk_id).toBe(4100);
    const all: number[] = [];
    for (const page of ["1", "2", "3"]) {
      all.push(...ids(await body({ q: "veneer", sort: "newest", page })));
    }
    expect(all).toHaveLength(50);
    expect(all).not.toContain(4100);
    // One episode, so date order is episode order.
    expect(all).toEqual(Array.from({ length: 50 }, (_, i) => 4000 + i));
  });
});

describe("paging", () => {
  // 50 keyword hits (4000..4049) and 50 meaning-only ones (4200..4249): 100, the cap.
  const FILLER = Array.from({ length: 50 }, (_, i) => 4200 + i);

  it("shows at most 100 hits, 5 pages of 20, and clamps page 6 to 5", async () => {
    const seen: number[] = [];
    for (let page = 1; page <= 5; page++) {
      const b = await body({ q: "veneer", page: String(page) }, FILLER);
      expect(b.page).toBe(page);
      expect(b.results).toHaveLength(20);
      expect(b.has_more).toBe(page < 5);
      seen.push(...ids(b));
    }
    expect(new Set(seen).size).toBe(100);
    for (const page of ["6", "99", "99999999999999999999"]) {
      const b = await body({ q: "veneer", page }, FILLER);
      expect(b.page, page).toBe(5);
      expect(b.results, page).toHaveLength(20);
      expect(b.has_more, page).toBe(false);
    }
  });

  it("caps pages at ceil(100 / limit) with ?limit=", async () => {
    const last = await body({ q: "veneer", limit: "7", page: "15" }, FILLER);
    expect(last).toMatchObject({ page: 15, limit: 7, has_more: false });
    expect(last.results).toHaveLength(2);
    expect((await body({ q: "veneer", limit: "7", page: "16" }, FILLER)).page).toBe(15);
    expect((await body({ q: "veneer", limit: "7", page: "14" }, FILLER)).has_more).toBe(true);
  });

  it("treats a bad page as 1", async () => {
    for (const page of ["0", "abc", "-1", "1.5"]) {
      expect((await body({ q: "veneer", page }, FILLER)).page, page).toBe(1);
    }
  });
});

describe("debug output (?debug=1)", () => {
  it("shows each result's ranks, Vectorize score and RRF score", async () => {
    const k = await keywordOrder("dovetail");
    // The fake scores are 0.9, 0.899, 0.898 in its order.
    const b = await body({ q: "dovetail", debug: "1" }, [3002, k[2]!, 3102]);
    expect(ids(b)).toEqual(ids(await body({ q: "dovetail" }, [3002, k[2]!, 3102])));
    const d = Object.fromEntries(b.results.map((r) => [r.chunk_id, r.debug]));
    expect(d[k[2]!]).toEqual({
      keyword_rank: 3,
      vector_rank: 2,
      vector_score: 0.899,
      rrf_score: expect.closeTo(1 / 63 + 1 / 62, 12),
    });
    expect(d[3002]).toEqual({ keyword_rank: null, vector_rank: 1, vector_score: 0.9, rrf_score: expect.closeTo(1 / 61, 12) });
    expect(d[k[0]!]).toMatchObject({ keyword_rank: 1, vector_rank: null, vector_score: null });
    expect(b.debug).toEqual({ keyword_hits: 3, vector_hits: 3, dropped: [] });
  });

  it("no longer lists folded hits in the debug object (they are on the result)", async () => {
    const b = await body({ q: "dovetail", debug: "1" }, [3203]);
    for (const r of b.results) expect(r.debug).not.toHaveProperty("folded");
    expect(b.results.find((r) => r.chunk_id === 3203)?.folded).toEqual([3201]);
  });

  it("lists the meaning-based hits that were dropped", async () => {
    // 3202 is excluded (biscuit), 999999 has no chunk.
    const b = await body({ q: "joints -biscuit", debug: "1" }, [3202, 999_999, 3002]);
    expect(b.debug).toEqual({ keyword_hits: 1, vector_hits: 3, dropped: [3202, 999_999] });
  });

  it("says there were no meaning-based hits when degraded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const vec = { query: vi.fn(async () => Promise.reject(new Error("VECTOR_QUERY_ERROR"))) };
    const { body: b } = await smart({ q: "dovetail", debug: "1" }, { vec });
    expect(b.smart_degraded).toBe("unavailable");
    expect(b.debug).toEqual({ keyword_hits: 3, vector_hits: null, dropped: [] });
    expect(b.results[0]!.debug).toMatchObject({ keyword_rank: 1, vector_rank: null });
  });

  it("is off unless debug is exactly 1, and absent from exact mode", async () => {
    for (const debug of ["0", "true", "", "yes"]) {
      const b = await body({ q: "dovetail", debug }, [3002]);
      expect(b, debug).not.toHaveProperty("debug");
      for (const r of b.results) expect(r, debug).not.toHaveProperty("debug");
    }
    const res = await exports.default.fetch(url({ q: "dovetail", mode: "exact", debug: "1" }));
    const exactBody = (await res.json()) as Body;
    expect(exactBody).not.toHaveProperty("debug");
    for (const r of exactBody.results) expect(r).not.toHaveProperty("debug");
  });
});

describe("degraded mode", () => {
  it("answers with the keyword hits when Workers AI throws, and logs one line without the query", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = { run: vi.fn(async () => Promise.reject(new Error("InferenceUpstreamError: 3040"))) };
    const vec = fakeVec([3002]);
    const { response, body: b } = await smart({ q: "secretword OR dovetail" }, { ai, vec });
    expect(response.status).toBe(200);
    expect(b.smart_degraded).toBe("unavailable");
    expect(tagged(b).map(([, match]) => match)).toEqual(["keyword", "keyword", "keyword"]);
    expect(ids(b)).toEqual(await keywordOrder("dovetail"));
    expect(vec.query).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ level: "error", event: "ai_unavailable", path: "/api/search" });
    expect(line).not.toContain("secretword");
  });

  it("answers with the keyword hits when Vectorize throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const vec = { query: vi.fn(async () => Promise.reject(new Error("VECTOR_QUERY_ERROR"))) };
    const { body: b } = await smart({ q: "dovetail", sort: "oldest" }, { vec });
    expect(b.smart_degraded).toBe("unavailable");
    expect(ids(b)).toEqual([3001, 3101, 3201]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("vectorize_unavailable");
  });

  it("treats a Workers AI answer with no embedding as a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const output of [{}, { data: [] }, { data: [[]] }, { request_id: "x" }, { data: [["a"]] }]) {
      const vec = fakeVec([3002]);
      const { body: b } = await smart({ q: "dovetail" }, { ai: fakeAi(output), vec });
      expect(b.smart_degraded, JSON.stringify(output)).toBe("unavailable");
      expect(vec.query).not.toHaveBeenCalled();
    }
  });

  it("is what a Worker without AI or Vectorize bindings answers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await exports.default.fetch(url({ q: "dovetail" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).smart_degraded).toBe("unavailable");
  });
});

/** A D1 stand-in that records the SQL it is asked to prepare, then runs it on the test database. */
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

describe("D1 use", () => {
  // Every uncached smart search first counts itself against the daily budget (budget.ts, spec
  // §4.8 item 2): one statement before the rest.
  it("counts the search, then runs one query for the keyword hits and one batch of two for the related ones", async () => {
    const { db, sql } = countingDb(env.DB);
    const { response } = await smart({ q: "dovetail -biscuit" }, { db, vec: fakeVec([3002, 3102]) });
    expect(response.status).toBe(200);
    expect(sql).toHaveLength(5);
    expect(sql[0]).toMatch(/^INSERT INTO usage/);
    expect(sql[1]).toMatch(/bm25\(chunks_fts\)/);
    expect(sql[2]).toMatch(/json_each/);
    expect(sql[2]).toMatch(/NOT IN/);
    expect(sql[3]).toMatch(/highlight\(chunks_fts/);
    expect(sql[4]).toBe("<batch>");
  });

  it("skips the highlight query when every query word is a stopword", async () => {
    const { db, sql } = countingDb(env.DB);
    const { response, body: b } = await smart({ q: '"to be or not to be"' }, { db, vec: fakeVec([3002]) });
    expect(response.status).toBe(200);
    expect(tagged(b)).toEqual([[3002, "related"]]);
    expect(b.results[0]!.ranges).toEqual([]);
    expect(sql).toHaveLength(4);
    expect(sql[2]).toMatch(/json_each/);
    expect(sql[2]).not.toMatch(/highlight/);
    expect(sql[3]).toBe("<batch>");
  });

  it("runs only the count and the keyword query when Vectorize adds nothing new", async () => {
    const { db, sql } = countingDb(env.DB);
    await smart({ q: "dovetail" }, { db, vec: fakeVec([3001]) });
    expect(sql).toHaveLength(2);
    expect(sql[0]).toMatch(/^INSERT INTO usage/);
  });

  it("never puts user text in the SQL", async () => {
    const { db, sql } = countingDb(env.DB);
    await smart({ q: "zzmarker -zzexcluded year:2019 ep:77 before:2001" }, { db, vec: fakeVec([3002]) });
    expect(sql.length).toBeGreaterThan(1);
    for (const statement of sql) expect(statement).not.toMatch(/zzmarker|zzexcluded|2019|77|2001|3002/);
  });

  it("returns 503 unavailable when D1 fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          all: () => Promise.reject(new Error("D1_ERROR: database unavailable")),
        };
      },
      batch: () => Promise.reject(new Error("D1_ERROR: database unavailable")),
    } as unknown as D1Database;
    const { response, body: b } = await smart({ q: "dovetail" }, { db: failingDb, vec: fakeVec([3002]) });
    expect(response.status).toBe(503);
    expect(b).toEqual({ error: "unavailable" });
  });

  it("returns 503 when only the related-hits batch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      prepare: (q: string) => env.DB.prepare(q),
      batch: () => Promise.reject(new Error("D1_ERROR: database unavailable")),
    } as unknown as D1Database;
    const { response } = await smart({ q: "dovetail" }, { db, vec: fakeVec([3002]) });
    expect(response.status).toBe(503);
  });
});
