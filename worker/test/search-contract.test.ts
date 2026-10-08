// Keeps the pipeline's search fixtures honest. `wts search` (pipeline/src/wts/search.py) is
// tested against hand-built responses in pipeline/tests/fixtures/search; this seeds a tiny
// corpus, asks the real Worker, and checks that those fixtures have the same keys and value
// types at every level. A change to the response shape fails here until the fixtures follow.
//
// Exact and smart responses differ at the top level (smart has no count, spec §4.4), so each
// fixture is compared with a live response of its own mode.

import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import empty from "../../pipeline/tests/fixtures/search/empty.json";
import exact from "../../pipeline/tests/fixtures/search/exact.json";
import exactTruncated from "../../pipeline/tests/fixtures/search/exact_truncated.json";
import smart from "../../pipeline/tests/fixtures/search/smart.json";
import smartDebug from "../../pipeline/tests/fixtures/search/smart_debug.json";
import smartDegraded from "../../pipeline/tests/fixtures/search/smart_degraded.json";
import type { Env } from "../src/env";
import worker from "../src/index";
import { seed, type SeedChunk, type SeedEpisode } from "./seed";

const EPISODES: SeedEpisode[] = [
  {
    id: 1,
    guid: "g1",
    number: 612,
    title: "Dovetails and Glue",
    published_at: "2024-03-12T08:00:00+00:00",
    duration_s: 3600,
    page_url: "https://example.com/ep/612",
    youtube_video_id: "yt612",
    apple_episode_id: "ap612",
    spotify_episode_id: "sp612",
    offset_youtube_s: 1,
    offset_apple_s: 2,
    offset_spotify_s: 3,
  },
];

const CHUNKS: SeedChunk[] = [
  { id: 1, episode_id: 1, seq: 0, start_ms: 60_000, end_ms: 90_000, text: "A hand cut dovetail is overrated" },
  { id: 2, episode_id: 1, seq: 1, start_ms: 600_000, end_ms: 630_000, text: "but a good dovetail saw is worth it" },
  { id: 3, episode_id: 1, seq: 2, start_ms: 900_000, end_ms: 930_000, text: "Unrelated chatter about coffee" },
];

const EXACT_FIXTURES = { exact, exactTruncated, empty };
const SMART_FIXTURES = { smart, smartDegraded };

type Json = Record<string, unknown>;

async function api(query: string): Promise<Json> {
  const res = await exports.default.fetch(`https://example.com/api/search?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

/** Smart search with fake Workers AI and a Vectorize that finds chunk 3 (no keyword in it). */
async function smartApi(query: string): Promise<Json> {
  const res = await worker.fetch(new Request(`https://example.com/api/search?${query}`), {
    DB: env.DB,
    AI: { run: async () => ({ shape: [1, 3], data: [[0.1, 0.2, 0.3]], pooling: "cls" }) },
    VEC: { query: async () => ({ count: 1, matches: [{ id: "3", score: 0.5 }] }) },
  } as unknown as Env);
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

const keys = (o: object): string[] => Object.keys(o).sort();
/** `smart_degraded` is optional (present only when smart mode fell back), so it is not compared. */
const requiredKeys = (o: object): string[] => keys(o).filter((k) => k !== "smart_degraded");

