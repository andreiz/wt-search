// A dense result card (DenseResult.dc.html; spec §5.3): the header "Ep. 71 · Title" with the match
// count and the date, then one hit row per hit. The card is one list item and one stop for the
// arrow and j/k keys (lib/keys.ts); it is focusable (roving tabindex, set by ResultList).
import type { SearchResult } from "../../../worker/src/api-types";
import { episodeDate } from "../lib/format";
import type { Card } from "../lib/group";
import { displayTitle } from "../lib/title";
import { HitRow, type HitActions } from "./HitRow";

const noop = () => {};

export function ResultCard({
  card,
  related,
  tabIndex,
  phone,
  onMore = noop,
  onNearby = noop,
  onReport = noop,
}: Partial<HitActions> & {
  card: Card;
  /** A meaning-only card: dashed, tagged "Related", outlined pills. */
  related: boolean;
  tabIndex: number;
  phone: boolean;
}) {
  const { episode, hits } = card;
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
      {hits.map((hit: SearchResult, index) => (
        <HitRow
          key={hit.chunk_id}
          hit={hit}
          first={index === 0}
          related={related}
          phone={phone}
          onMore={onMore}
          onNearby={onNearby}
          onReport={onReport}
        />
      ))}
    </li>
  );
}
