import { describe, expect, it } from "vitest";
import { headRange, sharedWords, tailRange } from "../src/repeat";

// A word every 500 ms from the chunk's start.
function chunk(start_ms: number, text: string, word_times?: string) {
  const count = text.split(" ").length;
  return { start_ms, text, word_times: word_times ?? Array.from({ length: count }, (_, i) => (i === 0 ? 0 : 500)).join(",") };
}

describe("sharedWords", () => {
  const before = chunk(0, "We cut the board. Then we glue it.");

  it("counts the words at the end of one chunk that start the next, at the same times", () => {
    expect(sharedWords(before, chunk(2_000, "Then we glue it. Clamps go on next."))).toBe(4);
  });

  it("is 0 when the same words come at other times", () => {
    expect(sharedWords(before, chunk(2_100, "Then we glue it. Clamps go on next."))).toBe(0);
    expect(sharedWords(before, chunk(9_000, "Then we glue it."))).toBe(0);
  });

  it("is 0 when the times line up but the words differ", () => {
    expect(sharedWords(before, chunk(2_000, "Then we clamp it. And wait."))).toBe(0);
  });

  it("is 0 for chunks that do not touch", () => {
    expect(sharedWords(before, chunk(4_000, "Clamps go on next."))).toBe(0);
  });

  it("finds the overlap when two words before it share its first time", () => {
    // "board." and "Then" both at 2000 ms: the overlap is still the four words from "Then".
    const tied = chunk(0, "We cut the board. Then we glue it.", "0,500,500,1000,0,500,500,500");
    expect(sharedWords(tied, chunk(2_000, "Then we glue it. Clamps go on next."))).toBe(4);
  });

  it("is the whole next chunk when it holds nothing else", () => {
    expect(sharedWords(before, chunk(2_000, "Then we glue it."))).toBe(4);
  });

  it("is 0 when either chunk's word times cannot be read", () => {
    const after = chunk(2_000, "Then we glue it. Clamps go on next.");
    expect(sharedWords({ ...before, word_times: "" }, after)).toBe(0);
    expect(sharedWords(before, { ...after, word_times: "0,500" })).toBe(0);
    expect(sharedWords(before, { ...after, word_times: "0,x,500,500,500,500,500,500" })).toBe(0);
  });
});

describe("the ranges", () => {
  const text = "We cut the board. Then we glue it.";

  it("tailRange is the last words", () => {
    expect(tailRange(text, 4)).toEqual([18, 34]);
    expect(text.slice(...tailRange(text, 4)!)).toBe("Then we glue it.");
    expect(tailRange(text, 8)).toEqual([0, 34]);
  });

  it("headRange is the first words", () => {
    expect(headRange(text, 4)).toEqual([0, 17]);
    expect(headRange(text, 8)).toEqual([0, 34]);
  });

  it("both are null for no words", () => {
    expect(tailRange(text, 0)).toBeNull();
    expect(headRange(text, 0)).toBeNull();
  });

  it("count in UTF-16 code units", () => {
    const emoji = "the café 🪚 saw. Then glue.";
    expect(emoji.slice(...tailRange(emoji, 2)!)).toBe("Then glue.");
    expect(emoji.slice(...headRange(emoji, 3)!)).toBe("the café 🪚");
  });
});
