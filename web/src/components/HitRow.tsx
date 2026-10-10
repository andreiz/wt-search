// One hit of a result card (spec §5.3; docs/design/card-separation-options.html, option A): the
// timestamp chip (the hit's one play control), the excerpt, ⋯, and "+N nearby" under the excerpt.
// Desktop is a three-column grid (chip, excerpt, ⋯); below 600 px the chip takes its own first row
// (CSS only, the DOM is the same). The excerpt opens More transcript on a click, unless text is
// selected. Keyboard order follows the visual order: chip, ⋯, "+N nearby", then the expanded view.
//
// The expanded view (spec §5.4) opens in this row, inside the card: radius 3 from the excerpt
// or the menu's More transcript, radius 6 from "+N nearby". While open it replaces the chip and
// the excerpt (its own row for the hit has the time and the play link); ⋯ and "+N nearby" stay
// above it (beside it, for a row without "+N nearby"). It takes focus when it opens, and
// when it collapses focus returns to the control that opened it: "+N nearby", or ⋯ for the other
// two (the excerpt is plain text for selecting, so it is not a control).
import { useEffect, useRef } from "preact/hooks";
import type { SearchResult } from "../../../worker/src/api-types";
import { excerpt } from "../lib/excerpt";
import { chipName, hitTime, menuPlays, primaryPlay } from "../lib/platforms";
import { useTranscript } from "../use-transcript";
import { MoreMenu } from "./MoreMenu";
import { PlayIcon } from "./PlayIcon";
import { Transcript } from "./Transcript";

export interface HitActions {
  onReport: (hit: SearchResult) => void;
  /** "Search this episode" in the expanded view: search the current query within episode `number`. */
  onSearchEpisode: (number: number) => void;
}

export function HitRow({
  hit,
  first,
  onReport,
  onSearchEpisode,
}: HitActions & {
  hit: SearchResult;
  /** The first row of its card has no rule above it. */
  first: boolean;
}) {
  const time = hitTime(hit);
  const play = primaryPlay(hit);
  const view = excerpt(hit.text, hit.ranges);
  const transcript = useTranscript(hit.chunk_id);
  const { shown } = transcript;

  const moreButton = useRef<HTMLButtonElement>(null);
  const nearbyButton = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLElement>(null);
  const opener = useRef<"more" | "nearby">("more");
  const regionId = `transcript-${hit.chunk_id}`;

  // Opening, or moving between the two views, puts focus on the region.
  useEffect(() => {
    if (shown !== null) region.current?.focus();
  }, [shown]);

  function collapse() {
    transcript.hide();
    (opener.current === "nearby" ? nearbyButton : moreButton).current?.focus();
  }

  function openMore() {
    opener.current = "more";
    transcript.show(3);
  }

  function onExcerptClick() {
    // Selecting text (to report it) must not open the passage.
    if (window.getSelection()?.toString()) return;
    openMore();
  }

  const open = shown !== null;
  const nearbyShown = hit.folded.length > 0;

  return (
    <div class={`hit${first ? "" : " hit--ruled"}${open ? " hit--open" : ""}${open && !nearbyShown ? " hit--bare" : ""}`}>
      {/* While the view is open it replaces the chip and the excerpt: its own row for the hit has the time and the play link. */}
      {open ? null : play ? (
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
      {!open && (
        <p class="hit__excerpt" title="Show full passage" onClick={onExcerptClick}>
          {view.cutStart && "… "}
          {view.segments.map((segment, index) =>
            segment.mark ? <mark key={index}>{segment.text}</mark> : segment.text,
          )}
          {view.cutEnd && " …"}
        </p>
      )}
      <MoreMenu
        plays={menuPlays(hit)}
        time={time}
        moreOpen={shown === 3}
        buttonRef={moreButton}
        onMore={() => (shown === 3 ? collapse() : openMore())}
        onReport={() => onReport(hit)}
      />
      {nearbyShown && (
        <button
          type="button"
          class="hit__nearby"
          ref={nearbyButton}
          aria-expanded={shown === 6 ? "true" : "false"}
          aria-controls={shown === 6 ? regionId : undefined}
          onClick={() => {
            if (shown === 6) {
              collapse();
              return;
            }
            opener.current = "nearby";
            transcript.show(6);
          }}
        >
          {`+${hit.folded.length} nearby`}
        </button>
      )}
      {shown !== null && (
        <Transcript
          id={regionId}
          hit={hit}
          radius={shown}
          entry={transcript.entry}
          regionRef={region}
          onRetry={() => {
            transcript.retry();
            region.current?.focus();
          }}
          onClose={collapse}
          onSearchEpisode={onSearchEpisode}
        />
      )}
    </div>
  );
}
