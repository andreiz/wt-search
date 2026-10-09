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
  youtube_video_id: string | null;
  apple_episode_id: string | null;
  spotify_episode_id: string | null;
  page_url: string | null;
  offset_youtube_s: number;
  offset_apple_s: number;
  offset_spotify_s: number;
}

/** Start 7 seconds before the hit so the listener hears the lead-in, shifted by the platform's offset; never before 0. */
export function cueSeconds(hitMs: number, offsetS: number): number {
  return Math.max(0, Math.floor(hitMs / 1000) - 7 + offsetS);
}

export function cueTimes(episode: LinkEpisode, hitMs: number): CueTimes {
  return {
    youtube: cueSeconds(hitMs, episode.offset_youtube_s),
    apple: cueSeconds(hitMs, episode.offset_apple_s),
    spotify: cueSeconds(hitMs, episode.offset_spotify_s),
  };
}

/**
 * Deep links, keys in card order; a platform is left out when its ID (or page_url) is null or
 * empty. Every platform link carries the cue time (with that platform's offset), in the
 * format the platform's own share sheet makes when sharing from the current time: Spotify
 * `?t=<seconds>`, Apple `&t=<seconds>` (both 2026-10-07, docs/deep-links.md).
 */
export function deepLinks(episode: LinkEpisode, hitMs: number): DeepLinks {
  const links: DeepLinks = {};
  if (episode.youtube_video_id) {
    const t = cueSeconds(hitMs, episode.offset_youtube_s);
    links.youtube = `https://www.youtube.com/watch?v=${encodeURIComponent(episode.youtube_video_id)}&t=${t}s`;
  }
  if (episode.apple_episode_id) {
    const t = cueSeconds(hitMs, episode.offset_apple_s);
    links.apple = `${APPLE_SHOW_URL}?i=${encodeURIComponent(episode.apple_episode_id)}&t=${t}`;
  }
  if (episode.spotify_episode_id) {
    const t = cueSeconds(hitMs, episode.offset_spotify_s);
    links.spotify = `https://open.spotify.com/episode/${encodeURIComponent(episode.spotify_episode_id)}?t=${t}`;
  }
  if (episode.page_url) links.page = episode.page_url;
  return links;
}
