// The API client (spec §4.4). Relative /api/... URLs only: the app holds no host. Every call
// returns a discriminated union and never throws for an HTTP status or a network failure; the
// one thing it throws is an AbortError, when the caller's signal aborted the request.
//
// Pure: no DOM, no Preact; it uses the global `fetch`.

import type {
  ContextResponse,
  ExactResponse,
  InfoResponse,
  SmartResponse,
  Sort,
} from "../../../worker/src/api-types";
import type { SearchState } from "./url";

/** A search answer. The Worker adds `mode` and `sort` to the body (index.ts), so `mode` tells the arms apart. */
export type SearchData =
  | (ExactResponse & { mode: "exact"; sort: Sort })
  | (SmartResponse & { mode: "smart"; sort: Sort });

export type { ContextResponse };

export type { InfoResponse };

/**
 * POST /api/report. The request body, which the Worker has no type for (its `ReportFields` is the
 * checked, stored shape, a different thing). A passage report has `chunk_id` and `quoted_text`; general feedback has
 * neither and must leave `quoted_text` and `suggested_text` out altogether (the Worker
 * refuses them even as null), so they are optional and sent exactly as given.
 */
export interface ReportBody {
  chunk_id?: number;
  quoted_text?: string;
  suggested_text?: string;
  note?: string;
  turnstile_token: string;
}

export type Failure =
  /** 503 `{error: "maintenance"}` (the kill switch). */
  | { kind: "maintenance"; message: string }
  /** 429. `retryAfterS` is the `retry-after` header in seconds (60 when missing or unusable). */
  | { kind: "rate_limited"; retryAfterS: number }
  /** Anything else the server answered that is not usable: other 5xx, a body that is not JSON. */
  | { kind: "unavailable" }
  /** `fetch` itself failed (offline, DNS, reset). */
  | { kind: "network" };

export type ApiResult<T> = { kind: "ok"; data: T } | Failure;

/** A report the Worker refused with a message to show the listener (400, 403, or 429). */
export type ReportResult =
  | ApiResult<{ ok: true }>
  | { kind: "refused"; status: number; message: string };

const DEFAULT_RETRY_AFTER_S = 60;
const MAINTENANCE_MESSAGE = "Search is down for maintenance. Please try again later.";

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return (
    (signal?.aborted ?? false) ||
    (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError")
  );
}

function abortError(err: unknown): unknown {
  if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError") return err;
  return new DOMException("The operation was aborted.", "AbortError");
}

function retryAfterS(response: Response): number {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d+$/.test(value.trim())) return DEFAULT_RETRY_AFTER_S;
  const seconds = Number(value.trim());
  return seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_S;
}

/** The JSON body as a record, or null when it is missing, not JSON, or not an object. */
function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One request. `refusable` lists statuses that, when their body has a string `message`, are a
 * `refused` answer (report only). The body is read at most once.
 */
async function call<T>(
  url: string,
  init: RequestInit,
  refusable: readonly number[] = [],
): Promise<ApiResult<T> | { kind: "refused"; status: number; message: string }> {
  const signal = init.signal ?? undefined;
  let response: Response;
  let body: unknown = undefined;
  let parsed = false;
  try {
    response = await fetch(url, init);
    try {
      body = await response.json();
      parsed = true;
    } catch (err) {
      if (isAbort(err, signal)) throw err;
    }
  } catch (err) {
    if (isAbort(err, signal)) throw abortError(err);
    return { kind: "network" };
  }

  const record = parsed ? recordOf(body) : null;
  const message = typeof record?.message === "string" ? record.message : null;

  if (response.status === 503) {
    return record?.error === "maintenance"
      ? { kind: "maintenance", message: message ?? MAINTENANCE_MESSAGE }
      : { kind: "unavailable" };
  }
  if (refusable.includes(response.status) && message !== null) {
    return { kind: "refused", status: response.status, message };
  }
  if (response.status === 429) return { kind: "rate_limited", retryAfterS: retryAfterS(response) };
  if (response.ok && record !== null) return { kind: "ok", data: body as T };
  return { kind: "unavailable" };
}

/** GET /api/search. Always sends q, mode, sort and page; the Worker treats them like the URL. */
export function search(params: SearchState, signal: AbortSignal): Promise<ApiResult<SearchData>> {
  const query = new URLSearchParams({
    q: params.q,
    mode: params.mode,
    sort: params.sort,
    page: String(params.page),
  });
  return call<SearchData>(`/api/search?${query}`, { signal }) as Promise<ApiResult<SearchData>>;
}

/** GET /api/context: the chunk and `radius` chunks either side of it. */
export function context(chunkId: number, radius: number, signal: AbortSignal): Promise<ApiResult<ContextResponse>> {
  const query = new URLSearchParams({ chunk: String(chunkId), radius: String(radius) });
  return call<ContextResponse>(`/api/context?${query}`, { signal }) as Promise<ApiResult<ContextResponse>>;
}

/** GET /api/info: the episode count, newest date and Turnstile site key. */
export function info(signal: AbortSignal): Promise<ApiResult<InfoResponse>> {
  return call<InfoResponse>("/api/info", { signal }) as Promise<ApiResult<InfoResponse>>;
}

/** POST /api/report. The body is sent exactly as given (no keys are added). */
export function report(body: ReportBody): Promise<ReportResult> {
  return call<{ ok: true }>(
    "/api/report",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    [400, 403, 429],
  );
}
