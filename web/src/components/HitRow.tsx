// One hit of a result card (spec §5.3; docs/design/card-separation-options.html, option A): the
// timestamp chip (the hit's one play control), the excerpt, ⋯, and "+N nearby" under the excerpt.
// Desktop is a three-column grid (chip, excerpt, ⋯); below 600 px the chip takes its own first row
// (CSS only, the DOM is the same). The excerpt opens More transcript on a click, unless text is
// selected. Keyboard order follows the visual order: chip, ⋯, "+N nearby".
import type { SearchResult } from "../../../worker/src/api-types";
import { excerpt } from "../lib/excerpt";
import { chipName, hitTime, menuPlays, primaryPlay } from "../lib/platforms";
import { MoreMenu } from "./MoreMenu";

export interface HitActions {
  onMore: (hit: SearchResult) => void;
  onNearby: (hit: SearchResult) => void;
  onReport: (hit: SearchResult) => void;
}

function PlayIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 1.5v11l9.5-5.5z" fill="currentColor" />
    </svg>
  );
}

export function HitRow({
  hit,
  first,
  onMore,
  onNearby,
  onReport,
}: HitActions & {
  hit: SearchResult;
  /** The first row of its card has no rule above it. */
  first: boolean;
}) {
  const time = hitTime(hit);
  const play = primaryPlay(hit);
  const view = excerpt(hit.text, hit.ranges);

  function onExcerptClick() {
    // Selecting text (to report it) must not open the passage.
    if (window.getSelection()?.toString()) return;
    onMore(hit);
  }

  return (
    <div class={`hit${first ? "" : " hit--ruled"}`}>
      {play ? (
        <a
          class="hit__time"
          href={play.href}
          target="_blank"
          rel="noopener"
          aria-label={chipName(play, time)}
          title={chipName(play, time)}
        >
          <PlayIcon size={9} />
          {time}
        </a>
      ) : (
        <span class="hit__time hit__time--text">{time}</span>
      )}
      <p class="hit__excerpt" title="Show full passage" onClick={onExcerptClick}>
        {view.cutStart && "… "}
        {view.segments.map((segment, index) =>
          segment.mark ? <mark key={index}>{segment.text}</mark> : segment.text,
        )}
        {view.cutEnd && " …"}
      </p>
      <MoreMenu plays={menuPlays(hit)} time={time} onMore={() => onMore(hit)} onReport={() => onReport(hit)} />
      {hit.folded.length > 0 && (
        <button type="button" class="hit__nearby" onClick={() => onNearby(hit)}>
          {`+${hit.folded.length} nearby`}
        </button>
      )}
    </div>
  );
}
