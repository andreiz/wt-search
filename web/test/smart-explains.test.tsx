// Smart search explains itself (spec §5.2, last bullet): "top results" in the summary, the "How
// this works" popover, the tooltip on the Related tag, and the end-of-results line.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
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

async function smartPage(url = "/?q=glue", body = smartBody([result(1), result(2)])) {
  go(url);
  const calls = stubFetch();
  render(<App />);
  calls[0]!.respond(body);
  await screen.findByRole("list", { name: "Results" });
  return calls;
}

const trigger = () => screen.getByRole("button", { name: "How this works" });

describe("the How this works popover", () => {
  it("is a button beside the Smart summary, closed at first", async () => {
    await smartPage();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: /Smart search/ })).toBeNull();
  });

  it("opens with the three paragraphs, verbatim", async () => {
    await smartPage();
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "How Smart search works" });
    const paragraphs = [...dialog.querySelectorAll("p")].map((p) => p.textContent);
    expect(paragraphs).toEqual([
      "Smart search finds passages two ways: ones that contain your words, and ones that talk about the same thing in different words. Those are marked Related.",
      'It shows the best matches first, up to 100. There is no total, because "about the same thing" has no cut-off: every passage is a little bit related, so a count would mean nothing.',
      "Want every match and a count? Switch to Exact.",
    ]);
    expect(within(dialog).getByRole("button", { name: "Switch to Exact" })).toBeTruthy();
  });

  it("Esc closes it and returns focus to the button", async () => {
    await smartPage();
    fireEvent.click(trigger());
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("a press outside closes it", async () => {
    await smartPage();
    fireEvent.click(trigger());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Switch to Exact switches the mode, searches, and closes the popover", async () => {
    const calls = await smartPage();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Switch to Exact" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("mode")).toBe("exact");
    expect(screen.getByRole("radio", { name: "Exact" }).getAttribute("aria-checked")).toBe("true");
  });

  it("is not there in Exact", async () => {
    await smartPage("/?q=glue&mode=exact", exactBody([result(1)]));
    expect(screen.queryByRole("button", { name: "How this works" })).toBeNull();
  });

  it("is not there while loading, or with no results", async () => {
    go("/?q=glue");
    const calls = stubFetch();
    render(<App />);
    expect(screen.queryByRole("button", { name: "How this works" })).toBeNull();
    calls[0]!.respond(smartBody([]));
    await screen.findByText("Nothing found.");
    expect(screen.queryByRole("button", { name: "How this works" })).toBeNull();
  });
});

describe("the Related tag", () => {
  it("has the tooltip, and its text is still just 'Related'", async () => {
    await smartPage("/?q=glue", smartBody([result(1, { match: "related" })]));
    const tag = screen.getByText("Related");
    expect(tag.getAttribute("title")).toBe("Matched by meaning, not by your exact words.");
    expect(tag.getAttribute("aria-label")).toBeNull();
  });
});

describe("the end of the top results", () => {
  const END = "That's the end of the top results. Exact search lists every match.";

  it("shows under the last Smart page after page 1", async () => {
    await smartPage("/?q=glue&page=2", smartBody([result(1)], { page: 2, has_more: false }));
    expect(screen.getByText(END)).toBeTruthy();
  });

  it("not on page 1", async () => {
    await smartPage("/?q=glue", smartBody([result(1)], { page: 1, has_more: false }));
    expect(screen.queryByText(END)).toBeNull();
  });

  it("not while there is a next page", async () => {
    await smartPage("/?q=glue&page=2", smartBody([result(1)], { page: 2, has_more: true }));
    expect(screen.queryByText(END)).toBeNull();
  });

  it("not in Exact", async () => {
    await smartPage("/?q=glue&mode=exact&page=2", exactBody([result(1)], { page: 2, total: 25, has_more: false }));
    expect(screen.queryByText(END)).toBeNull();
  });
});
