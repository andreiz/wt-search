// The states and notices of <App/> (spec §5.6; brief §4.5; plan 3 Task 11): the empty state and
// its info line, no results, truncated Exact, degraded Related, the maintenance banner, the rate
// limit with its countdown, and the error with Retry. The API is stubbed.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { exactBody, infoBody, result, relatedBody, stubFetch } from "./helpers";

function go(url: string) {
  window.history.replaceState(null, "", url);
}

beforeEach(() => go("/"));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  go("/");
});

function typeAndSubmit(text: string) {
  fireEvent.input(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

describe("the empty state", () => {
  it("has the heading, the TRY list and, once /api/info answers, the info line", async () => {
    const calls = stubFetch();
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Find the moment it was said.");
    expect(screen.getByText("Try")).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["hide glue", "split-top Roubo", "sharpening a card scraper"]);
    for (const li of items) {
      expect(li.closest("ul")?.classList.contains("try-list")).toBe(true);
      expect(within(li).getByRole("button").classList.contains("try-list__item")).toBe(true);
      expect(li.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
    // Absent while loading.
    expect(screen.queryByText(/episodes indexed/)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(calls.info).toHaveLength(1);
    calls.info[0]!.respond(infoBody());
    expect(await screen.findByText("625 episodes indexed through Sep 17, 2026")).toBeTruthy();
  });

  it("asks /api/info once, even across searches and back to the empty state", async () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("glue");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    fireEvent.submit(screen.getByRole("search"));
    await act(async () => {});
    expect(calls.info).toHaveLength(1);
  });

  it("aborts the /api/info request when the page goes away", () => {
    const calls = stubFetch();
    const { unmount } = render(<App />);
    act(() => {
      unmount();
    });
    expect(calls.info[0]!.signal.aborted).toBe(true);
  });

  it("does not ask /api/info when the page opens on a search", () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    expect(calls.info).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("leaves the info line out when /api/info fails", async () => {
    const calls = stubFetch();
    render(<App />);
    calls.info[0]!.fail();
    await act(async () => {});
    expect(screen.queryByText(/episodes indexed/)).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("leaves the info line out when /api/info answers an error status", async () => {
    const calls = stubFetch();
    render(<App />);
    calls.info[0]!.respond({ error: "boom" }, 500);
    await act(async () => {});
    expect(screen.queryByText(/episodes indexed/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says just the count when there is no latest date", async () => {
    const calls = stubFetch();
    render(<App />);
    calls.info[0]!.respond(infoBody({ episodes: 1234, latest_episode_date: null }));
    expect(await screen.findByText("1,234 episodes indexed")).toBeTruthy();
  });

  it("an example fills the box and searches", () => {
    const calls = stubFetch();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "sharpening a card scraper" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("sharpening a card scraper");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/api/search");
    expect(calls[0]!.url.searchParams.get("q")).toBe("sharpening a card scraper");
    expect(window.location.search).toContain("q=sharpening");
  });
});

describe("no results", () => {
  async function nothing(url: string) {
    go(url);
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(url.includes("mode=related") ? relatedBody([]) : exactBody([]));
    await screen.findByText(/^(Nothing found|No related passages)\.$/);
    return calls;
  }

  it("Exact: 'Nothing found.', what that means, the oak button, then what to try, in a status", async () => {
    await nothing("/?q=zzz&mode=exact");
    const note = screen.getByText("Nothing found.").closest("[role='status']") as HTMLElement;
    expect(note).toBeTruthy();
    expect(within(note).getByText("No passage has those exact words.")).toBeTruthy();
    expect(within(note).getByRole("button", { name: "See related passages (beta)" }).className).toContain("across--related");
    expect(within(note).getByText("Or use fewer words, or check the spelling.")).toBeTruthy();
    const order = Array.from(note.children).map((el) => el.textContent);
    expect(order).toEqual([
      "Nothing found.",
      "No passage has those exact words.",
      "≈ See related passages BETA",
      "Or use fewer words, or check the spelling.",
      "Intros, sponsor reads and plugs are left out; add include:ads to search them too.",
    ]);
    expect(note.textContent).not.toMatch(/Try one of these/);
  });

  it("Exact: the button switches to Related and searches", async () => {
    const calls = await nothing("/?q=zzz");
    const button = screen.getByRole("button", { name: "See related passages (beta)" });
    fireEvent.click(button);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("mode")).toBe("related");
    expect(window.location.search).toBe("?q=zzz&mode=related");
    expect(screen.getByRole("radio", { name: "Related, beta" }).getAttribute("aria-checked")).toBe("true");
  });

  it("in Related: its three parts, and the 'See exact matches' button switches and searches", async () => {
    const calls = await nothing("/?q=zzz&mode=related");
    expect(screen.queryByText("Nothing found.")).toBeNull();
    expect(screen.queryByRole("button", { name: "See related passages (beta)" })).toBeNull();
    const note = screen.getByText("No related passages.").closest("[role='status']") as HTMLElement;
    expect(Array.from(note.children).map((el) => el.textContent)).toEqual([
      "No related passages.",
      "Nothing about the same thing turned up without your words.",
      "See exact matches",
    ]);
    expect(note.textContent).not.toContain("include:ads");
    const button = within(note).getByRole("button", { name: "See exact matches" });
    expect(button.className).toContain("across--exact");
    fireEvent.click(button);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("mode")).toBe("exact");
    expect(window.location.search).toBe("?q=zzz");
    expect(screen.getByRole("radio", { name: "Exact" }).getAttribute("aria-checked")).toBe("true");
  });

  it("mentions looser years only when the query has a year filter", async () => {
    await nothing("/?q=zzz");
    expect(screen.getByText(/Or use fewer words/).textContent).toBe("Or use fewer words, or check the spelling.");
    cleanup();
    await nothing("/?q=zzz+year%3A2015");
    expect(screen.getByText(/Or use fewer words/).textContent).toBe("Or use fewer words, loosen the years, or check the spelling.");
  });

  it("is only for page 1", async () => {
    go("/?q=glue&mode=exact&page=2");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(exactBody([], { page: 2, total: 3 }));
    await act(async () => {});
    expect(screen.queryByText("Nothing found.")).toBeNull();
  });
});

describe("Exact, truncated", () => {
  it("after the last page: 'Showing the best 200 of N matches'", async () => {
    go("/?q=glue&mode=exact&page=10");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(exactBody([result(1)], { page: 10, total: 1318, truncated: true, has_more: false }));
    const note = await screen.findByText(/Showing the best 200 of 1,318 matches/);
    expect(note.textContent).toBe('Showing the best 200 of 1,318 matches — add words, a "phrase" or a year to narrow it.');
    expect(note.closest("[role='status']")).toBeTruthy();
  });

  it("a capped total reads '1,000+'", async () => {
    go("/?q=glue&mode=exact&page=10");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(exactBody([result(1)], { page: 10, total: 1000, total_capped: true, truncated: true }));
    expect(await screen.findByText(/Showing the best 200 of 1,000\+ matches/)).toBeTruthy();
  });

  it("not before the last page", async () => {
    go("/?q=glue&mode=exact");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(exactBody([result(1)], { total: 500, truncated: true, has_more: true }));
    await screen.findByRole("list", { name: "Results" });
    expect(screen.queryByText(/Showing the best 200/)).toBeNull();
  });

  it("not when nothing was cut", async () => {
    go("/?q=glue&mode=exact");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(exactBody([result(1)], { total: 150 }));
    await screen.findByRole("list", { name: "Results" });
    expect(screen.queryByText(/Showing the best 200/)).toBeNull();
  });
});

describe("Exact, only a few matches", () => {
  const BUTTON = "See related passages (beta)";

  async function exactPage(url: string, body: ReturnType<typeof exactBody>) {
    go(url);
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(body);
    await screen.findByRole("list", { name: "Results" });
    return calls;
  }

  it.each([2, 3, 4])("%i matches: 'Only N exact matches.' with the meaning sentence and the oak button, under the list", async (total) => {
    await exactPage("/?q=glue", exactBody(Array.from({ length: total }, (_, i) => result(i + 1))));
    const bold = screen.getByText(`Only ${total} exact matches.`);
    expect(bold.tagName).toBe("STRONG");
    expect(bold.parentElement?.textContent).toBe(`Only ${total} exact matches. Related passages match the meaning, not just the words.`);
    const few = bold.closest(".few") as HTMLElement;
    const button = within(few).getByRole("button", { name: BUTTON });
    expect(button.className).toContain("across--related");
    const list = screen.getByRole("list", { name: "Results" });
    expect(list.compareDocumentPosition(few) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("1 match is singular", async () => {
    await exactPage("/?q=glue", exactBody([result(1)]));
    expect(screen.getByText("Only 1 exact match.").parentElement?.textContent).toBe(
      "Only 1 exact match. Related passages match the meaning, not just the words.",
    );
  });

  it("not at 5 matches", async () => {
    await exactPage("/?q=glue", exactBody(Array.from({ length: 5 }, (_, i) => result(i + 1))));
    expect(screen.queryByText(/Only \d+ exact match/)).toBeNull();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
  });

  it("not on page 2", async () => {
    await exactPage("/?q=glue&page=2", exactBody([result(1)], { page: 2, total: 3 }));
    expect(screen.queryByText(/Only \d+ exact match/)).toBeNull();
  });

  it("not when the total is capped", async () => {
    await exactPage("/?q=glue", exactBody([result(1)], { total: 3, total_capped: true }));
    expect(screen.queryByText(/Only \d+ exact match/)).toBeNull();
  });

  it("not in Related", async () => {
    await exactPage("/?q=glue&mode=related", relatedBody([result(1), result(2)]) as ReturnType<typeof exactBody>);
    expect(screen.queryByText(/Only \d+ exact match/)).toBeNull();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
  });

  it("the button switches to Related, searches, and puts mode=related in the URL", async () => {
    const calls = await exactPage("/?q=glue", exactBody([result(1), result(2)]));
    fireEvent.click(screen.getByRole("button", { name: BUTTON }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("mode")).toBe("related");
    expect(window.location.search).toBe("?q=glue&mode=related");
    expect(screen.getByRole("radio", { name: "Related, beta" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("Related, degraded", () => {
  async function degraded(reason: "unavailable" | "budget" | "off") {
    go("/?q=glue&mode=related");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(relatedBody([], { smart_degraded: reason }));
    await screen.findByRole("button", { name: "See exact matches" });
    return calls;
  }

  it("unavailable", async () => {
    await degraded("unavailable");
    const note = screen.getByText("Related search is unavailable right now.");
    expect(note.closest("[role='status']")).toBeTruthy();
  });

  for (const reason of ["budget", "off"] as const) {
    it(`${reason}: paused`, async () => {
      await degraded(reason);
      expect(screen.getByText("Related search is paused.")).toBeTruthy();
      expect(screen.queryByText(/unavailable right now/)).toBeNull();
    });
  }

  it("shows no 'nothing found' block and no results", async () => {
    await degraded("unavailable");
    expect(screen.queryByText("No related passages.")).toBeNull();
    expect(screen.queryByText("Nothing found.")).toBeNull();
    expect(screen.queryByRole("list", { name: "Results" })).toBeNull();
  });

  it("See exact matches switches to Exact and searches", async () => {
    const calls = await degraded("budget");
    fireEvent.click(screen.getByRole("button", { name: "See exact matches" }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("mode")).toBe("exact");
    expect(window.location.search).toBe("?q=glue");
    expect(screen.getByRole("radio", { name: "Exact" }).getAttribute("aria-checked")).toBe("true");
  });

  it("the exact-matches button is the full-width one, under the notice", async () => {
    await degraded("unavailable");
    const note = screen.getByText("Related search is unavailable right now.").closest(".notice") as HTMLElement;
    const button = screen.getByRole("button", { name: "See exact matches" });
    expect(button.className).toContain("across--exact");
    expect(note.contains(button)).toBe(false);
    expect(note.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("no notice for an ordinary Related answer", async () => {
    go("/?q=glue&mode=related");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(relatedBody([result(1)]));
    await screen.findByRole("list", { name: "Results" });
    expect(screen.queryByText(/Related search is/)).toBeNull();
    expect(screen.queryByRole("button", { name: "See exact matches" })).toBeNull();
  });
});

describe("the maintenance banner", () => {
  it("shows the API's message in an alert when the search answers maintenance", async () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond({ error: "maintenance", message: "Back soon." }, 503);
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toBe("Back soon.");
    // It is above the header.
    const header = screen.getByRole("banner");
    expect(banner.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows when /api/info answers maintenance on load", async () => {
    const calls = stubFetch();
    render(<App />);
    calls.info[0]!.respond({ error: "maintenance", message: "Down for a bit." }, 503);
    expect((await screen.findByRole("alert")).textContent).toBe("Down for a bit.");
    expect(screen.queryByText(/episodes indexed/)).toBeNull();
  });

  it("shows when /api/context answers maintenance", async () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(relatedBody([result(1)]));
    await screen.findByRole("list", { name: "Results" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
    expect(calls[1]!.url.pathname).toBe("/api/context");
    calls[1]!.respond({ error: "maintenance", message: "Context is down." }, 503);
    await waitFor(() => expect(screen.getAllByRole("alert").map((a) => a.textContent)).toContain("Context is down."));
  });

  it("clears when a later search succeeds", async () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond({ error: "maintenance", message: "Back soon." }, 503);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    // Still shown while the next search runs, gone once it succeeds.
    calls[1]!.respond(relatedBody([result(1)]));
    await screen.findByRole("list", { name: "Results" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("no banner by default", () => {
    stubFetch();
    render(<App />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("rate limited", () => {
  // Fake timers, with the clock moving only when the test says; answers are let through by hand.
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  async function limited(retryAfter = "42") {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond({ error: "rate_limited" }, 429, { "retry-after": retryAfter });
    await advance(0);
    return calls;
  }

  const note = () => screen.getByText(/Too many searches from here; try again in a minute\./).closest("[role='status']") as HTMLElement;
  const searchButton = () => screen.getByRole("button", { name: "Search" }) as HTMLButtonElement;

  it("shows the message and a countdown from retry-after, and disables Search", async () => {
    await limited("42");
    expect(note().textContent).toContain("Try again in 42 s");
    expect(searchButton().disabled).toBe(true);
  });

  it("counts down each second", async () => {
    await limited("42");
    await advance(1000);
    expect(note().textContent).toContain("Try again in 41 s");
    await advance(9000);
    expect(note().textContent).toContain("Try again in 32 s");
  });

  it("re-enables Search at zero and does not retry by itself", async () => {
    const calls = await limited("3");
    await advance(2000);
    expect(searchButton().disabled).toBe(true);
    await advance(1000);
    expect(searchButton().disabled).toBe(false);
    expect(note().textContent).not.toMatch(/Try again in/);
    await advance(120_000);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not search while the button is disabled (Enter too)", async () => {
    const calls = await limited("30");
    fireEvent.submit(screen.getByRole("search"));
    expect(calls).toHaveLength(1);
  });

  it("a search after the countdown works", async () => {
    const calls = await limited("2");
    await advance(2000);
    fireEvent.click(searchButton());
    expect(calls).toHaveLength(2);
  });

  it("uses 60 seconds when retry-after is missing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond({ error: "rate_limited" }, 429);
    await advance(0);
    expect(note().textContent).toContain("Try again in 60 s");
  });

  it("stops its timer when the page goes away", async () => {
    await limited("42");
    const stopped = vi.spyOn(globalThis, "clearInterval");
    act(() => {
      cleanup();
    });
    expect(stopped).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the countdown out of the live announcement", async () => {
    await limited("42");
    const countdown = within(note()).getByText(/Try again in 42 s/);
    expect(countdown.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("error with Retry", () => {
  for (const [name, fail] of [
    ["network", (c: { fail(): void }) => c.fail()],
    ["unavailable", (c: { respond(b: unknown, s?: number): void }) => c.respond({ error: "boom" }, 500)],
  ] as const) {
    it(`${name}: 'Something went wrong.' with a Retry button`, async () => {
      go("/?q=glue");
      const calls = stubFetch();
      render(<App />);
      (fail as (c: unknown) => void)(calls[0]!);
      const message = await screen.findByText("Something went wrong.");
      const box = message.closest("[role='status']") as HTMLElement;
      expect(box).toBeTruthy();
      expect(within(box).getByRole("button", { name: "Retry" })).toBeTruthy();
    });
  }

  it("Retry runs the same search again, with no new history entry", async () => {
    go("/?q=glue&mode=exact&sort=newest&page=2");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.fail();
    await screen.findByText("Something went wrong.");
    const entries = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(calls).toHaveLength(2);
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual(Object.fromEntries(calls[0]!.url.searchParams));
    expect(window.history.length).toBe(entries);
    expect(document.querySelector("[aria-busy='true']")).toBeTruthy();
    calls[1]!.respond(exactBody([result(1)], { page: 2, total: 40, sort: "newest" }));
    await screen.findByRole("list", { name: "Results" });
    expect(screen.queryByText("Something went wrong.")).toBeNull();
  });
});
