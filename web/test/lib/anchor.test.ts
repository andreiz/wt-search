import { describe, expect, it } from "vitest";
import { anchorDelta } from "../../src/lib/anchor";

// The viewport is 800 px high, the sticky header's bottom edge is at 80.
const base = { height: 60, headerBottom: 80, viewportHeight: 800 };

describe("anchorDelta", () => {
  it.each([
    // recordedTop, top now, expected delta
    ["unchanged", 300, 300, 0],
    ["pushed down by paragraphs above", 300, 540, 240],
    ["pulled up", 300, 100, -200],
    ["recorded exactly at the header edge", 80, 200, 120],
  ])("anchors: %s", (_name, recordedTop, top, delta) => {
    expect(anchorDelta({ ...base, recordedTop, top })).toBe(delta);
  });

  it("puts the top 8 px below the header when the recorded top is under the header", () => {
    // Wanted top 40 is under the header (bottom 80): end at 88, so from top 300 scroll 212.
    expect(anchorDelta({ ...base, recordedTop: 40, top: 300 })).toBe(212);
  });

  it("puts the top 8 px below the header when the recorded top is below the viewport", () => {
    // From top 1000 the anchor scroll is 200 (to 800, the edge), then the clamp moves it to 88.
    expect(anchorDelta({ ...base, recordedTop: 800, top: 1000 })).toBe(912);
  });

  it("does not clamp a top inside the viewport", () => {
    expect(anchorDelta({ ...base, recordedTop: 790, top: 900 })).toBe(110);
  });

  it("keeps clear of the stuck strip when it is lower than the header", () => {
    // The strip's bottom is at 150: a recorded top of 120 is under it, so end at 158.
    expect(anchorDelta({ ...base, stripBottom: 150, recordedTop: 120, top: 300 })).toBe(300 - 158);
    // A top just below the strip stays where it was.
    expect(anchorDelta({ ...base, stripBottom: 150, recordedTop: 154, top: 300 })).toBe(146);
    // A strip higher than the header changes nothing.
    expect(anchorDelta({ ...base, stripBottom: 40, recordedTop: 120, top: 300 })).toBe(180);
    expect(anchorDelta({ ...base, stripBottom: null, recordedTop: 40, top: 300 })).toBe(212);
  });

  it("rescues an off-screen paragraph to just below the strip too", () => {
    expect(anchorDelta({ ...base, stripBottom: 150, recordedTop: null, top: 1500 })).toBe(1500 - 158);
    // Hidden behind the strip entirely (top -20, bottom 40, strip bottom 150).
    expect(anchorDelta({ ...base, stripBottom: 150, recordedTop: null, top: -20 })).toBe(-20 - 158);
  });

  it("without a recorded top, leaves a visible paragraph alone", () => {
    expect(anchorDelta({ ...base, recordedTop: null, top: 400 })).toBe(0);
    // Partly under the header still counts as visible.
    expect(anchorDelta({ ...base, recordedTop: null, top: 50 })).toBe(0);
    // A top one px above the viewport's bottom is still on screen.
    expect(anchorDelta({ ...base, recordedTop: null, top: 799 })).toBe(0);
  });

  it("without a recorded top, brings an invisible paragraph to 8 px under the header", () => {
    expect(anchorDelta({ ...base, recordedTop: null, top: 1500 })).toBe(1500 - 88);
    expect(anchorDelta({ ...base, recordedTop: null, top: -500 })).toBe(-500 - 88);
    expect(anchorDelta({ ...base, recordedTop: null, top: 800 })).toBe(800 - 88);
  });
});
