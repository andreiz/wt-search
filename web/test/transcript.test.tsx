// More transcript and "+N nearby" (spec §5.4): the expanded view under a hit's row, built from
// the /api/context answer. The fetch is stubbed; the answers come from test/fixtures/context.ts.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { createRef } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextResponse, SearchResult } from "../../worker/src/api-types";
import { App } from "../src/app";
import { ResultList } from "../src/components/ResultList";
import { handleKeydown } from "../src/lib/keys";
import { chunkOf, contextAnswer, FOLDED_ID, HIT, HIT_ID, HIT_TEXT } from "./fixtures/context";
import { exactBody, stubFetch, type PendingCall } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function renderList(results: SearchResult[] = [HIT], onSearchEpisode = vi.fn()) {
  const listRef = createRef<HTMLDivElement>();
  const view = render(<ResultList results={results} page={1} listRef={listRef} onSearchEpisode={onSearchEpisode} />);
  return { ...view, onSearchEpisode };
}

const nearby = () => screen.getByRole("button", { name: "+1 nearby" });
const moreActions = () => screen.getByRole("button", { name: "More actions" });
const region = () => screen.getByRole("region", { name: "Transcript around 2:35" });

function openFromMenu() {
  fireEvent.click(moreActions());
  fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
}

/** Waits until the open view has its paragraphs (the page's own cards are list items too). */
const loaded = () => waitFor(() => expect(within(region()).getAllByRole("listitem").length).toBeGreaterThan(0));

/** Answer a pending context call with the fixture for its own radius. */
function answer(call: PendingCall) {
  call.respond(contextAnswer(Number(call.url.searchParams.get("radius"))));
}

describe("the three ways in", () => {
  it("'+N nearby' fetches radius 6 for the hit's chunk", async () => {
    const calls = stubFetch();
    renderList();
    fireEvent.click(nearby());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/api/context");
    expect(calls[0]!.url.searchParams.get("chunk")).toBe(String(HIT_ID));
    expect(calls[0]!.url.searchParams.get("radius")).toBe("6");
  });

  it("the menu's More transcript fetches radius 3", () => {
    const calls = stubFetch();
    renderList();
    openFromMenu();
    expect(calls.map((c) => c.url.searchParams.get("radius"))).toEqual(["3"]);
  });

  it("a click on the excerpt fetches radius 3", () => {
    const calls = stubFetch();
    const { container } = renderList();
    fireEvent.click(container.querySelector(".hit__excerpt")!);
    expect(calls.map((c) => c.url.searchParams.get("radius"))).toEqual(["3"]);
  });

  it("a click on the excerpt while text is selected opens nothing", () => {
    const calls = stubFetch();
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "dovetail" } as Selection);
    const { container } = renderList();
    fireEvent.click(container.querySelector(".hit__excerpt")!);
    expect(calls).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("opens under the hit's own row, inside its card, and only for that hit", async () => {
    const calls = stubFetch();
    const other: SearchResult = { ...HIT, chunk_id: 9001, text: "Another one.", ranges: [], folded: [], more_in_episode: 0 };
    const { container } = renderList([other, HIT]);
    const rows = container.querySelectorAll(".hit");
    expect(rows).toHaveLength(2);
    fireEvent.click(within(rows[1] as HTMLElement).getByRole("button", { name: "+1 nearby" }));
    answer(calls[0]!);
    await screen.findByRole("region");
    expect(rows[0]!.querySelector(".transcript")).toBeNull();
    expect(rows[1]!.querySelector(".transcript")).not.toBeNull();
    expect(rows[1]!.closest(".result__card")).not.toBeNull();
  });

  it("opens on a related card the same way", async () => {
    const calls = stubFetch();
    renderList([{ ...HIT, match: "related", ranges: [], folded: [], more_in_episode: 0 }]);
    openFromMenu();
    answer(calls[0]!);
    expect(await screen.findByRole("region", { name: "Transcript around 2:35" })).toBeTruthy();
    expect(document.querySelector(".result--related .transcript")).not.toBeNull();
  });
});

