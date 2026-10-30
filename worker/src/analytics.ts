// Workers Analytics Engine (spec §8.3): one data point per search and per report, kept about
// 3 months. The binding is optional and a failed write never fails a request.
//
// Column layout (what a SQL query over the dataset reads):
//   search: index1 "search"; blob1 query (≤ 200 characters), blob2 mode, blob3 sort,
//           blob4 cache (hit | miss | skip), blob5 traffic; double1 results, double2 latency ms,
//           double3 degraded (0/1), double4 page, double5 status.
//   report: index1 "report"; blob1 traffic; double1 status.
// Points written before 2026-10-30 have no traffic blob (it reads as "").

import type { Env } from "./env";

/**
 * Who sent the request, so reports can leave out our own searches (spec §8.3). Only this class
 * is kept, never the headers it comes from: `pipeline` is the Mac's `wts` (its User-Agent),
 * `maintainer` a browser switched with `?me=1` (the frontend sends the header), else `web`.
 */
export type Traffic = "pipeline" | "maintainer" | "web";

const PIPELINE_AGENT = "WoodTalkSearchBot/";
const TRAFFIC_HEADER = "x-wts-traffic";

export function trafficOf(request: Request): Traffic {
  if ((request.headers.get("user-agent") ?? "").startsWith(PIPELINE_AGENT)) return "pipeline";
  if (request.headers.get(TRAFFIC_HEADER) === "maintainer") return "maintainer";
  return "web";
}

export interface SearchPoint {
  q: string;
  mode: string;
  sort: string;
  cache: string;
  results: number;
  ms: number;
  degraded: boolean;
  page: number;
  status: number;
  traffic: Traffic;
}

let warned = false;

/** Forget that a failed write was logged (tests; a new isolate starts without it). */
export function forgetAnalyticsWarning(): void {
  warned = false;
}

function write(env: Env, point: AnalyticsEngineDataPoint): void {
  if (!env.ANALYTICS) return;
  try {
    env.ANALYTICS.writeDataPoint(point);
  } catch (err) {
    // Logged once per isolate: a broken binding would otherwise log on every request.
    if (warned) return;
    warned = true;
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(JSON.stringify({ level: "error", event: "analytics_unavailable", error: `${e.name}: ${e.message}`.slice(0, 300) }));
  }
}

export function recordSearch(env: Env, p: SearchPoint): void {
  write(env, {
    indexes: ["search"],
    blobs: [p.q, p.mode, p.sort, p.cache, p.traffic],
    doubles: [p.results, p.ms, p.degraded ? 1 : 0, p.page, p.status],
  });
}

export function recordReport(env: Env, status: number, traffic: Traffic): void {
  write(env, { indexes: ["report"], blobs: [traffic], doubles: [status] });
}
