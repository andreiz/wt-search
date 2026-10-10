import { describe, expect, it } from "vitest";
import type { DeepLinks } from "../../../worker/src/api-types";
import { chipName, hitTime, menuName, menuPlays, primaryPlay, type PlayLink } from "../../src/lib/platforms";
import { result } from "../helpers";

const ALL: DeepLinks = {
  youtube: "https://yt.test/1",
  apple: "https://apple.test/1",
  spotify: "https://spotify.test/1",
  page: "https://page.test/1?seek=1740",
};

// hit_ms 1_741_000 is 29:01; the lead-in puts YouTube's cue at 28:54, Apple's at 28:20.
function hit(links: DeepLinks) {
  return result(1, {
    episode: { ...result(1).episode, links },
    hit_ms: 1_741_000,
    cue_s: { youtube: 1734, apple: 1700, spotify: 1700, page: 1734 },
  });
}

describe("primaryPlay", () => {
  it("is YouTube when the episode has it, even with a page", () => {
    expect(primaryPlay(hit(ALL))).toEqual({ key: "youtube", name: "YouTube", href: ALL.youtube, cue: "28:54" });
  });
  it("is the show page when there is no YouTube", () => {
    const { youtube: _y, ...rest } = ALL;
    expect(primaryPlay(hit(rest))).toEqual({ key: "page", name: "the show page", href: ALL.page, cue: "28:54" });
  });
  it("is null with Apple only, or with nothing", () => {
    expect(primaryPlay(hit({ apple: ALL.apple }))).toBeNull();
    expect(primaryPlay(hit({}))).toBeNull();
  });
});

describe("menuPlays", () => {
  const keys = (links: DeepLinks) => menuPlays(hit(links)).map((p) => p.key);
  it("lists the page, Apple and Spotify for an episode with all of them", () => {
    expect(keys(ALL)).toEqual(["page", "apple", "spotify"]);
    expect(menuPlays(hit(ALL)).map((p) => p.name)).toEqual(["the show page", "Apple", "Spotify"]);
  });
  it("leaves the page out when it is the chip's link", () => {
    const { youtube: _y, ...noYoutube } = ALL;
    expect(keys(noYoutube)).toEqual(["apple", "spotify"]);
    expect(keys({ page: ALL.page })).toEqual([]);
  });
  it("lists Apple alone, and nothing for no links", () => {
    expect(keys({ apple: ALL.apple })).toEqual(["apple"]);
    expect(keys({})).toEqual([]);
  });
});

describe("names", () => {
  const play = (key: PlayLink["key"], name: string, cue: string): PlayLink => ({ key, name, href: "https://x.test", cue });

  it("names the chip around its visible words, adding where playback starts when that differs", () => {
    expect(chipName(play("youtube", "YouTube", "28:54"), "29:01")).toBe("Play on YouTube 29:01, starts at 28:54");
    expect(chipName(play("youtube", "YouTube", "29:01"), "29:01")).toBe("Play on YouTube 29:01");
    expect(chipName(play("page", "the show page", "28:54"), "29:01")).toBe(
      "Play on the show page 29:01, starts at 28:54, may play an ad first",
    );
    expect(chipName(play("page", "the show page", "29:01"), "29:01")).toBe(
      "Play on the show page 29:01, may play an ad first",
    );
  });

  it("names the menu rows around their visible words", () => {
    // The show page row never adds "starts at": it would contradict "plays from".
    expect(menuName(play("page", "the show page", "29:01"), "29:01")).toBe("Show page plays from 29:01, may play an ad first");
    expect(menuName(play("page", "the show page", "28:54"), "29:01")).toBe("Show page plays from 29:01, may play an ad first");
    expect(menuName(play("apple", "Apple", "28:20"), "29:01")).toBe(
      "Play on Apple at 29:01 · may start minutes early, starts at 28:20",
    );
    expect(menuName(play("spotify", "Spotify", "29:01"), "29:01")).toBe("Play on Spotify at 29:01 · may start minutes early");
  });

});

describe("hitTime", () => {
  it("is the hit's own time", () => {
    expect(hitTime(hit(ALL))).toBe("29:01");
  });
});