describe("the paragraphs", () => {
  async function open(radius: 3 | 6) {
    const calls = stubFetch();
    renderList();
    if (radius === 6) fireEvent.click(nearby());
    else openFromMenu();
    answer(calls[0]!);
    await loaded();
    return calls;
  }

  const rows = () => within(region()).getAllByRole("listitem");

  it("shows one paragraph per chunk, in order, each labelled with its start time", async () => {
    await open(6);
    expect(rows()).toHaveLength(10);
    const times = rows().map((row) => within(row).getAllByRole("link")[0]!.textContent);
    expect(times).toEqual(["0:00", "0:30", "1:00", "1:30", "2:00", "2:30", "3:00", "3:30", "4:00", "4:30"]);
    expect(rows().map((row) => row.querySelector("p")!.textContent)).toEqual(
      contextAnswer(6).chunks.map((chunk) => chunk.text),
    );
  });

  it("radius 3 shows seven paragraphs", async () => {
    await open(3);
    expect(rows()).toHaveLength(7);
  });

  it("emphasises the hit's paragraph and marks the result's ranges in it, nowhere else", async () => {
    await open(6);
    const hit = rows().filter((row) => row.classList.contains("passage--hit"));
    expect(hit).toHaveLength(1);
    expect(hit[0]!.querySelector("p")!.textContent).toBe(HIT_TEXT);
    expect([...region().querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["dovetail"]);
    expect(hit[0]!.querySelector("mark")).not.toBeNull();
    // Chunk 7 also says "dovetail", but the API sent no ranges for it.
    const later = rows()[7]!;
    expect(later.querySelector("p")!.textContent).toContain("dovetail");
    expect(later.querySelector("mark")).toBeNull();
  });

  it("says in words which paragraph is the match, not by colour alone", async () => {
    await open(6);
    const hit = rows().find((row) => row.classList.contains("passage--hit"))!;
    expect(within(hit).getByText("Matching passage")).toBeTruthy();
  });

  it("labels the folded chunk's paragraph 'Nearby match' in the radius 6 view", async () => {
    await open(6);
    const folded = rows().filter((row) => row.classList.contains("passage--fold"));
    expect(folded).toHaveLength(1);
    expect(folded[0]!.textContent).toContain("Nearby match");
    expect(folded[0]!.querySelector("p")!.textContent).toBe(chunkOf(7).text);
    expect(within(region()).getAllByText("Nearby match")).toHaveLength(1);
  });

  it("does not mark folded chunks in the radius 3 view", async () => {
    await open(3);
    expect(region().querySelector(".passage--fold")).toBeNull();
    expect(within(region()).queryByText("Nearby match")).toBeNull();
  });

  it("gives a sponsor read no treatment of its own", async () => {
    await open(6);
    const ad = rows()[8]!;
    expect(ad.textContent).toContain("brought to you by Sponsorly");
    expect(ad.textContent).not.toMatch(/sponsor read/i);
    expect(ad.className).toBe("passage");
  });

  it("does not mark the hit's paragraph when the chunk's text is not the result's text", async () => {
    const calls = stubFetch();
    renderList([{ ...HIT, text: "A different text altogether." }]);
    fireEvent.click(nearby());
    answer(calls[0]!);
    await screen.findByRole("region");
    expect(region().querySelector("mark")).toBeNull();
  });
});

describe("the timestamp labels", () => {
  async function openWith(answerBody: ContextResponse) {
    const calls = stubFetch();
    renderList();
    openFromMenu();
    calls[0]!.respond(answerBody);
    await screen.findByRole("region");
  }

  it("play on YouTube from the chunk's own link, named around the visible time", async () => {
    await openWith(contextAnswer(3));
    const link = screen.getByRole("link", { name: "Play on YouTube 2:30, starts at 2:33" });
    expect(link.textContent).toBe("2:30");
    expect(link.getAttribute("href")).toBe(chunkOf(5).links.youtube);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("title")).toBe("Play on YouTube 2:30, starts at 2:33");
  });

  it("play on the show page when there is no YouTube, and say it may play an ad", async () => {
    const body = contextAnswer(3);
    body.chunks = body.chunks.map((chunk) => {
      const { youtube: _y, ...links } = chunk.links;
      return { ...chunk, links };
    });
    await openWith(body);
    const link = screen.getByRole("link", { name: "Play on the show page 2:30, starts at 2:23, may play an ad first" });
    expect(link.getAttribute("href")).toBe("https://example.com/ep/301");
  });

  it("are plain text with neither", async () => {
    const body = contextAnswer(3);
    body.chunks = body.chunks.map((chunk) => ({ ...chunk, links: { apple: chunk.links.apple } }));
    await openWith(body);
    expect(within(region()).queryAllByRole("link")).toHaveLength(0);
    expect(within(region()).getAllByText("2:30").length).toBeGreaterThan(0);
  });
});

