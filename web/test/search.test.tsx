// The search lifecycle in <App/> (spec §5.2, §5.6, §5.7; plan 3 Task 7): URL <-> state, one
// search in flight, stale answers dropped, paging, and the keyboard.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { exactBody, result, smartBody, stubFetch } from "./helpers";

function go(url: string) {
  window.history.replaceState(null, "", url);
}

beforeEach(() => go("/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  go("/");
});

function typeAndSubmit(text: string) {
  fireEvent.input(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

describe("starting up", () => {
  it("with no q: no request, and the empty-state heading", () => {
    const calls = stubFetch();
    render(<App />);
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Find the moment it was said.");
  });

  it("with a q in the URL: runs that search with its mode, sort and page, and fills the box", async () => {
    go("/?q=hvlp+sprayer&mode=exact&sort=newest&page=2");
    const calls = stubFetch();
    render(<App />);
    expect(calls).toHaveLength(1);
    const url = calls[0]!.url;
    expect(url.pathname).toBe("/api/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "hvlp sprayer", mode: "exact", sort: "newest", page: "2" });
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("hvlp sprayer");
    expect(screen.getByRole("radio", { name: "Exact" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: /Sort: Newest/ })).toBeTruthy();
    // Loading: skeletons, busy.
    expect(document.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    calls[0]!.respond(exactBody([result(1)], { total: 40, page: 2, has_more: true, sort: "newest" }));
    expect(await screen.findByText(/Text of passage 1/)).toBeTruthy();
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
  });
});

describe("searching", () => {
  it("does not search while typing, only on the Search button", async () => {
    const calls = stubFetch();
    render(<App />);
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "glue" } });
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("q")).toBe("glue");
    expect(calls[0]!.url.searchParams.get("page")).toBe("1");
  });

  it("searches on Enter (the form submit)", () => {
    const calls = stubFetch();
    render(<App />);
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "dovetail" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(calls).toHaveLength(1);
  });

  it("shows the results as a real list, with a heading to land on", async () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("glue");
    calls[0]!.respond(smartBody([result(1), result(2), result(3)]));
    const list = await screen.findByRole("list", { name: "Results" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("heading", { level: 2, name: "Search results" })).toBeTruthy();
    expect(screen.getByText("Smart search")).toBeTruthy();
    expect(list.textContent).toContain("Ep. 1 · Show 1 title");
  });

  it("pushes a history entry per search and writes the state to the URL", () => {
    stubFetch();
    render(<App />);
    const before = window.history.length;
    typeAndSubmit("glue");
    expect(window.location.search).toBe("?q=glue");
    expect(window.history.length).toBe(before + 1);
    typeAndSubmit("epoxy resin");
    expect(window.location.search).toBe("?q=epoxy+resin");
    expect(window.history.length).toBe(before + 2);
  });

  it("searching the same thing again re-runs it without piling up history entries", () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("glue");
    const length = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(calls).toHaveLength(2);
    expect(window.history.length).toBe(length);
  });

  it("an empty box runs no request, aborts the one in flight, and goes back to the bare path", () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("glue");
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/");
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("the clear button empties the box without searching", () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("glue");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(false);
  });
});

describe("mode and sort", () => {
  it("changing the mode re-runs the current search from page 1", () => {
    go("/?q=glue&page=3");
    const calls = stubFetch();
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Exact" }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ q: "glue", mode: "exact", sort: "relevance", page: "1" });
    expect(window.location.search).toBe("?q=glue&mode=exact");
  });

  it("changing the sort re-runs the current search from page 1", () => {
    go("/?q=glue&mode=exact&page=2");
    const calls = stubFetch();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Newest/ }));
    expect(calls).toHaveLength(2);
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ q: "glue", mode: "exact", sort: "newest", page: "1" });
    expect(window.location.search).toBe("?q=glue&mode=exact&sort=newest");
  });

  it("re-runs the searched text, not unsent text in the box", () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "something else" } });
    fireEvent.click(screen.getByRole("radio", { name: "Exact" }));
    expect(calls[1]!.url.searchParams.get("q")).toBe("glue");
  });

  it("with nothing searched yet, a mode change makes no request but is remembered for the next search", () => {
    const calls = stubFetch();
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Exact" }));
    expect(calls).toHaveLength(0);
    typeAndSubmit("glue");
    expect(calls[0]!.url.searchParams.get("mode")).toBe("exact");
  });
});

