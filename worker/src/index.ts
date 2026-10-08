import { recordReport, recordSearch } from "./analytics";
import { countSmartSearch } from "./budget";
import { cached, cacheKey, cacheTtl, corpusVersion, store } from "./cache";
import { context } from "./context";
import type { Env } from "./env";
import { robots, searchOverride, withSecurityHeaders } from "./guard";
import { JSON_HEADERS, json, logError } from "./http";
import { info as infoRoute } from "./info";
import { MAX_QUERY_CHARS, parseQuery } from "./query";
import { rateLimited } from "./ratelimit";
import { report } from "./report";
import {
  exactSearch,
  maxExactPage,
  maxSmartPage,
  PAGE_SIZE,
  smartSearch,
  type ExactResponse,
  type SmartResponse,
  type Sort,
} from "./search";

/**
 * What a route adds to its request's log line (spec §8.3). Only the search route fills it
 * (and /api/info, its `cache` field); the router writes the line, so every request gets
 * exactly one, whatever happens.
 */
interface RequestInfo {
  /** The query as typed, cut like the parser cuts it (the log line shortens it further). */
  q?: string;
  mode?: "smart" | "exact";
  sort?: Sort;
  page?: number;
  results?: number;
  degraded?: boolean;
  /** hit: served from the edge cache; miss: computed and stored; skip: not cacheable. */
  cache?: "hit" | "miss" | "skip";
}

type Handler = (
  request: Request,
  env: Env,
  info: RequestInfo,
  ctx?: ExecutionContext,
) => Response | Promise<Response>;

/** The log line keeps this much of the query; Analytics Engine keeps MAX_QUERY_CHARS. */
const LOG_QUERY_CHARS = 80;
/** Carries the result count on a cached response, so a hit's log line has it too. */
const RESULTS_HEADER = "x-wts-results";

/** GET /api/health: the corpus version, from one trivial D1 query (spec §4.4). */
const health: Handler = async (request, env) => {
  let row: { value: string | null } | null;
  try {
    row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'corpus_version'").first<{
      value: string | null;
    }>();
  } catch (err) {
    // D1 is down or unreachable (spec §6): 503, not a bug in the Worker.
    logError("d1_unavailable", request, err);
    return json({ error: "unavailable" }, 503);
  }
  // schema/0001_init.sql seeds this row and `wts publish` only ever updates it. If it is
  // gone, the database is not the schema the Worker expects: fail loudly, not with ok.
  if (row?.value == null) throw new Error("meta.corpus_version is missing");
  return json({ ok: true, corpus_version: row.value });
};

const SORTS: readonly Sort[] = ["relevance", "newest", "oldest"];

/** The page size: a plain integer, 1–PAGE_SIZE; anything else is PAGE_SIZE, bigger is clamped. */
function parseLimit(value: string | null): number {
  if (value === null || !/^\d+$/.test(value) || Number(value) < 1) return PAGE_SIZE;
  return Math.min(Number(value), PAGE_SIZE);
}

/** Anything but a plain non-negative integer is page 1; a page past the cap is the cap. */
function parsePage(value: string | null, lastPage: number): number {
  if (value === null || !/^\d+$/.test(value)) return 1;
  return Math.min(Math.max(Number(value), 1), lastPage);
}

/**
 * GET /api/search?q=&mode=smart|exact&sort=relevance|newest|oldest&page=&limit=&debug= (spec
 * §4.4). Bad parameters fall back to their defaults and bad query syntax is plain words
 * (query.ts), so the only error is D1 being down.
 *
 * Answers are cached at the edge (cache.ts) unless smart search was degraded or `debug=1`
 * (smart mode only) asked for the ranking details.
 */
