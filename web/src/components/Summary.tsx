// The summary line under the bar (Screen.dc.html; spec §5.2, §4.4). Related (the "related" mode):
// "Related (beta) · top results 1–20" (which results this page holds; "top result 41" for one,
// bare "Related (beta)" for none; "top" because Related shows the best matches, not all of them).
// Exact: "**318 matches**" or "**1,000+ matches**". When the page folded hits into a nearby
// result: "; 4 results (1 folded into a nearby hit)", as `wts search` words it
// (pipeline/src/wts/search.py `_header`). Exact on a phone also shows " · page N of M".
import type { SearchData } from "../lib/api";
import { count } from "../lib/format";
import { lastPage } from "../lib/paging";

function folded(data: SearchData): string {
  const hits = data.results.reduce((sum, r) => sum + r.more_in_episode, 0);
  if (hits === 0) return "";
  const results = `${data.results.length} result${data.results.length === 1 ? "" : "s"}`;
  return `; ${results} (${hits} folded into ${hits === 1 ? "a nearby hit" : "nearby hits"})`;
}

export function Summary({ data }: { data: SearchData }) {
  if (data.mode === "exact") {
    const one = data.total === 1 && !data.total_capped;
    const matches = `${count(data.total, data.total_capped)} ${one ? "match" : "matches"}`;
    const pages = lastPage(data);
    return (
      <p class="summary">
        <strong class="summary__count">{matches}</strong>
        {folded(data)}
        {pages > 1 && <span class="summary__phone">{` · page ${data.page} of ${pages}`}</span>}
      </p>
    );
  }
  const shown = data.results.length;
  const first = (data.page - 1) * data.limit + 1;
  const range = shown === 0 ? "" : shown === 1 ? ` · top result ${first}` : ` · top results ${first}–${first + shown - 1}`;
  return <p class="summary">{`Related (beta)${range}`}</p>;
}
