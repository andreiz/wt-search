// Edge cache for /api/search and /api/info (spec §4.7). A response is cached by the Cache API,
// keyed by the normalized query and the parameters as the route read them (so `page=abc` and
// `page=1` share an entry; /api/info has none), plus corpus_version: a publish bumps the
// version, so old entries are simply never asked for again and age out. API_VERSION does the
// same for a deploy that changes the answers.
//
// The Cache API is per data centre and, by Cloudflare's docs, works on Workers with a custom
// domain; `x-wts-cache` on every search and info response says what happened (hit, miss, skip).

import { boundQuery } from "./query";

/** corpus_version is read from D1 at most this often per isolate. */
export const VERSION_TTL_MS = 60_000;

let memo: { value: string; at: number } | null = null;

/** Forget the remembered corpus_version (tests; a new isolate starts without one). */
export function forgetCorpusVersion(): void {
  memo = null;
}

/** The current corpus_version, from D1 at most once per VERSION_TTL_MS. D1 errors propagate. */
export async function corpusVersion(db: D1Database): Promise<string> {
  const now = Date.now();
  if (memo !== null && now - memo.at < VERSION_TTL_MS) return memo.value;
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = 'corpus_version'")
    .first<{ value: string | null }>();
  memo = { value: row?.value ?? "", at: now };
  return memo.value;
}

/** `SEARCH_CACHE_TTL_S` (a var per environment) as seconds; null (no caching) unless a positive integer. */
export function cacheTtl(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) return null;
  return Number(value);
}

export interface SearchKey {
  q: string;
  mode: string;
  sort: string;
  page: number;
  limit: number;
}

/**
 * The cache key: a GET on the request's own origin, so the entry belongs to this zone. The
 * query is cut where the parser cuts it (boundQuery), so a search that parses differently never
 * shares an entry. Then only runs of whitespace are normalized, and `\s` is exactly what the
 * parser's scanner splits words on (NBSP included): case matters (`OR` is an operator).
 */
export function cacheKey(requestUrl: string, key: SearchKey, version: string): Request {
  const url = new URL("/api/search", requestUrl);
  url.searchParams.set("q", boundQuery(key.q).trim().replace(/\s+/g, " "));
  url.searchParams.set("mode", key.mode);
  url.searchParams.set("sort", key.sort);
  url.searchParams.set("page", String(key.page));
  url.searchParams.set("limit", String(key.limit));
  return versioned(url, version);
}

/** The cache key for a route with no parameters (`/api/info`): the path and corpus_version. */
export function pathCacheKey(requestUrl: string, path: string, version: string): Request {
  return versioned(new URL(path, requestUrl), version);
}

/**
 * Part of every cache key. **Bump it in the commit that changes what an answer holds** (a field
 * added, removed or given a new meaning, a link built differently): a deploy doesn't clear the
 * cache, so without this the new page is served answers the old code stored, for up to the TTL.
 * 2: `cue_s.page`, and `seek` on the show page link (2026-10-09).
 */
export const API_VERSION = 2;

function versioned(url: URL, version: string): Request {
  url.searchParams.set("api", String(API_VERSION));
  url.searchParams.set("v", version);
  return new Request(url.toString());
}

/** A cached response, as served: the stored `cache-control` is the cache's, not the browser's. */
export async function cached(key: Request): Promise<Response | null> {
  const hit = await caches.default.match(key);
  if (!hit) return null;
  const response = new Response(hit.body, hit);
  response.headers.delete("cache-control");
  response.headers.set("x-wts-cache", "hit");
  return response;
}

/** Store `body` (JSON text) under `key` for `ttl` seconds. A cache failure never fails a search. */
export async function store(key: Request, body: string, headers: HeadersInit, ttl: number): Promise<void> {
  try {
    const response = new Response(body, { headers });
    response.headers.set("cache-control", `public, max-age=${ttl}`);
    await caches.default.put(key, response);
  } catch {
    // Not cached this time; the next request tries again.
  }
}
