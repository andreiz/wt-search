// Query parser (spec §4.3). Turns what a listener typed into an FTS5 MATCH expression, the
// text to embed, and the filters.
//
// The security rule (plan Review Focus 4): user text reaches FTS5 only inside double-quoted
// strings, with `"` doubled. Operators (AND, OR, NOT, parentheses, and `*` right after a
// closing quote) come only from parsed syntax, never from the text itself. So `text:glue`
// is the phrase "text:glue", not a column filter, and `NEAR(` is just a word. The parser
// never throws: any surprise falls back to plain words.

/** Longer queries are cut: bounds the FTS5 expression and the embedding input. */
export const MAX_QUERY_CHARS = 200;

export interface Filters {
  year?: number;
  before?: number;
  after?: number;
  ep?: number;
}

export interface ParsedQuery {
  /** FTS5 MATCH expression; null when there is nothing to match (empty input, only filters, or only exclusions). */
  fts: string | null;
  /** Text to embed for meaning-based search: the positive words and phrases only, space-joined. */
  semantic: string;
  filters: Filters;
  includeAds: boolean;
  /** Positive words as FTS5 strings (quoted; `*` kept on prefixes; phrases split into their words; no HIGHLIGHT_STOPWORDS), for highlighting related hits: callers join them with " OR ". Can be empty when `fts` isn't. */
  terms: string[];
  /** The excluded words and phrases ORed, as an FTS5 expression, or null. Smart search (Task 14) applies it to vector hits. */
  exclude: string | null;
}

/** Tokens with no letter or digit (`-`, `*`, emoji, punctuation) match nothing and are dropped. */
const SEARCHABLE = /[\p{L}\p{N}]/u;

/**
 * Words left out of `terms`, the highlights of meaning-only hits: FTS5 has no stopwords, and
 * a question like "how do I flatten a workbench top" would otherwise mark every "a" and "I"
 * in a related chunk. Matching, ranking and the embedding text keep them. Function words
 * only: nothing that means something in a shop ("up", "top", "back", "off", "out", "set").
 */
export const HIGHLIGHT_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "so", "than", "as", "because",
  "of", "at", "by", "for", "from", "in", "into", "on", "onto", "to", "with", "about",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "doing", "have", "has", "had", "having",
  "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his", "she", "her",
  "it", "its", "they", "them", "their", "this", "that", "these", "those", "there", "here",
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "can", "could", "would", "should", "will", "shall", "may", "might", "must",
  "not", "no", "just", "very", "any", "some", "also", "too",
  "i'm", "i've", "i'd", "i'll", "it's", "that's", "there's", "what's", "let's", "you're",
  "we're", "they're", "don't", "doesn't", "didn't", "can't", "won't", "isn't", "wasn't",
]);

/** Whether a word goes into `terms`. A prefix (`the*`) is deliberate, so it always does. */
function highlightable(word: string, prefix: boolean): boolean {
  return prefix || !HIGHLIGHT_STOPWORDS.has(word.toLowerCase());
}

const SMART_DOUBLE_QUOTES = new Set(["“", "”", "„", "‟", "″", "＂"]);
const SMART_SINGLE_QUOTES = new Set(["‘", "’", "‚", "‛", "′"]);

/**
 * Normalize raw input. Keyboards and phones type curly quotes, so they must act as the
 * straight ones. NUL would end an FTS5 string early and lone surrogates are not valid text,
 * so those become spaces, as do all control characters.
 */
function clean(input: unknown): string {
  if (typeof input !== "string") return "";
  // By code point, so the cut never splits a surrogate pair.
  return Array.from(input)
    .slice(0, MAX_QUERY_CHARS)
    .map((ch) => {
      if (/^[\ud800-\udfff]$/.test(ch) || /^\p{Cc}$/u.test(ch)) return " ";
      if (SMART_DOUBLE_QUOTES.has(ch)) return '"';
      if (SMART_SINGLE_QUOTES.has(ch)) return "'";
      return ch;
    })
    .join("");
}

/** The only way user text enters an FTS5 expression. */
function quote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

type Token = { kind: "word"; text: string } | { kind: "phrase"; text: string; negated: boolean };

