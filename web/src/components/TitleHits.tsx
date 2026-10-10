// The "Episodes" row (spec §5.2 "Episodes whose title matches"; §4.4 `episodes`): the episodes
// whose title matched the query, above the passage results. An entry reads like a card's header
// line, "Ep. 613 · Shove a Kregger in the Hole · Aug 19, 2026". The title plays the episode from
// its start (the link the API sends: YouTube, else the show page; plain text with neither).
// "Search this episode" only puts `ep:613` in the search box and moves the cursor there: the word
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
          const where = episode.links.youtube ? "YouTube" : "the show page";
          const which = episode.number === null ? "this episode" : `episode ${episode.number}`;
          return (
            <li key={episode.id} class="title-hit">
              <span class="title-hit__name">
                {episode.number !== null && (
                  <>
                    <span class="result__ep">{`Ep. ${episode.number}`}</span>
                    <span class="result__sep"> · </span>
                  </>
                )}
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
              <span class="title-hit__meta">
                <time dateTime={episode.date}>{episodeDate(episode.date)}</time>
                {episode.number !== null && (
                  <button
                    type="button"
                    class="title-hit__search"
                    aria-label={`Search this episode: Ep. ${episode.number}`}
                    onClick={() => onSearchEpisode(episode.number!)}
                  >
                    Search this episode
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
