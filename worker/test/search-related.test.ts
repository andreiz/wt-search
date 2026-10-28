import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { SmartResponse } from "../src/search";
import { seed, type SeedChunk, type SeedEpisode } from "./seed";

// Related search (spec §4.4, §5.2): the Vectorize top 50 without what exact mode lists for the
// same query. Workers AI and Vectorize are fakes, as in search-smart.test.ts: the fake
// Vectorize returns the chunk ids a test names.

type Body = SmartResponse & { mode: string; sort: string };

const EPISODES: SeedEpisode[] = [
  { id: 30, guid: "g30", number: 100, title: "Old Shop", published_at: "2014-03-01T08:00:00+00:00", duration_s: 3600 },
  { id: 31, guid: "g31", number: 200, title: "Dovetail Day", published_at: "2019-06-15T08:00:00+00:00", duration_s: 3600 },
  { id: 32, guid: "g32", number: 300, title: "New Shop", published_at: "2023-01-10T08:00:00+00:00", duration_s: 3600 },
];

function chunk(id: number, episode_id: number, seq: number, start_ms: number, text: string, extra: Partial<SeedChunk> = {}): SeedChunk {
  return { id, episode_id, seq, start_ms, end_ms: start_ms + 30_000, text, ...extra };
}

const CHUNKS: SeedChunk[] = [
  // What exact mode lists for "dovetail", and for "hand dovetail" (3101 only).
  chunk(3001, 30, 0, 0, "dovetail dovetail on the drawer"),
  chunk(3101, 31, 0, 0, "we cut a dovetail by hand today with a saw and a chisel"),
  // No "dovetail". 3002 has "hand", one word of "hand dovetail".
  chunk(3002, 30, 1, 600_000, "hand cut joinery for drawer boxes"),
  chunk(3102, 31, 1, 600_000, "a router jig makes the pins and tails"),
  chunk(3103, 31, 2, 660_000, "half blind joints for drawers"),
  chunk(3202, 32, 2, 600_000, "biscuit joints are quick"),
  chunk(3203, 32, 3, 1_200_000, "this joinery segment is brought to you by a sponsor", { is_boilerplate: true }),
];

const VECTOR = Array.from({ length: 768 }, (_, i) => (i % 7) / 7);

function fakeAi() {
  return { run: vi.fn(async (_model: string, _inputs: unknown) => ({ shape: [1, VECTOR.length], data: [VECTOR], pooling: "cls" })) };
}

function fakeVec(ids: (number | string)[]) {
  return {
    query: vi.fn(async (_vector: number[], _options: unknown) => ({
      count: ids.length,
      matches: ids.map((id, i) => ({ id: String(id), score: 0.9 - i / 1000 })),
    })),
  };
}

function fakeVecScored(matches: [number, number][]) {
  return {
    query: vi.fn(async () => ({
      count: matches.length,
      matches: matches.map(([id, score]) => ({ id: String(id), score })),
    })),
  };
}

async function related(
  params: Record<string, string>,
  vecIds: (number | string)[] = [],
  bindings: Record<string, unknown> = {},
): Promise<Body> {
  const u = new URL("https://example.com/api/search");
  for (const [key, value] of Object.entries({ mode: "related", ...params })) u.searchParams.set(key, value);
  const response = await worker.fetch(new Request(u), {
    DB: env.DB,
    AI: fakeAi(),
    VEC: fakeVec(vecIds),
    ...bindings,
  } as unknown as Env);
  expect(response.status).toBe(200);
  return (await response.json()) as Body;
}

const ids = (b: Body): number[] => b.results.map((r) => r.chunk_id);

