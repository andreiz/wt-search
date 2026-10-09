// The page shell (spec §5.1, §5.7): title, the three landmarks, no style attributes.
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app";

afterEach(cleanup);

describe("<App/>", () => {
  it("shows the site title and the unofficial note in the header", () => {
    render(<App />);
    const header = screen.getByRole("banner");
    expect(header.textContent).toContain("Wood Talk Search");
    expect(header.textContent).toContain("Unofficial · fan-made");
  });

  it("has a header, a main and a footer landmark", () => {
    render(<App />);
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
  });

  it("names the footer's note about the hosts", () => {
    render(<App />);
    expect(screen.getByRole("contentinfo").textContent).toContain("made with the hosts' blessing");
  });

  it("never sets a style attribute (CSP style-src 'self')", () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll("[style]").length).toBe(0);
  });
});