describe("one search in flight", () => {
  it("a new search aborts the old request", () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("first");
    typeAndSubmit("second");
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);
  });

  it("a slow first answer never overwrites a newer one (fetch ignores the abort)", async () => {
    const calls = stubFetch(false);
    render(<App />);
    typeAndSubmit("first");
    typeAndSubmit("second");
    // The newer search answers first, then the older one limps in.
    await act(async () => {
      calls[1]!.respond(smartBody([result(2, { text: "SECOND answer" })]));
    });
    expect(await screen.findByText(/SECOND answer/)).toBeTruthy();
    await act(async () => {
      calls[0]!.respond(smartBody([result(1, { text: "FIRST answer" })]));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.queryByText(/FIRST answer/)).toBeNull();
    expect(screen.getByText(/SECOND answer/)).toBeTruthy();
  });

  it("the older answer arriving while the newer is still loading does not show either", async () => {
    const calls = stubFetch(false);
    render(<App />);
    typeAndSubmit("first");
    typeAndSubmit("second");
    await act(async () => {
      calls[0]!.respond(smartBody([result(1, { text: "FIRST answer" })]));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.queryByText(/FIRST answer/)).toBeNull();
    expect(document.querySelector("[aria-busy='true']")).toBeTruthy();
    await act(async () => {
      calls[1]!.respond(smartBody([result(2, { text: "SECOND answer" })]));
    });
    expect(await screen.findByText(/SECOND answer/)).toBeTruthy();
  });

  it("an older failure does not replace a newer answer", async () => {
    const calls = stubFetch(false);
    render(<App />);
    typeAndSubmit("first");
    typeAndSubmit("second");
    await act(async () => {
      calls[1]!.respond(smartBody([result(2, { text: "SECOND answer" })]));
    });
    await act(async () => {
      calls[0]!.fail();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.getByText(/SECOND answer/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Back and Forward", () => {
  it("popstate re-runs the search from the URL and puts its text back in the box", async () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("glue");
    calls[0]!.respond(smartBody([result(1, { text: "GLUE answer" })]));
    await screen.findByText(/GLUE answer/);
    typeAndSubmit("epoxy");
    expect(calls).toHaveLength(2);

    window.history.replaceState(null, "", "/?q=glue&mode=exact&sort=oldest");
    const entries = window.history.length;
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(Object.fromEntries(calls[2]!.url.searchParams)).toEqual({ q: "glue", mode: "exact", sort: "oldest", page: "1" });
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("glue");
    expect(screen.getByRole("radio", { name: "Exact" }).getAttribute("aria-checked")).toBe("true");
    // It does not push a new entry.
    expect(window.history.length).toBe(entries);
  });

  it("popstate to the bare path shows the empty state and aborts the search", () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    go("/");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
  });
});

describe("paging", () => {
  async function onPageOne(body = smartBody([result(1), result(2)], { has_more: true })) {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(body);
    await screen.findByRole("list", { name: "Results" });
    return calls;
  }

  it("Next asks for page 2, pushes it to the URL and moves focus to the results heading", async () => {
    const calls = await onPageOne();
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("page")).toBe("2");
    expect(window.location.search).toBe("?q=glue&page=2");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Search results" }));
    });
    expect(scrollTo).toHaveBeenCalled();
  });

  it("focus stays where it was for an ordinary search (here, the box), and does not jump to the heading", async () => {
    const calls = await onPageOne();
    const input = screen.getByRole("textbox") as HTMLInputElement;
    input.focus();
    fireEvent.input(input, { target: { value: "epoxy" } });
    fireEvent.submit(screen.getByRole("search"));
    calls[1]!.respond(smartBody([result(1)]));
    await screen.findByRole("list", { name: "Results" });
    expect(document.activeElement).toBe(input);
  });

  it("Back from page 2 shows page 1's results again, with the URL back to no page", async () => {
    const calls = await onPageOne(smartBody([result(1, { text: "PAGE ONE text" })], { has_more: true }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    calls[1]!.respond(smartBody([result(2, { text: "PAGE TWO text" })], { page: 2 }));
    await screen.findByText(/PAGE TWO text/);
    expect(window.location.search).toBe("?q=glue&page=2");

    go("/?q=glue");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.url.searchParams.get("page")).toBe("1");
    calls[2]!.respond(smartBody([result(1, { text: "PAGE ONE text" })], { has_more: true }));
    expect(await screen.findByText(/PAGE ONE text/)).toBeTruthy();
    expect(screen.queryByText(/PAGE TWO text/)).toBeNull();
    expect(window.location.search).toBe("?q=glue");
  });

  it("Exact page numbers go straight to that page", async () => {
    const calls = await onPageOne(exactBody([result(1)], { total: 100, has_more: true }));
    fireEvent.click(screen.getByRole("button", { name: "Page 4" }));
    expect(calls[1]!.url.searchParams.get("page")).toBe("4");
  });
});

describe("answers that are not results", () => {
  const cases: [string, number, Record<string, string>, unknown, RegExp][] = [
    ["maintenance", 503, {}, { error: "maintenance", message: "Back soon." }, /Back soon\./],
    ["rate limited", 429, { "retry-after": "30" }, { error: "rate_limited" }, /Too many searches from here; try again in a minute\./],
    ["unavailable", 500, {}, { error: "boom" }, /Something went wrong\./],
  ];
  for (const [name, status, headers, body, text] of cases) {
    it(`${name}: shows one plain message`, async () => {
      go("/?q=glue");
      const calls = stubFetch();
      render(<App />);
      calls[0]!.respond(body, status, headers);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(text);
      expect(document.querySelector("[aria-busy='true']")).toBeNull();
    });
  }

  it("network failure: 'Something went wrong.'", async () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.fail();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Something went wrong\./);
  });

  it("a later good answer replaces the message", async () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.fail();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    calls[1]!.respond(smartBody([result(1)]));
    await screen.findByRole("list", { name: "Results" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("keyboard", () => {
  async function withResults() {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(smartBody([result(1), result(2), result(3)]));
    await screen.findByRole("list", { name: "Results" });
  }

  it("'/' focuses the search box", async () => {
    await withResults();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("typing '/', j or k in the box types them and moves nothing", async () => {
    await withResults();
    const input = screen.getByRole("textbox") as HTMLInputElement;
    input.focus();
    for (const key of ["/", "j", "k"]) fireEvent.keyDown(input, { key });
    expect(document.activeElement).toBe(input);
  });

  it("j and k move between result cards; the focused card is the one in the tab order", async () => {
    await withResults();
    const cards = within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem");
    expect(cards.map((c) => c.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(document.activeElement).toBe(cards[0]);
    fireEvent.keyDown(document.activeElement as Element, { key: "j" });
    expect(document.activeElement).toBe(cards[1]);
    await waitFor(() => expect(cards.map((c) => c.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cards[2]);
    fireEvent.keyDown(document.activeElement as Element, { key: "k" });
    expect(document.activeElement).toBe(cards[1]);
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(document.activeElement).toBe(cards[0]);
  });
});

describe("roving tabindex", () => {
  it("resets to the first card when the results change", async () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(smartBody([result(1), result(2), result(3)]));
    await screen.findByRole("list", { name: "Results" });
    const before = within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem");
    before[2]!.focus();
    await waitFor(() => expect(before.map((c) => c.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]));
    typeAndSubmit("epoxy");
    calls[1]!.respond(smartBody([result(4), result(5), result(6)]));
    await screen.findByText(/Text of passage 4/);
    const after = within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem");
    expect(after.map((c) => c.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });
});

describe("the status region", () => {
  it("is one element, there before any search, saying 'Searching…' while loading and the summary after", async () => {
    const calls = stubFetch();
    render(<App />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    typeAndSubmit("glue");
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("Searching…");
    calls[0]!.respond(smartBody([result(1)]));
    await screen.findByRole("list", { name: "Results" });
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("Smart search");
    typeAndSubmit("epoxy");
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("Searching…");
  });

  it("the skeleton is hidden from screen readers (no 'list, 3 items')", () => {
    go("/?q=glue");
    stubFetch();
    render(<App />);
    const skeleton = document.querySelector(".skeleton");
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("list", { name: "Loading results" })).toBeNull();
  });

  it("is empty again for a failure, so the alert is the only thing announced", async () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.fail();
    await screen.findByRole("alert");
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("the query in the box", () => {
  it("shows the normalised text after a search: no trailing space", () => {
    stubFetch();
    render(<App />);
    typeAndSubmit("glue");
    typeAndSubmit("glue ");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("glue");
  });

  it("drops emoji on submit, in the box, the request and the URL", () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("glue \u{1FAB5} up");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("glue up");
    expect(calls[0]!.url.searchParams.get("q")).toBe("glue up");
    expect(window.location.search).toBe("?q=glue+up");
  });

  it("a box with only emoji is no search", () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("\u{1FA9A}");
    expect(calls).toHaveLength(0);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("drops emoji from a q that arrives in the URL", () => {
    go("/?q=%F0%9F%91%8D+dovetail");
    const calls = stubFetch();
    render(<App />);
    expect(calls[0]!.url.searchParams.get("q")).toBe("dovetail");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("dovetail");
  });
});

describe("markup rules", () => {
  it("sets no style attribute anywhere, in any state (CSP style-src 'self')", async () => {
    go("/?q=glue");
    const calls = stubFetch();
    const { container } = render(<App />);
    expect(container.querySelectorAll("[style]").length).toBe(0);
    calls[0]!.respond(smartBody([result(1)], { has_more: true }));
    await screen.findByRole("list", { name: "Results" });
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    expect(container.querySelectorAll("[style]").length).toBe(0);
  });

  it("the phone summary button names the current settings and toggles the controls", () => {
    go("/?q=glue&mode=exact&sort=oldest");
    stubFetch();
    render(<App />);
    const button = screen.getByRole("button", { name: /Exact · Oldest · Any year/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  describe("reopened controls (phone, scrolled)", () => {
    function open() {
      go("/?q=glue");
      stubFetch();
      render(<App />);
      const button = screen.getByRole("button", { name: /Smart · Relevance · Any year/ });
      fireEvent.click(button);
      return button;
    }

    it("the button stays after opening, says expanded, and points at the controls", () => {
      const button = open();
      expect(screen.getByRole("button", { name: /Smart · Relevance · Any year/ })).toBe(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      const controls = document.getElementById(button.getAttribute("aria-controls") ?? "");
      expect(controls?.contains(screen.getByRole("radio", { name: "Smart" }))).toBe(true);
    });

    it("pressing it again closes the controls", () => {
      const button = open();
      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    it("Esc inside the controls closes them and focuses the button", () => {
      const button = open();
      fireEvent.keyDown(screen.getByRole("radio", { name: "Smart" }), { key: "Escape" });
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(button);
    });

    it("Esc on the button closes them too", () => {
      const button = open();
      button.focus();
      fireEvent.keyDown(button, { key: "Escape" });
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(button);
    });

    it("with the sort menu open, the first Esc closes the menu only, the second the controls", () => {
      const button = open();
      fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(button.getAttribute("aria-expanded")).toBe("true");
      fireEvent.keyDown(screen.getByRole("button", { name: /Sort/ }), { key: "Escape" });
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(button);
    });

    it("Esc does nothing when the controls are not reopened", () => {
      go("/?q=glue");
      stubFetch();
      render(<App />);
      const button = screen.getByRole("button", { name: /Smart · Relevance · Any year/ });
      fireEvent.keyDown(screen.getByRole("radio", { name: "Smart" }), { key: "Escape" });
      expect(button.getAttribute("aria-expanded")).toBe("false");
    });
  });
});
