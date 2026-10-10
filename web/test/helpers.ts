// Test helpers: API answers built from the real response shapes, and a `fetch` whose answers
// the test resolves by hand (so two searches can finish out of order).
import { vi } from "vitest";
import type { EpisodeHit, InfoResponse, SearchResult } from "../../worker/src/api-types";
import type { SearchData } from "../src/lib/api";

export function result(n: number, over: Partial<SearchResult> = {}): SearchResult {
  return {
    episode: {
      id: n,
      number: n,
      // No number at the end or after "Ep.": displayTitle would strip the episode's own number from those.
      title: `Show ${n} title`,
      date: "2015-06-10",
      links: { youtube: `https://example.test/yt/${n}` },
    },
    chunk_id: 1000 + n,
    text: `Text of passage ${n}`,
    ranges: [],
    hit_ms: 60_000 * n,
    cue_s: { youtube: 60 * n, apple: 60 * n, spotify: 60 * n, page: 60 * n },
    match: "keyword",
    more_in_episode: 0,
    folded: [],
    ...over,
  };
}

export function smartBody(results: SearchResult[], over: Partial<Extract<SearchData, { mode: "smart" }>> = {}): SearchData {
  return { mode: "smart", sort: "relevance", page: 1, limit: 20, has_more: false, results, episodes: [], ...over };
}

/** An episode whose title matched, from the real shape (`EpisodeHit`). */
export function episodeHit(n: number, over: Partial<EpisodeHit> = {}): EpisodeHit {
  return {
    id: n,
    number: n,
    title: `Shove a Kregger in the Hole`,
    date: "2026-08-19",
    links: { youtube: `https://example.test/yt/ep/${n}`, page: `https://example.test/page/${n}` },
    ...over,
  };
}

export function exactBody(results: SearchResult[], over: Partial<Extract<SearchData, { mode: "exact" }>> = {}): SearchData {
  return {
    mode: "exact",
    sort: "relevance",
    total: results.length,
    total_capped: false,
    truncated: false,
    page: 1,
    limit: 20,
    has_more: false,
    results,
    episodes: [],
    ...over,
  };
}

export interface PendingCall {
  url: URL;
  signal: AbortSignal;
  /** Answer the request with a 200 and this body (or another status and body). */
  respond(body: unknown, status?: number, headers?: Record<string, string>): void;
  /** Fail the request the way a dropped connection does. */
  fail(): void;
}

/** The calls `stubFetch` has seen: everything but /api/info, which is kept in `info`. */
export type Calls = PendingCall[] & { info: PendingCall[] };

/** A GET /api/info answer, from the real response shape. */
export function infoBody(over: Partial<InfoResponse> = {}): InfoResponse {
  return { episodes: 625, latest_episode_date: "2026-09-17", corpus_version: "v1", turnstile_site_key: null, ...over };
}

/**
 * Replaces `fetch`. Each call waits for the test to answer it. With `honorAbort` (the default) an
 * aborted request rejects with an AbortError, like the real thing; with `false` the stub ignores
 * the signal, so only the app's own "is this the latest request" check can drop the answer.
 *
 * The page asks /api/info once when it shows the empty state. Those requests go to `calls.info`
 * and not into `calls`, so `calls[0]` is still the first search (or context) request and a
 * test about the info line or the maintenance banner reads `calls.info[0]`.
 */
export function stubFetch(honorAbort = true): Calls {
  const calls = Object.assign([] as PendingCall[], { info: [] as PendingCall[] });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? new AbortController().signal;
      return new Promise<Response>((resolve, reject) => {
        const url = new URL(String(input), "http://localhost");
        (url.pathname === "/api/info" ? calls.info : calls).push({
          url,
          signal,
          respond(body, status = 200, headers = {}) {
            resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
          },
          fail() {
            reject(new TypeError("Failed to fetch"));
          },
        });
        if (honorAbort) {
          signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }
      });
    }),
  );
  return calls;
}
