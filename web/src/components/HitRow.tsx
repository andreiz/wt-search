// One hit of a result card (DenseResult.dc.html; spec §5.3): the time link (desktop column), the
// excerpt, and the actions row. Desktop: every platform as a pill; phone: the first platform only,
// the rest in the ⋯ menu. The excerpt opens More transcript on a click, unless text is selected.
import { useState } from "preact/hooks";
import type { SearchResult } from "../../../worker/src/api-types";
import { excerpt } from "../lib/excerpt";
import { hitTime, platformsOf, playName } from "../lib/platforms";
import { MoreMenu } from "./MoreMenu";
import { PlayButtons, PlayIcon } from "./PlayButtons";

export interface HitActions {
  onMore: (hit: SearchResult) => void;
  onNearby: (hit: SearchResult) => void;
  onReport: (hit: SearchResult) => void;
}

const ADS_NOTE = "May start a bit early because of ads";

export function HitRow({
  hit,
  first,
  related,
  phone,
  onMore,
  onNearby,
  onReport,
}: HitActions & {
  hit: SearchResult;
  /** The first row of its card has no rule above it. */
  first: boolean;
  related: boolean;
  phone: boolean;
}) {
  const [adsOpen, setAdsOpen] = useState(false);
  const platforms = platformsOf(hit);
  const shown = phone ? platforms.slice(0, 1) : platforms;
  const extra = phone ? platforms.slice(1) : [];
  const late = shown.filter((p) => p.key !== "youtube");
  const time = hitTime(hit);
  const playFirst = platforms[0];
  const view = excerpt(hit.text, hit.ranges);

  function onExcerptClick() {
    // Selecting text (to report it) must not open the passage.
    if (window.getSelection()?.toString()) return;
    onMore(hit);
  }

  return (
    <div class={`hit${first ? "" : " hit--ruled"}${phone ? "" : " hit--gutter"}`}>
      {!phone &&
        (playFirst ? (
          <a
            class="hit__time"
            href={playFirst.href}
            target="_blank"
            rel="noopener"
            aria-label={playName(playFirst, time, "time")}
            title={playName(playFirst, time, "time")}
          >
            <PlayIcon size={9} />
            {time}
          </a>
        ) : (
          <span class="hit__time hit__time--text">{time}</span>
        ))}
      <div class="hit__body">
        <p class="hit__excerpt" title="Show full passage" onClick={onExcerptClick}>
          {view.cutStart && "… "}
          {view.segments.map((segment, index) =>
            segment.mark ? <mark key={index}>{segment.text}</mark> : segment.text,
          )}
          {view.cutEnd && " …"}
        </p>
        <div class="hit__actions">
          <div class="hit__links">
            <PlayButtons platforms={shown} phone={phone} related={related} time={time} />
            {late.length > 0 && (
              <button
                type="button"
                class="ads-info"
                aria-label={`${late.map((p) => p.name).join(" and ")} may start a bit early because of ads`}
                title={ADS_NOTE}
                aria-expanded={adsOpen ? "true" : "false"}
                onClick={() => setAdsOpen(!adsOpen)}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4" />
                  <path d="M8 7.2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  <circle cx="8" cy="4.9" r="1" fill="currentColor" />
                </svg>
              </button>
            )}
            {hit.folded.length > 0 && (
              <button type="button" class="hit__nearby" onClick={() => onNearby(hit)}>
                {`+${hit.folded.length} nearby`}
              </button>
            )}
          </div>
          <MoreMenu
            extra={extra}
            pageHref={hit.episode.links.page}
            time={time}
            onMore={() => onMore(hit)}
            onReport={() => onReport(hit)}
          />
        </div>
        {adsOpen && late.length > 0 && <p class="hit__note">{ADS_NOTE}</p>}
      </div>
    </div>
  );
}
