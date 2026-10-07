// Word times decoder (spec §4.1). The inverse of the pipeline's encode_word_times
// (pipeline/src/wts/chunker.py): comma-joined deltas in ms, each from the previous word's
// start and the first from the chunk's start_ms. The two halves share
// worker/test/fixtures/word_times.json.

const INTEGER = /^-?\d+$/;

/**
 * Absolute word start times in ms, one per space-separated token of the chunk text. A delta
 * can be negative in principle, so `-` is accepted. Never throws: an empty string or any
 * part that is not an integer gives [], and the caller falls back to the chunk's start_ms.
 */
export function decodeWordTimes(startMs: number, encoded: string): number[] {
  const starts: number[] = [];
  let current = startMs;
  for (const part of encoded.split(",")) {
    const delta = part.trim();
    if (!INTEGER.test(delta)) return [];
    current += Number(delta);
    starts.push(current);
  }
  return starts;
}
