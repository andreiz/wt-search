// The dense result card, its hit rows, the timestamp chip and the ⋯ menu (spec §5.3; design:
// DenseResult.dc.html and docs/design/card-separation-options.html, option A), built from the
// real response fixtures.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepLinks, SearchResult } from "../../worker/src/api-types";
import exactFixture from "../../pipeline/tests/fixtures/search/exact.json";
import smartFixture from "../../pipeline/tests/fixtures/search/smart.json";
import { ResultCard } from "../src/components/ResultCard";
import { result, stubFetch } from "./helpers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const exact = exactFixture.results as unknown as SearchResult[];
const smart = smartFixture.results as unknown as SearchResult[];
// exact[0]: all four links, two ranges, 2 folded. exact[1]: YouTube only, emoji before the ranges.
// exact[2]: unnumbered, page link only. smart[0]: YouTube + Spotify, folded 1. smart[1]: related,
// Apple and a page link. smart[2]: related, unnumbered, page only, one range.
const [full, emoji, bare] = exact as [SearchResult, SearchResult, SearchResult];
const [keywordHit, relatedApple, relatedBare] = smart as [SearchResult, SearchResult, SearchResult];

function card(hits: SearchResult[]) {
  return { episode: hits[0]!.episode, hits, related: hits[0]!.match === "related" };
}

function renderCard(hits: SearchResult[], props: Partial<Parameters<typeof ResultCard>[0]> = {}) {
  return render(
    <ol>
      <ResultCard card={card(hits)} tabIndex={0} {...props} />
    </ol>,
  );
}

function withLinks(hit: SearchResult, links: DeepLinks): SearchResult {
  return { ...hit, episode: { ...hit.episode, links } };
}

