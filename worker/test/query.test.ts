import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { HIGHLIGHT_STOPWORDS, MAX_QUERY_CHARS, fallbackQuery, parseQuery } from "../src/query";
import type { Filters } from "../src/query";
import { seed } from "./seed";
import type { SeedChunk, SeedEpisode } from "./seed";

const EPISODE: SeedEpisode = {
  id: 31,
  guid: "guid-query-31",
  number: 250,
  title: "Query fixtures",
  published_at: "2015-05-01T08:00:00Z",
  duration_s: 3600,
};

const TEXTS: [number, string][] = [
  [301, "gluing dovetails with hide glue"],
  [302, "the router table and dust collection"],
  [303, "a hand plane and a chisel"],
  [304, "dovetail saw versus router jig"],
  [305, "SawStop table saw safety"],
];

const CHUNKS: SeedChunk[] = TEXTS.map(([id, text], seq) => ({
  id,
  episode_id: EPISODE.id,
  seq,
  start_ms: seq * 20_000,
  end_ms: (seq + 1) * 20_000,
  text,
}));

// One "zzyear" chunk in each of 2010-2013, for the year filters' rows (the table above only
// checks what the parser emits; these run the filters in SQL).
const YEARS = [2010, 2011, 2012, 2013];
const YEAR_EPISODES: SeedEpisode[] = YEARS.map((year, i) => ({
  id: 40 + i,
  guid: `guid-query-${40 + i}`,
  number: 100 + i,
  title: `Year ${year}`,
  published_at: `${year}-06-01T08:00:00Z`,
  duration_s: 3600,
}));
const YEAR_CHUNKS: SeedChunk[] = YEARS.map((year, i) => ({
  id: 400 + i,
  episode_id: 40 + i,
  seq: 0,
  start_ms: 0,
  end_ms: 20_000,
  text: `zzyear marker from ${year}`,
}));

beforeAll(async () => {
  await seed(env.DB, [EPISODE, ...YEAR_EPISODES], [...CHUNKS, ...YEAR_CHUNKS]);
});

const MATCH_SQL = "select rowid from chunks_fts where chunks_fts match ? order by rowid";

/** Run an FTS5 expression against the test D1. Throws if FTS5 rejects the syntax. */
async function matchRows(expression: string): Promise<number[]> {
  const { results } = await env.DB.prepare(MATCH_SQL).bind(expression).all<{ rowid: number }>();
  return results.map((r) => r.rowid);
}

/** Run many expressions in batches: proves FTS5 accepts them without a round trip each. */
async function expectAllAccepted(expressions: string[]): Promise<void> {
  for (let i = 0; i < expressions.length; i += 50) {
    const group = expressions.slice(i, i + 50);
    try {
      await env.DB.batch(group.map((e) => env.DB.prepare(MATCH_SQL).bind(e)));
    } catch (err) {
      // Name the culprit: a batch error does not say which statement failed.
      for (const e of group) await matchRows(e).catch(() => expect.fail(`FTS5 rejected ${JSON.stringify(e)}`));
      throw err;
    }
  }
}

interface Case {
  q: string;
  fts: string | null;
  semantic?: string;
  terms?: string[];
  exclude?: string | null;
  filters?: Filters;
  includeAds?: boolean;
  rows?: number[];
}

