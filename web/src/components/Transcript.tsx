// The expanded view of a hit (spec §5.4, design: ResultCard.dc.html states 2e, 2i, 3p, 3u): the
// chunks around it from /api/context, one paragraph each, labelled with its start time. The label
// plays by the card's rule (YouTube, else the show page; plain text with neither). The hit's own
// paragraph is on the tint and carries the result's highlights; in the radius 6 view the folded
// hits' paragraphs are a lighter tint labelled "Nearby match". Every paragraph marks the query's
// words from the chunk's own `ranges` (the answer to /api/context?q=), in a lighter mark outside
// the hit's paragraph. Boilerplate (an intro, sponsor read, plug or outro; boilerplate spec §5.4)
// is shown, muted and tagged "Intro, ad or plug"; a folded hit's "Nearby match" tag wins. Chunks
// overlap by a sentence; the API has already taken out the copy on the side away from the hit (§4.4).
//
// The view is a labelled region that takes focus when it opens; Esc or "Show less" collapses it
// (the row returns focus to whatever opened it). Loading, error and retry live inside it.
import type { Ref } from "preact";
import type { ContextChunk, SearchResult } from "../../../worker/src/api-types";
import { segments } from "../lib/excerpt";
import { ONE_TEXT } from "../lib/one-text";
import { chipName, chunkTime, hitTime, primaryPlay } from "../lib/platforms";
import type { Entry, Radius } from "../use-transcript";
import { PlayIcon } from "./PlayIcon";

function failureText(entry: Exclude<Entry, { kind: "loading" | "ok" }>): string {
  switch (entry.kind) {
    case "maintenance":
      return entry.message;
    case "rate_limited":
      return "Too many requests from here; try again in a minute.";
    default:
      return "Couldn't load the transcript.";
  }
}

function Passage({ chunk, hit, radius }: { chunk: ContextChunk; hit: SearchResult; radius: Radius }) {
  const time = chunkTime(chunk);
  const play = primaryPlay(chunk);
  const isHit = chunk.chunk_id === hit.chunk_id;
  const folded = !isHit && radius === 6 && hit.folded.includes(chunk.chunk_id);
  // The hit's paragraph keeps the result's ranges, so it matches its excerpt; if its text is not
  // the result's, or for any other chunk, the chunk's own ranges (an older answer has none).
  const ranges = isHit && chunk.text === hit.text ? hit.ranges : (chunk.ranges ?? []);
  const pieces = segments(chunk.text, ranges);
  const name = play ? chipName(play, time) : undefined;
  return (
    <li
      class={`passage${isHit ? " passage--hit" : ""}${folded ? " passage--fold" : ""}${chunk.boilerplate ? " passage--boilerplate" : ""}`}
    >
      {play ? (
        <a class="passage__time" href={play.href} target="_blank" rel="noopener" aria-label={name} title={name}>
          <PlayIcon size={9} />
          {time}
        </a>
      ) : (
        <span class="passage__time passage__time--text">{time}</span>
      )}
      <div class="passage__body">
        {isHit && <span class="visually-hidden">Matching passage</span>}
        {folded ? (
          <span class="passage__tag">Nearby match</span>
        ) : (
          chunk.boilerplate && <span class="passage__tag">Intro, ad or plug</span>
        )}
        <p class="passage__text">
          <span {...ONE_TEXT}>
            {pieces.map((piece, index) => (piece.mark ? <mark key={index}>{piece.text}</mark> : piece.text))}
          </span>
        </p>
      </div>
    </li>
  );
}

export function Transcript({
  id,
  hit,
  radius,
  entry,
  regionRef,
  onRetry,
  onClose,
  onSearchEpisode,
}: {
  id: string;
  hit: SearchResult;
  radius: Radius;
  /** Undefined only for the instant between opening and the request starting. */
  entry: Entry | undefined;
  regionRef: Ref<HTMLElement>;
  onRetry: () => void;
  onClose: () => void;
  onSearchEpisode: (number: number) => void;
}) {
  const number = hit.episode.number;
  return (
    <section
      class="transcript"
      id={id}
      data-transcript
      ref={regionRef}
      tabIndex={-1}
      aria-label={`Transcript around ${hitTime(hit)}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      {(entry === undefined || entry.kind === "loading") && (
        <p class="transcript__note" role="status">
          Loading transcript…
        </p>
      )}
      {entry !== undefined && entry.kind !== "loading" && entry.kind !== "ok" && (
        <p class="transcript__note" role="alert">
          {failureText(entry)}{" "}
          <button type="button" class="transcript__link" onClick={onRetry}>
            Try again
          </button>
        </p>
      )}
      {entry?.kind === "ok" && (
        <ol class="transcript__list">
          {entry.data.chunks.map((chunk) => (
            <Passage key={chunk.chunk_id} chunk={chunk} hit={hit} radius={radius} />
          ))}
        </ol>
      )}
      <div class="transcript__foot">
        {entry?.kind === "ok" && number !== null && (
          <button type="button" class="transcript__search" onClick={() => onSearchEpisode(number)}>
            <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="6" fill="none" stroke="currentColor" stroke-width="2" />
              <path d="M13 13l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
            Search this episode{" "}
            <span class="transcript__code">{`ep:${number}`}</span>
          </button>
        )}
        <button type="button" class="transcript__link" onClick={onClose}>
          Show less
        </button>
      </div>
    </section>
  );
}
