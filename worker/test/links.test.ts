import { describe, expect, it } from "vitest";
import { APPLE_PODCAST_ID, cueSeconds, cueTimes, deepLinks } from "../src/links";
import type { LinkEpisode } from "../src/links";

const FULL: LinkEpisode = {
  youtube_video_id: "dQw4w9WgXcQ",
  apple_episode_id: "1000612345678",
  spotify_episode_id: "4rOoJ6Egrf8K2IrywzwOMk",
  page_url: "https://woodtalk.example/episodes/250",
  offset_youtube_s: 0,
  offset_apple_s: 0,
  offset_spotify_s: 0,
};

const EMPTY: LinkEpisode = {
  youtube_video_id: null,
  apple_episode_id: null,
  spotify_episode_id: null,
  page_url: null,
  offset_youtube_s: 0,
  offset_apple_s: 0,
  offset_spotify_s: 0,
};

describe("cueSeconds", () => {
  it("starts 7 seconds before the hit, floored, never below 0", () => {
    expect(cueSeconds(0, 0)).toBe(0);
    expect(cueSeconds(6999, 0)).toBe(0);
    expect(cueSeconds(7000, 0)).toBe(0);
    expect(cueSeconds(8000, 0)).toBe(1);
    expect(cueSeconds(65_432, 0)).toBe(58);
  });

  it("adds the platform offset", () => {
    expect(cueSeconds(65_432, 12)).toBe(70);
    expect(cueSeconds(65_432, -20)).toBe(38);
  });

  it("clamps at 0 with a negative offset", () => {
    expect(cueSeconds(10_000, -20)).toBe(0);
    expect(cueSeconds(0, -1)).toBe(0);
  });
});

describe("cueTimes", () => {
  it("uses each platform's own offset", () => {
    const episode = { ...FULL, offset_youtube_s: 3, offset_apple_s: 30, offset_spotify_s: -5 };
    expect(cueTimes(episode, 65_432)).toEqual({ youtube: 61, apple: 88, spotify: 53 });
  });
});

describe("deepLinks", () => {
  it("builds the YouTube link with the cue time and its offset", () => {
    expect(deepLinks(FULL, 65_432).youtube).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=58s");
    expect(deepLinks({ ...FULL, offset_youtube_s: 2 }, 65_432).youtube).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=60s",
    );
  });

  // Apple's own share sheet makes `…/us/podcast/wood-talk-woodworking/id251471480?i=<id>&t=<seconds>`.
  it("builds the Apple link in the share sheet's form, with t=<cue seconds> and its offset", () => {
    expect(APPLE_PODCAST_ID).toBe(251471480);
    expect(deepLinks(FULL, 65_432).apple).toBe(
      "https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480?i=1000612345678&t=58",
    );
    expect(deepLinks({ ...FULL, offset_apple_s: 30 }, 65_432).apple).toBe(
      "https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480?i=1000612345678&t=88",
    );
  });

  // Spotify's own share sheet ("share from current time") makes `?…&t=<seconds>` links.
  it("builds the Spotify link with t=<cue seconds> and its offset", () => {
    expect(deepLinks(FULL, 65_432).spotify).toBe("https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk?t=58");
    expect(deepLinks({ ...FULL, offset_spotify_s: 30 }, 65_432).spotify).toBe(
      "https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk?t=88",
    );
  });

  it("passes the page URL as is", () => {
    expect(deepLinks(FULL, 0).page).toBe("https://woodtalk.example/episodes/250");
  });

  it("omits each link when its ID is null", () => {
    expect(Object.keys(deepLinks({ ...FULL, youtube_video_id: null }, 0))).toEqual(["apple", "spotify", "page"]);
    expect(Object.keys(deepLinks({ ...FULL, apple_episode_id: null }, 0))).toEqual(["youtube", "spotify", "page"]);
    expect(Object.keys(deepLinks({ ...FULL, spotify_episode_id: null }, 0))).toEqual(["youtube", "apple", "page"]);
    expect(Object.keys(deepLinks({ ...FULL, page_url: null }, 0))).toEqual(["youtube", "apple", "spotify"]);
  });

  it("omits a link whose ID is an empty string", () => {
    const links = deepLinks({ ...FULL, youtube_video_id: "", apple_episode_id: "", spotify_episode_id: "", page_url: "" }, 0);
    expect(links).toEqual({});
  });

  it("gives {} when every ID is null", () => {
    expect(deepLinks(EMPTY, 12_345)).toEqual({});
  });

  it("keeps card order: youtube, apple, spotify, page", () => {
    expect(Object.keys(deepLinks(FULL, 0))).toEqual(["youtube", "apple", "spotify", "page"]);
  });

  it("encodes IDs", () => {
    const links = deepLinks(
      { ...FULL, youtube_video_id: "a&b=c d", apple_episode_id: "1/2?x#y", spotify_episode_id: "s p/q" },
      8000,
    );
    expect(links.youtube).toBe("https://www.youtube.com/watch?v=a%26b%3Dc%20d&t=1s");
    expect(links.apple).toBe(
      "https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480?i=1%2F2%3Fx%23y&t=1",
    );
    expect(links.spotify).toBe("https://open.spotify.com/episode/s%20p%2Fq?t=1");
  });
});
