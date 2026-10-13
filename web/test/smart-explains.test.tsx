// Related search explains itself (spec §5.2, last bullet): "top results" in the summary, the "How
// this works" popover, and the end-of-results line.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { exactBody, result, relatedBody, stubFetch } from "./helpers";

function go(url: string) {
  window.history.replaceState(null, "", url);
}

beforeEach(() => go("/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  go("/");
});

async function relatedPage(url = "/?q=glue&mode=related",body = relatedBody([result(1), result(2)])) {
  go(url);
  const calls = stubFetch();
  render(<App />);
  calls[0]!.respond(body);
  await screen.findByRole("list", { name: "Results" });
  return calls;
}

const trigger = () => screen.getByRole("button", { name: "How this works" });

describe("the How this works popover", () => {
  it("is a button beside the Related summary, closed at first", async () => {
    await relatedPage();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: /Related search/ })).toBeNull();
  });

  it("opens with the four paragraphs, verbatim", async () => {
    await relatedPage();
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "How Related search works" });
    const paragraphs = [...dialog.querySelectorAll("p")].map((p) => p.textContent);
    expect(paragraphs).toEqual([
      "Related search finds passages about the same thing that don't contain your words. Exact lists the passages that do.",
      'It shows the best matches first, up to 100. There is no total, because "about the same thing" has no cut-off: every passage is a little bit related, so a count would mean nothing.',
      "Related search is a beta, and the results are uneven.",
      "Want every match and a count? Switch to Exact.",
    ]);
    expect(within(dialog).getByRole("button", { name: "Switch to Exact" })).toBeTruthy();
  });

  it("Esc closes it and returns focus to the button", async () => {
    await relatedPage();
    fireEvent.click(trigger());
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("a press outside closes it", async () => {
    await relatedPage();
    fireEvent.click(trigger());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Switch to Exact switches the mode, searches, and closes the popover", async () => {
    const calls = await relatedPage();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Switch to Exact" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("mode")).toBe("exact");
    expect(screen.getByRole("radio", { name: "Exact" }).getAttribute("aria-checked")).toBe("true");
  });

  it("is not there in Exact", async () => {
    await relatedPage("/?q=glue", exactBody([result(1)]));
    expect(screen.queryByRole("button", { name: "How this works" })).toBeNull();
  });

  it("is not there while loading, or with no results", async () => {
    go("/?q=glue&mode=related");
    const calls = stubFetch();
    render(<App />);
    expect(screen.queryByRole("button", { name: "How this works" })).toBeNull();
    calls[0]!.respond(relatedBody([]));
    await screen.findByText("No related passages.");
    expect(screen.queryByRole("button", { name: "How this works" })).toBeNull();
  });
});

describe("the end of the related passages", () => {
  const END = "That's the end of the related passages.";

  it("shows under the last Related page after page 1", async () => {
    await relatedPage("/?q=glue&mode=related&page=2", relatedBody([result(1)], { page: 2, has_more: false }));
    expect(screen.getByText(END)).toBeTruthy();
  });

  it("not on page 1", async () => {
    await relatedPage("/?q=glue&mode=related", relatedBody([result(1)], { page: 1, has_more: false }));
    expect(screen.queryByText(END)).toBeNull();
  });

  it("not while there is a next page", async () => {
    await relatedPage("/?q=glue&mode=related&page=2", relatedBody([result(1)], { page: 2, has_more: true }));
    expect(screen.queryByText(END)).toBeNull();
  });

  it("not in Exact", async () => {
    await relatedPage("/?q=glue&page=2", exactBody([result(1)], { page: 2, total: 25, has_more: false }));
    expect(screen.queryByText(END)).toBeNull();
  });
});
