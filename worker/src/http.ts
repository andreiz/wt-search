// Small helpers every route uses: JSON responses and the one-line error log.

export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * One structured line per error, for Workers Logs. Deliberately has no IP, no headers, no
 * query string and no stack: only what is needed to find the failing route (spec §8.3).
 */
export function logError(event: string, request: Request, err: unknown): void {
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
