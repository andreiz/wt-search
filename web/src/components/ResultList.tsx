// The results as a real list with roving tabindex: one card is in the tab order, and ArrowDown/
// ArrowUp and j/k (lib/keys.ts) move focus between cards. The cards are placeholders (title and
// text) until Task 9 builds the result card.
import type { RefObject } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
import type { SearchResult } from "../../../worker/src/api-types";

function title(result: SearchResult): string {
  const { number, title: name } = result.episode;
  return number === null ? name : `Ep. ${number} · ${name}`;
}

export function ResultList({ results, listRef }: { results: SearchResult[]; listRef: RefObject<HTMLOListElement | null> }) {
  const [active, setActive] = useState(0);
  const current = Math.min(active, Math.max(results.length - 1, 0));

  // Whichever card (or something inside it) takes focus becomes the one in the tab order.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onFocus = (event: FocusEvent) => {
      const cards = [...list.querySelectorAll("[data-result]")];
      const at = cards.findIndex((card) => card.contains(event.target as Node));
      if (at !== -1) setActive(at);
    };
    // `focus` does not bubble, so listen in the capture phase.
    list.addEventListener("focus", onFocus, true);
    return () => list.removeEventListener("focus", onFocus, true);
  }, [listRef]);

  return (
    <ol class="results" aria-label="Results" ref={listRef}>
      {results.map((result, index) => (
        <li key={result.chunk_id} class="result" data-result tabIndex={index === current ? 0 : -1}>
          <p class="result__title">{title(result)}</p>
          <p class="result__text">{result.text}</p>
        </li>
      ))}
    </ol>
  );
}
