// The year tokens of a query (spec §4.3, §5.2). The cases mirror the Worker's parser tests
// (worker/test/query.test.ts): last one wins per key, hyphen or en dash, malformed tokens are
// plain words, quotes hide a token.
import { describe, expect, it } from "vitest";
import { clearRange, effectiveRange, rangeLabel, setRange, START_YEAR } from "../src/lib/years";

const NOW = 2026;

describe("effectiveRange", () => {
  const cases: [string, { from: number; to: number } | null][] = [
    ["", null],
    ["glue", null],
    ["year:2015", { from: 2015, to: 2015 }],
    ["YEAR:2015", { from: 2015, to: 2015 }],
    ["year:2015 dovetail", { from: 2015, to: 2015 }],
    ["year:2015-2020 glue", { from: 2015, to: 2020 }],
    ["year:2020-2015 glue", { from: 2015, to: 2020 }],
    ["year:2015-2015", { from: 2015, to: 2015 }],
    ["YEAR:2011-2012", { from: 2011, to: 2012 }],
    ["year:2015–2020 glue", { from: 2015, to: 2020 }],
    ["year:2020–2015", { from: 2015, to: 2020 }],
    // after: and before: exclude their year; open ends run to the corpus start and to this year.
    ["after:2019", { from: 2020, to: NOW }],
    ["before:2012", { from: START_YEAR, to: 2011 }],
    ["before:2018 after:2010 glue", { from: 2011, to: 2017 }],
    // An empty range shows as such, not as null.
    ["after:2020 before:2019", { from: 2021, to: 2018 }],
    // Each key keeps its last value; a range sets two keys, a single year one.
    ["year:2015 year:2016", { from: 2016, to: 2016 }],
    ["year:2010-2012 after:2011", { from: 2012, to: 2012 }],
    ["after:2011 year:2010-2012", { from: 2010, to: 2012 }],
    ["before:2020 year:2010-2012", { from: 2010, to: 2012 }],
    ["year:2010-2012 year:2014-2015", { from: 2014, to: 2015 }],
    // year: together with a range of after/before is both filters at once (an AND, as in SQL).
    ["year:2010-2012 year:2015", { from: 2015, to: 2012 }],
    ["year:2015 year:2010-2012", { from: 2015, to: 2012 }],
    ["year:2010-2012 year:2015-2015", { from: 2015, to: 2012 }],
    ["year:2011 after:2009", { from: 2011, to: 2011 }],
    // Anything but two four-digit years is a plain word.
    ["year:2015-", null],
    ["year:-2015", null],
    ["year:15-20", null],
    ["year:2015-20", null],
    ["year:20-2015", null],
    ["year:2015-20200", null],
    ["year:2015-2020-2021", null],
    ["year:2015--2020", null],
    ["year:2015–2020–2021", null],
    ["year:2015-–2020", null],
    ["year:abc", null],
    ["year:", null],
    ["before:2015-2020", null],
    ["after:2015-2020", null],
    ["ep:250-260", null],
    ["year:2015-2020*", null],
    ["-year:2015-2020 glue", null],
    ["-year:2015", null],
    ["year:20155", null],
    // Spaces end the token: a lone year filter and the word 2020.
    ["year:2015 - 2020", { from: 2015, to: 2015 }],
    // A filter between an OR's sides is still a filter.
    ["dovetail OR year:2011-2012 glue", { from: 2011, to: 2012 }],
    // Quotes: inside a phrase it is text; outside, a filter.
    ['"year:2015"', null],
    ['"hide year:2015 glue"', null],
    ['"year:2015" year:2016', { from: 2016, to: 2016 }],
    ['-"year:2015"', null],
    // An unbalanced quote is dropped, and what follows it is outside any phrase.
    ['"hide year:2015', { from: 2015, to: 2015 }],
    ['hide" year:2015', { from: 2015, to: 2015 }],
    // A token touching a phrase is still a word of its own (the Worker flushes the word at the quote).
    ['year:2015"glue"', { from: 2015, to: 2015 }],
    // Curly quotes are quotes.
    ["“year:2015”", null],
    // Other filters are left alone.
    ["ep:250 include:ads", null],
    // The Worker only sees normalised text: emoji touching a token are gone.
    ["💥year:2015-2020", { from: 2015, to: 2020 }],
    ["glue year:2015🔥", { from: 2015, to: 2015 }],
  ];
  for (const [q, want] of cases) {
    it(`${JSON.stringify(q)} -> ${JSON.stringify(want)}`, () => {
      expect(effectiveRange(q, NOW)).toEqual(want);
    });
  }

  it("ignores what the Worker never reads: tokens past the 200th code point", () => {
    // 190 + 1 + 9 characters: the token ends exactly at the 200th. One more and it is cut.
    expect(effectiveRange(`${"a".repeat(190)} year:2015`, NOW)).toEqual({ from: 2015, to: 2015 });
    expect(effectiveRange(`${"a".repeat(191)} year:2015`, NOW)).toBeNull();
  });
});

