// The search bar, mode switch, sort menu and the keyboard helpers (spec §5.2, §5.7).
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModeSwitch } from "../src/components/ModeSwitch";
import { SearchBar } from "../src/components/SearchBar";
import { SortMenu } from "../src/components/SortMenu";
import { handleKeydown, isTypingTarget } from "../src/lib/keys";

afterEach(cleanup);

describe("<SearchBar/>", () => {
  it("limits the input to the Worker's 200-character query", () => {
    render(<SearchBar value="" onInput={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole("textbox", { name: /search/i }).getAttribute("maxlength")).toBe("200");
  });

  it("submits the text on the Search button and on form submit (Enter), and not on typing", () => {
    const onSubmit = vi.fn();
    const onInput = vi.fn();
    render(<SearchBar value="glue" onInput={onInput} onSubmit={onSubmit} />);
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "glues" } });
    expect(onInput).toHaveBeenCalledWith("glues");
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.submit(screen.getByRole("search"));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("shows the '/' hint only while the box is empty, and a clear button only when it is filled", () => {
    const { container, rerender } = render(<SearchBar value="" onInput={() => {}} onSubmit={() => {}} />);
    expect(container.querySelector("kbd")?.textContent).toBe("/");
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    rerender(<SearchBar value="x" onInput={() => {}} onSubmit={() => {}} />);
    expect(container.querySelector("kbd")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
  });

  it("clear empties the box without searching, and puts the cursor back in it", () => {
    const onInput = vi.fn();
    const onSubmit = vi.fn();
    render(<SearchBar value="x" onInput={onInput} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onInput).toHaveBeenCalledWith("");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
});

describe("<ModeSwitch/>", () => {
  it("is a radio group of Smart and Exact with their tooltips", () => {
    render(<ModeSwitch mode="smart" onChange={() => {}} />);
    const group = screen.getByRole("radiogroup", { name: "Search mode" });
    expect(group).toBeTruthy();
    const smart = screen.getByRole("radio", { name: "Smart" });
    const exact = screen.getByRole("radio", { name: "Exact" });
    expect(smart.getAttribute("aria-checked")).toBe("true");
    expect(exact.getAttribute("aria-checked")).toBe("false");
    expect(smart.getAttribute("title")).toBe("Matches meaning as well as words");
    expect(exact.getAttribute("title")).toBe("Exact keywords only, with counts");
  });

  it("reports the other mode when it is clicked, and nothing for the current one", () => {
    const onChange = vi.fn();
    render(<ModeSwitch mode="smart" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Smart" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Exact" }));
    expect(onChange).toHaveBeenCalledWith("exact");
  });

  it("moves with the arrow keys, as radio groups do", () => {
    const onChange = vi.fn();
    render(<ModeSwitch mode="smart" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "Smart" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("exact");
  });

  it("only the selected radio is in the tab order", () => {
    render(<ModeSwitch mode="exact" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "Exact" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Smart" }).getAttribute("tabindex")).toBe("-1");
  });
});

describe("<SortMenu/>", () => {
  it("shows the current sort on a menu button, closed", () => {
    render(<SortMenu sort="newest" onChange={() => {}} />);
    const button = screen.getByRole("button", { name: "Sort: Newest" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens with Relevance, Newest and Oldest, the current one checked", () => {
    render(<SortMenu sort="newest" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort: Newest" }));
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent?.replace("✓", "").trim())).toEqual(["Relevance", "Newest", "Oldest"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("choosing an option reports it, closes the menu and returns focus to the button", () => {
    const onChange = vi.fn();
    render(<SortMenu sort="relevance" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort: Relevance" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Oldest/ }));
    expect(onChange).toHaveBeenCalledWith("oldest");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Sort/ }));
  });

  it("Esc closes the menu without choosing", () => {
    const onChange = vi.fn();
    render(<SortMenu sort="relevance" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a click elsewhere closes it", () => {
    render(<SortMenu sort="relevance" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("keys", () => {
  function setup() {
    document.body.innerHTML = `
      <input id="q" />
      <textarea id="t"></textarea>
      <ol id="list">
        <li data-result tabindex="0" id="a">a</li>
        <li data-result tabindex="-1" id="b">b</li>
        <li data-result tabindex="-1" id="c">c</li>
      </ol>`;
    const q = document.getElementById("q") as HTMLInputElement;
    const list = document.getElementById("list") as HTMLElement;
    return { q, list, ctx: { input: q, list } };
  }
  function press(target: Element, key: string, init: KeyboardEventInit = {}) {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  }

  it("isTypingTarget: inputs, textareas, selects and editable elements, not buttons", () => {
    document.body.innerHTML = `<input id="i"><textarea id="t"></textarea><select id="s"></select><div id="e" contenteditable="true"></div><button id="b"></button><input id="r" type="radio">`;
    const el = (id: string) => document.getElementById(id);
    expect(isTypingTarget(el("i"))).toBe(true);
    expect(isTypingTarget(el("t"))).toBe(true);
    expect(isTypingTarget(el("s"))).toBe(true);
    expect(isTypingTarget(el("e"))).toBe(true);
    expect(isTypingTarget(el("b"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("'/' focuses the input and does not type a slash", () => {
    const { q, ctx } = setup();
    const e = press(document.body, "/");
    expect(handleKeydown(e, ctx)).toBe(true);
    expect(document.activeElement).toBe(q);
    expect(e.defaultPrevented).toBe(true);
  });

  it("'/', j, k and the arrows are left alone while typing in a field", () => {
    const { q, list, ctx } = setup();
    q.focus();
    for (const key of ["/", "j", "k", "ArrowDown", "ArrowUp"]) {
      const e = press(q, key);
      expect(handleKeydown(e, ctx), key).toBe(false);
      expect(e.defaultPrevented, key).toBe(false);
    }
    expect(list.contains(document.activeElement)).toBe(false);
    const t = document.getElementById("t") as HTMLElement;
    t.focus();
    expect(handleKeydown(press(t, "j"), ctx)).toBe(false);
  });

  it("j and ArrowDown move to the next result, k and ArrowUp to the previous", () => {
    const { ctx } = setup();
    const a = document.getElementById("a") as HTMLElement;
    a.focus();
    handleKeydown(press(a, "j"), ctx);
    expect(document.activeElement?.id).toBe("b");
    handleKeydown(press(document.activeElement as Element, "ArrowDown"), ctx);
    expect(document.activeElement?.id).toBe("c");
    handleKeydown(press(document.activeElement as Element, "ArrowDown"), ctx);
    expect(document.activeElement?.id).toBe("c");
    handleKeydown(press(document.activeElement as Element, "k"), ctx);
    expect(document.activeElement?.id).toBe("b");
    handleKeydown(press(document.activeElement as Element, "ArrowUp"), ctx);
    expect(document.activeElement?.id).toBe("a");
    handleKeydown(press(document.activeElement as Element, "ArrowUp"), ctx);
    expect(document.activeElement?.id).toBe("a");
  });

  it("j from nowhere goes to the first result, but the arrows only act inside the list (they scroll the page)", () => {
    const { ctx } = setup();
    const down = press(document.body, "ArrowDown");
    expect(handleKeydown(down, ctx)).toBe(false);
    expect(down.defaultPrevented).toBe(false);
    expect(handleKeydown(press(document.body, "j"), ctx)).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("ignores keys with Ctrl, Meta or Alt held, and keys pressed inside a menu or dialog", () => {
    document.body.innerHTML = `<ol id="list"><li data-result tabindex="0" id="a">a</li></ol><div role="menu"><button id="m"></button></div>`;
    const ctx = { input: null, list: document.getElementById("list") as HTMLElement };
    expect(handleKeydown(press(document.body, "j", { ctrlKey: true }), ctx)).toBe(false);
    expect(handleKeydown(press(document.body, "j", { metaKey: true }), ctx)).toBe(false);
    expect(handleKeydown(press(document.getElementById("m") as Element, "j"), ctx)).toBe(false);
  });

  it("does nothing when there are no results", () => {
    document.body.innerHTML = `<input id="q">`;
    const ctx = { input: document.getElementById("q") as HTMLElement, list: null };
    expect(handleKeydown(press(document.body, "j"), ctx)).toBe(false);
  });
});