beforeAll(async () => {
  await seed(env.DB, EPISODES, CHUNKS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("related mode", () => {
  it("lists the meaning-based hits in Vectorize's order, without the ones that contain the words", async () => {
    const b = await related({ q: "dovetail" }, [3102, 3001, 3002, 3101, 3202]);
    expect(ids(b)).toEqual([3102, 3002, 3202]);
    expect(b.results.every((r) => r.match === "related")).toBe(true);
    expect(b).toMatchObject({ mode: "related", sort: "relevance", page: 1, limit: 20, has_more: false });
    expect(b).not.toHaveProperty("smart_degraded");
    expect(b).not.toHaveProperty("total");
  });

  it("keeps a hit that has only some of the words, with those highlighted", async () => {
    // Exact mode needs both words, so it lists 3101 only; 3002 has "hand" and stays.
    const b = await related({ q: "hand dovetail" }, [3101, 3002, 3001]);
    expect(ids(b)).toEqual([3002, 3001]);
    const [hand] = b.results;
    expect(hand!.ranges.map(([from, to]) => hand!.text.slice(from, to))).toEqual(["hand"]);
  });

  it("is empty, and not degraded, when every meaning-based hit contains the words", async () => {
    const b = await related({ q: "dovetail" }, [3001, 3101]);
    expect(b.results).toEqual([]);
    expect(b).not.toHaveProperty("smart_degraded");
  });

  it("has no title hits, though the title matches", async () => {
    const b = await related({ q: "dovetail" }, [3102]);
    expect(b.episodes).toEqual([]);
  });

  it("applies the exclusions, the filters and the boilerplate rule", async () => {
    expect(ids(await related({ q: "dovetail -biscuit" }, [3202, 3102]))).toEqual([3102]);
    expect(ids(await related({ q: "dovetail ep:100" }, [3102, 3002]))).toEqual([3002]);
    expect(ids(await related({ q: "dovetail" }, [3203, 3102]))).toEqual([3102]);
    expect(ids(await related({ q: "dovetail include:ads" }, [3203, 3102]))).toEqual([3203, 3102]);
  });

  it("collapses nearby hits and sorts by date when asked", async () => {
    // 3103 is 60 s after 3102 in the same episode: folded into it.
    const b = await related({ q: "dovetail" }, [3102, 3103, 3002]);
    expect(ids(b)).toEqual([3102, 3002]);
    expect(b.results[0]!.folded).toEqual([3103]);
    expect(ids(await related({ q: "dovetail", sort: "oldest" }, [3202, 3102, 3002]))).toEqual([3002, 3102, 3202]);
    expect(ids(await related({ q: "dovetail", sort: "newest" }, [3002, 3102, 3202]))).toEqual([3202, 3102, 3002]);
  });

  it("pages", async () => {
    const first = await related({ q: "dovetail", limit: "2" }, [3102, 3002, 3202]);
    expect(ids(first)).toEqual([3102, 3002]);
    expect(first.has_more).toBe(true);
    const second = await related({ q: "dovetail", limit: "2", page: "2" }, [3102, 3002, 3202]);
    expect(ids(second)).toEqual([3202]);
    expect(second.has_more).toBe(false);
  });

  it("with debug=1, gives each result's Vectorize rank and names what was left out", async () => {
    const b = await related({ q: "dovetail", debug: "1" }, [3001, 3102]);
    expect(b.results[0]!.debug).toMatchObject({ keyword_rank: null, vector_rank: 2, rrf_score: 0 });
    expect(b.debug).toEqual({ keyword_hits: 0, vector_hits: 2, dropped: [3001] });
  });
});

describe("the similarity floor (spec §4.4)", () => {
  it("drops hits below 0.62 and keeps the rest in Vectorize's order", async () => {
    const body = await related({ q: "dovetail" }, [], {
      VEC: fakeVecScored([[3102, 0.7], [3002, 0.619], [3202, 0.62]]),
    });
    expect(ids(body)).toEqual([3102, 3202]);
  });

  it("with every hit below it, answers no results and is not degraded", async () => {
    const body = await related({ q: "dovetail" }, [], { VEC: fakeVecScored([[3102, 0.5]]) });
    expect(body.results).toEqual([]);
    expect(body.smart_degraded).toBeUndefined();
  });

  it("debug=1&floor= overrides it; a bad floor is ignored", async () => {
    const vec = () => fakeVecScored([[3102, 0.7], [3202, 0.65]]);
    expect(ids(await related({ q: "dovetail", debug: "1", floor: "0.68" }, [], { VEC: vec() }))).toEqual([3102]);
    expect(ids(await related({ q: "dovetail", debug: "1", floor: "0" }, [], { VEC: vec() }))).toEqual([3102, 3202]);
    for (const bad of ["", "x", "-0.1", "1.5"]) {
      expect(ids(await related({ q: "dovetail", debug: "1", floor: bad }, [], { VEC: vec() }))).toEqual([3102, 3202]);
    }
  });

  it("ignores floor= without debug=1", async () => {
    const body = await related({ q: "dovetail", floor: "0.68" }, [], {
      VEC: fakeVecScored([[3102, 0.7], [3202, 0.65]]),
    });
    expect(ids(body)).toEqual([3102, 3202]);
  });

  it("with debug=1, counts what Vectorize returned and lists the ids under the floor as dropped", async () => {
    const body = await related({ q: "dovetail", debug: "1" }, [], {
      VEC: fakeVecScored([[3102, 0.7], [3002, 0.5]]),
    });
    expect(body.debug).toEqual({ keyword_hits: 0, vector_hits: 2, dropped: [3002] });
  });
});

function fakeAiRerank(scores: Record<string, number> | Error | unknown) {
  return {
    run: vi.fn(async (model: string, inputs: { contexts?: { text?: string }[] }) => {
      if (model !== "@cf/baai/bge-reranker-base") return { shape: [1, VECTOR.length], data: [VECTOR], pooling: "cls" };
      if (scores instanceof Error) throw scores;
      // A raw answer (`{ response: ... }`) or a non-object goes back as given.
      if (typeof scores !== "object" || scores === null || "response" in scores) return scores;
      // Score each context by a word it contains, so tests read clearly.
      return {
        response: (inputs.contexts ?? []).map((c, id) => ({
          id,
          score: Object.entries(scores as Record<string, number>).find(([w]) => c.text?.includes(w))?.[1] ?? 0,
        })),
      };
    }),
  };
}

describe("the reranker (spec §4.4)", () => {
  // Three episodes, so collapse folds nothing: 3102 "router jig", 3002 "hand cut", 3202 "biscuit".
  const vec = () => fakeVecScored([[3102, 0.8], [3002, 0.75], [3202, 0.7]]);
  const scores = { biscuit: 0.9, "hand cut": 0.5, router: 0.1 };

  it("is off by default: Vectorize's order, no rerank call", async () => {
    const ai = fakeAiRerank(scores);
    const body = await related({ q: "dovetail" }, [], { VEC: vec(), AI: ai });
    expect(ids(body)).toEqual([3102, 3002, 3202]);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("with RELATED_RERANK=on, orders by the reranker's score", async () => {
    const ai = fakeAiRerank(scores);
    const body = await related({ q: "dovetail" }, [], { VEC: vec(), AI: ai, RELATED_RERANK: "on" });
    expect(ids(body)).toEqual([3202, 3002, 3102]);
    const call = ai.run.mock.calls.find(([m]) => m === "@cf/baai/bge-reranker-base")!;
    expect(call[1]).toMatchObject({ query: "dovetail" });
    // Plain text: no highlight markers.
    expect(JSON.stringify(call[1])).not.toMatch(/\\u000[12]/);
  });

  it("debug=1&rerank=1 turns it on, rerank=0 off, and debug carries its rank and score", async () => {
    const on = await related({ q: "dovetail", debug: "1", rerank: "1" }, [], { VEC: vec(), AI: fakeAiRerank(scores) });
    expect(on.results[0]!.debug).toMatchObject({ rerank_rank: 1, rerank_score: 0.9, vector_rank: 3 });
    const off = await related({ q: "dovetail", debug: "1", rerank: "0" }, [], {
      VEC: vec(), AI: fakeAiRerank(scores), RELATED_RERANK: "on",
    });
    expect(ids(off)).toEqual([3102, 3002, 3202]);
    expect(off.results[0]!.debug).toMatchObject({ rerank_rank: null, rerank_score: null });
  });

  it("ignores rerank= without debug=1", async () => {
    const body = await related({ q: "dovetail", rerank: "1" }, [], { VEC: vec(), AI: fakeAiRerank(scores) });
    expect(ids(body)).toEqual([3102, 3002, 3202]);
  });

  it.each([
    ["an error", new Error("AI down")],
    ["no response", { response: null }],
    ["a non-object", "nonsense"],
    ["only unusable scores", { response: [{ id: 99, score: 1 }, { id: 0 }, { id: 1, score: "high" }] }],
  ])("keeps Vectorize's order when the reranker gives %s, logs it, and is not degraded", async (_name, answer) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await related({ q: "dovetail", debug: "1" }, [], {
      VEC: vec(), AI: fakeAiRerank(answer), RELATED_RERANK: "on",
    });
    expect(ids(body)).toEqual([3102, 3002, 3202]);
    expect(body.smart_degraded).toBeUndefined();
    expect(body.results[0]!.debug).toMatchObject({ rerank_rank: null, rerank_score: null });
    expect(JSON.stringify(log.mock.calls)).toContain("rerank_unavailable");
  });

  it("puts rows the reranker left out after the scored ones, each row once", async () => {
    const ai = {
      run: vi.fn(async (model: string) =>
        model === "@cf/baai/bge-reranker-base"
          ? { response: [{ id: 2, score: 0.9 }, { id: 2, score: 0.8 }, { id: 99, score: 1 }] }
          : { shape: [1, VECTOR.length], data: [VECTOR], pooling: "cls" }),
    };
    const body = await related({ q: "dovetail" }, [], { VEC: vec(), AI: ai, RELATED_RERANK: "on" });
    expect(ids(body)).toEqual([3202, 3102, 3002]);
  });

  it("with sort=newest, date order wins and the set is the same", async () => {
    const body = await related({ q: "dovetail", sort: "newest" }, [], {
      VEC: vec(), AI: fakeAiRerank({ router: 0.9 }), RELATED_RERANK: "on",
    });
    expect(ids(body)).toEqual([3202, 3102, 3002]);
  });
});

describe("when meaning-based search can't answer", () => {
  it("has no results and says unavailable when Workers AI fails, calling Vectorize not at all", async () => {
    const vec = fakeVec([3102]);
    const ai = { run: vi.fn(async () => Promise.reject(new Error("AI is down"))) };
    vi.spyOn(console, "log").mockImplementation(() => {});
    const b = await related({ q: "dovetail" }, [], { AI: ai, VEC: vec });
    expect(b.results).toEqual([]);
    expect(b.smart_degraded).toBe("unavailable");
    expect(vec.query).not.toHaveBeenCalled();
  });

  it("has no results and says off under the kill switch, calling neither", async () => {
    const ai = fakeAi();
    const vec = fakeVec([3102]);
    const b = await related({ q: "dovetail" }, [], { AI: ai, VEC: vec, SEARCH_OVERRIDE: "exact" });
    expect(b.results).toEqual([]);
    expect(b.smart_degraded).toBe("off");
    expect(ai.run).not.toHaveBeenCalled();
    expect(vec.query).not.toHaveBeenCalled();
  });

  it("has no results and says budget once the day's searches are used up", async () => {
    // The searches above were counted too, so a budget of 1 is long gone.
    const ai = fakeAi();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = await related({ q: "dovetail" }, [3102], { AI: ai, SMART_DAILY_BUDGET: "1" });
    expect(b.results).toEqual([]);
    expect(b.smart_degraded).toBe("budget");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("asks nothing when there is nothing to match", async () => {
    const ai = fakeAi();
    const b = await related({ q: "ep:100" }, [3102], { AI: ai });
    expect(b.results).toEqual([]);
    expect(ai.run).not.toHaveBeenCalled();
  });
});

describe("exact scores from Vectorize (debug=1&exact=1)", () => {
  // Vectorize scores approximately unless asked for the values; at 17k vectors its approximate
  // scores fell under the floor and it missed close matches (2026-10-27).
  const returnValues = (vec: ReturnType<typeof fakeVec>) =>
    (vec.query.mock.calls[0]?.[1] as { returnValues?: boolean; topK?: number }) ?? {};

  it.each([
    ["related", { debug: "1", exact: "1" }, true],
    ["related", { debug: "1" }, false],
    ["related", { exact: "1" }, false],
    ["smart", { debug: "1", exact: "1" }, true],
    ["smart", { exact: "1" }, false],
  ])("%s mode with %o asks for values: %s", async (mode, params, expected) => {
    const vec = fakeVec([3102]);
    await related({ q: "dovetail", mode, ...params }, [], { VEC: vec });
    expect(returnValues(vec).returnValues).toBe(expected);
    expect(returnValues(vec).topK).toBe(50); // within Vectorize's limit with values (50)
  });
});
