// A dense result card (spec §5.3; docs/design/card-separation-options.html, option A): the header
// "Ep. 71 · Title" with the match count and the date, on the page background, then the card's box
// (`.result__card`) holding one hit row per hit. The list item is one stop for the arrow and j/k
// keys (lib/keys.ts) and is labelled by the header; it is focusable (roving tabindex, set by
// ResultList).
import type { SearchResult } from "../../../worker/src/api-types";
import { episodeDate } from "../lib/format";
import type { Card } from "../lib/group";
import { displayTitle } from "../lib/title";
import { HitRow, type HitActions } from "./HitRow";

const noop = () => {};

export function ResultCard({
  card,
  tabIndex,
  onMore = noop,
  onNearby = noop,
  onReport = noop,
}: Partial<HitActions> & {
  /** A related card (`card.related`) is dashed, tagged "Related", with a muted excerpt. */
  card: Card;
  tabIndex: number;
}) {
  const { episode, hits, related } = card;
  const headingId = `card-${hits[0]!.chunk_id}`;
  return (
    <li
      class={`result${related ? " result--related" : ""}`}
      data-result
      tabIndex={tabIndex}
      aria-labelledby={headingId}
    >
      <div class="result__head">
        <h3 class="result__title" id={headingId}>
          {episode.number !== null && (
            <>
              <span class="result__ep">{`Ep. ${episode.number}`}</span>
              <span class="result__sep"> · </span>
            </>
          )}
          {displayTitle(episode.title, episode.number)}
        </h3>
        <span class="result__meta">
          {related && <span class="result__tag">Related</span>}
          {hits.length > 1 && (
            <>
              <span class="result__count">{`${hits.length} matches`}</span>
              <span aria-hidden="true"> · </span>
            </>
          )}
          <time dateTime={episode.date}>{episodeDate(episode.date)}</time>
        </span>
      </div>
      <div class="result__card">
        {hits.map((hit: SearchResult, index) => (
          <HitRow
            key={hit.chunk_id}
            hit={hit}
            first={index === 0}
            onMore={onMore}
            onNearby={onNearby}
            onReport={onReport}
          />
        ))}
      </div>
    </li>
  );
}
