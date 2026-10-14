// A dense result card (spec §5.3; docs/design/card-separation-options.html, option A): the
// two-line episode line on the page background (a meta line "Ep. 71 · date · 2 matches", or "Bonus"
// for an unnumbered episode, above the title; spec §5.2 round 2), then the card's box
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
  q = "",
  onReport = noop,
  onSearchEpisode = noop,
}: Partial<HitActions> & {
  /** The searched query, passed on to each hit row. */
  q?: string;
  card: Card;
  tabIndex: number;
}) {
  const { episode, hits } = card;
  const headingId = `card-${hits[0]!.chunk_id}`;
  return (
    <li
      class="result"
      data-result
      tabIndex={tabIndex}
      aria-labelledby={headingId}
    >
      <div class="result__head">
        <h3 class="result__title" id={headingId}>
          <span class="result__meta">
            {episode.number !== null ? (
              <span class="result__ep">{`Ep. ${episode.number}`}</span>
            ) : (
              <span class="result__bonus">Bonus</span>
            )}
            <span aria-hidden="true"> · </span>
            <time dateTime={episode.date}>{episodeDate(episode.date)}</time>
            {hits.length > 1 && (
              <>
                <span aria-hidden="true"> · </span>
                <span class="result__count">{`${hits.length} matches`}</span>
              </>
            )}
          </span>{" "}
          <span class="result__name">{displayTitle(episode.title, episode.number)}</span>
        </h3>
      </div>
      <div class="result__card">
        {hits.map((hit: SearchResult, index) => (
          <HitRow
            key={hit.chunk_id}
            hit={hit}
            first={index === 0}
            q={q}
            onReport={onReport}
            onSearchEpisode={onSearchEpisode}
          />
        ))}
      </div>
    </li>
  );
}
