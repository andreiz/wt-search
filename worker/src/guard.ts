// Abuse and cost protection that every route shares (spec §4.8 items 3, 5 and 6): the kill
// switch, the report Origin check, security headers and robots.txt (by environment).

import type { Env } from "./env";

/** Sent on every response; no response ever carries Access-Control-Allow-Origin. */
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

/** The response with SECURITY_HEADERS added (a copy: some responses' headers are immutable). */
export function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}

export type Override = "exact" | "maintenance";

let warnedOverride = false;

/** Forget that an unknown SEARCH_OVERRIDE was logged (tests; a new isolate starts afresh). */
export function forgetOverrideWarning(): void {
  warnedOverride = false;
}

/**
 * The kill switch's state. Unset or empty is normal (null); an unknown value is normal too,
 * with one warning per isolate, so a typo in the dashboard never takes search down.
 */
export function searchOverride(env: Pick<Env, "SEARCH_OVERRIDE">): Override | null {
  const value = (env.SEARCH_OVERRIDE ?? "").trim().toLowerCase();
  if (value === "exact" || value === "maintenance") return value;
  if (value !== "" && !warnedOverride) {
    warnedOverride = true;
    console.warn(
      JSON.stringify({ level: "warn", event: "unknown_search_override", value: value.slice(0, 40) }),
    );
  }
  return null;
}

/**
 * Whether the request's Origin is the Worker's own (the site is served from the same origin as
 * the API, spec §5.1) or one of REPORT_ORIGINS (exact match; extra origins such as Vite's dev
 * server). A missing Origin is refused, and unset REPORT_ORIGINS adds none.
 */
export function originAllowed(request: Request, env: Pick<Env, "REPORT_ORIGINS">): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  if (origin === new URL(request.url).origin) return true;
  const allowed = (env.REPORT_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
  return allowed.includes(origin);
}

/**
 * GET /robots.txt, by environment (spec §4.8 item 5): production allows the pages and keeps
 * crawlers off /api/; every other environment (staging, e2e, unset) disallows everything.
 */
export function robots(_request: Request, env: Pick<Env, "WTS_ENV">): Response {
  const body =
    env.WTS_ENV === "production"
      ? "User-agent: *\nAllow: /\nDisallow: /api/\n"
      : "User-agent: *\nDisallow: /\n";
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