const CASES: Case[] = [
  // Spec §4.3 syntax rows.
  { q: "dovetail", fts: '"dovetail"', semantic: "dovetail", terms: ['"dovetail"'], exclude: null, rows: [301, 304] },
  { q: "dovetail router", fts: '"dovetail" AND "router"', semantic: "dovetail router", rows: [304] },
  // terms (related-hit highlights) split a phrase into its words: a meaning-only hit that says
  // "glue the hide" still shows why it matched.
  { q: '"hide glue"', fts: '"hide glue"', semantic: "hide glue", terms: ['"hide"', '"glue"'], rows: [301] },
  {
    q: '"T-square  jig" -"router table" saw*',
    fts: '("T-square jig" AND "saw"*) NOT "router table"',
    semantic: "T-square jig saw",
    terms: ['"T-square"', '"jig"', '"saw"*'],
    exclude: '"router table"',
  },
  { q: '"hide ??? glue"', fts: '"hide ??? glue"', terms: ['"hide"', '"glue"'] },
  // terms leave out stopwords (any case), so related hits don't mark every "a" and "the".
  // Matching and the embedding text keep them.
  {
    q: "How do I flatten a workbench top",
    fts: '"How" AND "do" AND "I" AND "flatten" AND "a" AND "workbench" AND "top"',
    semantic: "How do I flatten a workbench top",
    terms: ['"flatten"', '"workbench"', '"top"'],
  },
  { q: '"pins and tails" don\'t', fts: '"pins and tails" AND "don\'t"', terms: ['"pins"', '"tails"'] },
  // A prefix is deliberate, so it stays; a query of stopwords only has no terms at all.
  { q: "the* glue", fts: '"the"* AND "glue"', terms: ['"the"*', '"glue"'] },
  { q: '"to be or not to be"', fts: '"to be or not to be"', terms: [], rows: [] },
  { q: '"glue hide"', fts: '"glue hide"', rows: [] },
  { q: "dovetail -router", fts: '"dovetail" NOT "router"', semantic: "dovetail", terms: ['"dovetail"'], exclude: '"router"', rows: [301] },
  { q: 'dovetail -"router jig"', fts: '"dovetail" NOT "router jig"', exclude: '"router jig"', rows: [301] },
  {
    q: "dovetail glue -router -chisel",
    fts: '("dovetail" AND "glue") NOT ("router" OR "chisel")',
    semantic: "dovetail glue",
    exclude: '"router" OR "chisel"',
    rows: [301],
  },
  {
    q: "chisel OR sawstop",
    fts: '("chisel" OR "sawstop")',
    semantic: "chisel sawstop",
    terms: ['"chisel"', '"sawstop"'],
    rows: [303, 305],
  },
  { q: "router OR chisel table", fts: '("router" OR "chisel") AND "table"', semantic: "router chisel table", rows: [302] },
  { q: "dove*", fts: '"dove"*', semantic: "dove", terms: ['"dove"*'], rows: [301, 304] },
  { q: "saw*", fts: '"saw"*', rows: [304, 305] },
  { q: "year:2015 dovetail", fts: '"dovetail"', filters: { year: 2015 }, rows: [301, 304] },
  { q: "before:2018 after:2010 glue", fts: '"glue"', filters: { before: 2018, after: 2010 }, rows: [301] },
  { q: "ep:250 router", fts: '"router"', filters: { ep: 250 }, rows: [302, 304] },
  { q: "include:ads glue", fts: '"glue"', includeAds: true, rows: [301] },
  { q: "YEAR:2015 Include:Ads", fts: null, semantic: "", terms: [], exclude: null, filters: { year: 2015 }, includeAds: true },
  { q: "year:2015 year:2016", fts: null, filters: { year: 2016 } },
  { q: "ep:12345", fts: null, filters: { ep: 12345 } },

  // year:A-B is inclusive: after A-1 and before B+1, whichever order, or year:A for one year.
  { q: "year:2015-2020 glue", fts: '"glue"', semantic: "glue", terms: ['"glue"'], filters: { after: 2014, before: 2021 }, rows: [301] },
  { q: "year:2020-2015 glue", fts: '"glue"', filters: { after: 2014, before: 2021 }, rows: [301] },
  { q: "year:2015-2015 glue", fts: '"glue"', filters: { year: 2015 }, rows: [301] },
  { q: "YEAR:2011-2012", fts: null, semantic: "", terms: [], exclude: null, filters: { after: 2010, before: 2013 } },
  // An en dash (U+2013), as a phone or the year chip's label types it.
  { q: "year:2015–2020 glue", fts: '"glue"', filters: { after: 2014, before: 2021 }, rows: [301] },
  { q: "year:2020–2015", fts: null, filters: { after: 2014, before: 2021 } },
  // Each filter key keeps its last value; a range sets two keys, a single year one.
  { q: "year:2010-2012 after:2011", fts: null, filters: { after: 2011, before: 2013 } },
  { q: "after:2011 year:2010-2012", fts: null, filters: { after: 2009, before: 2013 } },
  { q: "before:2020 year:2010-2012", fts: null, filters: { after: 2009, before: 2013 } },
  { q: "year:2010-2012 year:2014-2015", fts: null, filters: { after: 2013, before: 2016 } },
  { q: "year:2010-2012 year:2015", fts: null, filters: { year: 2015, after: 2009, before: 2013 } },
  { q: "year:2015 year:2010-2012", fts: null, filters: { year: 2015, after: 2009, before: 2013 } },
  { q: "year:2010-2012 year:2015-2015", fts: null, filters: { year: 2015, after: 2009, before: 2013 } },
  // Anything but two four-digit years is a plain word, like year:abc.
  { q: "year:2015-", fts: '"year:2015-"', terms: ['"year:2015-"'], filters: {}, rows: [] },
  { q: "year:-2015", fts: '"year:-2015"', filters: {}, rows: [] },
  { q: "year:15-20", fts: '"year:15-20"', filters: {}, rows: [] },
  { q: "year:2015-20", fts: '"year:2015-20"', filters: {}, rows: [] },
  { q: "year:20-2015", fts: '"year:20-2015"', filters: {}, rows: [] },
  { q: "year:2015-20200", fts: '"year:2015-20200"', filters: {}, rows: [] },
  { q: "year:2015-2020-2021", fts: '"year:2015-2020-2021"', filters: {}, rows: [] },
  { q: "year:2015--2020", fts: '"year:2015--2020"', filters: {}, rows: [] },
  { q: "year:2015–2020–2021", fts: '"year:2015–2020–2021"', filters: {}, rows: [] },
  { q: "year:2015-–2020", fts: '"year:2015-–2020"', filters: {}, rows: [] },
  // Spaces end the token: a lone year filter, a dropped "-", and the word 2020.
  { q: "year:2015 - 2020", fts: '"2020"', filters: { year: 2015 }, rows: [] },
  { q: "year:2015-abcd", fts: '"year:2015-abcd"', filters: {}, rows: [] },
  { q: "-year:2015-2020 glue", fts: '"glue" NOT "year:2015-2020"', exclude: '"year:2015-2020"', filters: {}, rows: [301] },
  { q: "before:2015-2020", fts: '"before:2015-2020"', filters: {}, rows: [] },
  { q: "after:2015-2020", fts: '"after:2015-2020"', filters: {}, rows: [] },
  { q: "ep:250-260", fts: '"ep:250-260"', filters: {}, rows: [] },
  { q: "year:2015-2020*", fts: '"year:2015-2020"*', filters: {}, rows: [] },
  // A range between an OR's sides is a filter, like year:2015 is.
  { q: "dovetail OR year:2011-2012 glue", fts: '"dovetail" AND "glue"', filters: { after: 2010, before: 2013 }, rows: [301] },

  // Combining.
  { q: "a OR b OR c", fts: '("a" OR "b" OR "c")' },
  { q: "dovetail OR router -jig", fts: '("dovetail" OR "router") NOT "jig"', exclude: '"jig"', rows: [301, 302] },
  { q: "router OR chisel table -saw", fts: '(("router" OR "chisel") AND "table") NOT "saw"', rows: [302] },
  { q: "dovetail -rout*", fts: '"dovetail" NOT "rout"*', exclude: '"rout"*', rows: [301] },
  { q: "-router", fts: null, semantic: "", terms: [], exclude: '"router"' },
  { q: "-router -chisel", fts: null, exclude: '"router" OR "chisel"' },
  { q: '"hide   glue "  router', fts: '"hide glue" AND "router"', semantic: "hide glue router", rows: [] },
  { q: 'hide\t"glue\n  hide"', fts: '"hide" AND "glue hide"', rows: [] },
  { q: "year:2015 OR glue", fts: '"glue"', filters: { year: 2015 }, rows: [301] },
  { q: "-router OR glue", fts: '"glue" NOT "router"', exclude: '"router"', rows: [301] },
  { q: "glue OR include:ads dovetail", fts: '"glue" AND "dovetail"', includeAds: true, rows: [301] },
  { q: '"hide glue"*', fts: '"hide glue"', rows: [301] },
  { q: 'a"" b', fts: '"a" AND "b"' },

  // Hostile input: user text must stay inside quotes.
  // Unquoted, text:glue is a column filter and would match chunk 301.
  { q: "text:glue", fts: '"text:glue"', semantic: "text:glue", terms: ['"text:glue"'], rows: [] },
  { q: "NEAR(hide glue)", fts: '"NEAR(hide" AND "glue)"', rows: [] },
  { q: "^gluing", fts: '"^gluing"', rows: [301] },
  { q: '"hide glue', fts: '"hide" AND "glue"', rows: [301] },
  { q: 'hide" glue', fts: '"hide" AND "glue"', rows: [301] },
  { q: "-", fts: null },
  { q: "--router glue", fts: '"glue" NOT "router"', exclude: '"router"', rows: [301] },
  { q: "**", fts: null },
  { q: "-*", fts: null },
  { q: '""', fts: null },
  { q: "OR dovetail", fts: '"dovetail"', rows: [301, 304] },
  { q: "dovetail OR", fts: '"dovetail"', rows: [301, 304] },
  { q: "OR", fts: null },
  { q: "dovetail OR -router", fts: '"dovetail" NOT "router"', rows: [301] },
  { q: "chisel OR OR sawstop", fts: '("chisel" OR "sawstop")', rows: [303, 305] },
  { q: "chisel or sawstop", fts: '"chisel" AND "or" AND "sawstop"', rows: [] },
  { q: "year:abc", fts: '"year:abc"', terms: ['"year:abc"'], filters: {}, rows: [] },
  { q: "ep:", fts: '"ep:"', terms: ['"ep:"'], rows: [] },
  { q: "year:20155", fts: '"year:20155"', terms: ['"year:20155"'], rows: [] },
  { q: "-year:2015 glue", fts: '"glue" NOT "year:2015"', exclude: '"year:2015"', filters: {}, rows: [301] },
  { q: "🪚 dovetail 🙂", fts: '"dovetail"', semantic: "dovetail", rows: [301, 304] },
  { q: "“hide glue”", fts: '"hide glue"', rows: [301] },
  { q: "don’t", fts: '"don\'t"', semantic: "don't", rows: [] },
  { q: 'glue" OR "x', fts: '"glue" AND "OR" AND "x"', rows: [] },
  { q: 'glue\u0000"', fts: '"glue"', rows: [301] },
  { q: "\ud83d glue", fts: '"glue"', rows: [301] },
  { q: "T-square", fts: '"T-square"', rows: [] },
  { q: "", fts: null, semantic: "", terms: [], exclude: null },
  { q: " \t\n ", fts: null },
];

