// Keeps the pipeline's search fixtures honest. `wts search` (pipeline/src/wts/search.py) is
// tested against hand-built responses in pipeline/tests/fixtures/search; this seeds a tiny
// corpus, asks the real Worker, and checks that those fixtures have the same keys and value
// types at every level. A change to the response shape fails here until the fixtures follow.

import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import empty from "../../pipeline/tests/fixtures/search/empty.json";
import exact from "../../pipeline/tests/fixtures/search/exact.json";
import exactTruncated from "../../pipeline/tests/fixtures/search/exact_truncated.json";
import smartDegraded from "../../pipeline/tests/fixtures/search/smart_degraded.json";
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

const FIXTURES = { exact, exactTruncated, smartDegraded, empty };

type Json = Record<string, unknown>;

async function api(query: string): Promise<Json> {
  const res = await exports.default.fetch(`https://example.com/api/search?${query}`);
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
  expect(r.match).toBe("keyword");
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

let live: Json;

beforeAll(async () => {
  await seed(env.DB, EPISODES, CHUNKS);
  live = await api("q=dovetail&mode=exact");
});

describe("the Worker's own response", () => {
  it("is the seeded corpus's two dovetail hits, with every link", () => {
    const results = live.results as Json[];
    expect(results).toHaveLength(2);
    expect(Object.keys((results[0]!.episode as Json).links as Json).sort()).toEqual(
      ["apple", "page", "spotify", "youtube"],
    );
  });

  it("has the value types the fixtures claim", () => {
    for (const r of live.results as Json[]) expectResultTypes(r);
    expect(typeof live.total).toBe("number");
    for (const flag of ["total_capped", "truncated", "has_more"]) expect(typeof live[flag]).toBe("boolean");
    expect(typeof live.page).toBe("number");
    expect(live.mode).toBe("exact");
    expect(live.sort).toBe("relevance");
  });
});

describe.each(Object.entries(FIXTURES))("fixture %s", (_name, fixture) => {
  it("has the response's keys", () => {
    expect(requiredKeys(fixture)).toEqual(requiredKeys(live));
  });

  it("has the value types of a response", () => {
    expect(typeof fixture.total).toBe("number");
    for (const flag of ["total_capped", "truncated", "has_more"] as const) {
      expect(typeof fixture[flag]).toBe("boolean");
    }
    expect(typeof fixture.page).toBe("number");
    expect(["smart", "exact"]).toContain(fixture.mode);
    expect(["relevance", "newest", "oldest"]).toContain(fixture.sort);
    expect(Array.isArray(fixture.results)).toBe(true);
  });

  it("has results shaped like the Worker's", () => {
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
  });
});

describe("smart_degraded", () => {
  it("is set by the Worker exactly where the fixture has it", async () => {
    const smart = await api("q=dovetail&mode=smart");
    // Task 13 answers every smart search with the keyword results and the flag; Task 14 only
    // sets it when Workers AI or Vectorize fail. Either way the fixture's flag is `true`.
    expect(smart.smart_degraded).toBe(true);
    expect(smartDegraded.smart_degraded).toBe(true);
    expect(keys(smart)).toEqual(keys(smartDegraded));
  });

  it("is absent from exact responses and their fixtures", () => {
    expect("smart_degraded" in live).toBe(false);
    for (const f of [exact, exactTruncated, empty]) expect("smart_degraded" in f).toBe(false);
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
});
