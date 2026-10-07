import type { Env } from "./env";
import { parseQuery } from "./query";
import { exactSearch, maxExactPage, PAGE_SIZE, type SearchResponse, type Sort } from "./search";

type Handler = (request: Request, env: Env) => Response | Promise<Response>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * One structured line per error, for Workers Logs. Deliberately has no IP, no headers, no
 * query string and no stack: only what is needed to find the failing route (spec §8.3).
 */
function logError(event: string, request: Request, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(
    JSON.stringify({
      level: "error",
      event,
      method: request.method,
      path: new URL(request.url).pathname,
      error: `${e.name}: ${e.message}`.slice(0, 300),
    }),
  );
}

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
function parsePage(value: string | null, limit: number): number {
  if (value === null || !/^\d+$/.test(value)) return 1;
  return Math.min(Math.max(Number(value), 1), maxExactPage(limit));
}

/**
 * GET /api/search?q=&mode=smart|exact&sort=relevance|newest|oldest&page=&limit= (spec §4.4).
 * Bad parameters fall back to their defaults and bad query syntax is plain words (query.ts),
 * so the only error is D1 being down.
 */
const search: Handler = async (request, env) => {
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode") === "exact" ? "exact" : "smart";
  const sortParam = (params.get("sort") ?? "").toLowerCase();
  const sort = SORTS.find((s) => s === sortParam) ?? "relevance";
  const limit = parseLimit(params.get("limit"));
  const page = parsePage(params.get("page"), limit);

  let response: SearchResponse;
  try {
    response = await exactSearch(env.DB, parseQuery(params.get("q") ?? ""), sort, page, limit);
  } catch (err) {
    logError("d1_unavailable", request, err);
    return json({ error: "unavailable" }, 503);
  }
  // Task 14 replaces this: smart mode will merge the Vectorize results into the keyword ones,
  // and set smart_degraded only when AI or Vectorize fail. Until then smart mode is the same
  // keyword-only answer that Task 14 gives in that failure.
  if (mode === "smart") response = { ...response, smart_degraded: true };
  return json({ ...response, mode, sort });
};

// Keyed by "METHOD /path". A known path with another method is simply not found.
const routes = new Map<string, Handler>([
  ["GET /api/health", health],
  ["GET /api/search", search],
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const handler = routes.get(`${request.method} ${new URL(request.url).pathname}`);
      if (!handler) return json({ error: "not_found" }, 404);
      return await handler(request, env);
    } catch (err) {
      logError("unhandled_error", request, err);
      return json({ error: "internal" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