describe("parseQuery", () => {
  // The title is JSON-escaped: a raw lone surrogate or NUL in a test name breaks the
  // runner's WebSocket (invalid UTF-8).
  it.each(CASES.map((c) => [JSON.stringify(c.q), c] as const))("parses %s", async (_title, c) => {
    const parsed = parseQuery(c.q);
    expect(parsed.fts).toBe(c.fts);
    expect(parsed.filters).toEqual(c.filters ?? {});
    expect(parsed.includeAds).toBe(c.includeAds ?? false);
    if (c.semantic !== undefined) expect(parsed.semantic).toBe(c.semantic);
    if (c.terms !== undefined) expect(parsed.terms).toEqual(c.terms);
    if (c.exclude !== undefined) expect(parsed.exclude).toBe(c.exclude);

    // FTS5 must accept everything the parser emits, including the highlight expression.
    const rows = parsed.fts === null ? null : await matchRows(parsed.fts);
    if (parsed.exclude !== null) await matchRows(parsed.exclude);
    if (parsed.terms.length > 0) await matchRows(parsed.terms.join(" OR "));
    if (c.rows !== undefined) expect(rows).toEqual(c.rows);
  });

  describe("year filters in exact search", () => {
    // [query, publish years of the hits]: the filters reach the SQL as parsed.
    const YEAR_CASES: [string, number[]][] = [
      ["year:2011-2012", [2011, 2012]],
      ["year:2012-2011", [2011, 2012]],
      ["year:2011–2012", [2011, 2012]],
      ["year:2010-2013", [2010, 2011, 2012, 2013]],
      ["year:2012-2012", [2012]],
      ["year:2012", [2012]],
      ["year:2008-2011", [2010, 2011]],
      ["year:2014-2020", []],
      ["year:2010-2012 after:2011", [2012]],
      ["after:2011 year:2010-2012", [2010, 2011, 2012]],
      ["year:2011-2013 before:2013", [2011, 2012]],
      ["year:2011-2012 year:2013", []],
      // Malformed: a plain word, which no chunk has.
      ["year:2011-", []],
      ["year:11-12", []],
      ["year:2011-12", []],
      ["year:2011-2012-2013", []],
    ];

    it.each(YEAR_CASES)("%s", async (q, years) => {
      const res = await exports.default.fetch(
        `https://example.com/api/search?mode=exact&sort=oldest&q=${encodeURIComponent(`zzyear ${q}`)}`,
      );
      const body = (await res.json()) as { results: { episode: { date: string } }[] };
      expect(body.results.map((r) => Number(r.episode.date.slice(0, 4)))).toEqual(years);
    });
  });

  it("treats non-string input as empty", () => {
    for (const bad of [undefined, null, 42, {}, ["glue"]]) {
      const parsed = parseQuery(bad as unknown as string);
      expect(parsed.fts).toBeNull();
      expect(parsed.semantic).toBe("");
      expect(parsed.filters).toEqual({});
    }
  });

  describe("length limit", () => {
    it("keeps the first 200 characters", async () => {
      expect(MAX_QUERY_CHARS).toBe(200);
      const parsed = parseQuery("glue ".repeat(100));
      expect(parsed.terms).toEqual(Array<string>(40).fill('"glue"'));
      expect(parsed.fts).toBe(Array<string>(40).fill('"glue"').join(" AND "));
      await matchRows(parsed.fts ?? "");

      const long = parseQuery("a".repeat(500));
      expect(long.terms).toEqual([`"${"a".repeat(200)}"`]);
      await matchRows(long.fts ?? "");
    });

    it("counts code points, so a surrogate pair is never split", () => {
      // 7 code points per repeat (the saw is one); 28 repeats = 196, then "🪚 gl".
      const parsed = parseQuery("🪚 glue ".repeat(100));
      expect(parsed.terms).toHaveLength(29);
      expect(parsed.terms.at(-1)).toBe('"gl"');
    });

    it("stays within FTS5's expression depth at the most terms 200 characters allow", async () => {
      // "b", not a stopword, so the terms (the related-hit highlight expression) are 100 too.
      const ands = parseQuery("b ".repeat(100));
      expect(ands.terms).toHaveLength(100);
      await matchRows(ands.fts ?? "");
      await matchRows(ands.terms.join(" OR "));

      const nots = parseQuery(`a${" -b".repeat(66)}`);
      expect(nots.exclude?.split(" OR ")).toHaveLength(66);
      await matchRows(nots.fts ?? "");
      await matchRows(nots.exclude ?? "");
    });

    it("still runs when the input is all operators", async () => {
      const parsed = parseQuery("x OR ".repeat(100));
      expect(parsed.fts).toBe(`(${Array<string>(40).fill('"x"').join(" OR ")})`);
      await matchRows(parsed.fts ?? "");
    });
  });
});

