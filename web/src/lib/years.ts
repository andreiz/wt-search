// The year range in the query text (spec §4.3, §5.2). The range is not separate state: it is the
// `year:`, `year:A-B`, `before:` and `after:` tokens of `q`, read here the way the Worker's parser
// reads them (worker/src/query.ts; re-implemented, since the web app imports no Worker code).
//
// The rules, as the parser has them:
//   - The query is cut at 200 code points; curly quotes are straight ones; control characters are
//     spaces. Words are split on whitespace; a "quoted phrase" is text, whatever it holds.
//   - A token is a filter only as a whole word: `year:2015`, `before:2018`, `after:2020`, or
//     `year:2015-2020` (hyphen or en dash, both ends four digits), in any letter case. Anything
//     else (`year:15`, `year:2015-`, `-year:2015`, `year:2015*`) is a plain word.
//   - Each key keeps its last value. `year:A-B` sets after = min-1 and before = max+1, or, when
//     both ends are one year, `year` alone; `year:` and the pair are separate keys and all hold.
//
// Pure: no DOM, no Preact.
import { normalizeQuery } from "./url";

/** The first year of the corpus (spec §5.2: the pickers run from 2007). */
export const START_YEAR = 2007;

/** The Worker cuts queries at 200 code points (worker/src/query.ts MAX_QUERY_CHARS). */
export const MAX_QUERY_CHARS = 200;

export interface YearRange {
  from: number;
  to: number;
}

const SMART_DOUBLE_QUOTES = new Set(["“", "”", "„", "‟", "″", "＂"]);
const SMART_SINGLE_QUOTES = new Set(["‘", "’", "‚", "‛", "′"]);

/**
 * The text as the parser sees it: cut, with control characters and lone surrogates as spaces and
 * curly quotes as straight ones. Every replacement is one UTF-16 unit for one, so a position in
 * the result is the same position in the input.
 */
function seen(q: string): string {
  return Array.from(q)
    .slice(0, MAX_QUERY_CHARS)
    .map((ch) => {
      if (/^[\ud800-\udfff]$/.test(ch) || /^\p{Cc}$/u.test(ch)) return " ";
      if (SMART_DOUBLE_QUOTES.has(ch)) return '"';
      if (SMART_SINGLE_QUOTES.has(ch)) return "'";
      return ch;
    })
    .join("");
}

export interface Token {
  kind: "word" | "phrase";
  text: string;
  /** Where it sits in the text, `[start, end)`. */
  start: number;
  end: number;
}

/** The parser's `scan`, with positions: words, and quoted phrases (which are never filters). */
function scan(text: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let wordStart = 0;
  const flush = (end: number): void => {
    if (word !== "") tokens.push({ kind: "word", text: word, start: wordStart, end });
    word = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (/\s/.test(ch)) {
      flush(i);
      i++;
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) {
        flush(i);
        i++;
        continue;
      }
      // `-"phrase"` is one negated phrase; otherwise the word before the quote ends there.
      const negated = /^-+$/.test(word);
      if (negated) word = "";
      else flush(i);
      tokens.push({ kind: "phrase", text: text.slice(i + 1, end), start: i, end: end + 1 });
      i = end + 1;
    } else {
      if (word === "") wordStart = i;
      word += ch;
      i++;
    }
  }
  flush(text.length);
  return tokens;
}

const RANGE_FILTER = /^(year|before|after):(\d{4})$/i;
const YEAR_SPAN = /^year:(\d{4})[-–](\d{4})$/i;

/** Whether a token is one of the four year filters. */
function isYearToken(token: Token): boolean {
  return token.kind === "word" && (RANGE_FILTER.test(token.text) || YEAR_SPAN.test(token.text));
}

/**
 * The years a query searches: from the first to the last, both included, or null with no year
 * token. `after:2019` is 2020 to this year and `before:2012` is 2007 to 2011. A range that holds
 * no year (`after:2020 before:2019`) is returned as it reads, `from` past `to`, not as null.
 */
