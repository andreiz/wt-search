// Field lengths the way the Worker counts them (spec §4.4): code points, after trimming. A
// `maxlength` attribute counts UTF-16 units, which disagrees on emoji, so the forms use this for
// both the counter and the limit.

/** How many characters the Worker sees in `text`. */
export function codePoints(text: string): number {
  return [...text.trim()].length;
}

/** The first `limit` code points of `text` (whole code points, never half a surrogate pair). */
export function clip(text: string, limit: number): string {
  const points = [...text];
  return points.length <= limit ? text : points.slice(0, limit).join("");
}
