// The dense result card, its hit rows, play buttons and ⋯ menu (spec §5.3; design:
// DenseResult.dc.html), built from the real response fixtures.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../worker/src/api-types";
import exactFixture from "../../pipeline/tests/fixtures/search/exact.json";
import smartFixture from "../../pipeline/tests/fixtures/search/smart.json";
import { ResultCard } from "../src/components/ResultCard";
import { result } from "./helpers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const exact = exactFixture.results as unknown as SearchResult[];
const smart = smartFixture.results as unknown as SearchResult[];
// exact[0]: all four links, two ranges, 2 folded. exact[1]: YouTube only, emoji before the ranges.
// exact[2]: unnumbered, page link only. smart[0]: YouTube + Spotify, folded 1. smart[1]: related,
// Apple and a page link. smart[2]: related, unnumbered, page only, one range.
const [full, emoji, bare] = exact as [SearchResult, SearchResult, SearchResult];
const [keywordHit, relatedApple, relatedBare] = smart as [SearchResult, SearchResult, SearchResult];

function card(hits: SearchResult[]) {
  return { episode: hits[0]!.episode, hits };
}

function renderCard(hits: SearchResult[], props: Partial<Parameters<typeof ResultCard>[0]> = {}) {
  return render(
    <ol>
      <ResultCard card={card(hits)} related={hits[0]!.match === "related"} tabIndex={0} phone={false} {...props} />
    </ol>,
  );
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

  it("opens More transcript on a click", () => {
    const onMore = vi.fn();
    const { container } = renderCard([full], { onMore });
    const excerpt = container.querySelector(".hit__excerpt")!;
    expect(excerpt.getAttribute("title")).toBe("Show full passage");
    fireEvent.click(excerpt);
    expect(onMore).toHaveBeenCalledWith(full);
  });

  it("does nothing on a click while text is selected", () => {
    const onMore = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "dovetail" } as Selection);
    const { container } = renderCard([full], { onMore });
    fireEvent.click(container.querySelector(".hit__excerpt")!);
    expect(onMore).not.toHaveBeenCalled();
  });
});

