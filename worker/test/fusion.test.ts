import { describe, expect, it } from "vitest";
import { collapse, COLLAPSE_MS, RRF_K, rrf, sortByDate } from "../src/fusion";

describe("rrf", () => {
  it("uses k = 60", () => {
    expect(RRF_K).toBe(60);
  });

  it("matches a hand-computed table", () => {
    // keyword: a b c d; meaning: c e a.
    //   a: 1/61 + 1/63 = 0.032266   (rank 1 and 3)
    //   c: 1/63 + 1/61 = 0.032266   (rank 3 and 1): ties a; a was seen first
    //   b: 1/62        = 0.016129
    //   e: 1/62        = 0.016129   ties b; b was seen first
    //   d: 1/64        = 0.015625
    const fused = rrf([
      ["a", "b", "c", "d"],
      ["c", "e", "a"],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "e", "d"]);
    const score = Object.fromEntries(fused.map((f) => [f.id, f.score]));
    expect(score.a).toBeCloseTo(1 / 61 + 1 / 63, 12);
    expect(score.c).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(score.b).toBeCloseTo(1 / 62, 12);
    expect(score.e).toBeCloseTo(1 / 62, 12);
    expect(score.d).toBeCloseTo(1 / 64, 12);
  });

  it("lets two middling ranks beat one top rank", () => {
    // x: 1/61 = 0.01639; y: 1/65 + 1/65 = 0.03077.
    const fused = rrf([
      ["x", "p", "q", "r", "y"],
      ["s", "t", "u", "v", "y"],
    ]);
    expect(fused[0]).toEqual({ id: "y", score: 2 / 65 });
  });

  it("takes another k", () => {
    expect(rrf([["a"], ["a"]], 0)).toEqual([{ id: "a", score: 2 }]);
  });

  it("counts an id repeated in one list only at its first rank", () => {
    expect(rrf([[1, 1, 2]])).toEqual([
      { id: 1, score: 1 / 61 },
      { id: 2, score: 1 / 63 },
    ]);
  });

  it("is empty for empty lists, and one list keeps its order", () => {
    expect(rrf([])).toEqual([]);
    expect(rrf([[], []])).toEqual([]);
    expect(rrf([[3, 1, 2], []]).map((f) => f.id)).toEqual([3, 1, 2]);
  });
});

describe("sortByDate", () => {
  const hit = (id: number, episode_id: number, seq: number, published_at: string) => ({
    id,
    episode_id,
    seq,
    published_at,
  });
  const hits = [
    hit(1, 10, 5, "2019-06-15T08:00:00+00:00"),
    hit(2, 20, 1, "2023-01-10T08:00:00+00:00"),
    hit(3, 10, 2, "2019-06-15T08:00:00+00:00"),
    hit(4, 30, 0, "2014-03-01T08:00:00+00:00"),
    // Same date as episode 10: ordered by episode id, and ids run against seq.
    hit(6, 11, 1, "2019-06-15T08:00:00+00:00"),
    hit(5, 11, 1, "2019-06-15T08:00:00+00:00"),
  ];

  it("puts the newest episode first, hits in episode order", () => {
    expect(sortByDate(hits, "newest").map((h) => h.id)).toEqual([2, 3, 1, 5, 6, 4]);
  });

  it("puts the oldest episode first, hits in episode order", () => {
    expect(sortByDate(hits, "oldest").map((h) => h.id)).toEqual([4, 3, 1, 5, 6, 2]);
  });

  it("does not change its input", () => {
    const before = hits.map((h) => h.id);
    sortByDate(hits, "newest");
    expect(hits.map((h) => h.id)).toEqual(before);
  });
});

describe("collapse", () => {
  const result = (chunk_id: number, episode: number, hit_ms: number) => ({
    chunk_id,
    episode: { id: episode },
    hit_ms,
    more_in_episode: 0,
    folded: [] as number[],
  });

  it("folds hits of one episode less than 120 s from a kept one into it", () => {
    expect(COLLAPSE_MS).toBe(120_000);
    const kept = collapse([
      result(1, 10, 1_000_000),
      result(2, 10, 1_119_000), // 119 s: folded into 1
      result(3, 20, 1_000_000), // another episode: kept
      result(4, 10, 1_121_000), // 121 s from 1, the kept one (2 is not kept): kept
      result(5, 10, 881_000), // 119 s before 1: folded into 1
    ]);
    expect(kept.map((r) => [r.chunk_id, r.more_in_episode])).toEqual([
      [1, 2],
      [3, 0],
      [4, 0],
    ]);
  });

  it("records the folded chunk ids on the kept result, in fold order", () => {
    const kept = collapse([
      result(1, 10, 1_000_000),
      result(2, 10, 1_050_000),
      result(3, 20, 1_000_000),
      result(5, 10, 950_000),
      result(4, 10, 1_121_000),
    ]);
    expect(kept.map((r) => [r.chunk_id, r.folded])).toEqual([
      [1, [2, 5]],
      [3, []],
      [4, []],
    ]);
    for (const r of kept) expect(r.folded).toHaveLength(r.more_in_episode);
  });
});
