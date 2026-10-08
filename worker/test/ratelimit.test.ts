import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetCorpusVersion } from "../src/cache";
import type { Env } from "../src/env";
import worker from "../src/index";
import { forgetLimiterWarning } from "../src/ratelimit";
import { seed } from "./seed";

// Per-IP rate limits with the Workers rate-limiting binding (spec §4.8 item 1, plan 2 Task 18).

const IP = "198.51.100.23";
const ORIGIN = "http://localhost:5173";

beforeAll(async () => {
  await seed(env.DB);
});

beforeEach(() => {
  forgetCorpusVersion();
  forgetLimiterWarning();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A stand-in binding that allows `allowed` calls in total, recording each key. */
function limiter(allowed: number) {
  let calls = 0;
  return { limit: vi.fn(async (_options: { key: string }) => ({ success: ++calls <= allowed })) };
}

function bindings(overrides: Record<string, unknown> = {}): Env {
  return {
    DB: env.DB,
    TURNSTILE_SECRET: "test-secret",
    REPORT_ORIGINS: ORIGIN,
    ...overrides,
  } as unknown as Env;
}

function call(path: string, e: Env, init: RequestInit = {}, ip: string | null = IP): Promise<Response> {
  const headers = new Headers(init.headers);
  if (ip !== null) headers.set("cf-connecting-ip", ip);
  return worker.fetch(new Request(`https://example.com${path}`, { ...init, headers }), e);
}

const report = (e: Env) =>
  call("/api/report", e, {
    method: "POST",
    headers: { origin: ORIGIN },
    body: JSON.stringify({ chunk_id: 201, quoted_text: "hide glue", turnstile_token: "t" }),
  });

describe("reads", () => {
  it("answer 429 rate_limited with retry-after past the limit, keyed by the client IP", async () => {
    const read = limiter(2);
    const e = bindings({ RL_READ: read });
    expect((await call("/api/health", e)).status).toBe(200);
    expect((await call("/api/search?q=glue&mode=exact", e)).status).toBe(200);
    const over = await call("/api/context?chunk=201", e);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(read.limit.mock.calls.map((c) => c[0])).toEqual([{ key: IP }, { key: IP }, { key: IP }]);
  });

  it("count unknown /api paths and HEAD requests too", async () => {
    const read = limiter(0);
    const e = bindings({ RL_READ: read });
    expect((await call("/api/wp-admin", e)).status).toBe(429);
    expect((await call("/api/health", e, { method: "HEAD" })).status).toBe(429);
  });

  it("don't touch D1 once over the limit", async () => {
    const prepare = vi.fn();
    const e = bindings({ RL_READ: limiter(0), DB: { prepare } });
    expect((await call("/api/search?q=glue", e)).status).toBe(429);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("reports", () => {
  it("have their own limit: 429 with a message, and reads don't use it up", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(Response.json({ success: true })));
    await env.DB.exec("DELETE FROM reports");
    const read = limiter(100);
    const reportLimit = limiter(1);
    const e = bindings({ RL_READ: read, RL_REPORT: reportLimit });
    expect((await report(e)).status).toBe(200);
    const over = await report(e);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(await over.json()).toMatchObject({ error: "rate_limited", message: expect.any(String) });
    expect(read.limit).not.toHaveBeenCalled();
    expect((await call("/api/health", e)).status).toBe(200);
    expect(reportLimit.limit).toHaveBeenCalledTimes(2);
  });
});

describe("no limit", () => {
  it("without a binding (tests, local runs)", async () => {
    expect((await call("/api/health", bindings())).status).toBe(200);
  });

  it("without a client IP (not a request through Cloudflare)", async () => {
    const read = limiter(0);
    expect((await call("/api/health", bindings({ RL_READ: read }), {}, null)).status).toBe(200);
    expect(read.limit).not.toHaveBeenCalled();
  });

  it("for robots.txt", async () => {
    const read = limiter(0);
    expect((await call("/robots.txt", bindings({ RL_READ: read }))).status).toBe(200);
    expect(read.limit).not.toHaveBeenCalled();
  });

  it("when the binding throws: the request goes through, logged once per isolate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { limit: vi.fn(async () => Promise.reject(new Error("rate limiter unavailable"))) };
    const e = bindings({ RL_READ: broken });
    expect((await call("/api/health", e)).status).toBe(200);
    expect((await call("/api/health", e)).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ event: "rate_limiter_unavailable" });
  });
});

describe("the request log", () => {
  it("records the 429 and never the IP", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await call("/api/search?q=glue", bindings({ RL_READ: limiter(0) }));
    const lines = log.mock.calls.map((c) => String(c[0]));
    for (const line of lines) expect(line).not.toContain(IP);
    const request = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === "request");
    expect(request).toMatchObject({ path: "/api/search", status: 429 });
  });
});
