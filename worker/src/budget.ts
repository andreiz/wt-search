// The daily smart-search budget and its alerts (spec §4.8 items 2 and 4). Every uncached smart
// search costs a Workers AI embedding and a Vectorize query, so they are counted per UTC day in
// D1 (`usage`, schema/0002_usage.sql); past the budget, smart search runs keyword-only until
// midnight UTC. The maintainer's phone hears about it at half the budget and past it, once a
// day each.

import type { Env } from "./env";

export const DEFAULT_SMART_BUDGET = 20_000;
const DEFAULT_NTFY_URL = "https://ntfy.sh";

/** SMART_DAILY_BUDGET when it is a positive integer, else DEFAULT_SMART_BUDGET. */
export function dailyBudget(env: Pick<Env, "SMART_DAILY_BUDGET">): number {
  const value = env.SMART_DAILY_BUDGET;
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) return DEFAULT_SMART_BUDGET;
  return Number(value);
}

/** Today's (or `now`'s) UTC date, `usage.day`. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const COUNT = `INSERT INTO usage (day, smart) VALUES (?, 1)
ON CONFLICT (day) DO UPDATE SET smart = smart + 1
RETURNING smart, alerted_half, alerted_full`;

// One statement per threshold: whichever request flips the flag sends the alert, so two
// searches crossing the threshold together send it once. Fixed text, never built from input.
const CLAIM = {
  half: "UPDATE usage SET alerted_half = 1 WHERE day = ? AND alerted_half = 0",
  full: "UPDATE usage SET alerted_full = 1 WHERE day = ? AND alerted_full = 0",
} as const;

type Threshold = keyof typeof CLAIM;

/**
 * Count one uncached smart search. Returns whether it is over the budget, and the alert to post
 * (after the response), if this search is the one that crossed a threshold today. D1 errors
 * propagate: the route answers 503, as for any other D1 failure.
 */
export async function countSmartSearch(
  env: Env,
  now: Date = new Date(),
): Promise<{ over: boolean; alert: (() => Promise<void>) | null }> {
  const budget = dailyBudget(env);
  const day = utcDay(now);
  const row = await env.DB.prepare(COUNT)
    .bind(day)
    .first<{ smart: number; alerted_half: number; alerted_full: number }>();
  const smart = row?.smart ?? 1;
  let threshold: Threshold | null = null;
  if (smart > budget && !row?.alerted_full) threshold = "full";
  else if (smart >= Math.ceil(budget / 2) && smart <= budget && !row?.alerted_half) threshold = "half";
  let alert: (() => Promise<void>) | null = null;
  if (threshold !== null) {
    const claimed = await env.DB.prepare(CLAIM[threshold]).bind(day).run();
    if (claimed.meta.changes === 1) {
      const t = threshold;
      alert = () => sendAlert(env, t, smart, budget);
    }
  }
  return { over: smart > budget, alert };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Post one budget alert to ntfy (JSON publishing, as the pipeline's notify.py). Never throws. */
async function sendAlert(env: Env, threshold: Threshold, smart: number, budget: number): Promise<void> {
  const sent = Boolean(env.NTFY_TOPIC);
  console.warn(JSON.stringify({ level: "warn", event: "budget_alert", threshold, smart, budget, sent }));
  if (!env.NTFY_TOPIC) return;
  const message =
    threshold === "half"
      ? `${fmt(smart)} of ${fmt(budget)} smart searches used today (UTC). Past the budget, ` +
        "smart search runs keyword-only until midnight UTC."
      : `${fmt(smart)} of ${fmt(budget)} smart searches today (UTC): smart search is keyword-only ` +
        "until midnight UTC. If this is a bot, SEARCH_OVERRIDE=exact turns smart search off.";
  const payload = {
    topic: env.NTFY_TOPIC,
    title: threshold === "half" ? "wts: smart search at 50% of today's budget" : "wts: smart search budget used up",
    message,
    priority: threshold === "half" ? 3 : 4,
    tags: [threshold === "half" ? "hourglass" : "warning"],
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.NTFY_TOKEN) headers.authorization = `Bearer ${env.NTFY_TOKEN}`;
  // The topic and token stay in the body and headers, never in the URL or a log line.
  const url = `${(env.NTFY_URL ?? DEFAULT_NTFY_URL).replace(/\/+$/, "")}/`;
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.warn(JSON.stringify({ level: "warn", event: "ntfy_failed", threshold, error: `${e.name}: ${e.message}`.slice(0, 200) }));
  }
}
