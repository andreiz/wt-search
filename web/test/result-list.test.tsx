// The result list: one list in the API's order, grouping neighbours (spec §5.3, §5.6), the intro
// line and the keyboard stops.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { createRef } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { ResultList } from "../src/components/ResultList";
import { handleKeydown } from "../src/lib/keys";
import { exactBody, result, relatedBody, stubFetch } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const related = (n: number) => result(n, { match: "related", text: `Related passage ${n}` });
const INTRO = "Passages about the same thing that don't contain all your words:";

function renderList(results: ReturnType<typeof result>[], page = 1, isRelated = false) {
  const listRef = createRef<HTMLDivElement>();
  const view = render(<ResultList results={results} page={page} related={isRelated} listRef={listRef} />);
  return { ...view, listRef };
}

function cardsOf() {
  return within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem");
}

describe("grouping", () => {
  it("merges neighbours from one episode into one card and keeps the order", () => {
    const a = result(1, { chunk_id: 11, text: "first A" });
    const b = result(1, { chunk_id: 12, text: "second A" });
    const c = result(2, { chunk_id: 21, text: "only B" });
    const d = result(1, { chunk_id: 13, text: "later A" });
    renderList([a, b, c, d]);
    const cards = cardsOf();
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => within(card).queryByText(/\d matches/)?.textContent ?? null)).toEqual(["2 matches", null, null]);
    expect(cards[0]!.textContent).toMatch(/first A.*second A/);
    expect(cards[2]!.textContent).toContain("later A");
  });

  it("merges neighbouring related hits of one episode into one card, like any other", () => {
    const r1 = result(1, { chunk_id: 12, match: "related", text: "Related one" });
    const r2 = result(1, { chunk_id: 13, match: "related", text: "Related two" });
    renderList([result(2), r1, r2], 1, true);
    const cards = cardsOf();
    expect(cards).toHaveLength(2);
    expect(within(cards[1]!).getByText("2 matches")).toBeTruthy();
    expect(cards[1]!.className).toBe("result");
  });
});

describe("related cards", () => {
  it("are ordinary cards: no Related tag, no dashed class, in the API's order", () => {
    renderList([related(1), related(2), related(3)], 1, true);
    expect(screen.getAllByRole("list")).toHaveLength(1);
    const cards = cardsOf();
    expect(cards.map((c) => c.className)).toEqual(["result", "result", "result"]);
    expect(document.querySelector(".result__tag")).toBeNull();
    expect(screen.queryByText("Related")).toBeNull();
    expect(cards.map((c) => c.querySelector(".hit__excerpt")?.textContent)).toEqual([
      "Related passage 1",
      "Related passage 2",
      "Related passage 3",
    ]);
    expect(screen.queryByRole("button", { name: /Show|Hide/ })).toBeNull();
  });
});

describe("the intro line", () => {
  it("is shown on page 1 of the Related tab", () => {
    renderList([related(1), related(2)], 1, true);
    expect(screen.getByText(INTRO)).toBeTruthy();
    expect(cardsOf()).toHaveLength(2);
  });

  it("is not shown on page 2 of the Related tab", () => {
    renderList([related(1), related(2)], 2, true);
    expect(screen.queryByText(INTRO)).toBeNull();
    expect(cardsOf()).toHaveLength(2);
  });

  it("is not shown in Exact, whatever the hits are", () => {
    renderList([result(1), result(2)]);
    expect(screen.queryByText(INTRO)).toBeNull();
    cleanup();
    renderList([related(1), related(2)]);
    expect(screen.queryByText(INTRO)).toBeNull();
  });

  it("is not shown when the page has no results", () => {
    renderList([], 1, true);
    expect(screen.queryByText(INTRO)).toBeNull();
  });

  it("reaches the list from the page: Related page 1 shows it, page 2 does not, Exact never", async () => {
    window.history.replaceState(null, "", "/?q=glue&mode=related");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(relatedBody([related(1)]));
    expect(await screen.findByText(INTRO)).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/?q=glue");
    const calls3 = stubFetch();
    render(<App />);
    calls3[0]!.respond(exactBody([result(1, { text: "Exact passage 1" })]));
    await screen.findByText("Exact passage 1");
    expect(screen.queryByText(INTRO)).toBeNull();
    cleanup();
    window.history.replaceState(null, "", "/?q=glue&mode=related&page=2");
    const calls2 = stubFetch();
    render(<App />);
    calls2[0]!.respond(relatedBody([related(1)], { page: 2 }));
    await screen.findByText("Related passage 1");
    expect(screen.queryByText(INTRO)).toBeNull();
  });
});

describe("the keyboard stops", () => {
  it("one stop is one card, even with two hits; every card, keyword or related, is a stop", async () => {
    const k1 = result(1, { chunk_id: 11 });
    const k2 = result(1, { chunk_id: 12 });
    const k3 = result(2, { chunk_id: 21 });
    const { listRef } = renderList([k1, k2, related(5), k3]);
    const stops = [...listRef.current!.querySelectorAll<HTMLElement>("[data-result]")];
    expect(stops).toHaveLength(3);
    expect(stops.map((s) => s.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    stops[2]!.focus();
    await waitFor(() => expect(stops.map((s) => s.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]));
  });

  it("ArrowDown, ArrowUp, j and k move through mixed cards", () => {
    const { listRef } = renderList([result(1), related(2), result(3)]);
    const onKey = (event: KeyboardEvent) => handleKeydown(event, { input: null, list: listRef.current });
    document.addEventListener("keydown", onKey);
    try {
      const cards = cardsOf();
      cards[0]!.focus();
      fireEvent.keyDown(cards[0]!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(cards[1]);
      fireEvent.keyDown(cards[1]!, { key: "j" });
      expect(document.activeElement).toBe(cards[2]);
      fireEvent.keyDown(cards[2]!, { key: "k" });
      expect(document.activeElement).toBe(cards[1]);
      fireEvent.keyDown(cards[1]!, { key: "ArrowUp" });
      expect(document.activeElement).toBe(cards[0]);
    } finally {
      document.removeEventListener("keydown", onKey);
    }
  });

  it("a stop is a card (data-result), not the controls inside it", () => {
    const { listRef } = renderList([result(1)]);
    expect(listRef.current!.querySelectorAll("[data-result]")).toHaveLength(1);
    expect(listRef.current!.querySelector("[data-result]")!.tagName).toBe("LI");
  });
});

describe("one DOM at every width", () => {
  it("renders the same chip and ⋯ menu whatever the window width; only CSS differs", () => {
    const hit = result(1, { episode: { ...result(1).episode, links: { youtube: "https://y.test/1", apple: "https://a.test/1" } } });
    renderList([hit]);
    expect(document.querySelectorAll("a.hit__time")).toHaveLength(1);
    expect(document.querySelectorAll("a.play")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /^Play on Apple/ })).toBeTruthy();
  });
});

describe("in the page", () => {
  it("opens More transcript in the card of the hit", async () => {
    const calls = stubFetch();
    const hit = result(1);
    renderList([hit]);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url.searchParams.get("chunk")).toBe(String(hit.chunk_id));
  });

  it("with an exact answer, renders cards the same way", async () => {
    window.history.replaceState(null, "", "/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(exactBody([result(1, { chunk_id: 1, text: "Glue up" })], { total: 40 }));
    expect(await screen.findByText("Glue up")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /related/ })).toBeNull();
  });
});
