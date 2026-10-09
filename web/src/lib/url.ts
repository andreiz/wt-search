// The search state in the address bar (spec §5.2): ?q=&mode=&sort=&page=, defaults omitted,
// so a shared link, a reload and Back/Forward all show the same search.
//
// Bad values fall back the way the Worker's own reading does (worker/src/index.ts `search`):
//   mode  exactly "exact" is exact (case-sensitive); anything else is smart.
//   sort  lower-cased, then one of the three; anything else is relevance.
//   page  digits only, else 1; at least 1 and at most the last page for the mode.
// The last page assumes the default page size of 20 (the app never sends `limit`): 10 for
// exact (200 results) and 5 for smart (100 results). The Worker's clamp can be tighter only
// through `limit`, which the app does not use. Whether a page has results is not known here.
//
// Pure: no DOM, no Preact.

export type Mode = "smart" | "exact";
export type SortOrder = "relevance" | "newest" | "oldest";

export interface SearchState {
  q: string;
  mode: Mode;
  sort: SortOrder;
  page: number;
}

const SORTS: readonly SortOrder[] = ["relevance", "newest", "oldest"];

/** Last page at 20 results a page: exact shows at most 200 results, smart 100 (spec §4.4). */
const LAST_PAGE: Record<Mode, number> = { exact: 10, smart: 5 };

function clampPage(page: number, mode: Mode): number {
  // Only NaN is 1; Infinity (309+ digits) clamps to the last page, as the Worker's Math.min does.
  if (Number.isNaN(page)) return 1;
  return Math.min(Math.max(Math.floor(page), 1), LAST_PAGE[mode]);
}

/** `location.search` (with or without the leading `?`) to a state. Never throws. */
export function parse(search: string): SearchState {
  const params = new URLSearchParams(search);
  const mode: Mode = params.get("mode") === "exact" ? "exact" : "smart";
  const sortParam = (params.get("sort") ?? "").toLowerCase();
  const sort = SORTS.find((s) => s === sortParam) ?? "relevance";
  const pageParam = params.get("page");
  const page = pageParam !== null && /^\d+$/.test(pageParam) ? clampPage(Number(pageParam), mode) : 1;
  return { q: (params.get("q") ?? "").trim(), mode, sort, page };
}

/**
 * A state to a string for `location.search`: `?q=…&mode=…&sort=…&page=…` with defaults left
 * out, and "" (no `?`) when nothing is left. `q` is trimmed; spaces are written as `+`.
 */
export function serialize(state: SearchState): string {
  const params = new URLSearchParams();
  const q = state.q.trim();
  if (q !== "") params.set("q", q);
  if (state.mode !== "smart") params.set("mode", state.mode);
  if (state.sort !== "relevance") params.set("sort", state.sort);
  const page = clampPage(state.page, state.mode);
  if (page !== 1) params.set("page", String(page));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}
