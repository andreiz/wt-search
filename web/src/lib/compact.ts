// When the phone header compacts (spec §5.2). Pure: no DOM, no Preact.
//
// The header's footprint in the page does not change when it compacts (components.css), so
// compacting cannot move the scroll position; the marks below still leave a wide gap so a
// small scroll never flips it back and forth.

/** Scrolled past this many px the header compacts. */
export const COMPACT_AT = 120;
/** Back at or above this it opens again. */
export const EXPAND_AT = 20;
/** The page must be able to scroll this far beyond COMPACT_AT, else it never compacts. */
const ROOM = 40;

export function nextCompact(was: boolean, scrollY: number, maxScrollY: number): boolean {
  if (maxScrollY < COMPACT_AT + ROOM) return false;
  return was ? scrollY > EXPAND_AT : scrollY > COMPACT_AT;
}
