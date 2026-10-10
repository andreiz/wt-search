// Which platforms a hit can be played on (spec §4.6). The links come from the API (`episode.links`,
// already carrying their cue times); this module never builds one. It only orders them, YouTube
// first, and pairs each with that platform's cue time for the name screen readers hear.
import type { SearchResult } from "../../../worker/src/api-types";
import { timestamp } from "./format";

export type PlatformKey = "youtube" | "apple" | "spotify";

export interface Platform {
  key: PlatformKey;
  name: string;
  href: string;
  /** "1:09:44": where this platform starts to play (`cue_s`), for the link's name. */
  cue: string;
}

const ORDER: { key: PlatformKey; name: string }[] = [
  { key: "youtube", name: "YouTube" },
  { key: "apple", name: "Apple" },
  { key: "spotify", name: "Spotify" },
];

/** The platforms the episode has, in the card's order. */
export function platformsOf(hit: SearchResult): Platform[] {
  const out: Platform[] = [];
  for (const { key, name } of ORDER) {
    const href = hit.episode.links[key];
    if (href) out.push({ key, name, href, cue: timestamp(hit.cue_s[key]) });
  }
  return out;
}

/** What a play control shows: its platform name only, the hit's time too, or a menu row's words. */
export type Shown = "name" | "time" | "menu";

/**
 * The accessible name of a play control. It is built around the visible text, in order (WCAG
 * 2.5.3), and adds ", starts at <cue>" only when this platform's cue differs from the hit time:
 * "Play on Apple" / "Play on YouTube 1:09:51, starts at 1:09:44" /
 * "Play on Apple at 1:09:51 · may start early (ads), starts at 1:09:44".
 */
export function playName(platform: Platform, time: string, shown: Shown): string {
  const visible =
    shown === "name"
      ? ""
      : shown === "time"
        ? ` ${time}`
        : ` at ${time} · may start early (ads)`;
  const starts = platform.cue === time ? "" : `, starts at ${platform.cue}`;
  return `Play on ${platform.name}${visible}${starts}`;
}

/** Where the hit is in the episode, as the card shows it: "1:09:51". */
export function hitTime(hit: SearchResult): string {
  return timestamp(hit.hit_ms / 1000);
}
