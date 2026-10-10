// Which links play a hit (spec §4.6 "Which link the card plays", §5.3). The links come from the
// API (`episode.links`, already carrying their cue times); this module never builds one. It only
// picks the chip's link (YouTube, else the show page), lists the others for the ⋯ menu, and words
// the names screen readers hear.
import type { SearchResult } from "../../../worker/src/api-types";
import { timestamp } from "./format";

export type PlayKey = "youtube" | "page" | "apple" | "spotify";

export interface PlayLink {
  key: PlayKey;
  /** As it reads after "Play on": "YouTube", "the show page", "Apple", "Spotify". */
  name: string;
  href: string;
  /** "28:54": where this link starts to play (`cue_s`), for the link's name. */
  cue: string;
}

const NAMES: Record<PlayKey, string> = {
  youtube: "YouTube",
  page: "the show page",
  apple: "Apple",
  spotify: "Spotify",
};

function playOf(hit: SearchResult, key: PlayKey): PlayLink | null {
  const href = hit.episode.links[key];
  return href ? { key, name: NAMES[key], href, cue: timestamp(hit.cue_s[key]) } : null;
}

/** The hit's one play control: the YouTube link when the episode has one, else the show page. */
export function primaryPlay(hit: SearchResult): PlayLink | null {
  return playOf(hit, "youtube") ?? playOf(hit, "page");
}

/** The other links, for the ⋯ menu: the show page (unless the chip plays it), Apple, Spotify. */
export function menuPlays(hit: SearchResult): PlayLink[] {
  const primary = primaryPlay(hit);
  const keys: PlayKey[] = ["page", "apple", "spotify"];
  return keys
    .filter((key) => key !== primary?.key)
    .flatMap((key) => {
      const play = playOf(hit, key);
      return play ? [play] : [];
    });
}

function starts(play: PlayLink, time: string): string {
  return play.cue === time ? "" : `, starts at ${play.cue}`;
}

/**
 * The chip's accessible name, built around its visible text (WCAG 2.5.3): "Play on YouTube 29:01,
 * starts at 28:54"; for the show page "Play on the show page 29:01, starts at 28:54, may play an ad
 * first". ", starts at …" is left out when the cue is the hit's time.
 */
export function chipName(play: PlayLink, time: string): string {
  const ad = play.key === "page" ? ", may play an ad first" : "";
  return `Play on ${play.name} ${time}${starts(play, time)}${ad}`;
}

/**
 * A menu row's accessible name: its visible words in order. Apple and Spotify add ", starts at …"
 * when the cue differs ("Play on Apple at 29:01 · may start minutes early, starts at 28:20"); the
 * show page never does, as "plays from 29:01 … starts at 28:54" would contradict itself:
 * "Show page plays from 29:01, may play an ad first".
 */
export function menuName(play: PlayLink, time: string): string {
  if (play.key === "page") return `Show page plays from ${time}, may play an ad first`;
  return `Play on ${play.name} at ${time} · may start minutes early${starts(play, time)}`;
}

/** Where the hit is in the episode, as the card shows it: "1:09:51". */
export function hitTime(hit: SearchResult): string {
  return timestamp(hit.hit_ms / 1000);
}
