// GET /api/info (spec §4.4): what the web app needs on load. The episode count and newest
// date feed "625 episodes indexed through Sep 17, 2026" (§5.6); the Turnstile site key comes
// from the environment's var, so one web build serves every environment (§5.1).
//
// One D1 statement, and the answer is edge-cached like a search (§4.7, cache.ts).

import { cached, cacheTtl, corpusVersion, pathCacheKey, store } from "./cache";
import type { Env } from "./env";
import { JSON_HEADERS, json, logError } from "./http";

interface InfoRow {
  episodes: number;
  latest: string | null;
  corpus_version: string | null;
}

export async function info(
  request: Request,
  env: Env,
  requestInfo: { cache?: "hit" | "miss" | "skip" },
): Promise<Response> {
  requestInfo.cache = "skip";
  const ttl = cacheTtl(env.SEARCH_CACHE_TTL_S);
  let key: Request | null = null;
  let row: InfoRow | null;
  try {
    if (ttl !== null) {
      key = pathCacheKey(request.url, "/api/info", await corpusVersion(env.DB));
      const hit = await cached(key);
      if (hit) {
        requestInfo.cache = "hit";
        return hit;
      }
    }
    row = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM episodes) AS episodes,
              (SELECT MAX(published_at) FROM episodes) AS latest,
              (SELECT value FROM meta WHERE key = 'corpus_version') AS corpus_version`,
    ).first<InfoRow>();
  } catch (err) {
    // D1 is down or unreachable (spec §6): 503, not a bug in the Worker.
    logError("d1_unavailable", request, err);
    return json({ error: "unavailable" }, 503);
  }
  // As in /api/health: a missing corpus_version row is a broken schema, not an empty answer.
  if (row?.corpus_version == null) throw new Error("meta.corpus_version is missing");

  const body = JSON.stringify({
    episodes: row.episodes,
    latest_episode_date: row.latest === null ? null : row.latest.slice(0, 10),
    corpus_version: row.corpus_version,
    turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
  });
  if (key !== null && ttl !== null) {
    await store(key, body, JSON_HEADERS, ttl);
    requestInfo.cache = "miss";
  }
  return new Response(body, { headers: { ...JSON_HEADERS, "x-wts-cache": requestInfo.cache } });
}