export function effectiveRange(q: string, thisYear: number): YearRange | null {
  const filters: { year?: number; before?: number; after?: number } = {};
  // The Worker only ever sees normalised text (emoji gone), so read that.
  for (const token of scan(seen(normalizeQuery(q)))) {
    if (token.kind !== "word") continue;
    const range = RANGE_FILTER.exec(token.text);
    const span = YEAR_SPAN.exec(token.text);
    if (range) {
      filters[(range[1] ?? "").toLowerCase() as "year" | "before" | "after"] = Number(range[2]);
    } else if (span) {
      const low = Math.min(Number(span[1]), Number(span[2]));
      const high = Math.max(Number(span[1]), Number(span[2]));
      if (low === high) {
        filters.year = low;
      } else {
        filters.after = low - 1;
        filters.before = high + 1;
      }
    }
  }
  if (filters.year === undefined && filters.before === undefined && filters.after === undefined) return null;
  // The Worker ANDs the filters (`year = ? AND year < ? AND year > ?`).
  let from = filters.after === undefined ? START_YEAR : filters.after + 1;
  let to = filters.before === undefined ? thisYear : filters.before - 1;
  if (filters.year !== undefined) {
    from = Math.max(from, filters.year);
    to = Math.min(to, filters.year);
  }
  return { from, to };
}

/**
 * The text without its year tokens. A bare `OR` next to a removed filter goes with it: a filter
 * ends an OR in the parser (`a OR year:2015 b` is `a b`, both words required), so the OR was
 * already doing nothing, and left alone it would start doing something.
 */
function withoutYears(raw: string): string {
  return withoutFilters(raw, isYearToken);
}

/** The query, the filter words of `isFilter` (as the parser reads them) and the ORs around them taken out. */
export function withoutFilters(raw: string, isFilter: (token: Token) => boolean): string {
  // Work on the normalised text, as the Worker reads it: emoji touching a token would hide it.
  const q = normalizeQuery(raw);
  const tokens = scan(seen(q));
  const inRun = (t: Token | undefined): boolean => t !== undefined && (isFilter(t) || (t.kind === "word" && t.text === "OR"));
  const drop = new Set<number>();
  tokens.forEach((token, at) => {
    if (!isFilter(token) || drop.has(at)) return;
    // The run of year tokens and bare ORs around this one goes whole.
    let first = at;
    let last = at;
    while (inRun(tokens[first - 1])) first--;
    while (inRun(tokens[last + 1])) last++;
    for (let k = first; k <= last; k++) drop.add(k);
  });
  let out = "";
  let from = 0;
  tokens.forEach((token, at) => {
    if (!drop.has(at)) return;
    out += q.slice(from, token.start);
    from = token.end;
  });
  return normalizeQuery(out + q.slice(from));
}

/** The query without any `year:`, `year:A-B`, `before:` or `after:` token. */
export function clearRange(q: string): string {
  return withoutYears(q);
}

/**
 * The query with its year tokens replaced by one `year:A-B` at the end (`year:A` for one year).
 * The ends go in either order, as the parser takes them. The Worker reads only the first 200
 * code points, so when the token at the end would fall past them it goes first instead; no word
 * is dropped.
 */
export function setRange(q: string, from: number, to: number): string {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const token = low === high ? `year:${low}` : `year:${low}-${high}`;
  const rest = withoutYears(q);
  const appended = normalizeQuery(`${rest} ${token}`);
  if (Array.from(appended).length <= MAX_QUERY_CHARS) return appended;
  return normalizeQuery(`${token} ${rest}`);
}

/** The chip's text: "Any year", "2015" for one year, "2015–2020" (en dash) for a span. */
export function rangeLabel(range: YearRange | null): string {
  if (range === null) return "Any year";
  return range.from === range.to ? String(range.from) : `${range.from}–${range.to}`;
}
