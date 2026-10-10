// Small display formats for the result card and the summary line.

/** `m:ss`, or `h:mm:ss` from one hour on. Whole seconds; a negative time is 0:00. */
export function timestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Jun 10, 2010" from `YYYY-MM-DD` (or a longer ISO string). Read from the text, never through
 * `Date`, so no time zone can move the day. Text that is not a date comes back unchanged.
 */
export function episodeDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return iso;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

const number = new Intl.NumberFormat("en-US");

/** "318", "1,318", or "1,000+" when the count was capped. */
export function count(n: number, capped: boolean): string {
  return `${number.format(n)}${capped ? "+" : ""}`;
}
