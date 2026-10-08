import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyBudget, DEFAULT_SMART_BUDGET, utcDay } from "../src/budget";
import { forgetCorpusVersion } from "../src/cache";
import type { Env } from "../src/env";
import worker from "../src/index";
import { seed } from "./seed";

// The daily smart-search budget and its ntfy alerts (spec §4.8 items 2 and 4, plan 2 Task 19).

const NTFY = "https://ntfy.example.net";
const TOPIC = "wts-alerts-7c1e";
const VECTOR = Array.from({ length: 768 }, (_, i) => (i % 3) / 3);

beforeAll(async () => {
  await seed(env.DB);
});

beforeEach(async () => {
  forgetCorpusVersion();
  await env.DB.exec("DELETE FROM usage");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function bindings(overrides: Record<string, unknown> = {}) {
  const ai = { run: vi.fn(async () => ({ shape: [1, VECTOR.length], data: [VECTOR], pooling: "cls" })) };
  const vec = { query: vi.fn(async () => ({ count: 1, matches: [{ id: "202", score: 0.5 }] })) };
  const e = {
    DB: env.DB,
    AI: ai,
    VEC: vec,
    TURNSTILE_SECRET: "test-secret",
    SEARCH_CACHE_TTL_S: "3600",
    NTFY_URL: NTFY,
    NTFY_TOPIC: TOPIC,
    ...overrides,
  } as unknown as Env;
  return { env: e, ai, vec };
}

/** Each query is new to the edge cache (unique words), so every smart search is uncached. */
let n = 0;
const fresh = (): string => `glue zzq${++n}`;

async function search(e: Env, params: string): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await worker.fetch(new Request(`https://example.com/api/search?${params}`), e);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function counted(): Promise<number> {
  const row = await env.DB.prepare("SELECT smart FROM usage WHERE day = ?").bind(utcDay()).first<{ smart: number }>();
  return row?.smart ?? 0;
}

/** Stand-in for the ntfy server; the Worker runs in this isolate, so the spy reaches it. */
function mockNtfy(answer: () => Response = () => Response.json({ id: "x" })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(answer()));
}

function posts(spy: ReturnType<typeof mockNtfy>): Record<string, unknown>[] {
  return spy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

describe("the counter", () => {
  it("counts uncached smart searches only: not exact mode, cache hits, the kill switch or empty queries", async () => {
    const b = bindings();
    const q = encodeURIComponent(fresh());
    await search(b.env, `q=${q}`); // counted
    await search(b.env, `q=${q}`); // a cache hit
    await search(b.env, `q=${encodeURIComponent(fresh())}&mode=exact`);
    await search(bindings({ SEARCH_OVERRIDE: "exact" }).env, `q=${encodeURIComponent(fresh())}`);
    await search(b.env, "q=");
    await search(b.env, `q=${encodeURIComponent(fresh())}&debug=1`); // debug asks AI too: counted
    expect(await counted()).toBe(2);
    expect(b.ai.run).toHaveBeenCalledTimes(2);
  });

  it("starts again on a new UTC day", async () => {
    await env.DB.prepare("INSERT INTO usage (day, smart) VALUES ('2026-01-01', 99999)").run();
    const b = bindings({ SMART_DAILY_BUDGET: "5" });
    const { body } = await search(b.env, `q=${encodeURIComponent(fresh())}`);
    expect(body).not.toHaveProperty("smart_degraded");
    expect(await counted()).toBe(1);
  });

  it("is a D1 error like any other: 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      prepare: (sql: string) =>
        sql.includes("usage") ? { bind: () => ({ first: () => Promise.reject(new Error("D1_ERROR")) }) } : env.DB.prepare(sql),
    };
    const b = bindings({ DB: failing, SEARCH_CACHE_TTL_S: undefined });
    const { response } = await search(b.env, `q=${encodeURIComponent(fresh())}`);
    expect(response.status).toBe(503);
    expect(b.ai.run).not.toHaveBeenCalled();
  });
});