describe("the header", () => {
  it("is 'Ep. 612 · Title' with the date on the right and no match count for one hit", () => {
    renderCard([full]);
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading.textContent).toBe("Ep. 612 · Dovetails, Glue and Bandsaw Tuning");
    expect(screen.getByText("Mar 12, 2024")).toBeTruthy();
    expect(screen.queryByText(/matches/)).toBeNull();
  });

  it("shows the title alone for an unnumbered episode", () => {
    renderCard([bare]);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Bonus: Shop Tour");
  });

  it("strips the episode's own number from the title", () => {
    const hit = result(552, { episode: { ...full.episode, number: 552, title: "552 - Embarrassed By All The Shiplap" } });
    renderCard([hit]);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Ep. 552 · Embarrassed By All The Shiplap");
  });

  it("names the card by its heading and is one stop for the keyboard", () => {
    renderCard([full]);
    const item = screen.getByRole("listitem", { name: /Dovetails, Glue and Bandsaw Tuning/ });
    expect(item.hasAttribute("data-result")).toBe(true);
    expect(item.getAttribute("tabindex")).toBe("0");
  });

  it("sits above the card's box, not in it, and still names the list item", () => {
    const { container } = renderCard([full]);
    const item = container.querySelector("li")!;
    const head = item.querySelector(".result__head")!;
    const box = item.querySelector(".result__card")!;
    expect(box.contains(head)).toBe(false);
    expect(item.contains(box)).toBe(true);
    expect(head.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box.querySelectorAll(".hit")).toHaveLength(1);
    const heading = head.querySelector("h3")!;
    expect(item.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("a two-hit card says '2 matches' before the date and rules off the second row", () => {
    const second = { ...full, chunk_id: 61299, hit_ms: 1_300_000, text: "Another dovetail line.", ranges: [[8, 16]] as [number, number][] };
    const { container } = renderCard([full, second]);
    expect(screen.getByText("2 matches")).toBeTruthy();
    expect(container.querySelector(".result__meta")?.textContent).toBe("2 matches · Mar 12, 2024");
    const rows = container.querySelectorAll(".hit");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.classList.contains("hit--ruled")).toBe(false);
    expect(rows[1]!.classList.contains("hit--ruled")).toBe(true);
    expect(screen.getAllByRole("button", { name: "More actions" })).toHaveLength(2);
  });
});

describe("the excerpt", () => {
  it("marks the ranges", () => {
    const { container } = renderCard([full]);
    const marks = [...container.querySelectorAll("mark")].map((m) => m.textContent);
    expect(marks).toEqual(full.ranges.map(([a, b]) => full.text.slice(a, b)));
    expect(marks).toEqual(["dovetail", "dovetail"]);
  });

  it("marks the right words after an emoji (UTF-16 offsets)", () => {
    const { container } = renderCard([emoji]);
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["dovetail", "dovetail"]);
  });

  it("has no marks when the API sent no ranges", () => {
    const { container } = renderCard([relatedApple]);
    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(container.textContent).toContain(relatedApple.text);
  });

  it("shows a window with '…' at the cut ends of a long chunk", () => {
    const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ");
    const at = long.indexOf("w80");
    const { container } = renderCard([result(1, { text: long, ranges: [[at, at + 3]] })]);
    const text = container.querySelector(".hit__excerpt")!.textContent!;
    expect(text.startsWith("…")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text).toContain("w80");
    expect(text).not.toContain("w0 ");
  });

  it("opens More transcript (radius 3) on a click", () => {
    const calls = stubFetch();
    const { container } = renderCard([full]);
    const excerpt = container.querySelector(".hit__excerpt")!;
    expect(excerpt.getAttribute("title")).toBe("Show full passage");
    fireEvent.click(excerpt);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("chunk")).toBe(String(full.chunk_id));
    expect(calls[0]!.url.searchParams.get("radius")).toBe("3");
    expect(screen.getByRole("region", { name: /^Transcript around/ })).toBeTruthy();
  });

  it("does nothing on a click while text is selected", () => {
    const calls = stubFetch();
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "dovetail" } as Selection);
    const { container } = renderCard([full]);
    fireEvent.click(container.querySelector(".hit__excerpt")!);
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("the timestamp chip", () => {
  const timed = { ...full, cue_s: { youtube: 4184, apple: 4100, spotify: 4000, page: 4184 }, hit_ms: 4_191_000 };

  it("is the one play control: a YouTube link named around its time, opening in a new tab", () => {
    const { container } = renderCard([timed]);
    const chip = container.querySelector<HTMLAnchorElement>("a.hit__time")!;
    expect(chip.textContent).toBe("1:09:51");
    expect(chip.getAttribute("aria-label")).toBe("Play on YouTube 1:09:51, starts at 1:09:44");
    expect(chip.getAttribute("title")).toBe("Play on YouTube 1:09:51, starts at 1:09:44");
    expect(chip.getAttribute("href")).toBe(full.episode.links.youtube);
    expect(chip.getAttribute("target")).toBe("_blank");
    expect(chip.getAttribute("rel")).toBe("noopener");
    expect(screen.getByRole("link", { name: "Play on YouTube 1:09:51, starts at 1:09:44" })).toBe(chip);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("adds no 'starts at' when the cue is the hit time", () => {
    renderCard([{ ...timed, cue_s: { youtube: 4191, apple: 4191, spotify: 4191, page: 4191 } }]);
    expect(screen.getByRole("link", { name: "Play on YouTube 1:09:51" })).toBeTruthy();
  });

  it("plays the show page when the episode has no YouTube, says where it starts and that an ad may play first", () => {
    const hit = withLinks(timed, { page: "https://page.test/ep?seek=4184" });
    renderCard([hit]);
    const name = "Play on the show page 1:09:51, starts at 1:09:44, may play an ad first";
    const chip = screen.getByRole("link", { name });
    expect(chip.getAttribute("href")).toBe("https://page.test/ep?seek=4184");
    expect(chip.getAttribute("target")).toBe("_blank");
    expect(chip.getAttribute("rel")).toBe("noopener");
    expect(chip.getAttribute("title")).toBe(name);
    expect(chip.classList.contains("hit__time")).toBe(true);
  });

  it("names a show page chip without 'starts at' when its cue is the hit time", () => {
    const hit = withLinks({ ...timed, cue_s: { ...timed.cue_s, page: 4191 } }, { page: "https://page.test/ep" });
    renderCard([hit]);
    expect(screen.getByRole("link", { name: "Play on the show page 1:09:51, may play an ad first" })).toBeTruthy();
  });

  it("is plain text, not a link, with neither YouTube nor a page (Apple or nothing)", () => {
    for (const links of [{ apple: "https://apple.test/1" }, {}] as DeepLinks[]) {
      const { container } = renderCard([withLinks(timed, links)]);
      const chip = container.querySelector(".hit__time")!;
      expect(chip.tagName).toBe("SPAN");
      expect(chip.classList.contains("hit__time--text")).toBe(true);
      expect(chip.textContent).toBe("1:09:51");
      expect(chip.hasAttribute("href")).toBe(false);
      expect(screen.queryAllByRole("link")).toHaveLength(0);
      cleanup();
    }
  });

  it("is the only play control: no pills, no ⓘ, no ads note, no actions row", () => {
    const { container } = renderCard([full]);
    expect(container.querySelector(".play")).toBeNull();
    expect(container.querySelector(".ads-info")).toBeNull();
    expect(container.querySelector(".hit__actions")).toBeNull();
    expect(container.querySelector(".hit__note")).toBeNull();
    expect(screen.queryByRole("button", { name: /ads/ })).toBeNull();
  });

  it("shows '+N nearby' only for a hit with folded matches, and it opens the radius 6 view", () => {
    const calls = stubFetch();
    renderCard([full]);
    fireEvent.click(screen.getByRole("button", { name: "+2 nearby" }));
    expect(calls.map((c) => c.url.searchParams.get("radius"))).toEqual(["6"]);
    cleanup();
    renderCard([emoji]);
    expect(screen.queryByText(/nearby/)).toBeNull();
  });

  it("puts the chip, ⋯ and '+N nearby' in the tab order in that order (the visual order)", () => {
    const { container } = renderCard([full]);
    const order = [...container.querySelectorAll<HTMLElement>("a[href], button")].map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(order).toEqual(["Play on YouTube 20:28, starts at 20:21", "More actions", "+2 nearby"]);
  });
});

describe("a related card", () => {
  it("is dashed with a Related tag in the header, and keeps its chip", () => {
    const { container } = renderCard([withLinks(relatedApple, { ...relatedApple.episode.links, youtube: "https://yt.test/r" })]);
    expect(container.querySelector("li")!.classList.contains("result--related")).toBe(true);
    expect(container.querySelector(".result__head .result__tag")?.textContent).toBe("Related");
    expect(container.querySelector("a.hit__time")?.getAttribute("href")).toBe("https://yt.test/r");
    expect(container.querySelector(".result__card")).toBeTruthy();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
  });

  it("a keyword card has neither the tag nor the dashes", () => {
    const { container } = renderCard([keywordHit]);
    expect(container.querySelector("li")!.classList.contains("result--related")).toBe(false);
    expect(screen.queryByText("Related")).toBeNull();
  });

  it("marks the ranges the API sent for a related hit", () => {
    const { container } = renderCard([relatedBare]);
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["glue"]);
  });
});

describe("the ⋯ menu", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  const items = () => within(screen.getByRole("menu")).getAllByRole("menuitem");
  const label = (el: Element) => el.getAttribute("aria-label") ?? el.textContent;

  it("is a button that opens a menu", () => {
    renderCard([full]);
    const button = screen.getByRole("button", { name: "More actions" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    open();
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("lists Show page, Apple, Spotify, More transcript and Report, with the sub-lines", () => {
    // Every cue (20:21) differs from the hit time (20:28), the page's too: its row still never says "starts at".
    renderCard([full]);
    open();
    expect(items().map(label)).toEqual([
      "Show page plays from 20:28, may play an ad first",
      "Play on Apple at 20:28 · may start minutes early, starts at 20:21",
      "Play on Spotify at 20:28 · may start minutes early, starts at 20:21",
      "More transcript",
      "Report transcript error",
    ]);
    expect(items().map((i) => i.firstChild?.textContent)).toEqual([
      "Show page",
      "Play on Apple",
      "Play on Spotify",
      "More transcript",
      "Report transcript error",
    ]);
    expect([...document.querySelectorAll(".menu-item__sub")].map((s) => s.textContent)).toEqual([
      "plays from 20:28, may play an ad first",
      "at 20:28 · may start minutes early",
      "at 20:28 · may start minutes early",
    ]);
    expect(screen.queryByText("Episode page")).toBeNull();
  });

  it("links the play rows from the API, in a new tab", () => {
    renderCard([full]);
    open();
    const [page, apple, spotify] = items() as [HTMLAnchorElement, HTMLAnchorElement, HTMLAnchorElement];
    expect([page, apple, spotify].map((a) => a.getAttribute("href"))).toEqual([
      full.episode.links.page,
      full.episode.links.apple,
      full.episode.links.spotify,
    ]);
    for (const link of [page, apple, spotify]) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener");
    }
  });

  it("has a rule between the play rows and More transcript, and again before Report", () => {
    renderCard([full]);
    open();
    expect(document.querySelectorAll(".more-menu__list [role='separator']")).toHaveLength(2);
  });

  it("leaves 'Show page' out when the page is the chip's link (no YouTube)", () => {
    renderCard([withLinks(full, { page: full.episode.links.page, apple: full.episode.links.apple })]);
    open();
    expect(items().map((i) => i.firstChild?.textContent)).toEqual(["Play on Apple", "More transcript", "Report transcript error"]);
  });

  it("with no links at all still opens, with More transcript and Report", () => {
    renderCard([withLinks(full, {})]);
    open();
    expect(items().map(label)).toEqual(["More transcript", "Report transcript error"]);
    expect(document.querySelectorAll(".more-menu__list [role='separator']")).toHaveLength(1);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("moves focus to the first item on opening, and the arrow keys move and wrap", () => {
    renderCard([withLinks(full, {})]);
    open();
    const [more, report] = items() as [HTMLElement, HTMLElement];
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: "ArrowDown" });
    expect(document.activeElement).toBe(report);
    fireEvent.keyDown(report, { key: "ArrowDown" });
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: "ArrowUp" });
    expect(document.activeElement).toBe(report);
    fireEvent.keyDown(report, { key: "Home" });
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: "End" });
    expect(document.activeElement).toBe(report);
  });

  it("Esc closes it and returns focus to ⋯", () => {
    renderCard([full]);
    const button = screen.getByRole("button", { name: "More actions" });
    open();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens from the keyboard with ArrowDown on the button", () => {
    renderCard([full]);
    const button = screen.getByRole("button", { name: "More actions" });
    button.focus();
    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(items()[0]);
  });

  it("closes on a press outside", () => {
    renderCard([full]);
    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the Tab key leaves the menu closed", () => {
    renderCard([full]);
    open();
    fireEvent.keyDown(document.activeElement as Element, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("More transcript and Report close the menu; Report returns focus to ⋯ and calls back with the hit", () => {
    const calls = stubFetch();
    const onReport = vi.fn();
    renderCard([full], { onReport });
    const button = screen.getByRole("button", { name: "More actions" });
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
    expect(calls.map((c) => c.url.searchParams.get("radius"))).toEqual(["3"]);
    expect(screen.queryByRole("menu")).toBeNull();
    // Focus goes on into the expanded view.
    expect(document.activeElement).toBe(screen.getByRole("region"));
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(document.activeElement).toBe(button);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Report transcript error" }));
    expect(onReport).toHaveBeenCalledWith(full);
  });

  it("activating a play row closes the menu and returns focus to ⋯", () => {
    renderCard([full]);
    const button = screen.getByRole("button", { name: "More actions" });
    for (const name of [/^Show page/, /^Play on Apple/]) {
      open();
      const row = screen.getByRole("menuitem", { name });
      row.addEventListener("click", (event) => event.preventDefault()); // no navigation in the test
      fireEvent.click(row);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(button);
    }
  });

  it("belongs to its own hit in a two-hit card", () => {
    const calls = stubFetch();
    const second = { ...full, chunk_id: 61299, text: "Another dovetail line.", ranges: [] as [number, number][] };
    renderCard([full, second]);
    fireEvent.click(screen.getAllByRole("button", { name: "More actions" })[1]!);
    fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
    expect(calls.map((c) => c.url.searchParams.get("chunk"))).toEqual(["61299"]);
  });
});
