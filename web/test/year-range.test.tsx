// The year range chip and the syntax help (spec §5.2; plan 3 Task 8), alone and in <App/>.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { SyntaxHelp } from "../src/components/SyntaxHelp";
import { YearRange } from "../src/components/YearRange";
import { result, smartBody, stubFetch } from "./helpers";

const THIS_YEAR = new Date().getFullYear();

function go(url: string) {
  window.history.replaceState(null, "", url);
}

beforeEach(() => go("/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  go("/");
});

describe("<YearRange/>", () => {
  const noop = () => {};

  it("unset: an 'Any year' button that opens a dialog, and no clear button", () => {
    render(<YearRange range={null} thisYear={2026} onApply={noop} onClear={noop} />);
    const chip = screen.getByRole("button", { name: "Year range: Any year" });
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Clear years" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("set: shows the span with a clear button; one year shows alone", () => {
    const { rerender } = render(<YearRange range={{ from: 2015, to: 2020 }} thisYear={2026} onApply={noop} onClear={noop} />);
    expect(screen.getByRole("button", { name: "Year range: 2015–2020" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear years" })).toBeTruthy();
    rerender(<YearRange range={{ from: 2015, to: 2015 }} thisYear={2026} onApply={noop} onClear={noop} />);
    expect(screen.getByRole("button", { name: "Year range: 2015" })).toBeTruthy();
  });

  it("opens with From and To selects from 2007 to this year, and focus on From", () => {
    render(<YearRange range={null} thisYear={2026} onApply={noop} onClear={noop} />);
    const chip = screen.getByRole("button", { name: "Year range: Any year" });
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Year range" });
    const from = within(dialog).getByRole("combobox", { name: "From" }) as HTMLSelectElement;
    const to = within(dialog).getByRole("combobox", { name: "To" }) as HTMLSelectElement;
    const years = [...from.options].map((o) => o.value);
    expect(years[0]).toBe("2007");
    expect(years.at(-1)).toBe("2026");
    expect(years).toHaveLength(20);
    expect([...to.options].map((o) => o.value)).toEqual(years);
    expect(from.value).toBe("2007");
    expect(to.value).toBe("2026");
    expect(document.activeElement).toBe(from);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
  });

  it("starts from the current range, kept inside the options", () => {
    const { unmount } = render(<YearRange range={{ from: 2015, to: 2020 }} thisYear={2026} onApply={noop} onClear={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Year range: 2015–2020" }));
    expect((screen.getByRole("combobox", { name: "From" }) as HTMLSelectElement).value).toBe("2015");
    expect((screen.getByRole("combobox", { name: "To" }) as HTMLSelectElement).value).toBe("2020");
    unmount();
    // after:2030 reads as 2031 to this year: not in the lists, so the nearest ends.
    render(<YearRange range={{ from: 2031, to: 2026 }} thisYear={2026} onApply={noop} onClear={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Year range: 2031–2026" }));
    expect((screen.getByRole("combobox", { name: "From" }) as HTMLSelectElement).value).toBe("2026");
    expect((screen.getByRole("combobox", { name: "To" }) as HTMLSelectElement).value).toBe("2026");
  });

  it("Apply reports the picked years, closes, and returns focus to the chip", () => {
    const onApply = vi.fn();
    render(<YearRange range={null} thisYear={2026} onApply={onApply} onClear={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Year range: Any year" }));
    fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "2012" } });
    fireEvent.change(screen.getByRole("combobox", { name: "To" }), { target: { value: "2014" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(2012, 2014);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Year range: Any year" }));
  });

  it("'Any year' in the dialog clears and closes", () => {
    const onClear = vi.fn();
    render(<YearRange range={{ from: 2015, to: 2020 }} thisYear={2026} onApply={noop} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Year range: 2015–2020" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Any year: clear range" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("with the dialog open the chip and the dialog's button have different names, and the chip names the filter", () => {
    render(<YearRange range={null} thisYear={2026} onApply={noop} onClear={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Year range: Any year" }));
    expect(screen.getAllByRole("button", { name: "Any year: clear range" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Year range: Any year$/ })).toHaveLength(1);
  });

  it("the chip points at its dialog with aria-controls", () => {
    render(<YearRange range={null} thisYear={2026} onApply={noop} onClear={noop} />);
    const chip = screen.getByRole("button", { name: "Year range: Any year" });
    fireEvent.click(chip);
    const id = chip.getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(screen.getByRole("dialog").id).toBe(id);
  });

  it("Esc works with focus on the dialog itself (a click on its padding)", () => {
    render(<YearRange range={null} thisYear={2026} onApply={noop} onClear={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Year range: Any year" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("tabindex")).toBe("-1");
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Year range: Any year" }));
  });

  it("× clears and keeps focus on the chip", () => {
    const onClear = vi.fn();
    const { rerender } = render(<YearRange range={{ from: 2015, to: 2020 }} thisYear={2026} onApply={noop} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear years" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    rerender(<YearRange range={null} thisYear={2026} onApply={noop} onClear={onClear} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Year range: Any year" }));
  });

  it("Esc closes without applying, returns focus to the chip, and goes no further", () => {
    const onApply = vi.fn();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(<YearRange range={null} thisYear={2026} onApply={onApply} onClear={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Year range: Any year" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "To" }), { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Year range: Any year" }));
    expect(outer).not.toHaveBeenCalled();
  });

  it("a press outside closes it", () => {
    render(<YearRange range={null} thisYear={2026} onApply={noop} onClear={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Year range: Any year" }));
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "From" }));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Tab off the last control (or Shift+Tab off the first) closes it; Tab between controls does not", () => {
    render(<YearRange range={null} thisYear={2026} onApply={noop} onClear={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Year range: Any year" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "From" }), { key: "Tab" });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Apply" }), { key: "Tab" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Year range: Any year" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "From" }), { key: "Tab", shiftKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the chip button toggles the dialog", () => {
    render(<YearRange range={null} thisYear={2026} onApply={noop} onClear={noop} />);
    const chip = screen.getByRole("button", { name: "Year range: Any year" });
    fireEvent.click(chip);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(chip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("<SyntaxHelp/>", () => {
  it("a '?' button that opens the syntax table, with the year range row and no include:ads", () => {
    render(<SyntaxHelp onPick={() => {}} />);
    const button = screen.getByRole("button", { name: "Search syntax help" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "Search syntax" });
    const examples = within(dialog)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(examples).toEqual([
      "hide glue",
      '"hide glue"',
      "titebond -hide",
      "glue OR epoxy",
      "dovetail*",
      "year:2015",
      "after:2019",
      "before:2012",
      "year:2015-2020",
      "ep:613",
    ]);
    for (const text of ["both words", "the exact phrase", "without a word", "either", "words starting with it", "one episode"]) {
      expect(within(dialog).getByText(text)).toBeTruthy();
    }
    expect(within(dialog).getByText(/years 2015 to 2020, both included/)).toBeTruthy();
    expect(dialog.textContent).not.toContain("include:ads");
  });

  it("the '?' points at its dialog with aria-controls", () => {
    render(<SyntaxHelp onPick={() => {}} />);
    const button = screen.getByRole("button", { name: "Search syntax help" });
    fireEvent.click(button);
    const id = button.getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(screen.getByRole("dialog").id).toBe(id);
  });

  it("an example goes to the box: reported, and the dialog closes", () => {
    const onPick = vi.fn();
    render(<SyntaxHelp onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "Search syntax help" }));
    fireEvent.click(screen.getByRole("button", { name: "year:2015-2020" }));
    expect(onPick).toHaveBeenCalledWith("year:2015-2020");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Esc closes it and returns focus to the '?'; so does a press outside", () => {
    render(<SyntaxHelp onPick={() => {}} />);
    const button = screen.getByRole("button", { name: "Search syntax help" });
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the '?' toggles it, and focus moves into the dialog on opening", () => {
    render(<SyntaxHelp onPick={() => {}} />);
    const button = screen.getByRole("button", { name: "Search syntax help" });
    fireEvent.click(button);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("in <App/>", () => {
  function typeAndSubmit(text: string) {
    fireEvent.input(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
  }
  const box = () => screen.getByRole("textbox") as HTMLInputElement;

  it("the chip shows the range of the searched query, and the compact summary says it too", async () => {
    const calls = stubFetch();
    render(<App />);
    expect(screen.getByRole("button", { name: "Year range: Any year" })).toBeTruthy();
    typeAndSubmit("glue after:2019");
    calls[0]!.respond(smartBody([result(1)]));
    expect(await screen.findByRole("button", { name: `Year range: 2020–${THIS_YEAR}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Smart · Relevance · 2020–/ })).toBeTruthy();
  });

  it("the chip does not change while typing, only when the search runs", () => {
    stubFetch();
    render(<App />);
    fireEvent.input(box(), { target: { value: "glue year:2015" } });
    expect(screen.getByRole("button", { name: "Year range: Any year" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("button", { name: "Year range: 2015" })).toBeTruthy();
  });

  it("a shared link with a range shows it", () => {
    go("/?q=glue+year%3A2015-2020");
    stubFetch();
    render(<App />);
    expect(screen.getByRole("button", { name: "Year range: 2015–2020" })).toBeTruthy();
  });

  it("Apply writes year:A-B into the box (replacing the old tokens), searches page 1 and adds a history entry", async () => {
    go("/?q=glue+after%3A2001&page=2");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(smartBody([result(1)]));
    const before = window.history.length;
    fireEvent.click(await screen.findByRole("button", { name: /^Year range: 2002–/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "2012" } });
    fireEvent.change(screen.getByRole("combobox", { name: "To" }), { target: { value: "2014" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(box().value).toBe("glue year:2012-2014"));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("q")).toBe("glue year:2012-2014");
    expect(calls[1]!.url.searchParams.get("page")).toBe("1");
    expect(window.location.search).toBe("?q=glue+year%3A2012-2014");
    expect(window.history.length).toBe(before + 1);
    calls[1]!.respond(smartBody([result(1)]));
    expect(await screen.findByRole("button", { name: "Year range: 2012–2014" })).toBeTruthy();
  });

  it("Apply with the same year at both ends writes year:A", async () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("glue");
    calls[0]!.respond(smartBody([result(1)]));
    fireEvent.click(await screen.findByRole("button", { name: "Year range: Any year" }));
    fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "2015" } });
    fireEvent.change(screen.getByRole("combobox", { name: "To" }), { target: { value: "2015" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(box().value).toBe("glue year:2015"));
    expect(calls[1]!.url.searchParams.get("q")).toBe("glue year:2015");
  });

  it("× removes the tokens from the box and re-runs the search", async () => {
    go("/?q=glue+year%3A2015-2020");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(smartBody([result(1)]));
    fireEvent.click(await screen.findByRole("button", { name: "Clear years" }));
    await waitFor(() => expect(box().value).toBe("glue"));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("q")).toBe("glue");
    expect(window.location.search).toBe("?q=glue");
    expect(screen.getByRole("button", { name: "Year range: Any year" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear years" })).toBeNull();
  });

  it("× on a query that was only a range goes back to the bare page", async () => {
    go("/?q=year%3A2015");
    const calls = stubFetch();
    render(<App />);
    calls[0]!.respond(smartBody([result(1)]));
    fireEvent.click(await screen.findByRole("button", { name: "Clear years" }));
    await waitFor(() => expect(box().value).toBe(""));
    expect(window.location.search).toBe("");
  });

  it("Apply and × build on what is in the box now, typed or not", async () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("glue");
    calls[0]!.respond(smartBody([result(1)]));
    await screen.findByText(/Text of passage 1/);
    fireEvent.input(box(), { target: { value: "glue clamps" } });
    fireEvent.click(screen.getByRole("button", { name: "Year range: Any year" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.url.searchParams.get("q")).toBe(`glue clamps year:2007-${THIS_YEAR}`);
  });

  it("a syntax example lands in the box and the box has focus, with no search", async () => {
    const calls = stubFetch();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Search syntax help" }));
    fireEvent.click(screen.getByRole("button", { name: "year:2015-2020" }));
    await waitFor(() => expect(box().value).toBe("year:2015-2020"));
    expect(document.activeElement).toBe(box());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toHaveLength(0);
    // Enter then searches it, and the chip follows.
    fireEvent.submit(screen.getByRole("search"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("q")).toBe("year:2015-2020");
    expect(screen.getByRole("button", { name: "Year range: 2015–2020" })).toBeTruthy();
  });

  it("Esc in the year dialog closes it and returns focus to the chip", async () => {
    const calls = stubFetch();
    render(<App />);
    typeAndSubmit("glue");
    calls[0]!.respond(smartBody([result(1)]));
    await screen.findByText(/Text of passage 1/);
    fireEvent.click(screen.getByRole("button", { name: "Year range: Any year" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "From" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Year range: Any year" }));
  });
});
