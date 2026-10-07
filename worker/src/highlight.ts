// FTS5 highlights and the time of the first hit (spec §4.5; docs/word-times-and-highlights.md).
//
// The search SQL selects `highlight(chunks_fts, 0, char(1), char(2))`: the chunk text with
// \u0001 before and \u0002 after each matched FTS5 token. Those tokens can be parts of a
// space-separated word (`SawStop,` is marked as `SawStop` only), and a phrase match can be
// one span over several words. This turns that into plain text plus ranges, so the
// frontend never parses markers.

import { decodeWordTimes } from "./wordtimes";

const OPEN = "\u0001";
const CLOSE = "\u0002";

export interface Highlighted {
  /** The chunk text with the markers removed. */
  text: string;
  /** `[start, end)` offsets into `text` in UTF-16 code units (what `String.slice` takes), in order, never empty. */
  ranges: [number, number][];
  /** Index of the space-separated token holding the first range's start (the key into word_times); null with no ranges. */
  firstToken: number | null;
}

/**
 * Split marked text into plain text and ranges. Never throws on bad markers: an open while a
 * range is open is ignored, a close with none open is ignored, and a range still open at the
 * end closes at the end of the text.
 */
export function highlightRanges(marked: string): Highlighted {
  let text = "";
  const ranges: [number, number][] = [];
  let start: number | null = null;
  const close = (end: number): void => {
    if (start !== null && end > start) ranges.push([start, end]);
    start = null;
  };
  // Runs of ordinary text are appended whole, so `text.length` is the UTF-16 offset.
  for (const piece of marked.split(/([\u0001\u0002])/)) {
    if (piece === OPEN) {
      if (start === null) start = text.length;
    } else if (piece === CLOSE) {
      close(text.length);
    } else {
      text += piece;
    }
  }
  close(text.length);

  const first = ranges[0];
  const firstToken = first === undefined ? null : text.slice(0, first[0]).split(" ").length - 1;
  return { text, ranges, firstToken };
}

/**
 * The time in ms of the word that `firstToken` names, or the chunk's start_ms when there is
 * no token, it is out of range, or the word times do not decode.
 */
export function hitMs(chunk: { start_ms: number; word_times: string }, firstToken: number | null): number {
  if (firstToken === null) return chunk.start_ms;
  return decodeWordTimes(chunk.start_ms, chunk.word_times)[firstToken] ?? chunk.start_ms;
}
