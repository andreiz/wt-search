import { describe, expect, it } from "vitest";
import { decodeWordTimes } from "../src/wordtimes";
import cases from "./fixtures/word_times.json";

describe("decodeWordTimes", () => {
  // The same file is checked against the pipeline's codec (pipeline/tests/test_chunker.py).
  it.each(cases.map((c) => [c.name, c] as const))("decodes the shared fixture: %s", (_name, c) => {
    expect(decodeWordTimes(c.start_ms, c.encoded)).toEqual(c.times);
  });

  it.each(["", "1,,2", "a,1", "1.5"])("gives [] for malformed input %j", (bad) => {
    expect(decodeWordTimes(1000, bad)).toEqual([]);
  });

  it("gives [] for a trailing comma, a lone sign and exponent notation", () => {
    for (const bad of ["1,", ",1", "-", "1e3", "0x10", "--1"]) expect(decodeWordTimes(0, bad)).toEqual([]);
  });

  it("tolerates whitespace around a part", () => {
    expect(decodeWordTimes(100, "0, 50 ,-10")).toEqual([100, 150, 140]);
  });
});
