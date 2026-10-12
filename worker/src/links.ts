// The one link builder (spec §4.6): the API's per-result `cue_s` and the deep links on a
// result card both come from here, so they always agree.

import type { CueTimes, DeepLinks } from "./api-types";

export type { CueTimes, DeepLinks } from "./api-types";

/** Wood Talk's Apple Podcasts show id. */
export const APPLE_PODCAST_ID = 251471480;
/** The show URL exactly as Apple's share sheet writes it (US storefront, the show's slug). */
const APPLE_SHOW_URL = `https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id${APPLE_PODCAST_ID}`;

/** The D1 `episodes` columns the links need, so a row can be passed as is. */
export interface LinkEpisode {
  /** The feed's id for the episode, which is also Acast's. */
  guid: string;
  youtube_video_id: string | null;
  apple_episode_id: string | null;
  spotify_episode_id: string | null;
  page_url: string | null;
  offset_youtube_s: number;
  offset_apple_s: number;
  offset_spotify_s: number;
}

/** The lead-in of a search hit: it is mid-sentence, so playback starts this many seconds before it. */
export const LEAD_S = 7;
/**
 * A transcript paragraph starts at a sentence, so its link plays from its first word; one second
 * early, because a word's recorded start can be a little late and would clip the first syllable.
 */
export const PARAGRAPH_LEAD_S = 1;

/** Start `leadS` seconds before the hit so the listener hears the lead-in, shifted by the platform's offset; never before 0. */
export function cueSeconds(hitMs: number, offsetS: number, leadS = LEAD_S): number {
  return Math.max(0, Math.floor(hitMs / 1000) - leadS + offsetS);
}

export function cueTimes(episode: LinkEpisode, hitMs: number, leadS = LEAD_S): CueTimes {
  return {
    youtube: cueSeconds(hitMs, episode.offset_youtube_s, leadS),
    apple: cueSeconds(hitMs, episode.offset_apple_s, leadS),
    spotify: cueSeconds(hitMs, episode.offset_spotify_s, leadS),
    page: cueSeconds(hitMs, 0, leadS),
  };
}

/** The host of Acast's episode pages, whose player takes `?seek=<seconds>` (spec §4.6). */
const ACAST_SHOW_HOST = "shows.acast.com";
/** Wood Talk's episode pages on Acast; an episode's own page is this plus its feed guid. */
const ACAST_EPISODES_URL = `https://${ACAST_SHOW_HOST}/woodtalk/episodes/`;

/**
 * The episode's Acast page at the cue. Acast serves every episode under its feed guid (also the
 * old ones, whose guid is the first host's audio URL), so this does not depend on where the
 * feed's own link points: for most episodes that is the show's site, which cannot seek.
 */
export function pageLink(guid: string, cue: number): string {
  return `${ACAST_EPISODES_URL}${encodeURIComponent(guid)}?seek=${cue}`;
}

/** The feed's own episode link when it is not the Acast page: the show's site, with the show notes. */
export function notesLink(pageUrl: string | null): string | undefined {
  if (!pageUrl) return undefined;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.hostname === ACAST_SHOW_HOST ? undefined : pageUrl;
  } catch {
    return undefined;
  }
}

/**
 * Deep links, keys in card order; a platform is left out when its ID is null or empty. Every
 * platform link carries the cue time (with that platform's offset), in the format the
 * platform's own share sheet makes when sharing from the current time: Spotify `?t=<seconds>`,
 * Apple `&t=<seconds>` (both 2026-10-07, docs/deep-links.md). The show page is the Acast page
 * with `?seek=<seconds>` (the lead-in, no offset). `notes` plays nothing and has no time.
 */
export function deepLinks(episode: LinkEpisode, hitMs: number, leadS = LEAD_S): DeepLinks {
  const links: DeepLinks = {};
  if (episode.youtube_video_id) {
    const t = cueSeconds(hitMs, episode.offset_youtube_s, leadS);
    links.youtube = `https://www.youtube.com/watch?v=${encodeURIComponent(episode.youtube_video_id)}&t=${t}s`;
  }
  if (episode.apple_episode_id) {
    const t = cueSeconds(hitMs, episode.offset_apple_s, leadS);
    links.apple = `${APPLE_SHOW_URL}?i=${encodeURIComponent(episode.apple_episode_id)}&t=${t}`;
  }
  if (episode.spotify_episode_id) {
    const t = cueSeconds(hitMs, episode.offset_spotify_s, leadS);
    links.spotify = `https://open.spotify.com/episode/${encodeURIComponent(episode.spotify_episode_id)}?t=${t}`;
  }
  if (episode.guid) links.page = pageLink(episode.guid, cueSeconds(hitMs, 0, leadS));
  const notes = notesLink(episode.page_url);
  if (notes) links.notes = notes;
  return links;
}