/** Split into words and quoted phrases. `-"x"` negates the phrase; an unbalanced quote is dropped. */
function scan(text: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  const flush = (): void => {
    if (word !== "") tokens.push({ kind: "word", text: word });
    word = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (/\s/.test(ch)) {
      flush();
      i++;
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) {
        flush();
        i++;
        continue;
      }
      const negated = /^-+$/.test(word);
      if (negated) word = "";
      else flush();
      tokens.push({ kind: "phrase", text: text.slice(i + 1, end).trim().replace(/\s+/g, " "), negated });
      i = end + 1;
    } else {
      word += ch;
      i++;
    }
  }
  flush();
  return tokens;
}

const RANGE_FILTER = /^(year|before|after):(\d{4})$/i;
const EP_FILTER = /^ep:(\d{1,5})$/i;
const INCLUDE_ADS = /^include:ads$/i;

/** One FTS5 operand: an OR-group is parenthesized only when it has more than one member. */
function group(members: string[]): string {
  return members.length === 1 ? (members[0] ?? "") : `(${members.join(" OR ")})`;
}

function emptyQuery(): ParsedQuery {
  return { fts: null, semantic: "", filters: {}, includeAds: false, terms: [], exclude: null };
}

function parse(input: unknown): ParsedQuery {
  const filters: Filters = {};
  let includeAds = false;
  const groups: string[][] = [];
  const neg: string[] = [];
  const semantic: string[] = [];
  const terms: string[] = [];
  // `a OR b` joins b to a's group; OR needs a positive term right before it to mean anything.
  let pendingOr = false;
  let afterPositive = false;

  const term = (stem: string, negated: boolean, prefix: boolean, phrase = false): void => {
    if (!SEARCHABLE.test(stem)) return;
    if (negated) {
      neg.push(quote(stem) + (prefix ? "*" : ""));
      pendingOr = false;
      afterPositive = false;
      return;
    }
    const expression = quote(stem) + (prefix ? "*" : "");
    const last = groups.at(-1);
    if (pendingOr && last) last.push(expression);
    else groups.push([expression]);
    // A phrase highlights word by word: a meaning-only hit rarely has the exact phrase.
    if (phrase) {
      terms.push(...stem.split(" ").filter((w) => SEARCHABLE.test(w) && highlightable(w, false)).map(quote));
    } else if (highlightable(stem, prefix)) {
      terms.push(expression);
    }
    semantic.push(stem);
    pendingOr = false;
    afterPositive = true;
  };

  for (const token of scan(clean(input))) {
    if (token.kind === "phrase") {
      term(token.text, token.negated, false, true);
      continue;
    }
    const word = token.text;
    const range = RANGE_FILTER.exec(word);
    const ep = EP_FILTER.exec(word);
    if (word === "OR") {
      if (afterPositive) pendingOr = true;
    } else if (range) {
      filters[(range[1] ?? "").toLowerCase() as "year" | "before" | "after"] = Number(range[2]);
      pendingOr = false;
      afterPositive = false;
    } else if (ep) {
      filters.ep = Number(ep[1]);
      pendingOr = false;
      afterPositive = false;
    } else if (INCLUDE_ADS.test(word)) {
      includeAds = true;
      pendingOr = false;
      afterPositive = false;
    } else {
      const unsigned = word.replace(/^-+/, "");
      const stem = unsigned.replace(/\*+$/, "");
      term(stem, unsigned.length < word.length, stem.length < unsigned.length);
    }
  }

  let fts: string | null = null;
  if (groups.length > 0) {
    const positive = groups.map(group).join(" AND ");
    fts = neg.length > 0 ? `${groups.length > 1 ? `(${positive})` : positive} NOT ${group(neg)}` : positive;
  }
  return {
    fts,
    semantic: semantic.join(" "),
    filters,
    includeAds,
    terms,
    exclude: neg.length > 0 ? neg.join(" OR ") : null,
  };
}

/**
 * Plain words ANDed, no syntax at all: what the parser degrades to if it ever fails.
 * Exported for its test, since the parser is not expected to throw.
 */
export function fallbackQuery(input: string): ParsedQuery {
  try {
    const words = clean(input)
      .split(/[\s"]+/)
      .filter((w) => SEARCHABLE.test(w));
    if (words.length === 0) return emptyQuery();
    return {
      ...emptyQuery(),
      fts: words.map(quote).join(" AND "),
      semantic: words.join(" "),
      terms: words.filter((w) => highlightable(w, false)).map(quote),
    };
  } catch {
    return emptyQuery();
  }
}

export function parseQuery(input: string): ParsedQuery {
  try {
    return parse(input);
  } catch {
    return fallbackQuery(input);
  }
}
