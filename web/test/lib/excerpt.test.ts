import { describe, expect, it } from "vitest";
import { excerpt, segments } from "../../src/lib/excerpt";

const words = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
const joined = (e: ReturnType<typeof excerpt>) => e.segments.map((s) => s.text).join("");
const marked = (e: ReturnType<typeof excerpt>) => e.segments.filter((s) => s.mark).map((s) => s.text);

describe("segments", () => {
  it("splits the text at the ranges", () => {
    expect(segments("Hide glue gives", [[0, 4], [5, 9]])).toEqual([
      { text: "Hide", mark: true },
      { text: " ", mark: false },
      { text: "glue", mark: true },
      { text: " gives", mark: false },
    ]);
  });

  it("is the whole text unmarked without ranges", () => {
    expect(segments("plain text", [])).toEqual([{ text: "plain text", mark: false }]);
  });

  it("handles ranges at the very start and end", () => {
    expect(segments("ab cd", [[0, 2], [3, 5]]).map((s) => s.text)).toEqual(["ab", " ", "cd"]);
  });

  it("uses UTF-16 offsets: an emoji before a range counts two units", () => {
    const text = "We drove 🚗 to the dovetail jig";
    const at = text.indexOf("dovetail");
    expect(marked({ segments: segments(text, [[at, at + 8]]), cutStart: false, cutEnd: false })).toEqual(["dovetail"]);
  });

  it("never splits a surrogate pair, even from a range that does", () => {
    const text = "a 🚗 b";
    // [2, 3) would end between the two halves of the emoji.
    const out = segments(text, [[2, 3]]);
    expect(out.map((s) => s.text).join("")).toBe(text);
    for (const s of out) expect(s.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });

  it("ignores empty, backwards and overlapping ranges safely", () => {
    const out = segments("abcdef", [[2, 2], [4, 3], [1, 4], [3, 5]]);
    expect(out.map((s) => s.text).join("")).toBe("abcdef");
    expect(out.filter((s) => s.mark).map((s) => s.text)).toEqual(["bcde"]);
  });
});

describe("excerpt", () => {
  it("is the whole text when it is short, with no cuts", () => {
    const e = excerpt("Hide glue gives you more open time", [[0, 4]]);
    expect(joined(e)).toBe("Hide glue gives you more open time");
    expect(e.cutStart).toBe(false);
    expect(e.cutEnd).toBe(false);
    expect(marked(e)).toEqual(["Hide"]);
  });

  it("starts at the beginning when there are no ranges, and cuts the end", () => {
    const e = excerpt(words(100), [], 45);
    expect(e.cutStart).toBe(false);
    expect(e.cutEnd).toBe(true);
    expect(joined(e).split(" ")).toHaveLength(45);
    expect(joined(e).startsWith("w0 w1")).toBe(true);
  });

  it("highlight at the start: window from the beginning", () => {
    const text = `hvlp ${words(80)}`;
    const e = excerpt(text, [[0, 4]]);
    expect(e.cutStart).toBe(false);
    expect(e.cutEnd).toBe(true);
    expect(marked(e)).toEqual(["hvlp"]);
  });

  it("highlight in the middle: starts a few words before it", () => {
    const text = `${words(60)} sprayer ${words(60, "x")}`;
    const at = text.indexOf("sprayer");
    const e = excerpt(text, [[at, at + 7]]);
    expect(e.cutStart).toBe(true);
    expect(e.cutEnd).toBe(true);
    expect(marked(e)).toEqual(["sprayer"]);
    const out = joined(e);
    expect(out.indexOf("sprayer")).toBeGreaterThan(0);
    expect(out.split(" ").indexOf("sprayer")).toBeLessThanOrEqual(8);
    expect(out.split(" ").length).toBeLessThanOrEqual(46);
    // Whole words only.
    expect(out.startsWith("w")).toBe(true);
    expect(out.split(" ").every((w) => /^(w|x)\d+$|^sprayer$/.test(w))).toBe(true);
  });

  it("highlight at the end: no cut at the end", () => {
    const text = `${words(80)} sprayer`;
    const at = text.indexOf("sprayer");
    const e = excerpt(text, [[at, at + 7]]);
    expect(e.cutStart).toBe(true);
    expect(e.cutEnd).toBe(false);
    expect(joined(e).endsWith("sprayer")).toBe(true);
  });

  it("never splits a range at the end of the window: it grows to hold the whole range", () => {
    const phrase = "open time for the glue";
    const text = `${words(42)} ${phrase} tail`;
    const first = text.indexOf("w2 ");
    // The first range is near the start, so the window is words 0-44; the phrase (words 42-46) straddles its end.
    const at = text.indexOf(phrase);
    const e = excerpt(text, [[first, first + 2], [at, at + phrase.length]], 45);
    expect(marked(e)).toEqual(["w2", phrase]);
    expect(joined(e).endsWith("glue")).toBe(true);
  });

  it("skips ranges outside the window", () => {
    const text = `${words(100)} late`;
    const at = text.indexOf("w3 ");
    const e = excerpt(text, [[at, at + 2], [text.length - 4, text.length]]);
    expect(marked(e)).toEqual(["w3"]);
    expect(e.cutEnd).toBe(true);
  });

  it("works with an emoji before the range (UTF-16 offsets)", () => {
    const text = `${words(30)} 🚗 and then the dovetail jig 🔧 ${words(40, "z")}`;
    const at = text.indexOf("dovetail");
    const e = excerpt(text, [[at, at + 8]]);
    expect(marked(e)).toEqual(["dovetail"]);
    expect(joined(e)).toContain("🚗");
    expect(joined(e)).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
  });

  it("collapses nothing: the window text is a slice of the original", () => {
    const text = `  ${words(70)}  `;
    const e = excerpt(text, []);
    expect(text.includes(joined(e))).toBe(true);
  });

  it("keeps a range that covers whitespace at either end of the text", () => {
    expect(marked(excerpt("foo bar ", [[4, 8]]))).toEqual(["bar"]);
    expect(marked(excerpt("  hello world", [[0, 7]]))).toEqual(["hello"]);
  });

  it("does not throw for maxWords of 0 or less: the window is one word", () => {
    expect(joined(excerpt("one two three", [], 0))).toBe("one");
    expect(joined(excerpt("one two three", [], -3))).toBe("one");
  });

  it("is empty for empty text", () => {
    expect(excerpt("", [])).toEqual({ segments: [], cutStart: false, cutEnd: false });
  });
});