// A seeded PRNG keeps the fuzz deterministic: a failure reproduces from the same inputs.
function mulberry32(seedValue: number): () => number {
  let a = seedValue;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY = [
  '"', '"', "-", "-", "*", "(", ")", ":", "^", "+", "OR", "AND", "NOT", "NEAR", "year:", "before:", "after:",
  "ep:", "text:", "include:ads", "0", "1", "2015", "12", "a", "b", "z", "glue", "router", "dove", "🪚", "🙂",
  "\u0000", "\ud83d", "\ude00", "“", "”", "’", "\u001f", " ", " ", " ", "\t", ",", "'", "\\",
];

function randomInput(rand: () => number): string {
  const pieces = Math.floor(rand() * 61);
  let out = "";
  for (let i = 0; i < pieces; i++) out += NASTY[Math.floor(rand() * NASTY.length)] ?? "";
  return out;
}

const QUOTED = /"(?:[^"]|"")*"\*?/g;

/** The security rule (plan Review Focus 4): quoted strings plus parsed operators, nothing else. */
function expectStructureOnly(fts: string, input: string): void {
  const rest = fts.replace(QUOTED, "").replace(/\b(?:AND|OR|NOT)\b/g, "");
  expect(rest, `unquoted text in ${JSON.stringify(fts)} for ${JSON.stringify(input)}`).toMatch(/^[\s()]*$/);
  for (const quoted of fts.match(QUOTED) ?? []) {
    expect(quoted).toMatch(/[\p{L}\p{N}]/u);
    expect(quoted).not.toMatch(/\p{Cc}/u);
  }
}