describe("setRange", () => {
  const cases: [string, number, number, string][] = [
    ["", 2015, 2020, "year:2015-2020"],
    ["glue", 2015, 2020, "glue year:2015-2020"],
    ["glue", 2015, 2015, "glue year:2015"],
    ["glue", 2020, 2015, "glue year:2015-2020"],
    ["year:2010-2012 glue", 2015, 2020, "glue year:2015-2020"],
    ["glue year:2015", 2016, 2017, "glue year:2016-2017"],
    ["glue after:2019", 2012, 2013, "glue year:2012-2013"],
    ["before:2012 glue after:2005", 2012, 2013, "glue year:2012-2013"],
    ["glue YEAR:2015 year:2011-2012 BEFORE:2019 After:2001", 2008, 2009, "glue year:2008-2009"],
    ["year:2015–2020 glue", 2008, 2009, "glue year:2008-2009"],
    // Text that only looks like a filter stays.
    ['"year:2015" glue', 2016, 2017, '"year:2015" glue year:2016-2017'],
    ["year:2015-2020-2021 glue", 2016, 2017, "year:2015-2020-2021 glue year:2016-2017"],
    ["-year:2015 glue", 2016, 2017, "-year:2015 glue year:2016-2017"],
    ["ep:250 glue", 2016, 2017, "ep:250 glue year:2016-2017"],
    // Gaps left by the removal close up.
    ["a   year:2015    b", 2016, 2017, "a b year:2016-2017"],
    // An OR beside a removed filter was inert (a filter ends an OR); it stays inert, by going too.
    ["dovetail OR year:2011-2012 glue", 2015, 2016, "dovetail glue year:2015-2016"],
    ["dovetail year:2011 OR glue", 2015, 2016, "dovetail glue year:2015-2016"],
    ["a OR year:2015 OR b", 2016, 2017, "a b year:2016-2017"],
    ["a OR year:2015 year:2016 OR b", 2018, 2019, "a b year:2018-2019"],
    ["a OR b year:2015 OR c", 2018, 2019, "a OR b c year:2018-2019"],
    ["a OR ep:5 year:2015 OR b", 2018, 2019, "a OR ep:5 b year:2018-2019"],
    // A real OR stays.
    ["a OR b year:2015", 2016, 2017, "a OR b year:2016-2017"],
    ['"a OR b" year:2015', 2016, 2017, '"a OR b" year:2016-2017'],
    // Emoji touching a token do not hide it.
    ["glue 🔥year:2012", 2015, 2016, "glue year:2015-2016"],
    ["💥year:2015-2020 glue", 2015, 2016, "glue year:2015-2016"],
  ];
  for (const [q, from, to, want] of cases) {
    it(`${JSON.stringify(q)} + ${from}-${to} -> ${JSON.stringify(want)}`, () => {
      expect(setRange(q, from, to)).toBe(want);
    });
  }

  it("puts the token first when appending would push it past the Worker's 200 code points, and drops no word", () => {
    const count = (s: string) => Array.from(s).length;
    // 189 characters of words: " year:2015-2016" (15) makes 204 > 200, so the token goes first.
    const words = "word ".repeat(38).trim(); // 189 characters
    expect(count(words)).toBe(189);
    const long = setRange(words, 2015, 2016);
    expect(long).toBe(`year:2015-2016 ${words}`);
    expect(effectiveRange(Array.from(long).slice(0, 200).join(""), NOW)).toEqual({ from: 2015, to: 2016 });
    // The boundary: exactly 200 appends, 201 prepends.
    const fits = "a".repeat(200 - " year:2015-2016".length);
    expect(setRange(fits, 2015, 2016)).toBe(`${fits} year:2015-2016`);
    expect(count(setRange(fits, 2015, 2016))).toBe(200);
    const over = `${fits}a`;
    expect(setRange(over, 2015, 2016)).toBe(`year:2015-2016 ${over}`);
    // The case from review: 45 words.
    const forty5 = "word ".repeat(45);
    const result = setRange(forty5, 2015, 2016);
    expect(result.startsWith("year:2015-2016 ")).toBe(true);
    expect(effectiveRange(Array.from(result).slice(0, 200).join(""), NOW)).toEqual({ from: 2015, to: 2016 });
    // Code points, not UTF-16 units: 𝒜 is one.
    const astral = "𝒜".repeat(200 - " year:2015-2016".length);
    expect(setRange(astral, 2015, 2016)).toBe(`${astral} year:2015-2016`);
  });

  it("what it writes reads back as the same range", () => {
    expect(effectiveRange(setRange("glue after:2001", 2015, 2020), NOW)).toEqual({ from: 2015, to: 2020 });
    expect(effectiveRange(setRange("glue", 2015, 2015), NOW)).toEqual({ from: 2015, to: 2015 });
  });
});

describe("clearRange", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["glue", "glue"],
    ["year:2015", ""],
    ["glue year:2015-2020", "glue"],
    ["glue after:2019 before:2012  saw", "glue saw"],
    ["year:2015–2020 glue", "glue"],
    ['"year:2015" glue year:2016', '"year:2015" glue'],
    ["year:2015-2020-2021 glue", "year:2015-2020-2021 glue"],
    ["-year:2015 glue", "-year:2015 glue"],
    ["a OR b year:2015", "a OR b"],
    ["a OR year:2015 b", "a b"],
    ["💥year:2015-2020", ""],
    ["glue year:2015🔥", "glue"],
  ];
  for (const [q, want] of cases) {
    it(`${JSON.stringify(q)} -> ${JSON.stringify(want)}`, () => {
      expect(clearRange(q)).toBe(want);
    });
  }
});

describe("rangeLabel", () => {
  it("is 'Any year' with no range, one year alone, and an en-dashed span otherwise", () => {
    expect(rangeLabel(null)).toBe("Any year");
    expect(rangeLabel({ from: 2015, to: 2015 })).toBe("2015");
    expect(rangeLabel({ from: 2015, to: 2020 })).toBe("2015–2020");
    expect(rangeLabel({ from: 2021, to: 2018 })).toBe("2021–2018");
  });
});
