// The phone's Sort & years sheet and its button (spec §5.2 "Round 2"; plan 6 Task 2): staged
// choices applied at once, Esc and the scrim close without applying, focus stays inside.
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SortYearsButton } from "../src/components/SortYearsButton";
import { SortYearsSheet } from "../src/components/SortYearsSheet";

afterEach(cleanup);

function sheet(over: Partial<Parameters<typeof SortYearsSheet>[0]> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(<SortYearsSheet sort="relevance" range={null} thisYear={2026} onApply={onApply} onClose={onClose} {...over} />);
  return { onApply, onClose };
}

const from = () => screen.getByRole("combobox", { name: "From" }) as HTMLSelectElement;
const to = () => screen.getByRole("combobox", { name: "To" }) as HTMLSelectElement;

describe("<SortYearsSheet/>", () => {
  it("is a dialog named 'Sort & years' with Best match, Newest and Oldest radios", () => {
    sheet();
    const dialog = screen.getByRole("dialog", { name: "Sort & years" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const group = screen.getByRole("radiogroup", { name: "Sort" });
    expect(group).toBeTruthy();
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? r.textContent)).toEqual(["Best match", "Newest", "Oldest"]);
  });

  it("opens with the props' sort checked and range in the selects, focus on the checked radio", () => {
    sheet({ sort: "oldest", range: { from: 2015, to: 2020 } });
    expect(screen.getByRole("radio", { name: "Oldest" }).getAttribute("aria-checked")).toBe("true");
    expect(from().value).toBe("2015");
    expect(to().value).toBe("2020");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Oldest" }));
  });

  it("with no range the selects show the whole corpus", () => {
    sheet();
    expect(from().value).toBe("2007");
    expect(to().value).toBe("2026");
  });

  it("Show results applies sort and years together, once, then closes", () => {
    const { onApply, onClose } = sheet();
    fireEvent.click(screen.getByRole("radio", { name: "Newest" }));
    fireEvent.change(from(), { target: { value: "2015" } });
    fireEvent.change(to(), { target: { value: "2020" } });
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show results" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith("newest", { from: 2015, to: 2020 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Done does the same", () => {
    const { onApply, onClose } = sheet();
    fireEvent.click(screen.getByRole("radio", { name: "Newest" }));
    fireEvent.change(from(), { target: { value: "2015" } });
    fireEvent.change(to(), { target: { value: "2020" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith("newest", { from: 2015, to: 2020 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc, also on a select, and a scrim click only close", () => {
    const { onApply, onClose } = sheet();
    fireEvent.click(screen.getByRole("radio", { name: "Newest" }));
    const escape = fireEvent.keyDown(from(), { key: "Escape" });
    expect(escape).toBe(false); // preventDefault was called
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector(".sheet-scrim")!);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("Esc does not reach an ancestor's key handler", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <SortYearsSheet sort="relevance" range={null} thisYear={2026} onApply={() => {}} onClose={() => {}} />
      </div>,
    );
    fireEvent.keyDown(from(), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
  });

  it("Any year clears the staged years: applying gives null, the selects show the whole corpus", () => {
    const { onApply } = sheet({ sort: "newest", range: { from: 2015, to: 2020 } });
    fireEvent.click(screen.getByRole("button", { name: "Any year" }));
    expect(from().value).toBe("2007");
    expect(to().value).toBe("2026");
    fireEvent.click(screen.getByRole("button", { name: "Show results" }));
    expect(onApply).toHaveBeenCalledWith("newest", null);
  });

  it("Tab from Show results wraps to the first focusable, Shift+Tab from it wraps back", () => {
    sheet();
    const last = screen.getByRole("button", { name: "Show results" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("the arrow keys move the sort choice", () => {
    const { onApply } = sheet();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Best match" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Newest" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Show results" }));
    expect(onApply).toHaveBeenCalledWith("newest", null);
  });
});

describe("<SortYearsButton/>", () => {
  const props = { open: false, onOpen: () => {}, buttonRef: { current: null } };

  it("reads 'Any year', with the name 'Sort and years: Best match, Any year', no dot", () => {
    render(<SortYearsButton sort="relevance" range={null} {...props} />);
    const button = screen.getByRole("button", { name: "Sort and years: Best match, Any year" });
    expect(button.textContent).toBe("Any year");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.classList.contains("sort-years-button--set")).toBe(false);
    expect(button.querySelector(".sort-years-button__dot")).toBeNull();
  });

  it("a set range and a sort other than Best match: accent style and the dot", () => {
    render(<SortYearsButton sort="newest" range={{ from: 2015, to: 2020 }} {...props} />);
    const button = screen.getByRole("button", { name: "Sort and years: Newest, 2015–2020" });
    expect(button.classList.contains("sort-years-button--set")).toBe(true);
    expect(button.querySelector(".sort-years-button__dot")?.getAttribute("aria-hidden")).toBe("true");
  });
});
