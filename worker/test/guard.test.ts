import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetCorpusVersion } from "../src/cache";
import type { Env } from "../src/env";
import { forgetOverrideWarning } from "../src/guard";
import worker from "../src/index";
import { seed } from "./seed";

// Spec §4.8 items 3, 5 and 6 (plan 2 Task 17): the kill switch, robots.txt, security headers
// and the report Origin check.

const ORIGIN = "http://localhost:5173";

beforeAll(async () => {
  await seed(env.DB);
});

beforeEach(() => {
  forgetCorpusVersion();
  forgetOverrideWarning();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const VECTOR = Array.from({ length: 768 }, (_, i) => (i % 5) / 5);

function bindings(overrides: Record<string, unknown> = {}) {
  const ai = { run: vi.fn(async () => ({ shape: [1, VECTOR.length], data: [VECTOR], pooling: "cls" })) };
  const vec = { query: vi.fn(async () => ({ count: 1, matches: [{ id: "202", score: 0.5 }] })) };
  const e = {
    DB: env.DB,
    AI: ai,
    VEC: vec,
    TURNSTILE_SECRET: "test-secret",
    REPORT_ORIGINS: ORIGIN,
    SEARCH_CACHE_TTL_S: "3600",
    ...overrides,
  } as unknown as Env;
  return { env: e, ai, vec };
}

function call(path: string, e: Env, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`https://example.com${path}`, init), e);
}

type Body = Record<string, unknown>;

describe("SEARCH_OVERRIDE", () => {
  it("exact: smart searches are keyword-only, say \"off\", call neither AI nor Vectorize, and aren't cached", async () => {
    const b = bindings({ SEARCH_OVERRIDE: "exact" });
    const response = await call("/api/search?q=dovetails&sort=newest", b.env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Body;
    expect(body.smart_degraded).toBe("off");
    expect((body.results as unknown[]).length).toBeGreaterThan(0);
    expect(b.ai.run).not.toHaveBeenCalled();
    expect(b.vec.query).not.toHaveBeenCalled();
    expect(response.headers.get("x-wts-cache")).toBe("skip");
  });

  it("exact: exact-mode searches are unchanged", async () => {
    const response = await call("/api/search?q=dovetails&mode=exact", bindings({ SEARCH_OVERRIDE: "exact" }).env);
    const body = (await response.json()) as Body;
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("smart_degraded");
  });

  it("maintenance: every /api/* route answers 503 maintenance, without touching D1", async () => {
    const prepare = vi.fn();
    const e = bindings({ SEARCH_OVERRIDE: "maintenance", DB: { prepare, batch: vi.fn() } }).env;
    for (const [path, init] of [
      ["/api/health", {}],
      ["/api/search?q=glue", {}],
      ["/api/context?chunk=201", {}],
      ["/api/report", { method: "POST", body: "{}", headers: { origin: ORIGIN } }],
      ["/api/nope", {}],
    ] as const) {
      const response = await call(path, e, init);
      expect(response.status, path).toBe(503);
      expect(await response.json(), path).toMatchObject({ error: "maintenance" });
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("maintenance: robots.txt is still served", async () => {
    const response = await call("/robots.txt", bindings({ SEARCH_OVERRIDE: "maintenance" }).env);
    expect(response.status).toBe(200);
  });

  it("an unknown value is normal, with one warning per isolate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = bindings({ SEARCH_OVERRIDE: "readonly" });
    await call("/api/search?q=dovetails+unknown+override", b.env);
    await call("/api/search?q=dovetails+unknown+override+again", b.env);
    expect(b.ai.run).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ event: "unknown_search_override" });
  });

  it("empty or unset is normal", async () => {
    for (const value of ["", undefined]) {
      const b = bindings({ SEARCH_OVERRIDE: value });
      const body = (await (await call(`/api/search?q=dovetails+empty+${String(value)}`, b.env)).json()) as Body;
      expect(body).not.toHaveProperty("smart_degraded");
      expect(b.ai.run).toHaveBeenCalledTimes(1);
    }
  });
});

describe("smart_degraded reasons", () => {
  it("is \"unavailable\" when Workers AI fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { run: vi.fn(async () => Promise.reject(new Error("InferenceUpstreamError"))) };
    const body = (await (await call("/api/search?q=dovetails+broken", bindings({ AI: broken }).env)).json()) as Body;
    expect(body.smart_degraded).toBe("unavailable");
  });
});

