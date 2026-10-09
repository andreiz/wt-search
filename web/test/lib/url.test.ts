// URL state (spec §5.2): ?q=&mode=&sort=&page=, defaults omitted, bad values falling back the
// way the Worker's own reading does (worker/src/index.ts).
import { describe, expect, it } from "vitest";
import { normalizeQuery, parse, serialize, type SearchState } from "../../src/lib/url";

const state = (over: Partial<SearchState> = {}): SearchState => ({
  q: "",
  mode: "smart",
  sort: "relevance",
  page: 1,
  ...over,
});

describe("serialize", () => {
  it("gives the empty string for the all-default, empty-query state", () => {
    expect(serialize(state())).toBe("");
  });

  it("omits defaults and keeps a leading ?", () => {
    expect(serialize(state({ q: "hide glue" }))).toBe("?q=hide+glue");
  });

  it("writes non-default mode, sort and page in a fixed order", () => {
    expect(serialize(state({ q: "glue", mode: "exact", sort: "newest", page: 3 }))).toBe(
      "?q=glue&mode=exact&sort=newest&page=3",
    );
  });

  it("trims q and leaves an all-space query out", () => {
    expect(serialize(state({ q: "  glue  " }))).toBe("?q=glue");
    expect(serialize(state({ q: "   " }))).toBe("");
  });

  it("keeps the case of OR and quotes, and encodes & and #", () => {
    expect(serialize(state({ q: 'glue OR "hide glue" a&b#c' }))).toBe(
      "?q=glue+OR+%22hide+glue%22+a%26b%23c",
    );
  });

  it("clamps page to what the Worker would serve for the mode (smart 5, exact 10)", () => {
    expect(serialize(state({ page: 9 }))).toBe("?page=5");
    expect(serialize(state({ mode: "exact", page: 99 }))).toBe("?mode=exact&page=10");
    expect(serialize(state({ page: 0 }))).toBe("");
    expect(serialize(state({ page: -2 }))).toBe("");
    expect(serialize(state({ page: 2.7 }))).toBe("?page=2");
    expect(serialize(state({ page: Number.NaN }))).toBe("");
  });
});

describe("parse", () => {
  it("reads an empty string as the default state", () => {
    expect(parse("")).toEqual(state());
    expect(parse("?")).toEqual(state());
  });

  it("accepts the string with or without the leading ?", () => {
    expect(parse("?q=glue&mode=exact")).toEqual(state({ q: "glue", mode: "exact" }));
    expect(parse("q=glue&mode=exact")).toEqual(state({ q: "glue", mode: "exact" }));
  });

  it("reads + and %20 in q as spaces", () => {
    expect(parse("?q=hide+glue").q).toBe("hide glue");
    expect(parse("?q=hide%20glue").q).toBe("hide glue");
    expect(parse("?q=a%2Bb").q).toBe("a+b");
  });

  it("keeps OR in upper case and does not touch other case", () => {
    expect(parse("?q=Glue+OR+Hide").q).toBe("Glue OR Hide");
    expect(parse("?q=glue+or+hide").q).toBe("glue or hide");
  });

  it("trims q", () => {
    expect(parse("?q=%20%20glue%20").q).toBe("glue");
    expect(parse("?q=+++").q).toBe("");
  });

  it("falls back to smart for any mode but exactly 'exact' (the Worker compares case-sensitively)", () => {
    expect(parse("?mode=exact").mode).toBe("exact");
    expect(parse("?mode=Exact").mode).toBe("smart");
    expect(parse("?mode=EXACT").mode).toBe("smart");
    expect(parse("?mode=fuzzy").mode).toBe("smart");
    expect(parse("?mode=").mode).toBe("smart");
    expect(parse("?mode=smart").mode).toBe("smart");
  });

  it("reads sort case-insensitively and falls back to relevance", () => {
    expect(parse("?sort=newest").sort).toBe("newest");
    expect(parse("?sort=OLDEST").sort).toBe("oldest");
    expect(parse("?sort=Newest").sort).toBe("newest");
    expect(parse("?sort=best").sort).toBe("relevance");
    expect(parse("?sort=%20newest").sort).toBe("relevance");
    expect(parse("?sort=").sort).toBe("relevance");
  });

  it("reads page as digits only; anything else is 1", () => {
    expect(parse("?page=2").page).toBe(2);
    expect(parse("?page=0").page).toBe(1);
    expect(parse("?page=-1").page).toBe(1);
    expect(parse("?page=1.5").page).toBe(1);
    expect(parse("?page=2x").page).toBe(1);
    expect(parse("?page=%202").page).toBe(1);
    expect(parse("?page=").page).toBe(1);
    expect(parse("?page=abc").page).toBe(1);
  });

  it("clamps page to the last page of the mode, which it reads first", () => {
    expect(parse("?page=7").page).toBe(5);
    expect(parse("?mode=exact&page=7").page).toBe(7);
    expect(parse("?page=7&mode=exact").page).toBe(7);
    expect(parse("?mode=exact&page=99").page).toBe(10);
    expect(parse("?page=99999999999999999999999").page).toBe(5);
    // 309 digits: Number() is Infinity, which the Worker's Math.min clamps to the last page.
    const huge = "9".repeat(309);
    expect(Number(huge)).toBe(Number.POSITIVE_INFINITY);
    expect(parse(`?page=${huge}`).page).toBe(5);
    expect(parse(`?mode=exact&page=${huge}`).page).toBe(10);
  });

  it("takes the first of a repeated parameter, like URLSearchParams.get", () => {
    expect(parse("?q=a&q=b").q).toBe("a");
  });

  it("ignores unknown parameters", () => {
    expect(parse("?q=glue&utm_source=x&limit=3&debug=1")).toEqual(state({ q: "glue" }));
  });

  it("survives a malformed percent escape", () => {
    expect(parse("?q=100%").q).toBe("100%");
  });
});

