// Summary wording (spec §5.2, §4.4; as `wts search` words it) and the pager (spec §5.6).
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pagination } from "../src/components/Pagination";
import { Summary } from "../src/components/Summary";
import { exactBody, result, relatedBody } from "./helpers";

afterEach(cleanup);

/** What a screen reader hears: the text without the `aria-hidden` parts (the BETA tag). */
function summaryText(data: Parameters<typeof Summary>[0]["data"]): string {
  const { container } = render(<Summary data={data} />);
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[aria-hidden='true']").forEach((el) => el.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("<Summary/>", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => result(i + 1));

  it("Related: a BETA tag after 'Related', hidden from screen readers, and '(beta)' said in words", () => {
    const { container } = render(<Summary data={relatedBody(many(20))} />);
    const rel = container.querySelector(".summary__rel");
    expect(rel?.textContent).toBe("Related BETA");
    expect(rel?.querySelector(".beta-tag")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".visually-hidden")?.textContent?.trim()).toBe("(beta)");
  });

  it("Exact has no BETA tag", () => {
    const { container } = render(<Summary data={exactBody([result(1)], { total: 5 })} />);
    expect(container.querySelector(".beta-tag")).toBeNull();
  });

  it("Related page 1: the range of results shown", () => {
    expect(summaryText(relatedBody(many(20)))).toBe("Related (beta) · top results 1–20");
  });

  it("Related page 2: the range continues from the page size", () => {
    expect(summaryText(relatedBody(many(20), { page: 2 }))).toBe("Related (beta) · top results 21–40");
    expect(summaryText(relatedBody(many(7), { page: 3 }))).toBe("Related (beta) · top results 41–47");
  });

  it("Related: one result on the page reads 'top result N'", () => {
    expect(summaryText(relatedBody([result(1)], { page: 3 }))).toBe("Related (beta) · top result 41");
    expect(summaryText(relatedBody([result(1)]))).toBe("Related (beta) · top result 1");
  });

  it("Related: no results is just 'Related (beta)'", () => {
    expect(summaryText(relatedBody([]))).toBe("Related (beta)");
  });

  it("Related: no page number and no folding note", () => {
    const text = summaryText(relatedBody([result(1, { more_in_episode: 2, folded: [8, 9] }), result(2)], { page: 2 }));
    expect(text).toBe("Related (beta) · top results 21–22");
    expect(text).not.toContain("page");
    expect(text).not.toContain("folded");
  });

  it("Exact: the match count, with a thousands separator", () => {
    expect(summaryText(exactBody([result(1)], { total: 1318 }))).toContain("1,318 matches");
    expect(summaryText(exactBody([result(1)], { total: 318 }))).toContain("318 matches");
  });

  it("Exact: one match is singular, none is plural", () => {
    expect(summaryText(exactBody([result(1)], { total: 1 }))).toContain("1 match");
    expect(summaryText(exactBody([result(1)], { total: 1 }))).not.toContain("1 matches");
    expect(summaryText(exactBody([], { total: 0 }))).toContain("0 matches");
  });

  it("Exact: a capped total reads '1,000+ matches'", () => {
    expect(summaryText(exactBody([result(1)], { total: 1000, total_capped: true }))).toContain("1,000+ matches");
  });

  it("Exact: the count is bold, the rest is not", () => {
    const { container } = render(<Summary data={exactBody([result(1)], { total: 318 })} />);
    expect(container.querySelector("strong")?.textContent).toBe("318 matches");
  });

  it("Exact on phones adds 'page N of M' (hidden from desktop by CSS, not by the markup)", () => {
    const { container } = render(<Summary data={exactBody([result(1)], { total: 212, page: 2 })} />);
    const phone = container.querySelector(".summary__phone");
    expect(phone?.textContent).toBe(" · page 2 of 10");
  });

  it("Exact: M is the pages that can be shown (200 results at most, 20 a page)", () => {
    const { container } = render(<Summary data={exactBody([result(1)], { total: 45 })} />);
    expect(container.querySelector(".summary__phone")?.textContent).toBe(" · page 1 of 3");
  });

  it("says how many results the page folded: '5 matches; 4 results (1 folded into a nearby hit)'", () => {
    const results = [result(1, { more_in_episode: 1, folded: [9] }), result(2), result(3), result(4)];
    expect(summaryText(exactBody(results, { total: 5 }))).toContain("5 matches; 4 results (1 folded into a nearby hit)");
  });

  it("says 'nearby hits' when more than one was folded, and 'result' for one", () => {
    const two = [result(1, { more_in_episode: 2, folded: [8, 9] })];
    expect(summaryText(exactBody(two, { total: 3 }))).toContain("3 matches; 1 result (2 folded into nearby hits)");
  });

  it("is not its own live region (the page's persistent status region holds it)", () => {
    const { container } = render(<Summary data={relatedBody([result(1)])} />);    expect(container.querySelector("[aria-live]")).toBeNull();
  });
});

describe("<Pagination/>", () => {
  it("Smart: Previous and Next only, from page and has_more", () => {
    render(<Pagination data={relatedBody([result(1)], { page: 2, has_more: true })} onPage={() => {}} />);
    expect(screen.getByRole("button", { name: /Previous/ }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: /Next/ }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "Page 3" })).toBeNull();
  });

  it("disables Previous on page 1 and Next without has_more", () => {
    const { rerender } = render(<Pagination data={relatedBody([result(1)], { page: 1, has_more: true })} onPage={() => {}} />);
    expect(screen.getByRole("button", { name: /Previous/ }).hasAttribute("disabled")).toBe(true);
    rerender(<Pagination data={relatedBody([result(1)], { page: 2, has_more: false })} onPage={() => {}} />);
    expect(screen.getByRole("button", { name: /Next/ }).hasAttribute("disabled")).toBe(true);
  });

  it("is absent when there is only one page", () => {
    const { container } = render(<Pagination data={relatedBody([result(1)])} onPage={() => {}} />);
    expect(container.querySelector("nav")).toBeNull();
  });

  it("asks for the neighbouring page", () => {
    const onPage = vi.fn();
    render(<Pagination data={relatedBody([result(1)], { page: 2, has_more: true })} onPage={onPage} />);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    expect(onPage.mock.calls).toEqual([[3], [1]]);
  });

  it("Exact: page numbers up to the cap, the current one marked", () => {
    const onPage = vi.fn();
    render(<Pagination data={exactBody([result(1)], { total: 1000, total_capped: true, page: 4, has_more: true })} onPage={onPage} />);
    const nav = screen.getByRole("navigation", { name: "Pages" });
    const numbers = [...nav.querySelectorAll("button")].map((b) => b.textContent).filter((t) => /^\d+$/.test(t ?? ""));
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(nav.querySelector("[aria-current='page']")?.textContent).toBe("4");
    fireEvent.click(screen.getByRole("button", { name: "Page 7" }));
    expect(onPage).toHaveBeenCalledWith(7);
  });

  it("Exact: only as many numbers as there are pages", () => {
    render(<Pagination data={exactBody([result(1)], { total: 45, page: 1, has_more: true })} onPage={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Pages" });
    const numbers = [...nav.querySelectorAll("button")].map((b) => b.textContent).filter((t) => /^\d+$/.test(t ?? ""));
    expect(numbers).toEqual(["1", "2", "3"]);
  });

  it("gives the page buttons names a screen reader can use", () => {
    render(<Pagination data={exactBody([result(1)], { total: 45, page: 1, has_more: true })} onPage={() => {}} />);
    expect(screen.getByRole("button", { name: "Page 2" })).toBeTruthy();
  });
});
