import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetAnalyticsWarning } from "../src/analytics";
import { forgetCorpusVersion } from "../src/cache";
import type { Env } from "../src/env";
import worker from "../src/index";
import { seed } from "./seed";

// One log line per request and one Analytics Engine data point per search and per report
// (spec §8.3). No IP address, ever.

const IP = "203.0.113.77";

beforeAll(async () => {
  await seed(env.DB);
});

beforeEach(() => {
  forgetAnalyticsWarning();
  forgetCorpusVersion();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function analytics() {
  return { writeDataPoint: vi.fn((_point: AnalyticsEngineDataPoint) => {}) };
}

function bindings(overrides: Record<string, unknown> = {}): Env {
  return {
    DB: env.DB,
    AI: { run: async () => ({ shape: [1, 3], data: [[0.1, 0.2, 0.3]], pooling: "cls" }) },
    VEC: { query: async () => ({ count: 1, matches: [{ id: "202", score: 0.5 }] }) },
    TURNSTILE_SECRET: "test-secret",
    ...overrides,
  } as unknown as Env;
}

function call(path: string, e: Env, init: RequestInit = {}): Promise<Response> {
  const headers = { "cf-connecting-ip": IP, "x-forwarded-for": IP, "x-real-ip": IP, ...(init.headers ?? {}) };
  return worker.fetch(new Request(`https://example.com${path}`, { ...init, headers }), e);
}

/** The request log lines written during `run`, parsed. */
async function logLines(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await run();
  const lines = log.mock.calls.map((c) => String(c[0]));
  log.mockRestore();
  for (const line of lines) expect(line).not.toContain(IP);
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "request");
}

describe("the request log line", () => {
  it("is one line per search with the endpoint, query, mode, sort, latency, result count and flags", async () => {
    const lines = await logLines(() => call("/api/search?q=dovetails&sort=newest", bindings()));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      level: "info",
      event: "request",
      method: "GET",
      path: "/api/search",
      status: 200,
      ms: expect.any(Number),
      q: "dovetails",
      mode: "smart",
      sort: "newest",
      page: 1,
      results: 1,
      degraded: false,
      cache: "skip",
    });
  });

  it("cuts the query to 80 characters, by code point", async () => {
    const q = "🪚".repeat(90);
    const [line] = await logLines(() => call(`/api/search?q=${encodeURIComponent(q)}&mode=exact`, bindings()));
    expect(line?.q).toBe("🪚".repeat(80));
  });

  it("says when smart search was degraded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { run: async () => Promise.reject(new Error("InferenceUpstreamError")) };
    const [line] = await logLines(() => call("/api/search?q=glue", bindings({ AI: broken })));
    expect(line).toMatchObject({ status: 200, degraded: true, mode: "smart" });
  });

  it("says when the answer came from the cache, with its result count", async () => {
    const cached = bindings({ SEARCH_CACHE_TTL_S: "3600" });
    await logLines(() => call("/api/search?q=router", cached));
    const [line] = await logLines(() => call("/api/search?q=router", cached));
    expect(line).toMatchObject({ cache: "hit", results: 1, degraded: false });
  });

  it("is written for every route, without search fields, and for a 404", async () => {
    const lines = await logLines(async () => {
      await call("/api/health", bindings());
      await call("/api/context?chunk=201", bindings());
      await call("/nope", bindings());
    });
    expect(lines.map((l) => [l.path, l.status])).toEqual([
      ["/api/health", 200],
      ["/api/context", 200],
      ["/nope", 404],
    ]);
    for (const l of lines) expect(l).not.toHaveProperty("q");
  });

  it("is written for a 503 too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error("D1_ERROR")) }) }) };
    const [line] = await logLines(() => call("/api/search?q=glue&mode=smart", bindings({ DB: failing })));
    expect(line).toMatchObject({ path: "/api/search", status: 503, q: "glue" });
  });
});

describe("Analytics Engine", () => {
  it("gets one data point per search: query, mode, sort, cache; results, latency, degraded, page, status", async () => {
    const a = analytics();
    await logLines(() => call("/api/search?q=hide%20glue&mode=exact&sort=oldest", bindings({ ANALYTICS: a })));
    expect(a.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(a.writeDataPoint).toHaveBeenCalledWith({
      indexes: ["search"],
      blobs: ["hide glue", "exact", "oldest", "skip"],
      doubles: [1, expect.any(Number), 0, 1, 200],
    });
  });

  it("keeps the query up to 200 characters, the parser's own cut", async () => {
    const a = analytics();
    await logLines(() => call(`/api/search?q=${"x".repeat(250)}&mode=exact`, bindings({ ANALYTICS: a })));
    expect(a.writeDataPoint.mock.calls[0]?.[0].blobs?.[0]).toBe("x".repeat(200));
  });

  it("gets one data point per report, with its status", async () => {
    const a = analytics();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(Response.json({ success: true })));
    await logLines(() =>
      call("/api/report", bindings({ ANALYTICS: a }), {
        method: "POST",
        body: JSON.stringify({ chunk_id: 201, quoted_text: "hide glue", turnstile_token: "t" }),
      }),
    );
    await logLines(() => call("/api/report", bindings({ ANALYTICS: a }), { method: "POST", body: "not json" }));
    expect(a.writeDataPoint.mock.calls.map((c) => c[0])).toEqual([
      { indexes: ["report"], blobs: [], doubles: [200] },
      { indexes: ["report"], blobs: [], doubles: [400] },
    ]);
  });

  it("gets nothing for health, context or unknown routes", async () => {
    const a = analytics();
    await logLines(async () => {
      await call("/api/health", bindings({ ANALYTICS: a }));
      await call("/api/context?chunk=201", bindings({ ANALYTICS: a }));
      await call("/nope", bindings({ ANALYTICS: a }));
    });
    expect(a.writeDataPoint).not.toHaveBeenCalled();
  });

  it("is skipped without a binding, and a failing write never fails a search (logged once)", async () => {
    const lines = await logLines(() => call("/api/search?q=glue&mode=exact", bindings()));
    expect(lines[0]?.status).toBe(200);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = {
      writeDataPoint: () => {
        throw new Error("AnalyticsEngine: write failed");
      },
    };
    for (let i = 0; i < 3; i++) {
      const [line] = await logLines(() => call("/api/search?q=glue&mode=exact", bindings({ ANALYTICS: throwing })));
      expect(line?.status).toBe(200);
    }
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("analytics_unavailable");
  });
});
