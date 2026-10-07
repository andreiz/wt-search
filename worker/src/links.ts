// The one link builder (spec §4.6): the API's per-result `cue_s` and the deep links on a
// result card both come from here, so they always agree.

/** Wood Talk's Apple Podcasts show id. */
export const APPLE_PODCAST_ID = 251471480;

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

export function cueTimes(episode: LinkEpisode, hitMs: number): { youtube: number; apple: number; spotify: number } {
  return {
    youtube: cueSeconds(hitMs, episode.offset_youtube_s),
    apple: cueSeconds(hitMs, episode.offset_apple_s),
    spotify: cueSeconds(hitMs, episode.offset_spotify_s),
  };
}

/**
 * Deep links, keys in card order; a platform is left out when its ID (or page_url) is null or
 * empty. YouTube and Spotify carry a time: Spotify's `t=<seconds>` is what its own share
 * sheet makes ("share from current time", 2026-10-07). Apple's time parameter is filled in
 * from docs/deep-links.md once checked by hand (spec §4.6, §10 item 2); a test pins its
 * absence, so adding one is a deliberate change.
 */
export function deepLinks(
  episode: LinkEpisode,
  hitMs: number,
): { youtube?: string; apple?: string; spotify?: string; page?: string } {
  const links: { youtube?: string; apple?: string; spotify?: string; page?: string } = {};
  if (episode.youtube_video_id) {
    const t = cueSeconds(hitMs, episode.offset_youtube_s);
    links.youtube = `https://www.youtube.com/watch?v=${encodeURIComponent(episode.youtube_video_id)}&t=${t}s`;
  }
  if (episode.apple_episode_id) {
    links.apple = `https://podcasts.apple.com/podcast/id${APPLE_PODCAST_ID}?i=${encodeURIComponent(episode.apple_episode_id)}`;
  }
  if (episode.spotify_episode_id) {
    const t = cueSeconds(hitMs, episode.offset_spotify_s);
    links.spotify = `https://open.spotify.com/episode/${encodeURIComponent(episode.spotify_episode_id)}?t=${t}`;
  }
  if (episode.page_url) links.page = episode.page_url;
  return links;
}
