import { describe, expect, it } from "vitest";
import { sharedWords, withoutHead, withoutTail } from "../src/repeat";

// A word every 500 ms from the chunk's start, ending 500 ms after the last word starts.
function chunk(start_ms: number, text: string, word_times?: string) {
  const count = text.split(" ").length;
  return {
    start_ms,
    end_ms: start_ms + count * 500,
    text,
    word_times: word_times ?? Array.from({ length: count }, (_, i) => (i === 0 ? 0 : 500)).join(","),
  };
}

const before = chunk(0, "We cut the board. Then we glue it.");
const after = chunk(2_000, "Then we glue it. Clamps go on next.");

describe("sharedWords", () => {
  it("counts the words at the end of one chunk that start the next, at the same times", () => {
    expect(sharedWords(before, after)).toBe(4);
  });

  it("is 0 when the same words come at other times", () => {
    expect(sharedWords(before, chunk(2_100, after.text))).toBe(0);
    expect(sharedWords(before, chunk(9_000, "Then we glue it."))).toBe(0);
  });

  it("is 0 when the times line up but the words differ", () => {
    expect(sharedWords(before, chunk(2_000, "Then we clamp it. And wait."))).toBe(0);
  });

  it("is 0 for chunks that do not touch", () => {
    expect(sharedWords(before, chunk(4_000, "Clamps go on next."))).toBe(0);
  });

  it("finds the overlap when the word before it shares its first time", () => {
    // "board." and "Then" both at 2000 ms: the overlap is still the four words from "Then".
    const tied = chunk(0, before.text, "0,500,500,1000,0,500,500,500");
    expect(sharedWords(tied, after)).toBe(4);
  });

  it("is 0 when either chunk's word times cannot be read", () => {
    expect(sharedWords({ ...before, word_times: "" }, after)).toBe(0);
    expect(sharedWords(before, { ...after, word_times: "0,500" })).toBe(0);
    expect(sharedWords(before, { ...after, word_times: "0,x,500,500,500,500,500,500" })).toBe(0);
  });
});

describe("withoutTail", () => {
  it("takes the shared words off the end; the chunk then ends where the next starts", () => {
    expect(withoutTail(before, [], after)).toEqual({ text: "We cut the board.", start_ms: 0, end_ms: 2_000, ranges: [] });
  });

  it("keeps the ranges in what is left, drops the others, and clips one that crosses the cut", () => {
    // "board." [11, 17), "Then" [18, 22), and "board. Then" [11, 22) across the cut.
    expect(withoutTail(before, [[11, 17], [18, 22]], after).ranges).toEqual([[11, 17]]);
    expect(withoutTail(before, [[11, 22]], after).ranges).toEqual([[11, 17]]);
  });

  it("changes nothing when the chunks share nothing", () => {
    const apart = chunk(4_000, "Clamps go on next.");
    expect(withoutTail(before, [[0, 2]], apart)).toEqual({ text: before.text, start_ms: 0, end_ms: 4_000, ranges: [[0, 2]] });
  });

  it("changes nothing when nothing would be left", () => {
    const all = chunk(2_000, "Then we glue it.");
    expect(withoutTail(all, [], after).text).toBe("Then we glue it.");
  });
});

describe("withoutHead", () => {
  it("takes the shared words off the start; the chunk then starts at its first word left", () => {
    // "Clamps" is the fifth word: 2000 + 4 × 500 ms.
    expect(withoutHead(after, [], before)).toEqual({ text: "Clamps go on next.", start_ms: 4_000, end_ms: 6_000, ranges: [] });
  });

  it("moves the ranges with the text, drops the ones cut off, and clips one that crosses the cut", () => {
    const glue = after.text.indexOf("glue");
    const clamps = after.text.indexOf("Clamps");
    expect(withoutHead(after, [[glue, glue + 4], [clamps, clamps + 6]], before).ranges).toEqual([[0, 6]]);
    expect(withoutHead(after, [[glue, clamps + 6]], before).ranges).toEqual([[0, 6]]);
  });

  it("counts in UTF-16 code units", () => {
    const first = chunk(0, "the café 🪚 saw.");
    const second = chunk(1_000, "🪚 saw. Then glue the naïve joint.");
    const at = second.text.indexOf("naïve");
    const shown = withoutHead(second, [[at, at + 5]], first);
    expect(shown.text).toBe("Then glue the naïve joint.");
    expect(shown.ranges.map(([s, e]) => shown.text.slice(s, e))).toEqual(["naïve"]);
  });

  it("changes nothing when the chunks share nothing, or nothing would be left", () => {
    expect(withoutHead(after, [[0, 4]], chunk(0, "Something else."))).toEqual({
      text: after.text,
      start_ms: 2_000,
      end_ms: 6_000,
      ranges: [[0, 4]],
    });
    const all = chunk(2_000, "Then we glue it.");
    expect(withoutHead(all, [], before)).toMatchObject({ text: "Then we glue it.", start_ms: 2_000 });
  });
});
