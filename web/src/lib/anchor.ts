// Keeping the reader's place when the transcript opens or collapses: the arithmetic only, no DOM.
// All numbers are viewport coordinates in px; the result is what `window.scrollBy(0, delta)`
// takes (positive scrolls down, so the element moves up).

/** The gap left between the sticky header and an element that had to be moved clear of it. */
const MARGIN = 8;

export interface AnchorInput {
  /** Where the element should be: its viewport top when the reader clicked; null to only keep it visible. */
  recordedTop: number | null;
  /** The element's viewport top now. */
  top: number;
  /** The element's height. */
  height: number;
  /** The bottom edge of what the site header covers. */
  headerBottom: number;
  /** The bottom edge of the open transcript's strip (it sticks under the header); omitted or null with no strip. */
  stripBottom?: number | null;
  viewportHeight: number;
}

export function anchorDelta({
  recordedTop,
  top,
  height,
  headerBottom: header,
  stripBottom,
  viewportHeight,
}: AnchorInput): number {
  // The top of the room the reader can see: below the header, and below the strip if there is one.
  const headerBottom = Math.max(header, stripBottom ?? header);
  if (recordedTop === null) {
    // The reader has moved on: only rescue an element that is not on screen at all.
    const visible = top < viewportHeight && top + height > headerBottom;
    return visible ? 0 : top - (headerBottom + MARGIN);
  }
  // Scroll by the difference so the element ends at the recorded top...
  let delta = top - recordedTop;
  // ...unless that is under the header or off the bottom, then just below the header.
  if (recordedTop < headerBottom || recordedTop >= viewportHeight) {
    delta += recordedTop - (headerBottom + MARGIN);
  }
  return delta;
}
