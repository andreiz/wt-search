// Per-IP rate limits (spec §4.8 item 1) with the Workers rate-limiting binding: 60 reads and 3
// reports per minute per client IP, counted per Cloudflare location and approximate. The IP is
// only the counter's key: it is never logged or stored.

import type { Env } from "./env";
import { json } from "./http";

/** Both bindings count over 60 s windows (the binding's `period`, wrangler.jsonc). */
const RETRY_AFTER_S = "60";

let warned = false;

/** Forget that a failing binding was logged (tests; a new isolate starts afresh). */
export function forgetLimiterWarning(): void {
  warned = false;
}

/**
 * A 429 when this client is over its limit, else null. Only /api/* is limited: reports by
 * RL_REPORT, everything else (HEAD and unknown paths too) by RL_READ. No binding (tests, local
 * runs) or no client IP (not a request through Cloudflare) means no limit, and a binding that
 * throws lets the request through: the limiter is never a reason to fail a search.
 */
export async function rateLimited(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/")) return null;
  const ip = request.headers.get("cf-connecting-ip");
  const isReport = request.method === "POST" && path === "/api/report";
  const binding = isReport ? env.RL_REPORT : env.RL_READ;
  if (!ip || !binding) return null;
  let success: boolean;
  try {
    ({ success } = await binding.limit({ key: ip }));
  } catch (err) {
    if (!warned) {
      warned = true;
      const e = err instanceof Error ? err : new Error(String(err));
      console.warn(
        JSON.stringify({ level: "warn", event: "rate_limiter_unavailable", error: `${e.name}: ${e.message}`.slice(0, 200) }),
      );
    }
    return null;
  }
  if (success) return null;
  const body = isReport
    ? { error: "rate_limited", message: "Too many reports from here. Please wait a minute and try again." }
    : { error: "rate_limited" };
  const response = json(body, 429);
  response.headers.set("retry-after", RETRY_AFTER_S);
  return response;
}
