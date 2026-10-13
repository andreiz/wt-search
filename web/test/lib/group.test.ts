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

  it("merges neighbouring related hits of one episode", () => {
    const cards = groupNeighbours([rel(1, 11), rel(1, 12), rel(2, 21), rel(2, 22)]);
    expect(cards.map((c) => c.hits.map((h) => h.chunk_id))).toEqual([[11, 12], [21, 22]]);
  });

  it("keeps the API's order between cards", () => {
    const mixed = groupNeighbours([rel(4, 41), ep(5, 51), rel(6, 61), ep(7, 71)]);
    expect(mixed.map((c) => c.hits[0]!.chunk_id)).toEqual([41, 51, 61, 71]);
  });

  it("puts a card's hits in the order of the episode, whatever their rank", () => {
    const at = (chunk: number, hit_ms: number) => ep(3, chunk, { hit_ms });
    const cards = groupNeighbours([at(33, 2_887_000), at(31, 1_885_000), at(32, 2_350_000)]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.hits.map((h) => h.chunk_id)).toEqual([31, 32, 33]);
  });

  it("sorts each card on its own: a later card of the same episode is not merged in", () => {
    const at = (id: number, chunk: number, hit_ms: number) => ep(id, chunk, { hit_ms });
    const cards = groupNeighbours([at(1, 12, 900_000), at(1, 11, 100_000), at(2, 21, 5_000), at(1, 13, 50_000)]);
    expect(cards.map((c) => c.hits.map((h) => h.chunk_id))).toEqual([[11, 12], [21], [13]]);
  });

  it("keeps the API's order for hits at the same moment, and does not change the list it was given", () => {
    const given = [ep(3, 33, { hit_ms: 5000 }), ep(3, 31, { hit_ms: 5000 }), ep(3, 32, { hit_ms: 1000 })];
    const cards = groupNeighbours(given);
    expect(cards[0]!.hits.map((h) => h.chunk_id)).toEqual([32, 33, 31]);
    expect(given.map((h) => h.chunk_id)).toEqual([33, 31, 32]);
  });

  it("gives each card the episode of its first hit", () => {
    const cards = groupNeighbours([ep(5, 51), ep(6, 61)]);
    expect(cards.map((c) => c.episode.id)).toEqual([5, 6]);
  });

  it("returns no cards for no results", () => {
    expect(groupNeighbours([])).toEqual([]);
  });
});
