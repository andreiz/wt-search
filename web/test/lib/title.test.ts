// displayTitle mirrors the pipeline's split_title (pipeline/src/wts/stems.py); the cases are
// shared with pipeline/tests/test_stems.py through test/fixtures/titles.json.
import { describe, expect, it } from "vitest";
import { displayTitle } from "../../src/lib/title";
import cases from "../fixtures/titles.json";

describe("displayTitle", () => {
  it("has cases to check", () => {
    expect(cases.length).toBeGreaterThan(15);
  });

  for (const { title, number, display } of cases) {
    it(`${JSON.stringify(title)} (${number}) shows as ${JSON.stringify(display)}`, () => {
      expect(displayTitle(title, number)).toBe(display);
    });
  }

  it("strips only the episode's own number", () => {
    expect(displayTitle("Ep. 5 Recap", 608)).toBe("Ep. 5 Recap");
    expect(displayTitle("Top 10 Tools", 608)).toBe("Top 10 Tools");
    expect(displayTitle("Tools | 10", 608)).toBe("Tools | 10");
  });

  it("keeps a marker that names another number, but still strips the own number elsewhere", () => {
    expect(displayTitle("Greasy Ham | Wood Talk 595", 596)).toBe("Greasy Ham | Wood Talk 595");
    expect(displayTitle("Ep. 5 Recap | 608", 608)).toBe("Ep. 5 Recap");
    expect(displayTitle("608 - Ep. 5 Recap", 608)).toBe("Ep. 5 Recap");
    expect(displayTitle("Ep. 5 Recap | WT 608", 608)).toBe("Ep. 5 Recap");
  });

  it("leaves an unnumbered episode's title alone", () => {
    expect(displayTitle("WT127 - Hand Tool Guy Straight", null)).toBe("WT127 - Hand Tool Guy Straight");
  });

  it("keeps the whole title when stripping would leave nothing", () => {
    expect(displayTitle("#85", 85)).toBe("#85");
  });
});
