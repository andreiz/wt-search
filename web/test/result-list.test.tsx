// The result list: grouping neighbours, the related fold (spec §5.3, §5.6) and the keyboard stops.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { createRef } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { ResultList } from "../src/components/ResultList";
import { exactBody, result, smartBody, stubFetch } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const related = (n: number) => result(n, { match: "related", text: `Related passage ${n}` });

function renderList(results: ReturnType<typeof result>[], onMore = vi.fn()) {
  const listRef = createRef<HTMLDivElement>();
  const view = render(<ResultList results={results} listRef={listRef} onMore={onMore} />);
  return { ...view, listRef };
}

describe("grouping", () => {
  it("merges neighbours from one episode into one card and keeps the order", () => {
    const a = result(1, { chunk_id: 11, text: "first A" });
    const b = result(1, { chunk_id: 12, text: "second A" });
    const c = result(2, { chunk_id: 21, text: "only B" });
    const d = result(1, { chunk_id: 13, text: "later A" });
    renderList([a, b, c, d]);
    const cards = within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem");
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => within(card).queryByText(/\d matches/)?.textContent ?? null)).toEqual(["2 matches", null, null]);
    expect(cards[0]!.textContent).toMatch(/first A.*second A/);
    expect(cards[2]!.textContent).toContain("later A");
  });
});

describe("the related fold", () => {
  const mixed = () => [result(1), result(2), related(3), related(4)];

  it("is closed after the keyword cards, saying how many related passages it holds", () => {
    renderList(mixed());
    expect(within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem")).toHaveLength(2);
    const show = screen.getByRole("button", { name: /Show 2 related passages/ });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(show.textContent).toContain("Matched on meaning, not the exact words");
    expect(screen.queryByText("Related passage 3")).toBeNull();
    expect(screen.queryByRole("list", { name: "Related results" })).toBeNull();
  });

  it("opens to a heading with Hide and the related cards, then hides again", () => {
    renderList(mixed());
    fireEvent.click(screen.getByRole("button", { name: /Show 2 related passages/ }));
    expect(screen.getByText("Related passages")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Related results" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByText("Related")).toHaveLength(2);
    const hide = screen.getByRole("button", { name: "Hide" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(hide);
    fireEvent.click(hide);
    expect(screen.queryByRole("list", { name: "Related results" })).toBeNull();
    const show = screen.getByRole("button", { name: /Show 2 related passages/ });
    expect(document.activeElement).toBe(show);
  });

  it("groups neighbours inside the related list too, apart from the keyword list", () => {
    const k = result(1, { chunk_id: 11 });
    const r1 = result(1, { chunk_id: 12, match: "related", text: "Related one" });
    const r2 = result(1, { chunk_id: 13, match: "related", text: "Related two" });
    renderList([k, r1, r2]);
    expect(within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Show 2 related passages/ }));
    const cards = within(screen.getByRole("list", { name: "Related results" })).getAllByRole("listitem");
    expect(cards).toHaveLength(1);
    expect(within(cards[0]!).getByText("2 matches")).toBeTruthy();
  });

  it("has no fold when there are no related hits", () => {
    renderList([result(1), result(2)]);
    expect(screen.queryByRole("button", { name: /related/ })).toBeNull();
  });

  it("a page with only related hits shows them open under 'No exact matches —', with no fold", () => {
    renderList([related(1), related(2)]);
    expect(screen.getByText("No exact matches — passages about similar things:")).toBeTruthy();
    const cards = within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Show|Hide/ })).toBeNull();
  });

  it("stays closed or open per page and resets on a new search", async () => {
    window.history.replaceState(null, "", "/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(smartBody([result(1), related(2)]));
    fireEvent.click(await screen.findByRole("button", { name: /Show 1 related passage/ }));
    expect(screen.getByRole("list", { name: "Related results" })).toBeTruthy();
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "epoxy" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    calls[1]!.respond(smartBody([result(3), related(4)]));
    await screen.findByRole("button", { name: /Show 1 related passage/ });
    expect(screen.queryByRole("list", { name: "Related results" })).toBeNull();
  });

  it("says 'passage' for one", () => {
    renderList([result(1), related(2)]);
    expect(screen.getByRole("button", { name: /Show 1 related passage\b/ })).toBeTruthy();
    expect(screen.queryByText(/1 related passages/)).toBeNull();
  });
});

describe("the keyboard stops", () => {
  it("one stop is one card, even with two hits; the open fold's cards come after the keyword cards", async () => {
    const k1 = result(1, { chunk_id: 11 });
    const k2 = result(1, { chunk_id: 12 });
    const k3 = result(2, { chunk_id: 21 });
    const { listRef } = renderList([k1, k2, k3, related(5)]);
    fireEvent.click(screen.getByRole("button", { name: /Show 1 related passage/ }));
    const stops = [...listRef.current!.querySelectorAll<HTMLElement>("[data-result]")];
    expect(stops).toHaveLength(3);
    expect(stops.map((s) => s.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    stops[2]!.focus();
    await waitFor(() => expect(stops.map((s) => s.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]));
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
  it("passes the callbacks on to the cards", async () => {
    const onMore = vi.fn();
    const hit = result(1);
    renderList([hit], onMore);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
    await waitFor(() => expect(onMore).toHaveBeenCalledWith(hit));
  });

  it("with an exact answer, renders cards the same way", async () => {
    window.history.replaceState(null, "", "/?q=glue&mode=exact");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(exactBody([result(1, { chunk_id: 1, text: "Glue up" })]));
    expect(await screen.findByText("Glue up")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /related/ })).toBeNull();
  });
});
