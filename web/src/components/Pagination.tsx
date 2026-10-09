// Previous / Next, and for Exact the page numbers up to the cap (Screen.dc.html; spec §5.6).
// Phones hide the numbers with CSS and show "page N of M" in the summary instead.
import type { SearchData } from "../lib/api";
import { lastPage } from "../lib/paging";

export function Pagination({ data, onPage }: { data: SearchData; onPage: (page: number) => void }) {
  if (data.page === 1 && !data.has_more) return null;
  const { page } = data;
  const numbers = data.mode === "exact" ? Array.from({ length: lastPage(data) }, (_, i) => i + 1) : [];

  return (
    <nav class="pager" aria-label="Pages">
      <button type="button" class="pager__button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <span aria-hidden="true">← </span>Previous
      </button>
      {numbers.length > 1 && (
        <div class="pager__numbers">
          {numbers.map((n) => (
            <button
              key={n}
              type="button"
              class={n === page ? "pager__number pager__number--current" : "pager__number"}
              aria-label={`Page ${n}`}
              aria-current={n === page ? "page" : undefined}
              onClick={() => {
                if (n !== page) onPage(n);
              }}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      <button type="button" class="pager__button" disabled={!data.has_more} onClick={() => onPage(page + 1)}>
        Next<span aria-hidden="true"> →</span>
      </button>
    </nav>
  );
}
