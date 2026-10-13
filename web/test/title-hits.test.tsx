// The "Episodes" row of <App/> (spec §5.2 "Episodes whose title matches"; §4.4 `episodes`): one
// entry per episode whose title matched, a play link from the episode's start, and "Search this
// episode", which only fills the box. The API is stubbed.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { episodeHit, exactBody, result, stubFetch } from "./helpers";

function go(url: string) {
  window.history.replaceState(null, "", url);
}

beforeEach(() => go("/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  go("/");
});

/** Open a search and answer it with `body`; resolves once the summary line is there. */
async function answered(body: unknown, url = "/?q=kregger") {
  go(url);
  const calls = stubFetch();
  render(<App />);
  calls[0]!.respond(body);
  await act(async () => {});
  await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
  return calls;
}

const row = () => screen.getByRole("region", { name: "Episodes with a matching title" });

describe("the Episodes row", () => {
  it("has one entry per episode: number, cleaned title, date", async () => {
    await answered(
      exactBody([result(1)], {
        episodes: [
          episodeHit(613),
          episodeHit(600, { title: "Wood Talk 600 | Greasy Ham", date: "2026-05-02" }),
        ],
      }),
    );
    expect(within(row()).getByText("Episodes")).toBeTruthy();
    const items = within(row()).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Ep. 613");
    expect(items[0]!.textContent).toContain("Shove a Kregger in the Hole");
    expect(items[0]!.textContent).toContain("Aug 19, 2026");
    expect(items[1]!.textContent).toContain("Ep. 600");
    expect(items[1]!.textContent).toContain("Greasy Ham");
    expect(items[1]!.textContent).not.toContain("Wood Talk 600");
    expect(items[1]!.textContent).toContain("May 2, 2026");
  });

  it("links the title to YouTube from the start, with a name that holds the title", async () => {
    await answered(exactBody([result(1)], { episodes: [episodeHit(613)] }));
    const link = within(row()).getByRole("link", { name: /play episode 613 from the start on YouTube/ });
    expect(link.getAttribute("href")).toBe("https://example.test/yt/ep/613");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
    expect(link.getAttribute("aria-label")).toBe("Shove a Kregger in the Hole — play episode 613 from the start on YouTube");
    expect(link.textContent).toContain("Shove a Kregger in the Hole");
  });

  it("falls back to the show page, named for it", async () => {
    await answered(exactBody([result(1)], { episodes: [episodeHit(613, { links: { page: "https://example.test/page/613" } })] }));
    const link = within(row()).getByRole("link", { name: /play episode 613 from the start on Acast/ });
    expect(link.getAttribute("href")).toBe("https://example.test/page/613");
  });

  it("shows plain text, no link, with neither", async () => {
    await answered(exactBody([result(1)], { episodes: [episodeHit(613, { links: {} })] }));
    expect(within(row()).queryByRole("link")).toBeNull();
    expect(within(row()).getByText("Shove a Kregger in the Hole")).toBeTruthy();
  });

  it("leaves out the number and Search this episode for an episode without one", async () => {
    await answered(exactBody([result(1)], { episodes: [episodeHit(7, { number: null, title: "Bonus Show" })] }));
    expect(within(row()).queryByText(/^Ep\./)).toBeNull();
    expect(within(row()).queryByRole("button")).toBeNull();
    expect(within(row()).getByRole("link", { name: "Bonus Show — play this episode from the start on YouTube" })).toBeTruthy();
  });

  it("Search this episode puts ep:613 alone in the box and focuses it, with no request or URL change", async () => {
    const calls = await answered(exactBody([result(1)], { episodes: [episodeHit(613)] }), "/?q=kregger+year%3A2020");
    const url = window.location.search;
    const box = screen.getByRole("textbox") as HTMLInputElement;
    const button = within(row()).getByRole("button", { name: "Search this episode: Ep. 613" });
    expect(button.textContent).toBe("Search this episode");
    fireEvent.click(button);
    expect(box.value).toBe("ep:613");
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(6);
    expect(box.selectionEnd).toBe(6);
    expect(calls).toHaveLength(1);
    expect(window.location.search).toBe(url);
  });

  it("is not there for empty or missing episodes", async () => {
    await answered(exactBody([result(1)], { episodes: [] }));
    expect(screen.queryByRole("region", { name: "Episodes with a matching title" })).toBeNull();
    cleanup();
    const old = exactBody([result(1)]) as unknown as Record<string, unknown>;
    delete old.episodes;
    await answered(old);
    expect(screen.queryByText("Episodes")).toBeNull();
    expect(screen.getByRole("list", { name: "Results" })).toBeTruthy();
  });

  it("shows without passages, and then 'Nothing found.' does not", async () => {
    await answered(exactBody([], { episodes: [episodeHit(613)] }));
    expect(row()).toBeTruthy();
    expect(screen.queryByText("Nothing found.")).toBeNull();
  });

  it("with no passages and no title hits still says 'Nothing found.'", async () => {
    await answered(exactBody([]));
    expect(screen.getByText("Nothing found.")).toBeTruthy();
    expect(screen.queryByText("Episodes")).toBeNull();
  });

  it("is not a stop for j or the arrows: they move between passage cards", async () => {
    await answered(exactBody([result(1), result(2)], { episodes: [episodeHit(613)] }));
    const cards = within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem");
    expect(cards[0]!.hasAttribute("data-result")).toBe(true);
    expect(row().querySelector("[data-result]")).toBeNull();
    // From the row's own link, j goes to the first card, not along the row.
    const link = within(row()).getByRole("link");
    link.focus();
    fireEvent.keyDown(link, { key: "j" });
    expect(document.activeElement).toBe(cards[0]);
    fireEvent.keyDown(cards[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cards[1]);
    fireEvent.keyDown(cards[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(cards[0]);
    // And from outside the page's controls too.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "j" });
    expect(document.activeElement).toBe(cards[0]);
  });
});
