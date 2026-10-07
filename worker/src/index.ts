import type { Env } from "./env";

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

// Keyed by "METHOD /path". A known path with another method is simply not found.
const routes = new Map<string, Handler>([["GET /api/health", health]]);

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
