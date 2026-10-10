// The sentence two neighbouring chunks share (spec §4.4, `repeat`). The chunker overlaps chunks
// by one sentence (pipeline/src/wts/chunker.py), so a transcript read chunk after chunk says that
// sentence twice. The shared words are the same words, so they have the same start times: that,
// and the same text, is how they are found. Pure; no I/O.

import { decodeWordTimes } from "./wordtimes";

/** What of a chunk the comparison needs. */
export interface RepeatChunk {
  start_ms: number;
  text: string;
  word_times: string;
}

interface Words {
  tokens: string[];
  times: number[];
}

/** The chunk's space-separated tokens and their start times; null when the two do not line up. */
function wordsOf(chunk: RepeatChunk): Words | null {
  const tokens = chunk.text.split(" ");
  const times = decodeWordTimes(chunk.start_ms, chunk.word_times);
  return times.length === tokens.length ? { tokens, times } : null;
}

/**
 * How many words at the end of `before` are the first words of `after`: the same tokens at the
 * same times. 0 when the chunks share nothing, or either one's word times cannot be read.
 */
export function sharedWords(before: RepeatChunk, after: RepeatChunk): number {
  const a = wordsOf(before);
  const b = wordsOf(after);
  if (!a || !b) return 0;
  for (let i = 0; i < a.tokens.length; i++) {
    const count = a.tokens.length - i;
    if (count > b.tokens.length || a.times[i] !== b.times[0]) continue;
    let same = true;
    for (let j = 0; j < count && same; j++) same = a.tokens[i + j] === b.tokens[j] && a.times[i + j] === b.times[j];
    if (same) return count;
  }
  return 0;
}

/** The last `count` words of `text` as a `[start, end)` range in UTF-16 code units; null for 0. */
export function tailRange(text: string, count: number): [number, number] | null {
  if (count <= 0) return null;
  const tokens = text.split(" ");
  return [text.length - tokens.slice(-count).join(" ").length, text.length];
}

/** The first `count` words of `text` as a `[start, end)` range; null for 0. */
export function headRange(text: string, count: number): [number, number] | null {
  if (count <= 0) return null;
  return [0, text.split(" ").slice(0, count).join(" ").length];
}
