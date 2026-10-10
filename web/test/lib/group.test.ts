import { describe, expect, it } from "vitest";
import { groupNeighbours } from "../../src/lib/group";
import { result } from "../helpers";

const ep = (id: number, chunk: number, over = {}) => {
  const base = result(id);
  return { ...base, chunk_id: chunk, ...over };
};
const rel = (id: number, chunk: number) => ep(id, chunk, { match: "related" });

describe("groupNeighbours", () => {
  it("merges only results that are next to each other and from the same episode", () => {
    const cards = groupNeighbours([ep(1, 11), ep(1, 12), ep(2, 21), ep(1, 13)]);
    expect(cards.map((c) => c.hits.map((h) => h.chunk_id))).toEqual([[11, 12], [21], [13]]);
  });

  it("merges neighbours of one episode and the same kind, keyword or related", () => {
    const cards = groupNeighbours([ep(1, 11), ep(1, 12), rel(2, 21), rel(2, 22)]);
    expect(cards.map((c) => c.hits.map((h) => h.chunk_id))).toEqual([[11, 12], [21, 22]]);
    expect(cards.map((c) => c.related)).toEqual([false, true]);
  });

  it("does not merge a keyword hit and a related hit of one episode that sit next to each other", () => {
    const cards = groupNeighbours([ep(1, 11), rel(1, 12), ep(1, 13)]);
    expect(cards.map((c) => c.hits.map((h) => h.chunk_id))).toEqual([[11], [12], [13]]);
    expect(cards.map((c) => c.related)).toEqual([false, true, false]);
  });

  it("keeps the API's order, within cards and between them", () => {
    const cards = groupNeighbours([ep(3, 33), ep(3, 31), ep(3, 32)]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.hits.map((h) => h.chunk_id)).toEqual([33, 31, 32]);
    const mixed = groupNeighbours([rel(4, 41), ep(5, 51), rel(6, 61), ep(7, 71)]);
    expect(mixed.map((c) => c.hits[0]!.chunk_id)).toEqual([41, 51, 61, 71]);
  });

  it("gives each card the episode of its first hit", () => {
    const cards = groupNeighbours([ep(5, 51), ep(6, 61)]);
    expect(cards.map((c) => c.episode.id)).toEqual([5, 6]);
  });

  it("returns no cards for no results", () => {
    expect(groupNeighbours([])).toEqual([]);
  });
});
