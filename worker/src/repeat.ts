// The sentence two neighbouring chunks share (spec §4.4). The chunker overlaps chunks by one
// sentence (pipeline/src/wts/chunker.py), so a transcript read chunk after chunk says that
// sentence twice; /api/context takes one copy out. The shared words are the same words, so they
// have the same start times: that, and the same text, is how they are found. Pure; no I/O.

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

/** A chunk as the transcript shows it: its text, when that starts and ends, and the highlights in it. */
export interface Shown {
  text: string;
  start_ms: number;
  end_ms: number;
  ranges: [number, number][];
}

/** The ranges that fall in `[from, to)` of the old text, as offsets into that slice. */
function clip(ranges: [number, number][], from: number, to: number): [number, number][] {
  return ranges
    .map(([start, end]): [number, number] => [Math.max(start, from) - from, Math.min(end, to) - from])
    .filter(([start, end]) => end > start);
}

type Chunk = RepeatChunk & { end_ms: number };

/**
 * `chunk` without the words at its end that `next` starts with. It then ends where `next`
 * starts. Unchanged when they share nothing, or when nothing would be left.
 */
export function withoutTail(chunk: Chunk, ranges: [number, number][], next: RepeatChunk): Shown {
  const tokens = chunk.text.split(" ");
  const count = sharedWords(chunk, next);
  if (count === 0 || count >= tokens.length) return { text: chunk.text, start_ms: chunk.start_ms, end_ms: chunk.end_ms, ranges };
  const text = tokens.slice(0, -count).join(" ");
  return { text, start_ms: chunk.start_ms, end_ms: next.start_ms, ranges: clip(ranges, 0, text.length) };
}

/**
 * `chunk` without the words at its start that `previous` ends with. It then starts at its first
 * word that is left. Unchanged when they share nothing, or when nothing would be left.
 */
export function withoutHead(chunk: Chunk, ranges: [number, number][], previous: RepeatChunk): Shown {
  const tokens = chunk.text.split(" ");
  const count = sharedWords(previous, chunk);
  if (count === 0 || count >= tokens.length) return { text: chunk.text, start_ms: chunk.start_ms, end_ms: chunk.end_ms, ranges };
  const text = tokens.slice(count).join(" ");
  // sharedWords read the times, so there is one per token.
  const start_ms = decodeWordTimes(chunk.start_ms, chunk.word_times)[count] ?? chunk.start_ms;
  return { text, start_ms, end_ms: chunk.end_ms, ranges: clip(ranges, chunk.text.length - text.length, chunk.text.length) };
}