describe("the play links on a desktop", () => {
  it("shows every platform in the order YouTube, Apple, Spotify, the first filled", () => {
    renderCard([full]);
    const pills = [...document.querySelectorAll<HTMLAnchorElement>("a.play")];
    expect(pills.map((p) => p.getAttribute("aria-label"))).toEqual([
      "Play on YouTube, starts at 20:21",
      "Play on Apple, starts at 20:21",
      "Play on Spotify, starts at 20:21",
    ]);
    expect(pills.map((p) => p.getAttribute("href"))).toEqual([
      full.episode.links.youtube,
      full.episode.links.apple,
      full.episode.links.spotify,
    ]);
    expect(pills.map((p) => p.classList.contains("play--primary"))).toEqual([true, false, false]);
  });

  it("opens links in a new tab with rel=noopener, and the page never builds a link", () => {
    renderCard([full]);
    for (const link of screen.getAllByRole("link", { name: /^Play on/ })) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
      expect(Object.values(full.episode.links)).toContain(link.getAttribute("href"));
    }
  });

  it("names each link around its visible text, with its own platform's cue time when that differs", () => {
    const hit = { ...full, cue_s: { youtube: 4184, apple: 4100, spotify: 4000, page: 4184 }, hit_ms: 4_191_000 };
    renderCard([hit]);
    expect(screen.getByRole("link", { name: "Play on YouTube 1:09:51, starts at 1:09:44" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Play on YouTube, starts at 1:09:44" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Play on Apple, starts at 1:08:20" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Play on Spotify, starts at 1:06:40" })).toBeTruthy();
  });

  it("adds no 'starts at' when the cue is the hit time", () => {
    const hit = { ...full, cue_s: { youtube: 4191, apple: 4191, spotify: 4191, page: 4191 }, hit_ms: 4_191_000 };
    renderCard([hit]);
    expect(screen.getByRole("link", { name: "Play on YouTube 1:09:51" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Play on Apple" })).toBeTruthy();
  });

  it("every play link's name contains its visible text", () => {
    renderCard([full]);
    for (const link of screen.getAllByRole("link", { name: /^Play on/ })) {
      const visible = link.textContent!.trim();
      expect(link.getAttribute("aria-label")).toContain(visible);
    }
  });

  it("puts the hit time in the 76 px column; it plays on the first platform", () => {
    const hit = { ...full, cue_s: { youtube: 4184, apple: 4184, spotify: 4184, page: 4184 }, hit_ms: 4_191_000 };
    const { container } = renderCard([hit]);
    const time = container.querySelector<HTMLAnchorElement>("a.hit__time")!;
    expect(time.textContent).toBe("1:09:51");
    expect(time.getAttribute("aria-label")).toBe("Play on YouTube 1:09:51, starts at 1:09:44");
    expect(time.getAttribute("href")).toBe(full.episode.links.youtube);
    expect(container.querySelector(".hit")!.classList.contains("hit--gutter")).toBe(true);
  });

  it("with one platform shows one pill, and the note about ads only for Apple or Spotify", () => {
    renderCard([emoji]);
    expect(document.querySelectorAll("a.play")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /ads/ })).toBeNull();
    cleanup();
    renderCard([relatedApple]);
    expect(document.querySelectorAll("a.play")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /may start a bit early because of ads/i })).toBeTruthy();
  });

  it("the ads note opens a visible line and closes again", () => {
    renderCard([full]);
    const info = screen.getByRole("button", { name: /may start a bit early because of ads/i });
    expect(info.getAttribute("title")).toBe("May start a bit early because of ads");
    expect(info.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(info);
    expect(info.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("May start a bit early because of ads")).toBeTruthy();
    fireEvent.click(info);
    expect(screen.queryByText("May start a bit early because of ads")).toBeNull();
  });

  it("with no platform at all shows the time as text, no play links and no filled pill", () => {
    const { container } = renderCard([bare]);
    expect(screen.queryAllByRole("link", { name: /^Play on/ })).toHaveLength(0);
    const time = container.querySelector(".hit__time")!;
    expect(time.tagName).toBe("SPAN");
    expect(time.textContent).toBe("0:07");
    expect(screen.queryByRole("button", { name: /ads/ })).toBeNull();
  });

  it("shows '+N nearby' only for a hit with folded matches, and calls back", () => {
    const onNearby = vi.fn();
    renderCard([full], { onNearby });
    fireEvent.click(screen.getByRole("button", { name: "+2 nearby" }));
    expect(onNearby).toHaveBeenCalledWith(full);
    cleanup();
    renderCard([emoji]);
    expect(screen.queryByText(/nearby/)).toBeNull();
  });
});

describe("a related card", () => {
  it("is dashed with a Related tag, a muted excerpt and no filled pill", () => {
    const { container } = renderCard([relatedApple]);
    expect(container.querySelector("li")!.classList.contains("result--related")).toBe(true);
    expect(screen.getByText("Related")).toBeTruthy();
    expect(container.querySelectorAll(".play--primary")).toHaveLength(0);
    expect(container.querySelectorAll("a.play")).toHaveLength(1);
  });

  it("a keyword card has neither the tag nor the dashes", () => {
    const { container } = renderCard([keywordHit]);
    expect(container.querySelector("li")!.classList.contains("result--related")).toBe(false);
    expect(screen.queryByText("Related")).toBeNull();
    expect(container.querySelectorAll(".play--primary")).toHaveLength(1);
  });

  it("marks the ranges the API sent for a related hit", () => {
    const { container } = renderCard([relatedBare]);
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["glue"]);
  });
});

describe("the ⋯ menu", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  const items = () => within(screen.getByRole("menu")).getAllByRole("menuitem");

  it("is a button that opens a menu, with More transcript, Episode page and Report", () => {
    renderCard([full]);
    const button = screen.getByRole("button", { name: "More actions" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    open();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(items().map((i) => i.getAttribute("aria-label") ?? i.textContent)).toEqual([
      "More transcript",
      "Episode page, jump to 20:28",
      "Report transcript error",
    ]);
  });

  it("links the episode page from the API, in a new tab, and leaves it out without a page link", () => {
    renderCard([full]);
    open();
    const page = screen.getByRole("menuitem", { name: "Episode page, jump to 20:28" });
    expect(page.getAttribute("href")).toBe(full.episode.links.page);
    expect(page.getAttribute("target")).toBe("_blank");
    expect(page.getAttribute("rel")).toContain("noopener");
    cleanup();
    renderCard([{ ...relatedApple, episode: { ...relatedApple.episode, links: { apple: relatedApple.episode.links.apple } } }]);
    open();
    expect(screen.queryByRole("menuitem", { name: /Episode page/ })).toBeNull();
  });

  it("moves focus to the first item on opening, and the arrow keys move and wrap", () => {
    renderCard([full]);
    open();
    const [more, page, report] = items() as [HTMLElement, HTMLElement, HTMLElement];
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: "ArrowDown" });
    expect(document.activeElement).toBe(page);
    fireEvent.keyDown(page, { key: "ArrowDown" });
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

  it("More transcript and Report close the menu, return focus to ⋯ and call back with the hit", () => {
    const onMore = vi.fn();
    const onReport = vi.fn();
    renderCard([full], { onMore, onReport });
    const button = screen.getByRole("button", { name: "More actions" });
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
    expect(onMore).toHaveBeenCalledWith(full);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Report transcript error" }));
    expect(onReport).toHaveBeenCalledWith(full);
  });

  it("activating the Episode page link closes the menu and returns focus to ⋯", () => {
    renderCard([full]);
    const button = screen.getByRole("button", { name: "More actions" });
    open();
    const page = screen.getByRole("menuitem", { name: /^Episode page/ });
    page.addEventListener("click", (event) => event.preventDefault()); // no navigation in the test
    fireEvent.click(page);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("activating a Play link in the phone menu returns focus to ⋯", () => {
    renderCard([full], { phone: true });
    const button = screen.getByRole("button", { name: "More actions" });
    open();
    const apple = screen.getByRole("menuitem", { name: /^Play on Apple/ });
    apple.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(apple);
    expect(document.activeElement).toBe(button);
  });

  it("belongs to its own hit in a two-hit card", () => {
    const onMore = vi.fn();
    const second = { ...full, chunk_id: 61299, text: "Another dovetail line.", ranges: [] as [number, number][] };
    renderCard([full, second], { onMore });
    fireEvent.click(screen.getAllByRole("button", { name: "More actions" })[1]!);
    fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
    expect(onMore).toHaveBeenCalledWith(second);
  });
});

describe("on a phone", () => {
  it("shows the first platform only, as '▶ YouTube 1:09:51', and no time column", () => {
    const hit = { ...full, cue_s: { youtube: 4184, apple: 4184, spotify: 4184, page: 4184 }, hit_ms: 4_191_000 };
    const { container } = renderCard([hit], { phone: true });
    const pills = container.querySelectorAll<HTMLAnchorElement>("a.play");
    expect(pills).toHaveLength(1);
    expect(pills[0]!.textContent).toBe("YouTube1:09:51");
    expect(pills[0]!.getAttribute("aria-label")).toBe("Play on YouTube 1:09:51, starts at 1:09:44");
    expect(container.querySelector(".hit__time")).toBeNull();
    expect(container.querySelector(".hit")!.classList.contains("hit--gutter")).toBe(false);
    expect(screen.getAllByRole("link", { name: /^Play on/ })).toHaveLength(1);
  });

  it("moves the other platforms into the menu with the sub-line", () => {
    const hit = { ...full, cue_s: { youtube: 4184, apple: 4100, spotify: 4000, page: 4184 }, hit_ms: 4_191_000 };
    renderCard([hit], { phone: true });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const menu = within(screen.getByRole("menu"));
    const apple = menu.getByRole("menuitem", { name: "Play on Apple at 1:09:51 · may start early (ads), starts at 1:08:20" });
    expect(apple.getAttribute("href")).toBe(full.episode.links.apple);
    expect(apple.getAttribute("target")).toBe("_blank");
    expect(apple.textContent).toContain("at 1:09:51 · may start early (ads)");
    expect(menu.getByRole("menuitem", { name: "Play on Spotify at 1:09:51 · may start early (ads), starts at 1:06:40" })).toBeTruthy();
    expect(menu.getAllByRole("menuitem").map((i) => (i.getAttribute("aria-label") ?? i.textContent)?.slice(0, 12))).toEqual([
      "Play on Appl",
      "Play on Spot",
      "More transcri",
      "Episode page",
      "Report trans",
    ].map((s) => s.slice(0, 12)));
  });

  it("shows the ads note only when the shown platform is Apple or Spotify", () => {
    renderCard([full], { phone: true });
    expect(screen.queryByRole("button", { name: /ads/ })).toBeNull();
    cleanup();
    renderCard([relatedApple], { phone: true });
    expect(screen.getByRole("button", { name: /may start a bit early because of ads/i })).toBeTruthy();
  });

  it("opens the menu with Play on rows only for the platforms it does not show", () => {
    renderCard([emoji], { phone: true });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /^Play on/ })).toBeNull();
  });
});