describe("fetching", () => {
  it("fetches once per radius: reopening radius 3 reuses the answer, radius 6 fetches once more", async () => {
    const calls = stubFetch();
    renderList();
    openFromMenu();
    answer(calls[0]!);
    await screen.findByRole("region");

    // Collapse and reopen at the same radius: no new request.
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("region")).toBeNull();
    openFromMenu();
    expect(within(region()).getAllByRole("listitem")).toHaveLength(7);
    expect(calls).toHaveLength(1);

    // The wider view is one more request.
    fireEvent.click(nearby());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("radius")).toBe("6");
    answer(calls[1]!);
    await waitFor(() => expect(within(region()).getAllByRole("listitem")).toHaveLength(10));

    // Back to 3 and to 6 again: neither fetches.
    openFromMenu();
    expect(within(region()).getAllByRole("listitem")).toHaveLength(7);
    fireEvent.click(nearby());
    expect(within(region()).getAllByRole("listitem")).toHaveLength(10);
    expect(calls).toHaveLength(2);
  });

  it("shows a loading state in the card until the answer comes", async () => {
    const calls = stubFetch();
    renderList();
    fireEvent.click(nearby());
    expect(within(region()).getByRole("status").textContent).toBe("Loading transcript…");
    expect(within(region()).queryAllByRole("listitem")).toHaveLength(0);
    answer(calls[0]!);
    await waitFor(() => expect(within(region()).queryByRole("status")).toBeNull());
    expect(within(region()).getAllByRole("listitem")).toHaveLength(10);
  });

  it("aborts a request that is still running when the card collapses, and fetches again on reopening", async () => {
    const calls = stubFetch();
    renderList();
    openFromMenu();
    expect(calls[0]!.signal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(screen.queryByRole("region")).toBeNull();
    openFromMenu();
    expect(calls).toHaveLength(2);
    expect(within(region()).getByRole("status")).toBeTruthy();
  });

  it("aborts when the list goes away (a new search)", async () => {
    const calls = stubFetch();
    const view = renderList();
    fireEvent.click(nearby());
    view.unmount();
    await waitFor(() => expect(calls[0]!.signal.aborted).toBe(true));
  });

  it("switching to the wider view aborts the narrower request, which is not kept", async () => {
    const calls = stubFetch();
    renderList();
    openFromMenu();
    fireEvent.click(nearby());
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls).toHaveLength(2);
    answer(calls[1]!);
    await waitFor(() => expect(within(region()).getAllByRole("listitem")).toHaveLength(10));
  });
});

