import { describe, expect, it } from "vitest";
import { groupNeighbours, splitRelated } from "../../src/lib/group";
import { result } from "../helpers";

const ep = (id: number, chunk: number, over = {}) => {
  const base = result(id);
  return { ...base, chunk_id: chunk, ...over };
};

describe("splitRelated", () => {
  it("separates keyword from related hits and keeps the API's order in each", () => {
    const list = [
      ep(1, 11),
      ep(2, 21, { match: "related" }),
      ep(3, 31),
      ep(4, 41, { match: "related" }),
    ];
    const { keyword, related } = splitRelated(list);
    expect(keyword.map((r) => r.chunk_id)).toEqual([11, 31]);
    expect(related.map((r) => r.chunk_id)).toEqual([21, 41]);
  });

  it("handles no results", () => {
    expect(splitRelated([])).toEqual({ keyword: [], related: [] });
  });
});

describe("groupNeighbours", () => {
  it("merges only results that are next to each other and from the same episode", () => {
    const cards = groupNeighbours([ep(1, 11), ep(1, 12), ep(2, 21), ep(1, 13)]);
    expect(cards.map((c) => c.hits.map((h) => h.chunk_id))).toEqual([[11, 12], [21], [13]]);
  });

  it("keeps the API's order, within cards and between them", () => {
    const cards = groupNeighbours([ep(3, 33), ep(3, 31), ep(3, 32)]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.hits.map((h) => h.chunk_id)).toEqual([33, 31, 32]);
  });

  it("gives each card the episode of its first hit", () => {
    const cards = groupNeighbours([ep(5, 51), ep(6, 61)]);
    expect(cards.map((c) => c.episode.id)).toEqual([5, 6]);
  });

  it("returns no cards for no results", () => {
    expect(groupNeighbours([])).toEqual([]);
  });
});
