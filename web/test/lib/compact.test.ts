// When the phone header compacts: a threshold with hysteresis, and never on a page that cannot
// scroll far enough to stay compact.
import { describe, expect, it } from "vitest";
import { COMPACT_AT, EXPAND_AT, nextCompact } from "../../src/lib/compact";

const LONG = 5000;

describe("nextCompact(was, scrollY, maxScrollY)", () => {
  it("compacts only past the upper mark", () => {
    expect(nextCompact(false, COMPACT_AT, LONG)).toBe(false);
    expect(nextCompact(false, COMPACT_AT + 1, LONG)).toBe(true);
  });

  it("once compact, stays compact until back above the top", () => {
    expect(nextCompact(true, COMPACT_AT - 50, LONG)).toBe(true);
    expect(nextCompact(true, EXPAND_AT + 1, LONG)).toBe(true);
    expect(nextCompact(true, EXPAND_AT, LONG)).toBe(false);
    expect(nextCompact(true, 0, LONG)).toBe(false);
  });

  it("has a gap between the marks (hysteresis)", () => {
    expect(COMPACT_AT).toBeGreaterThan(EXPAND_AT + 50);
  });

  it("never compacts when the page cannot scroll far enough to stay compact", () => {
    expect(nextCompact(false, 500, COMPACT_AT)).toBe(false);
    expect(nextCompact(false, 500, COMPACT_AT + 10)).toBe(false);
    expect(nextCompact(true, 500, COMPACT_AT)).toBe(false);
  });
});
