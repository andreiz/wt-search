// Workers Analytics Engine (spec §8.3): one data point per search and per report, kept about
// 3 months. The binding is optional and a failed write never fails a request.
//
// Column layout (what a SQL query over the dataset reads):
//   search: index1 "search"; blob1 query (≤ 200 characters), blob2 mode, blob3 sort,
//           blob4 cache (hit | miss | skip); double1 results, double2 latency ms,
//           double3 degraded (0/1), double4 page, double5 status.
//   report: index1 "report"; double1 status.

import type { Env } from "./env";

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
    blobs: [p.q, p.mode, p.sort, p.cache],
    doubles: [p.results, p.ms, p.degraded ? 1 : 0, p.page, p.status],
  });
}

export function recordReport(env: Env, status: number): void {
  write(env, { indexes: ["report"], blobs: [], doubles: [status] });
}