describe("failures", () => {
  it("shows an error with a retry, and the retry fetches again", async () => {
    const calls = stubFetch();
    renderList();
    fireEvent.click(nearby());
    calls[0]!.respond({ error: "boom" }, 500);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the transcript.");
    fireEvent.click(within(region()).getByRole("button", { name: "Try again" }));
    expect(calls).toHaveLength(2);
    expect(within(region()).getByRole("status")).toBeTruthy();
    answer(calls[1]!);
    await waitFor(() => expect(within(region()).getAllByRole("listitem")).toHaveLength(10));
    expect(within(region()).queryByRole("alert")).toBeNull();
  });

  it("a network failure is the same error, and the card can still be collapsed", async () => {
    const calls = stubFetch();
    renderList();
    openFromMenu();
    calls[0]!.fail();
    await screen.findByRole("alert");
    fireEvent.click(within(region()).getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("shows the maintenance message plainly", async () => {
    const calls = stubFetch();
    renderList();
    openFromMenu();
    calls[0]!.respond({ error: "maintenance", message: "Down for a bit." }, 503);
    expect((await screen.findByRole("alert")).textContent).toContain("Down for a bit.");
    expect(within(region()).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says when to try again after a rate limit", async () => {
    const calls = stubFetch();
    renderList();
    openFromMenu();
    calls[0]!.respond({ error: "rate_limited" }, 429, { "retry-after": "30" });
    expect((await screen.findByRole("alert")).textContent).toContain("Too many requests from here; try again in a minute.");
  });

  it("reopening after a failure fetches again", async () => {
    const calls = stubFetch();
    renderList();
    openFromMenu();
    calls[0]!.fail();
    await screen.findByRole("alert");
    fireEvent.click(within(region()).getByRole("button", { name: "Show less" }));
    openFromMenu();
    expect(calls).toHaveLength(2);
  });
});

// The open view replaces the hit's excerpt and chip (spec §5.4: "expands the card in place …
// collapsing returns to the excerpt"); the transcript's own row for the hit carries the time.
describe("the open view replaces the excerpt", () => {
  const row = (container: Element) => container.querySelector<HTMLElement>(".hit")!;

  it("hides the excerpt and the chip while loading, keeping ⋯ and '+N nearby'", () => {
    stubFetch();
    const { container } = renderList();
    expect(row(container).querySelector(".hit__excerpt")).not.toBeNull();
    expect(row(container).querySelector(".hit__time")).not.toBeNull();
    fireEvent.click(nearby());
    expect(within(region()).getByRole("status")).toBeTruthy();
    expect(row(container).querySelector(".hit__excerpt")).toBeNull();
    expect(row(container).querySelector(".hit__time")).toBeNull();
    expect(row(container).classList.contains("hit--open")).toBe(true);
    expect(nearby().getAttribute("aria-expanded")).toBe("true");
    expect(moreActions()).toBeTruthy();
  });

  it("hides them once loaded, and the hit's text shows once", async () => {
    const calls = stubFetch();
    const { container } = renderList();
    openFromMenu();
    answer(calls[0]!);
    await loaded();
    expect(row(container).querySelector(".hit__excerpt")).toBeNull();
    expect(container.textContent!.split(HIT_TEXT).length - 1).toBe(1);
  });

  it("hides them when the answer failed too", async () => {
    const calls = stubFetch();
    const { container } = renderList();
    fireEvent.click(nearby());
    calls[0]!.fail();
    await screen.findByRole("alert");
    expect(row(container).querySelector(".hit__excerpt")).toBeNull();
    expect(row(container).querySelector(".hit__time")).toBeNull();
  });

  it("brings the excerpt and the chip back on collapse, with focus on the opener", async () => {
    const calls = stubFetch();
    const { container } = renderList();
    fireEvent.click(container.querySelector(".hit__excerpt")!);
    answer(calls[0]!);
    await loaded();
    fireEvent.click(within(region()).getByRole("button", { name: "Show less" }));
    expect(row(container).querySelector(".hit__excerpt")).not.toBeNull();
    expect(row(container).querySelector("a.hit__time")).not.toBeNull();
    expect(row(container).classList.contains("hit--open")).toBe(false);
    expect(document.activeElement).toBe(moreActions());
  });

  it("marks a row without '+N nearby' so the view can sit beside ⋯", () => {
    stubFetch();
    const { container } = renderList([{ ...HIT, folded: [], more_in_episode: 0 }]);
    fireEvent.click(moreActions());
    fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
    expect(row(container).classList.contains("hit--open")).toBe(true);
    expect(row(container).classList.contains("hit--bare")).toBe(true);
  });

  it("the hit's own row in the view carries its time label and the emphasis", async () => {
    const calls = stubFetch();
    renderList();
    fireEvent.click(nearby());
    answer(calls[0]!);
    await loaded();
    const hit = within(region()).getAllByRole("listitem").find((li) => li.classList.contains("passage--hit"))!;
    expect(within(hit).getByRole("link", { name: "Play on YouTube 2:30, starts at 2:33" })).toBeTruthy();
  });
});

describe("an unusable answer is the load error", () => {
  async function failsWith(body: unknown) {
    const calls = stubFetch();
    renderList();
    fireEvent.click(nearby());
    calls[0]!.respond(body);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the transcript.");
    expect(within(region()).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(region()).queryAllByRole("listitem")).toHaveLength(0);
  }

  it("chunks that are not an array", () => failsWith({ ...contextAnswer(6), chunks: "nope" }));
  it("chunks missing", () => failsWith({ chunk_id: HIT_ID, episode: contextAnswer(6).episode }));
  it("no chunks", () => failsWith({ ...contextAnswer(6), chunks: [] }));
  it("chunks without the hit's chunk", () =>
    failsWith({ ...contextAnswer(6), chunks: contextAnswer(6).chunks.filter((c) => c.chunk_id !== HIT_ID) }));
});

describe("the arrows inside the open view", () => {
  const ctx = (list: HTMLElement) => ({ input: null, list });

  it("do not move to another card and are not prevented; j and k still do", async () => {
    const calls = stubFetch();
    const other: SearchResult = { ...HIT, episode: { ...HIT.episode, id: 34 }, chunk_id: 9002, folded: [], more_in_episode: 0 };
    const listRef = createRef<HTMLDivElement>();
    render(<ResultList results={[HIT, other]} page={1} listRef={listRef} />);
    const cards = [...listRef.current!.querySelectorAll<HTMLElement>("[data-result]")];
    fireEvent.click(nearby());
    answer(calls[0]!);
    await loaded();
    const link = within(region()).getAllByRole("link")[0]!;
    link.focus();
    for (const key of ["ArrowDown", "ArrowUp"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(handleKeydown(event, ctx(listRef.current!)), key).toBe(false);
      expect(event.defaultPrevented, key).toBe(false);
      expect(document.activeElement).toBe(link);
    }
    region().focus();
    const onRegion = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    region().dispatchEvent(onRegion);
    expect(handleKeydown(onRegion, ctx(listRef.current!))).toBe(false);
    expect(document.activeElement).toBe(region());

    const j = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
    link.focus();
    link.dispatchEvent(j);
    expect(handleKeydown(j, ctx(listRef.current!))).toBe(true);
    expect(document.activeElement).toBe(cards[1]);
    const k = new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true });
    cards[1]!.dispatchEvent(k);
    expect(handleKeydown(k, ctx(listRef.current!))).toBe(true);
    expect(document.activeElement).toBe(cards[0]);
  });

  it("still move between cards from the card itself", () => {
    stubFetch();
    const other: SearchResult = { ...HIT, episode: { ...HIT.episode, id: 34 }, chunk_id: 9002, folded: [], more_in_episode: 0 };
    const listRef = createRef<HTMLDivElement>();
    render(<ResultList results={[HIT, other]} page={1} listRef={listRef} />);
    const cards = [...listRef.current!.querySelectorAll<HTMLElement>("[data-result]")];
    cards[0]!.focus();
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    cards[0]!.dispatchEvent(down);
    expect(handleKeydown(down, ctx(listRef.current!))).toBe(true);
    expect(document.activeElement).toBe(cards[1]);
  });
});

describe("keyboard and focus", () => {
  it("'+N nearby' says whether the view is open, and Show less closes it and returns focus to it", async () => {
    const calls = stubFetch();
    renderList();
    const button = nearby();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(region().id);
    // Focus moves into the card as soon as it opens, so a keyboard user is not left behind.
    expect(document.activeElement).toBe(region());
    answer(calls[0]!);
    await waitFor(() => expect(within(region()).getAllByRole("listitem")).toHaveLength(10));
    expect(document.activeElement).toBe(region());

    fireEvent.click(within(region()).getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("region")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("Esc inside the card collapses it and returns focus to the opener", async () => {
    const calls = stubFetch();
    renderList();
    const button = nearby();
    fireEvent.click(button);
    answer(calls[0]!);
    await loaded();
    fireEvent.keyDown(within(region()).getAllByRole("link")[0]!, { key: "Escape" });
    expect(screen.queryByRole("region")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("opened from the menu, the menu item says it is open and collapsing returns focus to ⋯", async () => {
    const calls = stubFetch();
    renderList();
    fireEvent.click(moreActions());
    expect(screen.getByRole("menuitem", { name: "More transcript" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
    expect(document.activeElement).toBe(region());
    answer(calls[0]!);
    await loaded();

    fireEvent.click(moreActions());
    const item = screen.getByRole("menuitem", { name: "More transcript" });
    expect(item.getAttribute("aria-expanded")).toBe("true");
    // The nearby button is for the wider view only.
    expect(nearby().getAttribute("aria-expanded")).toBe("false");

    // Choosing it again closes the view, like any disclosure.
    fireEvent.click(item);
    expect(screen.queryByRole("region")).toBeNull();
    expect(document.activeElement).toBe(moreActions());
  });

  it("opened by the excerpt, collapsing returns focus to ⋯ (the excerpt itself is not focusable)", async () => {
    const calls = stubFetch();
    const { container } = renderList();
    const excerpt = container.querySelector<HTMLElement>(".hit__excerpt")!;
    expect(excerpt.getAttribute("tabindex")).toBeNull();
    expect(excerpt.getAttribute("role")).toBeNull();
    fireEvent.click(excerpt);
    answer(calls[0]!);
    await loaded();
    fireEvent.click(within(region()).getByRole("button", { name: "Show less" }));
    expect(document.activeElement).toBe(moreActions());
  });

  it("Esc with focus on the region itself collapses it and returns focus to the opener", async () => {
    stubFetch();
    renderList();
    const button = nearby();
    fireEvent.click(button);
    expect(document.activeElement).toBe(region());
    fireEvent.keyDown(region(), { key: "Escape" });
    expect(screen.queryByRole("region")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("the card's controls come after '+N nearby' in the tab order", async () => {
    const calls = stubFetch();
    const { container } = renderList();
    fireEvent.click(nearby());
    answer(calls[0]!);
    await loaded();
    const order = [...container.querySelectorAll<HTMLElement>("a[href], button")];
    expect(order.indexOf(nearby())).toBeLessThan(order.indexOf(within(region()).getAllByRole("link")[0]!));
    expect(order.at(-1)!.textContent).toBe("Show less");
  });
});

describe("Search this episode", () => {
  it("is offered for a numbered episode and calls back with its number", async () => {
    const calls = stubFetch();
    const { onSearchEpisode } = renderList();
    openFromMenu();
    answer(calls[0]!);
    await loaded();
    const button = within(region()).getByRole("button", { name: "Search this episode ep:301" });
    expect(button.textContent).toBe("Search this episode ep:301");
    fireEvent.click(button);
    expect(onSearchEpisode).toHaveBeenCalledWith(301);
  });

  it("is left out for an unnumbered episode", async () => {
    const calls = stubFetch();
    renderList([{ ...HIT, episode: { ...HIT.episode, number: null } }]);
    openFromMenu();
    answer(calls[0]!);
    await loaded();
    expect(within(region()).queryByRole("button", { name: /Search this episode/ })).toBeNull();
    expect(within(region()).getByRole("button", { name: "Show less" })).toBeTruthy();
  });
});

describe("in the page", () => {
  it("'Search this episode' puts the searched query and ep:N in the box and searches, replacing an ep: token", async () => {
    window.history.replaceState(null, "", "/?q=dovetail+ep%3A12+year%3A2015&mode=exact");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(exactBody([HIT]));
    fireEvent.click(await screen.findByRole("button", { name: "+1 nearby" }));
    expect(calls[1]!.url.pathname).toBe("/api/context");
    answer(calls[1]!);
    await loaded();
    // The box is edited but not searched: the searched query is what counts.
    const box = screen.getByLabelText("Search the transcripts") as HTMLInputElement;
    fireEvent.input(box, { target: { value: "something else typed" } });

    fireEvent.click(within(region()).getByRole("button", { name: "Search this episode ep:301" }));

    expect(calls).toHaveLength(3);
    expect(calls[2]!.url.pathname).toBe("/api/search");
    expect(calls[2]!.url.searchParams.get("q")).toBe("dovetail year:2015 ep:301");
    expect(calls[2]!.url.searchParams.get("page")).toBe("1");
    expect(box.value).toBe("dovetail year:2015 ep:301");
    expect(window.location.search).toContain("q=dovetail+year%3A2015+ep%3A301");
    // A new search throws the expanded view away.
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("a new search closes an open view and aborts its request", async () => {
    window.history.replaceState(null, "", "/?q=dovetail&mode=exact");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(exactBody([HIT]));
    fireEvent.click(await screen.findByRole("button", { name: "+1 nearby" }));
    const context = calls[1]!;
    fireEvent.input(screen.getByLabelText("Search the transcripts"), { target: { value: "glue" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(context.signal.aborted).toBe(true);
    expect(screen.queryByRole("region")).toBeNull();
  });
});

// Keeps the folded id in the fixture honest.
describe("the fixture", () => {
  it("has the folded chunk inside both radii and an answer cut at the ends of the episode", () => {
    expect(HIT.folded).toEqual([FOLDED_ID]);
    expect(contextAnswer(3).chunks.map((c) => c.seq)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(contextAnswer(6).chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(contextAnswer(6).chunks.find((c) => c.chunk_id === HIT_ID)!.text).toBe(HIT.text);
  });
});
