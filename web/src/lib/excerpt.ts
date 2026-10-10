// What the card shows of a chunk (spec §5.3): a window of whole words around the first highlight,
// split into marked and plain pieces. Ranges are UTF-16 offsets into `text` (spec §4.4), which
// are JavaScript string indices, so they slice the text directly. Pure; no DOM.

export interface Segment {
  text: string;
  mark: boolean;
}

export interface Excerpt {
  segments: Segment[];
  /** Words were left out before the window: the card shows "…" there. */
  cutStart: boolean;
  /** Words were left out after the window. */
  cutEnd: boolean;
}

/** Words of lead-in before the first highlight. */
const LEAD_WORDS = 6;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Valid ranges only, clamped, off the middle of surrogate pairs, sorted and merged. */
function clean(text: string, ranges: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  for (const [from, to] of ranges) {
    let start = Math.max(0, Math.min(from, text.length));
    let end = Math.max(0, Math.min(to, text.length));
    if (end <= start) continue;
    if (start > 0 && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start -= 1;
    if (end < text.length && isLow(text.charCodeAt(end)) && isHigh(text.charCodeAt(end - 1))) end += 1;
    out.push([start, end]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of out) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** The whole text as pieces, the ranges marked. */
export function segments(text: string, ranges: readonly (readonly [number, number])[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of clean(text, ranges)) {
    if (start > at) out.push({ text: text.slice(at, start), mark: false });
    out.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

/**
 * A window of at most about `maxWords` whole words, starting a few words before the first range
 * (at the start of the text when there are none). A range that begins inside the window is never
 * cut: the window grows to hold it. Ranges outside the window are left out.
 */
export function excerpt(
  text: string,
  ranges: readonly (readonly [number, number])[],
  maxWords = 45,
): Excerpt {
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  if (words.length === 0) return { segments: [], cutStart: false, cutEnd: false };

  const all = clean(text, ranges);
  const first = all[0];
  const firstWord = first ? words.findIndex((w) => w.end > first[0]) : 0;
  const startWord = Math.max(0, firstWord - LEAD_WORDS);
  let endWord = Math.min(words.length, startWord + Math.max(1, Math.floor(maxWords)));

  // Grow the window over a range that straddles its end (a phrase can be several words long).
  for (;;) {
    const edge = words[endWord - 1]!.end;
    const straddling = all.find(([from, to]) => from < edge && to > edge);
    if (!straddling) break;
    const needed = words.findIndex((w) => w.end >= straddling[1]) + 1;
    if (needed <= endWord) break;
    endWord = needed;
  }

  const from = words[startWord]!.start;
  const to = words[endWord - 1]!.end;
  // Clamp each range to the window and keep it when anything of it is left (a range can cover
  // the whitespace trimmed from either end of the text).
  const inside = all
    .map(([start, end]): [number, number] => [Math.max(start, from) - from, Math.min(end, to) - from])
    .filter(([start, end]) => end > start);
  return {
    segments: segments(text.slice(from, to), inside),
    cutStart: startWord > 0,
    cutEnd: endWord < words.length,
  };
}
