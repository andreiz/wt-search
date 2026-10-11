import { describe, expect, it } from "vitest";
import { clip, codePoints } from "../../src/lib/length";

describe("codePoints", () => {
  it("counts code points of the trimmed text, like the Worker", () => {
    expect(codePoints("")).toBe(0);
    expect(codePoints("  \n ")).toBe(0);
    expect(codePoints("  abc \n")).toBe(3);
  });

  it("counts an emoji as one, not as two UTF-16 units", () => {
    expect("😀".length).toBe(2);
    expect(codePoints("😀😀")).toBe(2);
  });
});

describe("clip", () => {
  it("leaves short text alone and cuts at a code point, never inside a pair", () => {
    expect(clip("abc", 5)).toBe("abc");
    expect(clip("abcdef", 3)).toBe("abc");
    expect(clip("a😀😀", 2)).toBe("a😀");
  });
});
