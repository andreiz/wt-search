// The footer (spec §5.7; design README "Footer"; brief §4.7).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { BLESSING, Footer, SHOW_LINKS } from "../src/components/Footer";
import { stubFetch } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<Footer/>", () => {
  it("says it is unofficial, with the hosts' line from one constant", () => {
    const { container } = render(<Footer />);
    expect(BLESSING).toBe("made with the hosts' blessing");
    expect(container.querySelector("p")?.textContent).toBe(`Unofficial · ${BLESSING}`);
    expect(container.querySelector("p strong")?.textContent).toBe("Unofficial");
  });

  it("links to the show: YouTube, the podcast and the website, in that order, in a new tab", () => {
    render(<Footer />);
    const nav = screen.getByRole("navigation", { name: "The show" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Wood Talk on YouTube", "Podcast", "Website"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://www.youtube.com/@WoodTalk",
      "https://shows.acast.com/woodtalk",
      "https://www.woodtalkshow.com/",
    ]);
    expect(SHOW_LINKS.map((l) => l.href)).toEqual(links.map((a) => a.getAttribute("href")));
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener");
    }
  });

  it("says that searches are logged", () => {
    render(<Footer />);
    expect(screen.getByText("Searches are logged anonymously to improve results.")).toBeTruthy();
  });

  it("Send feedback is a button after the links, and reports a press", () => {
    const onFeedback = vi.fn();
    render(<Footer onFeedback={onFeedback} />);
    const nav = screen.getByRole("navigation", { name: "The show" });
    const button = within(nav).getByRole("button", { name: "Send feedback" });
    expect(button.getAttribute("type")).toBe("button");
    expect(nav.lastElementChild).toBe(button);
    fireEvent.click(button);
    expect(onFeedback).toHaveBeenCalledTimes(1);
  });

  it("has no Send feedback until there is something for it to open", () => {
    render(<Footer />);
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
  });

  it("sets no style attribute", () => {
    const { container } = render(<Footer onFeedback={() => {}} />);
    expect(container.querySelectorAll("[style]").length).toBe(0);
  });
});

describe("in <App/>", () => {
  beforeEach(() => {
    stubFetch();
  });

  it("the footer landmark holds the show's links and both lines", () => {
    render(<App />);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getAllByRole("link")).toHaveLength(3);
    expect(footer.textContent).toContain("made with the hosts' blessing");
    expect(footer.textContent).toContain("Searches are logged anonymously to improve results.");
  });
});
