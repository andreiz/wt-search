// Test helpers: API answers built from the real response shapes, and a `fetch` whose answers
// the test resolves by hand (so two searches can finish out of order).
import { vi } from "vitest";
import type { SearchResult } from "../../worker/src/api-types";
import type { SearchData } from "../src/lib/api";

export function result(n: number, over: Partial<SearchResult> = {}): SearchResult {
  return {
    episode: {
      id: n,
      number: n,
      title: `Episode ${n} title`,
      date: "2015-06-10",
      links: { youtube: `https://example.test/yt/${n}` },
    },
    chunk_id: 1000 + n,
    text: `Text of passage ${n}`,
    ranges: [],
    hit_ms: 60_000 * n,
    cue_s: { youtube: 60 * n, apple: 60 * n, spotify: 60 * n },
    match: "keyword",
    more_in_episode: 0,
    folded: [],
    ...over,
  };
}

export function smartBody(results: SearchResult[], over: Partial<Extract<SearchData, { mode: "smart" }>> = {}): SearchData {
  return { mode: "smart", sort: "relevance", page: 1, limit: 20, has_more: false, results, ...over };
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

/**
 * Replaces `fetch`. Each call waits for the test to answer it. With `honorAbort` (the default) an
 * aborted request rejects with an AbortError, like the real thing; with `false` the stub ignores
 * the signal, so only the app's own "is this the latest request" check can drop the answer.
 */
export function stubFetch(honorAbort = true): PendingCall[] {
  const calls: PendingCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? new AbortController().signal;
      return new Promise<Response>((resolve, reject) => {
        calls.push({
          url: new URL(String(input), "http://localhost"),
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
