// The `ep:N` filter in the query text (spec §4.3), for "Search this episode" (spec §5.4). Like the
// year range it is a token of `q`, read the way the Worker's parser reads it (worker/src/query.ts
// EP_FILTER: `ep:` and one to five digits, as a whole word, in any letter case), so this puts
// `ep:N` in the text and takes an existing one out; nothing else is state.
//
// Pure: no DOM, no Preact.
import { normalizeQuery } from "./url";
import { MAX_QUERY_CHARS, withoutFilters } from "./years";

const EP_FILTER = /^ep:(\d{1,5})$/i;

/**
 * The query with its `ep:` tokens replaced by one `ep:N` at the end. The Worker reads only the
 * first 200 code points, so when the token at the end would fall past them it goes first instead;
 * no word is dropped.
 */
export function setEpisode(q: string, number: number): string {
  const rest = withoutFilters(q, (token) => token.kind === "word" && EP_FILTER.test(token.text));
  const token = `ep:${number}`;
  const appended = normalizeQuery(`${rest} ${token}`);
  if (Array.from(appended).length <= MAX_QUERY_CHARS) return appended;
  return normalizeQuery(`${token} ${rest}`);
}