describe("robots.txt", () => {
  it("disallows everything on the API host", async () => {
    for (const method of ["GET", "HEAD"]) {
      const response = await call("/robots.txt", bindings().env, { method });
      expect(response.status, method).toBe(200);
      expect(response.headers.get("content-type"), method).toBe("text/plain; charset=utf-8");
      if (method === "GET") expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
    }
  });
});

describe("security headers", () => {
  it("are on every response, and no CORS header is", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = { prepare: () => ({ first: () => Promise.reject(new Error("D1_ERROR")) }) };
    // No corpus_version: /api/health throws, which the router answers with 500.
    const brokenDb = { prepare: () => ({ first: () => Promise.resolve(null) }) };
    const cases: [string, Env, RequestInit, number][] = [
      ["/api/health", bindings().env, {}, 200],
      ["/api/search?q=glue&mode=exact", bindings().env, {}, 200],
      ["/robots.txt", bindings().env, {}, 200],
      ["/nope", bindings().env, {}, 404],
      ["/api/report", bindings().env, { method: "POST", body: "{}" }, 403],
      ["/api/health", bindings({ DB: failingDb }).env, {}, 503],
      ["/api/health", bindings({ SEARCH_OVERRIDE: "maintenance" }).env, {}, 503],
      ["/api/health", bindings({ DB: brokenDb }).env, {}, 500],
    ];
    for (const [path, e, init, status] of cases) {
      const response = await call(path, e, { ...init, headers: { origin: "https://evil.example", ...(init.headers ?? {}) } });
      expect(response.status, path).toBe(status);
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(response.headers.get("access-control-allow-origin"), path).toBeNull();
    }
  });

  it("are on a cached search answer too", async () => {
    const b = bindings();
    await call("/api/search?q=dovetails+cached+headers", b.env);
    const hit = await call("/api/search?q=dovetails+cached+headers", b.env);
    expect(hit.headers.get("x-wts-cache")).toBe("hit");
    expect(hit.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("report Origin", () => {
  const body = JSON.stringify({ chunk_id: 201, quoted_text: "hide glue", turnstile_token: "tok" });

  function siteverify() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(Response.json({ success: true })));
  }

  it("refuses a missing or wrong Origin with 403, before Turnstile and D1", async () => {
    const fetchSpy = siteverify();
    const prepare = vi.fn();
    const e = bindings({ DB: { prepare } }).env;
    for (const origin of [undefined, "https://evil.example", "http://localhost:5174", `${ORIGIN}/`, "null"]) {
      const headers: Record<string, string> = origin === undefined ? {} : { origin };
      const response = await call("/api/report", e, { method: "POST", body, headers });
      expect(response.status, String(origin)).toBe(403);
      expect(await response.json(), String(origin)).toMatchObject({ error: "forbidden" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("accepts any origin on the list", async () => {
    siteverify();
    await env.DB.exec("DELETE FROM reports");
    const e = bindings({ REPORT_ORIGINS: `https://search.example, ${ORIGIN}` }).env;
    const response = await call("/api/report", e, { method: "POST", body, headers: { origin: ORIGIN } });
    expect(response.status).toBe(200);
  });

  it("refuses every report when REPORT_ORIGINS is unset or empty", async () => {
    siteverify();
    for (const value of [undefined, "", " , "]) {
      const e = bindings({ REPORT_ORIGINS: value }).env;
      const response = await call("/api/report", e, { method: "POST", body, headers: { origin: ORIGIN } });
      expect(response.status, String(value)).toBe(403);
    }
  });

  it("is checked by the test configuration too (vitest.config.ts allows the dev origin)", async () => {
    siteverify();
    const response = await exports.default.fetch("https://example.com/api/report", {
      method: "POST",
      body,
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });
});
