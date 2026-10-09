// How many pages an answer has (spec §4.4). Pure: no DOM, no Preact. The caps are url.ts's
// LAST_PAGE (200 exact / 100 smart results at the 20 a page the app uses), kept in one place.
import type { SearchData } from "./api";
import { LAST_PAGE } from "./url";

/**
 * The last page that can be shown. Exact knows its total, so it is exact (up to the cap); Smart
 * has no count, so it is the page after the current one while `has_more`, else the current page.
 */
export function lastPage(data: SearchData): number {
  if (data.mode === "exact") {
    return Math.max(1, data.page, Math.min(Math.ceil(data.total / data.limit), LAST_PAGE.exact));
  }
  return data.has_more ? Math.min(data.page + 1, LAST_PAGE.smart) : data.page;
}