describe("round trip", () => {
  const table: [string, SearchState][] = [
    ["default", state()],
    ["plain query", state({ q: "hide glue" })],
    ["exact mode", state({ q: "titebond", mode: "exact" })],
    ["newest", state({ q: "glue", sort: "newest" })],
    ["oldest, exact, page 10", state({ q: "glue", mode: "exact", sort: "oldest", page: 10 })],
    ["smart, last page", state({ q: "glue", page: 5 })],
    ["operators", state({ q: 'glue OR "hide glue" -epoxy year:2015-2020' })],
    ["plus and percent", state({ q: "c++ 100% a&b=c #1" })],
    // (An emoji here would not survive: queries are cleaned of them, see normalizeQuery.)
    ["non-ASCII", state({ q: "café 木工" })],
    ["no query, non-default mode", state({ mode: "exact" })],
  ];

  it.each(table)("%s: parse(serialize(s)) is s", (_name, s) => {
    expect(parse(serialize(s))).toEqual(s);
  });

  it.each(table)("%s: serialize(parse(serialize(s))) is stable", (_name, s) => {
    const once = serialize(s);
    expect(serialize(parse(once))).toBe(once);
  });

  it("round-trips through location.search style input without the ?", () => {
    const s = state({ q: "glue", mode: "exact", page: 2 });
    expect(parse(serialize(s).slice(1))).toEqual(s);
  });
});

describe("normalizeQuery (emoji are dropped; a shared link behaves like typing)", () => {
  const removed: [string, string, string][] = [
    ["a pictograph", "glue \u{1FAB5} up", "glue up"],
    ["only an emoji", "\u{1FA9A}", ""],
    ["a skin-tone modifier", "\u{1F44D}\u{1F3FD} dovetail", "dovetail"],
    ["a ZWJ family", "\u{1F468}‍\u{1F469}‍\u{1F467} saw", "saw"],
    ["a flag", "\u{1F1FA}\u{1F1F8} oak", "oak"],
    ["a keycap (digit stays)", "1️⃣ plane", "1 plane"],
    ["a subdivision flag (tag sequence)", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} oak", "oak"],
    ["a VS16 after a pictograph", "❤️ glue", "glue"],
    ["spaces left behind", "  a \u{1F44D}   b  ", "a b"],
  ];
  for (const [name, input, want] of removed) {
    it(`removes ${name}`, () => expect(normalizeQuery(input)).toBe(want));
  }

  const kept = [
    "#8 screw*",
    "0123456789",
    '"hide glue" -epoxy year:2015-2020 ep:613 dovetail*',
    "glue OR epoxy",
    "café naïve ångström",
    "木工",
    "مرحبا",
    "हिन्दी",
    // A ZWNJ and a ZWJ between letters are part of the word.
    "می‌خواهم",
    "क्‍ष",
  ];
  for (const input of kept) {
    it(`keeps ${JSON.stringify(input)}`, () => expect(normalizeQuery(input)).toBe(input));
  }

  it("parse and serialize apply it, and the round trip is stable", () => {
    expect(parse("?q=glue+%F0%9F%AA%B5+up").q).toBe("glue up");
    expect(parse("?q=%F0%9F%AA%9A").q).toBe("");
    const once = serialize(state({ q: "\u{1F44D}\u{1F3FD} dovetail \u{1F1FA}\u{1F1F8}" }));
    expect(once).toBe("?q=dovetail");
    expect(serialize(parse(once))).toBe(once);
  });
});
