// The footer (spec §5.7; design README "Footer"; brief §4.7).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { Footer, SHOW_LINKS, TAGLINE } from "../src/components/Footer";
import { setMaintainer } from "../src/lib/traffic";
import { stubFetch } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<Footer/>", () => {
  it("says it is unofficial and fan-made, from one constant", () => {
    const { container } = render(<Footer />);
    expect(TAGLINE).toBe("fan-made");
    expect(container.querySelector("p")?.textContent).toBe(`Unofficial · ${TAGLINE}`);
    expect(container.querySelector("p strong")?.textContent).toBe("Unofficial");
  });

  it("says the maintainer's searches are not counted while the switch is on", () => {
    setMaintainer(true);
    try {
      const { container } = render(<Footer />);
      expect(container.querySelector("p")?.textContent).toBe(`Unofficial · ${TAGLINE} · not counted`);
    } finally {
      setMaintainer(false);
    }
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

  it("Send feedback is a button after the links; it toggles the form and says so", () => {
    render(<Footer feedback />);
    const nav = screen.getByRole("navigation", { name: "The show" });
    const button = within(nav).getByRole("button", { name: "Send feedback" });
    expect(button.getAttribute("type")).toBe("button");
    expect(nav.lastElementChild).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("form", { name: "Send feedback" })).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("form", { name: "Send feedback" })).toBeTruthy();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("form", { name: "Send feedback" })).toBeNull();
  });

  it("has no Send feedback unless it is given the form to open", () => {
    render(<Footer />);
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
  });

  it("sets no style attribute, closed or open", () => {
    const { container } = render(<Footer feedback />);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
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
    expect(footer.textContent).toContain("Unofficial · fan-made");
    expect(footer.textContent).toContain("Searches are logged anonymously to improve results.");
  });
});
