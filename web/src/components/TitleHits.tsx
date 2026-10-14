// The "Episodes" row (spec §5.2 "Episodes whose title matches"; §4.4 `episodes`): the episodes
// whose title matched the query, above the passage results. An entry reads like a card's header
// episode line: a meta line "Ep. 613 · Aug 19, 2026" above the title ("Shove a Kregger in the
// Hole"), and a 44 px magnifier button at the right. The title plays the episode from its start
// (the link the API sends: YouTube, else the show page; plain text with neither). The button,
// "Search this episode", only puts `ep:613` in the search box and moves the cursor there: the word
// that found the title is often not in the transcript, so searching it for the person would find
// nothing. The entries are not stops for the arrow and j/k keys (no `data-result`).
import type { EpisodeHit } from "../../../worker/src/api-types";
import { episodeDate } from "../lib/format";
import { displayTitle } from "../lib/title";
import { PlayIcon } from "./PlayIcon";

export function TitleHits({
  episodes,
  onSearchEpisode,
}: {
  episodes: EpisodeHit[];
  /** Put `ep:N` alone in the search box. */
  onSearchEpisode: (number: number) => void;
}) {
  return (
    <section class="title-hits" aria-label="Episodes with a matching title">
      <h2 class="title-hits__label">Episodes</h2>
      <ul class="title-hits__list">
        {episodes.map((episode) => {
          const title = displayTitle(episode.title, episode.number);
          const href = episode.links.youtube ?? episode.links.page;
          const where = episode.links.youtube ? "YouTube" : "Acast";
          const which = episode.number === null ? "this episode" : `episode ${episode.number}`;
          return (
            <li key={episode.id} class="title-hit">
              <div class="title-hit__body">
                <span class="title-hit__meta">
                  {episode.number !== null && (
                    <>
                      <span class="result__ep">{`Ep. ${episode.number}`}</span>
                      <span aria-hidden="true"> · </span>
                    </>
                  )}
                  <time dateTime={episode.date}>{episodeDate(episode.date)}</time>
                </span>
                <span class="title-hit__name">
                  {href ? (
                    <a
                      class="title-hit__link"
                      href={href}
                      target="_blank"
                      rel="noopener"
                      aria-label={`${title} — play ${which} from the start on ${where}`}
                    >
                      <PlayIcon size={9} />
                      {title}
                    </a>
                  ) : (
                    title
                  )}
                </span>
              </div>
              {episode.number !== null && (
                <button
                  type="button"
                  class="title-hit__search"
                  aria-label={`Search this episode: Ep. ${episode.number}`}
                  onClick={() => onSearchEpisode(episode.number!)}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                    <circle cx="7.5" cy="7.5" r="5" fill="none" stroke="currentColor" stroke-width="1.8" />
                    <path d="M11.5 11.5L16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                  </svg>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
