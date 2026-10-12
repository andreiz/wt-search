import { describe, expect, it } from "vitest";
import { APPLE_PODCAST_ID, cueSeconds, cueTimes, deepLinks, notesLink, PARAGRAPH_LEAD_S, pageLink } from "../src/links";
import type { LinkEpisode } from "../src/links";

const FULL: LinkEpisode = {
  guid: "65b16e479edb2b0016f6f435",
  youtube_video_id: "dQw4w9WgXcQ",
  apple_episode_id: "1000612345678",
  spotify_episode_id: "4rOoJ6Egrf8K2IrywzwOMk",
  page_url: "https://woodtalk.example/episodes/250",
  offset_youtube_s: 0,
  offset_apple_s: 0,
  offset_spotify_s: 0,
};

const EMPTY: LinkEpisode = {
  guid: "",
  youtube_video_id: null,
  apple_episode_id: null,
  spotify_episode_id: null,
  page_url: null,
  offset_youtube_s: 0,
  offset_apple_s: 0,
  offset_spotify_s: 0,
};

describe("another lead-in (a transcript paragraph's 1 s)", () => {
  it("is one second for a paragraph", () => {
    expect(PARAGRAPH_LEAD_S).toBe(1);
  });

  it("cues that long before the time, plus the offset, never before 0", () => {
    expect(cueSeconds(65_432, 0, 1)).toBe(64);
    expect(cueSeconds(65_432, 12, 1)).toBe(76);
    expect(cueSeconds(65_432, 0, 0)).toBe(65);
    expect(cueSeconds(3_000, -20, 1)).toBe(0);
  });

  it("cueTimes and deepLinks pass it on to every platform", () => {
    const episode = {
      guid: "x",
      youtube_video_id: "yt",
      apple_episode_id: "ap",
      spotify_episode_id: "sp",
      page_url: "https://shows.acast.com/woodtalk/episodes/x",
      offset_youtube_s: 10,
      offset_apple_s: 20,
      offset_spotify_s: 30,
    };
    expect(cueTimes(episode, 100_000, 0)).toEqual({ youtube: 110, apple: 120, spotify: 130, page: 100 });
    const links = deepLinks(episode, 100_000, 0);
    expect(links.youtube).toContain("&t=110s");
    expect(links.apple).toContain("&t=120");
    expect(links.spotify).toContain("?t=130");
    expect(links.page).toBe("https://shows.acast.com/woodtalk/episodes/x?seek=100");
    // The default is still the hit's 7 s lead-in.
    expect(cueTimes(episode, 100_000).page).toBe(93);
  });
});

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
    expect(cueTimes(episode, 65_432)).toEqual({ youtube: 61, apple: 88, spotify: 53, page: 58 });
  });

  it("gives the page the lead-in but no platform offset", () => {
    const episode = { ...FULL, offset_youtube_s: 3, offset_apple_s: 30, offset_spotify_s: -50 };
    expect(cueTimes(episode, 65_432).page).toBe(58);
    expect(cueTimes(episode, 3000).page).toBe(0);
  });
});

describe("pageLink", () => {
  // Both forms tried on a phone and a desktop, 2026-10-11: the player starts at the time.
  it("is the Acast page under the episode's guid, with seek", () => {
    expect(pageLink("6968079fe9172b83203dbacf", 600)).toBe(
      "https://shows.acast.com/woodtalk/episodes/6968079fe9172b83203dbacf?seek=600",
    );
  });
  it("encodes an old episode's guid, which is a URL", () => {
    expect(pageLink("http://archive.org/download/wt089/WT_071.mp3", 4184)).toBe(
      "https://shows.acast.com/woodtalk/episodes/http%3A%2F%2Farchive.org%2Fdownload%2Fwt089%2FWT_071.mp3?seek=4184",
    );
  });
  it("cannot be steered off the episodes path by a guid", () => {
    expect(pageLink("../../x?seek=1#y", 5)).toBe("https://shows.acast.com/woodtalk/episodes/..%2F..%2Fx%3Fseek%3D1%23y?seek=5");
  });
  it("seeks to 0 at the start", () => {
    expect(pageLink("x", 0)).toBe("https://shows.acast.com/woodtalk/episodes/x?seek=0");
  });
});

describe("notesLink", () => {
  it("is the feed's link when that is the show's own site", () => {
    expect(notesLink("https://woodtalkshow.com/episodes/wood-talk-online-71/")).toBe(
      "https://woodtalkshow.com/episodes/wood-talk-online-71/",
    );
  });
  it("is left out when the feed's link is the Acast page (the show page link goes there)", () => {
    expect(notesLink("https://shows.acast.com/woodtalk/episodes/should-i-buy-a-jointer-wt616")).toBeUndefined();
  });
  it("keeps a look-alike host: it is not Acast", () => {
    expect(notesLink("https://shows.acast.com.evil.example/x")).toBe("https://shows.acast.com.evil.example/x");
  });
  it("is left out with no link, one that does not parse, or one that is not http(s)", () => {
    expect(notesLink(null)).toBeUndefined();
    expect(notesLink("")).toBeUndefined();
    expect(notesLink("not a url")).toBeUndefined();
    expect(notesLink("javascript:alert(1)")).toBeUndefined();
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

  it("plays the show page on Acast whatever the feed's link is, and gives that link as the notes", () => {
    const links = deepLinks({ ...FULL, offset_apple_s: 30 }, 65_432);
    expect(links.page).toBe("https://shows.acast.com/woodtalk/episodes/65b16e479edb2b0016f6f435?seek=58");
    expect(links.notes).toBe("https://woodtalk.example/episodes/250");
  });

  it("has no notes link when the feed's link is the Acast page", () => {
    const acast = { ...FULL, page_url: "https://shows.acast.com/woodtalk/episodes/x" };
    expect(deepLinks(acast, 65_432).page).toBe("https://shows.acast.com/woodtalk/episodes/65b16e479edb2b0016f6f435?seek=58");
    expect("notes" in deepLinks(acast, 65_432)).toBe(false);
  });

  it("omits each link when its ID is null", () => {
    expect(Object.keys(deepLinks({ ...FULL, youtube_video_id: null }, 0))).toEqual(["apple", "spotify", "page", "notes"]);
    expect(Object.keys(deepLinks({ ...FULL, apple_episode_id: null }, 0))).toEqual(["youtube", "spotify", "page", "notes"]);
    expect(Object.keys(deepLinks({ ...FULL, spotify_episode_id: null }, 0))).toEqual(["youtube", "apple", "page", "notes"]);
    expect(Object.keys(deepLinks({ ...FULL, page_url: null }, 0))).toEqual(["youtube", "apple", "spotify", "page"]);
  });

  it("omits a link whose ID is an empty string", () => {
    const links = deepLinks(
      { ...FULL, guid: "", youtube_video_id: "", apple_episode_id: "", spotify_episode_id: "", page_url: "" },
      0,
    );
    expect(links).toEqual({});
  });

  it("gives {} when every ID is null", () => {
    expect(deepLinks(EMPTY, 12_345)).toEqual({});
  });

  it("keeps card order: youtube, apple, spotify, page, then the notes", () => {
    expect(Object.keys(deepLinks(FULL, 0))).toEqual(["youtube", "apple", "spotify", "page", "notes"]);
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
