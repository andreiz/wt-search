// A /api/context answer and the search result it belongs to, built from what
// worker/test/context.test.ts expects of the endpoint: the chunks in the order of the episode
// (30 s apart), each with its own `links` and `cue_s` (the cue at the chunk's start, with the
// platform offsets and the 7 s lead-in), the episode once at the top, `boilerplate` as a boolean.
//
// Episode 301 has ten chunks, seq 0 to 9. The hit is seq 5 (chunk 4105); radius 3 gives seq 2 to
// 8 and radius 6 gives seq 0 to 9 (the answer is cut at the ends of the episode). Chunk 4107 (seq
// 7) is the one hit folded into the result, and chunk 4108 (seq 8) is a sponsor read.
import type { ContextChunk, ContextResponse, DeepLinks, SearchResult } from "../../../worker/src/api-types";

export const HIT_ID = 4105;
export const FOLDED_ID = 4107;
export const HIT_TEXT = "Then we come to the dovetail jig and why it never fits.";
export const HIT_RANGES: [number, number][] = [[20, 28]]; // "dovetail"

function linksAt(cueYoutube: number, cueApple: number, cueSpotify: number): DeepLinks {
  return {
    youtube: `https://www.youtube.com/watch?v=yt33&t=${cueYoutube}s`,
    apple: `https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480?i=ap33&t=${cueApple}`,
    spotify: `https://open.spotify.com/episode/sp33?t=${cueSpotify}`,
    page: "https://example.com/ep/301",
  };
}

const TEXTS = [
  "Welcome back to the shop.",
  "We start with listener mail.",
  "Somebody asked about glue.",
  "Before the jig, a word about squaring stock.",
  "That always matters first.",
  HIT_TEXT,
  "Which brings us to the router table.",
  "A second mention of the dovetail jig, much later.",
  "This episode is brought to you by Sponsorly.",
  "And that is all for this week.",
];

export function chunkOf(seq: number): ContextChunk {
  const start = seq * 30;
  // Youtube +10 s offset, Apple +20, Spotify +30, the page none; all with the 7 s lead-in.
  const cue = { youtube: Math.max(0, start - 7 + 10), apple: Math.max(0, start - 7 + 20), spotify: Math.max(0, start - 7 + 30), page: Math.max(0, start - 7) };
  return {
    chunk_id: 4100 + seq,
    seq,
    start_ms: start * 1000,
    end_ms: (start + 30) * 1000,
    text: TEXTS[seq]!,
    boilerplate: seq === 8,
    cue_s: cue,
    links: { ...linksAt(cue.youtube, cue.apple, cue.spotify), page: "https://example.com/ep/301" },
  };
}

/** What `/api/context?chunk=4105&radius=<radius>` answers. */
export function contextAnswer(radius: number): ContextResponse {
  const hit = 5;
  const chunks: ContextChunk[] = [];
  for (let seq = Math.max(0, hit - radius); seq <= Math.min(9, hit + radius); seq++) chunks.push(chunkOf(seq));
  return {
    chunk_id: HIT_ID,
    episode: {
      id: 33,
      number: 301,
      title: "Links and Ads",
      date: "2021-01-02",
      // The hit chunk's cues.
      links: chunkOf(hit).links,
    },
    chunks,
  } satisfies ContextResponse;
}

/** The search result the answer belongs to: a keyword hit with one folded hit. */
export const HIT: SearchResult = {
  episode: { id: 33, number: 301, title: "Links and Ads", date: "2021-01-02", links: chunkOf(5).links },
  chunk_id: HIT_ID,
  text: HIT_TEXT,
  ranges: HIT_RANGES,
  hit_ms: 155_000,
  cue_s: chunkOf(5).cue_s,
  match: "keyword",
  more_in_episode: 1,
  folded: [FOLDED_ID],
};