describe("past the budget", () => {
  it("answers keyword-only with \"budget\", asks neither AI nor Vectorize, and isn't cached", async () => {
    mockNtfy();
    const b = bindings({ SMART_DAILY_BUDGET: "2" });
    for (let i = 0; i < 2; i++) {
      const { body } = await search(b.env, `q=${encodeURIComponent(fresh())}`);
      expect(body).not.toHaveProperty("smart_degraded");
    }
    const q = encodeURIComponent("hide glue");
    const { response, body } = await search(b.env, `q=${q}`);
    expect(body.smart_degraded).toBe("budget");
    expect((body.results as unknown[]).length).toBeGreaterThan(0);
    expect(response.headers.get("x-wts-cache")).toBe("skip");
    expect(b.ai.run).toHaveBeenCalledTimes(2);
    expect(b.vec.query).toHaveBeenCalledTimes(2);
    // Not stored: the same search asks again (and is counted again).
    await search(b.env, `q=${q}`);
    expect(await counted()).toBe(4);
  });

  it("leaves exact mode alone", async () => {
    mockNtfy();
    await env.DB.prepare("INSERT INTO usage (day, smart) VALUES (?, 99)").bind(utcDay()).run();
    const { body } = await search(bindings({ SMART_DAILY_BUDGET: "2" }).env, "q=glue&mode=exact");
    expect(body).not.toHaveProperty("smart_degraded");
    expect((body.results as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("alerts", () => {
  it("go to ntfy once a day each: at half the budget, then past it", async () => {
    const spy = mockNtfy();
    const b = bindings({ SMART_DAILY_BUDGET: "4", NTFY_TOKEN: "tk_secret" });
    for (let i = 0; i < 7; i++) await search(b.env, `q=${encodeURIComponent(fresh())}`);
    expect(spy).toHaveBeenCalledTimes(2);
    const [half, full] = posts(spy);
    expect(half).toMatchObject({ topic: TOPIC, priority: 3 });
    expect(String(half?.title)).toContain("50%");
    expect(String(half?.message)).toContain("2 of 4");
    expect(full).toMatchObject({ topic: TOPIC, priority: 4 });
    expect(String(full?.message)).toContain("5 of 4");
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${NTFY}/`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tk_secret");
    for (const p of posts(spy)) expect(JSON.stringify(p)).not.toContain("zzq");
  });

  it("name the environment in the title (WTS_ENV), so staging and production can't be confused", async () => {
    const spy = mockNtfy();
    await search(bindings({ SMART_DAILY_BUDGET: "2", WTS_ENV: "production" }).env, `q=${encodeURIComponent(fresh())}`);
    await env.DB.exec("DELETE FROM usage");
    await search(bindings({ SMART_DAILY_BUDGET: "2" }).env, `q=${encodeURIComponent(fresh())}`);
    const [named, unnamed] = posts(spy);
    expect(named?.title).toBe("wts production: smart search at 50% of today's budget");
    expect(unnamed?.title).toBe("wts: smart search at 50% of today's budget");
  });

  it("are sent once when two searches cross the threshold together", async () => {
    const spy = mockNtfy();
    const b = bindings({ SMART_DAILY_BUDGET: "2" });
    await Promise.all([search(b.env, `q=${encodeURIComponent(fresh())}`), search(b.env, `q=${encodeURIComponent(fresh())}`)]);
    expect(posts(spy).filter((p) => String(p.title).includes("50%"))).toHaveLength(1);
  });

  it("are only logged without a topic", async () => {
    const spy = mockNtfy();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = bindings({ SMART_DAILY_BUDGET: "2", NTFY_TOPIC: undefined });
    await search(b.env, `q=${encodeURIComponent(fresh())}`);
    expect(spy).not.toHaveBeenCalled();
    const line = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).find((l) => l.event === "budget_alert");
    expect(line).toMatchObject({ threshold: "half", smart: 1, budget: 2, sent: false });
  });

  it("never fail the search when ntfy fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("connection refused")));
    const b = bindings({ SMART_DAILY_BUDGET: "2" });
    const { response, body } = await search(b.env, `q=${encodeURIComponent(fresh())}`);
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("smart_degraded");
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("ntfy_failed"))).toBe(true);
    for (const c of warn.mock.calls) expect(String(c[0])).not.toContain(TOPIC);
  });

  it("are posted after the response when the runtime gives a context (waitUntil)", async () => {
    const spy = mockNtfy();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {} };
    const b = bindings({ SMART_DAILY_BUDGET: "2" });
    const response = await worker.fetch(
      new Request(`https://example.com/api/search?q=${encodeURIComponent(fresh())}`),
      b.env,
      ctx as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("D1 per uncached smart search", () => {
  it("stays a handful of statements (Free plan: 50 per invocation)", async () => {
    const sql: string[] = [];
    const db = {
      prepare(query: string) {
        sql.push(query);
        return env.DB.prepare(query);
      },
      batch: (s: D1PreparedStatement[]) => env.DB.batch(s),
    };
    mockNtfy();
    const b = bindings({ DB: db, SMART_DAILY_BUDGET: "1000" });
    await search(b.env, `q=${encodeURIComponent(fresh())}`);
    expect(sql.filter((s) => s.includes("usage"))).toHaveLength(1);
    expect(sql.length).toBeLessThanOrEqual(6);
  });
});

describe("dailyBudget", () => {
  it("is SMART_DAILY_BUDGET when a positive integer, else the default", () => {
    expect(DEFAULT_SMART_BUDGET).toBe(20_000);
    expect(dailyBudget({ SMART_DAILY_BUDGET: "500" })).toBe(500);
    for (const value of [undefined, "", "abc", "0", "-5", "1.5", "1e3"]) {
      expect(dailyBudget({ SMART_DAILY_BUDGET: value }), String(value)).toBe(20_000);
    }
  });
});