// The shape every result must have, whether the Worker or a fixture produced it.
function expectResultTypes(r: Json): void {
  expect(typeof r.chunk_id).toBe("number");
  expect(typeof r.text).toBe("string");
  expect(typeof r.hit_ms).toBe("number");
  expect(typeof r.more_in_episode).toBe("number");
  expect(["keyword", "related"]).toContain(r.match);
  expect(Array.isArray(r.ranges)).toBe(true);
  for (const range of r.ranges as unknown[]) {
    expect(Array.isArray(range)).toBe(true);
    expect(range).toHaveLength(2);
    for (const offset of range as unknown[]) expect(typeof offset).toBe("number");
  }
  const episode = r.episode as Json;
  expect(typeof episode.id).toBe("number");
  expect(episode.number === null || typeof episode.number === "number").toBe(true);
  expect(typeof episode.title).toBe("string");
  expect(episode.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  for (const [name, url] of Object.entries(episode.links as Json)) {
    expect(["youtube", "apple", "spotify", "page"]).toContain(name);
    expect(typeof url).toBe("string");
  }
  for (const seconds of Object.values(r.cue_s as Json)) expect(typeof seconds).toBe("number");
}

function expectResultsLike(fixture: Json, live: Json): void {
  const real = (live.results as Json[])[0]!;
  for (const r of fixture.results as unknown as Json[]) {
    expect(keys(r)).toEqual(keys(real));
    expect(keys(r.episode as Json)).toEqual(keys(real.episode as Json));
    expect(keys(r.cue_s as Json)).toEqual(keys(real.cue_s as Json));
    // links omit the platforms a result lacks, so its keys need only be known ones.
    for (const name of Object.keys((r.episode as Json).links as Json)) {
      expect(["youtube", "apple", "spotify", "page"]).toContain(name);
    }
    expectResultTypes(r);
  }
}

let liveExact: Json;
let liveSmart: Json;
let liveDebug: Json;
let liveDegraded: Json;

beforeAll(async () => {
  await seed(env.DB, EPISODES, CHUNKS);
  liveExact = await api("q=dovetail&mode=exact");
  liveSmart = await smartApi("q=dovetail&mode=smart");
  liveDebug = await smartApi("q=dovetail&mode=smart&debug=1");
  // The test Worker has no AI or Vectorize binding: smart search falls back (and logs it).
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  liveDegraded = await api("q=dovetail&mode=smart");
  consoleError.mockRestore();
});

describe("the Worker's own responses", () => {
  it("exact: the seeded corpus's two dovetail hits, with every link", () => {
    const results = liveExact.results as Json[];
    expect(results).toHaveLength(2);
    expect(Object.keys((results[0]!.episode as Json).links as Json).sort()).toEqual(
      ["apple", "page", "spotify", "youtube"],
    );
  });

  it("exact: has the value types the fixtures claim", () => {
    for (const r of liveExact.results as Json[]) expectResultTypes(r);
    expect(typeof liveExact.total).toBe("number");
    for (const flag of ["total_capped", "truncated", "has_more"]) expect(typeof liveExact[flag]).toBe("boolean");
    expect(typeof liveExact.page).toBe("number");
    expect(typeof liveExact.limit).toBe("number");
    expect(liveExact.mode).toBe("exact");
    expect(liveExact.sort).toBe("relevance");
  });

  it("smart: the two keyword hits and the related one", () => {
    const results = liveSmart.results as Json[];
    expect(results.map((r) => [r.chunk_id, r.match])).toEqual([
      [1, "keyword"],
      [3, "related"],
      [2, "keyword"],
    ]);
    for (const r of results) expectResultTypes(r);
    expect(typeof liveSmart.has_more).toBe("boolean");
    expect(typeof liveSmart.page).toBe("number");
    expect(typeof liveSmart.limit).toBe("number");
    expect(liveSmart.mode).toBe("smart");
    expect(liveSmart).not.toHaveProperty("smart_degraded");
  });

  it("smart responses have no count, degraded or not", () => {
    for (const live of [liveSmart, liveDegraded]) {
      for (const key of ["total", "total_capped", "truncated"]) expect(live).not.toHaveProperty(key);
    }
    expect(requiredKeys(liveDegraded)).toEqual(requiredKeys(liveSmart));
  });
});

describe.each(Object.entries(EXACT_FIXTURES))("exact fixture %s", (_name, fixture) => {
  it("has the exact response's keys", () => {
    expect(keys(fixture)).toEqual(keys(liveExact));
  });

  it("has the value types of a response", () => {
    expect(typeof fixture.total).toBe("number");
    for (const flag of ["total_capped", "truncated", "has_more"] as const) {
      expect(typeof fixture[flag]).toBe("boolean");
    }
    expect(typeof fixture.page).toBe("number");
    expect(fixture.mode).toBe("exact");
    expect(["relevance", "newest", "oldest"]).toContain(fixture.sort);
    expect(Array.isArray(fixture.results)).toBe(true);
  });

  it("has results shaped like the Worker's", () => {
    expectResultsLike(fixture as unknown as Json, liveExact);
  });
});

describe.each(Object.entries(SMART_FIXTURES))("smart fixture %s", (_name, fixture) => {
  it("has the smart response's keys", () => {
    expect(requiredKeys(fixture)).toEqual(requiredKeys(liveSmart));
  });

  it("has the value types of a response", () => {
    expect(typeof fixture.has_more).toBe("boolean");
    expect(typeof fixture.page).toBe("number");
    expect(typeof fixture.limit).toBe("number");
    expect(fixture.mode).toBe("smart");
    expect(["relevance", "newest", "oldest"]).toContain(fixture.sort);
    expect(Array.isArray(fixture.results)).toBe(true);
  });

  it("has results shaped like the Worker's", () => {
    expectResultsLike(fixture as unknown as Json, liveSmart);
  });
});

describe("smart fixture smart_debug", () => {
  it("has the debug response's keys, at the top and in every result", () => {
    expect(keys(smartDebug)).toEqual(keys(liveDebug));
    expect(keys(smartDebug.debug)).toEqual(keys(liveDebug.debug as Json));
    const real = (liveDebug.results as Json[])[0]!;
    for (const r of smartDebug.results as unknown as Json[]) {
      expect(keys(r)).toEqual(keys(real));
      expect(keys(r.debug as Json)).toEqual(keys(real.debug as Json));
      expectResultTypes(r);
    }
  });

  it("has the value types of the Worker's debug fields", () => {
    for (const source of [liveDebug, smartDebug as unknown as Json]) {
      const d = source.debug as Json;
      expect(typeof d.keyword_hits).toBe("number");
      expect(d.vector_hits === null || typeof d.vector_hits === "number").toBe(true);
      expect(Array.isArray(d.dropped)).toBe(true);
      for (const r of source.results as Json[]) {
        const rd = r.debug as Json;
        for (const k of ["keyword_rank", "vector_rank", "vector_score"]) {
          expect(rd[k] === null || typeof rd[k] === "number", k).toBe(true);
        }
        expect(typeof rd.rrf_score).toBe("number");
        expect(Array.isArray(rd.folded)).toBe(true);
      }
    }
  });
});

describe("smart_degraded", () => {
  it("is set by the Worker exactly where the fixtures have it", () => {
    expect(liveDegraded.smart_degraded).toBe("unavailable");
    expect(smartDegraded.smart_degraded).toBe("unavailable");
    expect(keys(liveDegraded)).toEqual(keys(smartDegraded));
    expect("smart_degraded" in liveSmart).toBe(false);
    expect("smart_degraded" in smart).toBe(false);
  });

  it("is absent from exact responses and their fixtures", () => {
    expect("smart_degraded" in liveExact).toBe(false);
    for (const f of Object.values(EXACT_FIXTURES)) expect("smart_degraded" in f).toBe(false);
  });
});

describe("the fixtures' flags describe what they say", () => {
  it("exact_truncated is capped, truncated and on the last page", () => {
    expect(exactTruncated).toMatchObject({ total: 1000, total_capped: true, truncated: true, has_more: false });
    expect(exactTruncated.page).toBe(10);
  });

  it("empty has no results and no more", () => {
    expect(empty).toMatchObject({ total: 0, results: [], has_more: false });
  });

  it("smart has keyword and related results", () => {
    expect(smart.results.map((r) => r.match)).toEqual(["keyword", "related", "related"]);
    expect(smart.results[1]!.ranges).toEqual([]);
  });
});
