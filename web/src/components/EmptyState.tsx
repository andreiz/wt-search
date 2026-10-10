// The two pages with nothing to list (design README "Empty, loading and no-results"; spec §5.6):
// the empty state before any search, with example searches and the corpus line from /api/info,
// and "Nothing found." with what to try.
import type { InfoResponse } from "../lib/api";
import { count, episodeDate } from "../lib/format";

const EXAMPLES = ["hide glue", "split-top Roubo", "how do I sharpen a card scraper"];

/** "625 episodes indexed through Sep 17, 2026" (just the count for an empty corpus). */
function indexed(info: InfoResponse): string {
  const episodes = `${count(info.episodes, false)} episodes indexed`;
  return info.latest_episode_date === null ? episodes : `${episodes} through ${episodeDate(info.latest_episode_date)}`;
}

/** `info` is null while /api/info is loading and when it failed: the line is then left out. */
export function EmptyState({ info, onPick }: { info: InfoResponse | null; onPick: (example: string) => void }) {
  return (
    <section class="empty">
      <h1 class="empty__title">Find the moment it was said.</h1>
      <div class="empty__try">
        <span class="empty__label">Try</span>
        <div class="empty__chips">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" class="chip" onClick={() => onPick(example)}>
              {example}
            </button>
          ))}
        </div>
      </div>
      {info && <p class="empty__info">{indexed(info)}</p>}
    </section>
  );
}

/**
 * An `ok` answer with no results on page 1. In Exact the first suggestion switches to Smart;
 * years are mentioned only when the query has a year filter (`hasYears`).
 */
export function NoResults({
  mode,
  hasYears,
  onSmart,
}: {
  mode: "smart" | "exact";
  hasYears: boolean;
  onSmart: () => void;
}) {
  return (
    <section class="nothing" role="status">
      <h2 class="nothing__title">Nothing found.</h2>
      <p class="nothing__lead">Try one of these:</p>
      <ul class="nothing__list">
        {mode === "exact" && (
          <li>
            <span aria-hidden="true">→</span>
            <span>
              <button type="button" class="text-button" onClick={onSmart}>
                Switch to Smart
              </button>
              {" — it matches meaning, not just words"}
            </span>
          </li>
        )}
        <li>
          <span aria-hidden="true">→</span>
          <span>{hasYears ? "Use fewer words, or loosen the years" : "Use fewer words"}</span>
        </li>
      </ul>
    </section>
  );
}
