import { describe, expect, it } from "vitest";
import { setEpisode } from "../../src/lib/episode";

describe("setEpisode", () => {
  it("adds ep:N at the end of the query", () => {
    expect(setEpisode("dovetail jig", 71)).toBe("dovetail jig ep:71");
  });

  it("keeps the other filters and phrases", () => {
    expect(setEpisode('"hand plane" year:2015-2018 -glue', 5)).toBe('"hand plane" year:2015-2018 -glue ep:5');
  });

  it("replaces an existing ep: token instead of stacking a second one", () => {
    expect(setEpisode("dovetail ep:12 jig", 71)).toBe("dovetail jig ep:71");
    expect(setEpisode("EP:12 dovetail", 71)).toBe("dovetail ep:71");
    expect(setEpisode("dovetail ep:12 ep:13", 71)).toBe("dovetail ep:71");
  });

  it("replaces the same episode too, and leaves look-alikes alone", () => {
    expect(setEpisode("dovetail ep:71", 71)).toBe("dovetail ep:71");
    expect(setEpisode("dovetail ep:abc", 71)).toBe("dovetail ep:abc ep:71");
    expect(setEpisode('"ep:12" dovetail', 71)).toBe('"ep:12" dovetail ep:71');
  });

  it("drops an OR that the removed token ended", () => {
    expect(setEpisode("glue OR ep:12 jig", 71)).toBe("glue jig ep:71");
  });

  it("puts the token first when it would fall past the 200 characters the Worker reads", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const out = setEpisode(long, 71);
    expect(out.startsWith("ep:71 word0")).toBe(true);
    expect(out).toContain("word39");
  });

  it("is just the token for an empty query", () => {
    expect(setEpisode("", 71)).toBe("ep:71");
  });
});