const search: Handler = async (request, env, info, ctx) => {
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode") === "exact" ? "exact" : "smart";
  const sortParam = (params.get("sort") ?? "").toLowerCase();
  const sort = SORTS.find((s) => s === sortParam) ?? "relevance";
  const limit = parseLimit(params.get("limit"));
  const page = parsePage(params.get("page"), mode === "exact" ? maxExactPage(limit) : maxSmartPage(limit));
  const q = params.get("q") ?? "";
  const debug = mode === "smart" && params.get("debug") === "1";
  Object.assign(info, {
    q: Array.from(q).slice(0, MAX_QUERY_CHARS).join(""),
    mode,
    sort,
    page,
    results: 0,
    degraded: false,
    cache: "skip",
  } satisfies RequestInfo);

  const ttl = debug ? null : cacheTtl(env.SEARCH_CACHE_TTL_S);
  let key: Request | null = null;
  let response: ExactResponse | SmartResponse;
  try {
    if (ttl !== null) {
      key = cacheKey(request.url, { q, mode, sort, page, limit }, await corpusVersion(env.DB));
      const hit = await cached(key);
      if (hit) {
        info.cache = "hit";
        info.results = Number(hit.headers.get(RESULTS_HEADER) ?? 0);
        return hit;
      }
    }
    const parsed = parseQuery(q);
    // The kill switch (spec §4.8 item 3), then the daily budget (item 2): keyword-only, with no
    // AI or Vectorize call. Only a search that would embed is counted: not exact mode, a cache
    // hit (returned above), the kill switch or a query with nothing to match.
    let skipMeaning: "off" | "budget" | undefined = searchOverride(env) === "exact" ? "off" : undefined;
    if (mode === "smart" && skipMeaning === undefined && parsed.fts !== null) {
      const counted = await countSmartSearch(env);
      if (counted.over) skipMeaning = "budget";
      if (counted.alert) {
        // After the response when the runtime allows it; tests call fetch() without a ctx.
        const posting = counted.alert();
        if (ctx) ctx.waitUntil(posting);
        else await posting;
      }
    }
    response =
      mode === "exact"
        ? await exactSearch(env.DB, parsed, sort, page, limit)
        : await smartSearch(env, parsed, sort, page, {
            limit,
            // Workers AI or Vectorize failing is not an error: keyword results, smart_degraded.
            onDegraded: (stage, err) => logError(`${stage}_unavailable`, request, err),
            debug,
            ...(skipMeaning ? { skipMeaning } : {}),
          });
  } catch (err) {
    logError("d1_unavailable", request, err);
    return json({ error: "unavailable" }, 503);
  }

  const body = JSON.stringify({ ...response, mode, sort });
  const degraded = "smart_degraded" in response && response.smart_degraded !== undefined;
  info.results = response.results.length;
  info.degraded = degraded;
  const headers = { ...JSON_HEADERS, [RESULTS_HEADER]: String(response.results.length) };
  // A degraded answer is not stored: a short Workers AI outage would otherwise last an hour.
  if (key !== null && ttl !== null && !degraded) {
    await store(key, body, headers, ttl);
    info.cache = "miss";
  }
  return new Response(body, { headers: { ...headers, "x-wts-cache": info.cache ?? "skip" } });
};

// Keyed by "METHOD /path". A known path with another method is simply not found, except that
// HEAD runs the GET route (so `curl -I` shows its headers); the runtime drops the body.
const routes = new Map<string, Handler>([
  ["GET /api/health", health],
  ["GET /api/info", infoRoute],
  ["GET /api/search", search],
  ["GET /api/context", context],
  ["POST /api/report", report],
  ["GET /robots.txt", robots],
]);

const MAINTENANCE = {
  error: "maintenance",
  message: "Search is down for maintenance. Please try again later.",
};

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const path = new URL(request.url).pathname;
    const route = `${request.method} ${path}`;
    const info: RequestInfo = {};
    let response: Response;
    try {
      const handler = routes.get(request.method === "HEAD" ? `GET ${path}` : route);
      if (path.startsWith("/api/") && searchOverride(env) === "maintenance") {
        response = json(MAINTENANCE, 503); // the kill switch (spec §4.8 item 3); no D1
      } else {
        response =
          (await rateLimited(request, env, path)) ??
          (handler ? await handler(request, env, info, ctx) : json({ error: "not_found" }, 404));
      }
    } catch (err) {
      logError("unhandled_error", request, err);
      response = json({ error: "internal" }, 500);
    }
    response = withSecurityHeaders(response);
    const ms = Date.now() - started;

    // One line per request (spec §8.3). Built from named fields only: never headers, so no IP.
    const { q, ...rest } = info;
    console.log(
      JSON.stringify({
        level: "info",
        event: "request",
        method: request.method,
        path,
        status: response.status,
        ms,
        ...(q === undefined ? {} : { q: Array.from(q).slice(0, LOG_QUERY_CHARS).join("") }),
        ...rest,
      }),
    );
    if (route === "GET /api/search" && info.mode !== undefined) {
      recordSearch(env, {
        q: q ?? "",
        mode: info.mode,
        sort: info.sort ?? "relevance",
        cache: info.cache ?? "skip",
        results: info.results ?? 0,
        ms,
        degraded: info.degraded ?? false,
        page: info.page ?? 1,
        status: response.status,
      });
    } else if (route === "POST /api/report") {
      recordReport(env, response.status);
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