describe("generated input", () => {
  it("never throws, emits only quoted strings and operators, and FTS5 accepts it", async () => {
    const rand = mulberry32(0x5eed);
    const expressions: string[] = [];
    for (let i = 0; i < 500; i++) {
      const input = randomInput(rand);
      for (const parsed of [parseQuery(input), fallbackQuery(input)]) {
        for (const expression of [parsed.fts, parsed.exclude]) {
          if (expression === null) continue;
          expectStructureOnly(expression, input);
          expressions.push(expression);
        }
        if (parsed.terms.length > 0) expressions.push(parsed.terms.join(" OR "));
      }
    }
    expect(expressions.length).toBeGreaterThan(500);
    await expectAllAccepted(expressions);
  });
});

describe("fallbackQuery", () => {
  it("ANDs every word that has a letter or digit, quoted, with no syntax", async () => {
    const parsed = fallbackQuery('a "b" -c');
    expect(parsed.fts).toBe('"a" AND "b" AND "-c"');
    expect(parsed.semantic).toBe("a b -c");
    expect(parsed.filters).toEqual({});
    expect(parsed.includeAds).toBe(false);
    expect(parsed.exclude).toBeNull();
    await matchRows(parsed.fts ?? "");
  });

  it("is empty when nothing is searchable", () => {
    const parsed = fallbackQuery("- * 🪚");
    expect(parsed).toEqual({ fts: null, semantic: "", filters: {}, includeAds: false, terms: [], exclude: null });
  });

  it("leaves stopwords out of terms too", () => {
    const parsed = fallbackQuery("The glue AND the clamps");
    expect(parsed.fts).toBe('"The" AND "glue" AND "AND" AND "the" AND "clamps"');
    expect(parsed.terms).toEqual(['"glue"', '"clamps"']);
  });
});

describe("HIGHLIGHT_STOPWORDS", () => {
  it("is lowercase function words, and no shop words", () => {
    expect(HIGHLIGHT_STOPWORDS.size).toBeGreaterThan(50);
    for (const w of HIGHLIGHT_STOPWORDS) expect(w).toBe(w.toLowerCase());
    for (const w of ["the", "a", "and", "i", "how", "don't", "it's"]) expect(HIGHLIGHT_STOPWORDS.has(w), w).toBe(true);
    // Words that mean something in a woodshop ("glue up", "top coat", "back saw", "cut off").
    for (const w of ["up", "top", "back", "off", "out", "down", "over", "cut", "square", "flat", "set"]) {
      expect(HIGHLIGHT_STOPWORDS.has(w), w).toBe(false);
    }
  });
});
