// The two pages with nothing to list (design README "Empty, loading and no-results"; spec §5.6):
// the empty state before any search, with a list of example searches and the corpus line from /api/info,
// and "Nothing found." / "No related passages." with the button across to the other mode.
import type { InfoResponse } from "../lib/api";
import { count, episodeDate } from "../lib/format";
import { AcrossButton } from "./AcrossButton";
import { SyntaxHelp } from "./SyntaxHelp";

const EXAMPLES = ["hide glue", "split-top Roubo", "sharpening a card scraper"];

/** "625 episodes indexed through Sep 17, 2026" (just the count for an empty corpus). */
function indexed(info: InfoResponse): string {
  const episodes = `${count(info.episodes, false)} episodes indexed`;
  return info.latest_episode_date === null ? episodes : `${episodes} through ${episodeDate(info.latest_episode_date)}`;
}

/** `info` is null while /api/info is loading and when it failed: the line is then left out. */
export function EmptyState({
  info,
  onPick,
  onTip,
}: {
  info: InfoResponse | null;
  onPick: (example: string) => void;
  /** A syntax example picked from "Tips ?": it goes in the box. */
  onTip: (example: string) => void;
}) {
  return (
    <section class="empty">
      <h1 class="empty__title">Find the moment it was said.</h1>
      <div class="empty__try">
        {/* No summary line yet, so "Tips ?" sits at the right of the label. */}
        <div class="empty__try-head">
          <span class="empty__label">Try</span>
          <SyntaxHelp onPick={onTip} />
        </div>
        <ul class="try-list">
          {EXAMPLES.map((example) => (
            <li key={example}>
              <button type="button" class="try-list__item" onClick={() => onPick(example)}>
                {example}
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {info && <p class="empty__info">{indexed(info)}</p>}
    </section>
  );
}

/**
 * An `ok` answer with no results on page 1. In Exact the first suggestion switches to Related, in
 * Related to Exact; years are mentioned only when the query has a year filter (`hasYears`). */
export function NoResults({
  mode,
  hasYears,
  onRelated,
  onExact,
}: {
  mode: "related" | "exact";
  hasYears: boolean;
  onRelated: () => void;
  onExact: () => void;
}) {
  return (
    <section class="nothing" role="status">
      {mode === "related" ? (
        <>
          <h2 class="nothing__title">No related passages.</h2>
          <p class="nothing__lead">Nothing about the same thing turned up without your words.</p>
          <AcrossButton to="exact" onClick={onExact} />
        </>
      ) : (
        <>
          <h2 class="nothing__title">Nothing found.</h2>
          <p class="nothing__lead">No passage has those exact words.</p>
          <AcrossButton to="related" onClick={onRelated} />
          <p class="nothing__tip">
            {hasYears ? "Or use fewer words, loosen the years, or check the spelling." : "Or use fewer words, or check the spelling."}
          </p>
          <p class="nothing__tip">Intros, sponsor reads and plugs are left out; add include:ads to search them too.</p>
        </>
      )}
    </section>
  );
}
