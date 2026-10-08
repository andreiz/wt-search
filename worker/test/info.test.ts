import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetCorpusVersion } from "../src/cache";
import type { Env } from "../src/env";
import worker from "../src/index";
import { seed } from "./seed";

// GET /api/info (spec §4.4): what the web app needs on load, edge-cached like a search (§4.7).

const JSON_TYPE = "application/json; charset=utf-8";

beforeAll(async () => {
  await seed(env.DB);
});

beforeEach(() => {
  forgetCorpusVersion();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('corpus_version', '0')").run();
});

/** Counts the SQL the Worker prepares, then runs it on the test database. */
function countingDb(): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare(query: string) {
      sql.push(query);
      return env.DB.prepare(query);
    },
    batch(statements: D1PreparedStatement[]) {
      sql.push("<batch>");
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  return { db, sql };
}

function bindings(overrides: Partial<Record<keyof Env, unknown>> = {}) {
  const { db, sql } = countingDb();
  const e = { DB: db, TURNSTILE_SITE_KEY: "site-key-1", ...overrides } as unknown as Env;
  return { env: e, sql };
}

function get(e: Env, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request("https://example.com/api/info", init), e);
}

describe("GET /api/info", () => {
  it("answers the episode count, the newest episode's date, corpus_version and the site key", async () => {
    await env.DB.prepare("UPDATE meta SET value = 'v7' WHERE key = 'corpus_version'").run();
    const res = await get(bindings().env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await res.json()).toEqual({
      episodes: 2,
      latest_episode_date: "2019-06-15",
      corpus_version: "v7",
      turnstile_site_key: "site-key-1",
    });
  });

  it("uses the newest published_at, not the highest id", async () => {
    await env.DB.prepare(
      `INSERT INTO episodes (id, guid, number, title, published_at, year, duration_s)
       VALUES (90, 'guid-old', 0, 'Old', '2010-01-02T00:00:00Z', 2010, 60)`,
    ).run();
    try {
      const body = (await (await get(bindings().env)).json()) as { episodes: number; latest_episode_date: string };
      expect(body.episodes).toBe(3);
      expect(body.latest_episode_date).toBe("2019-06-15");
    } finally {
      await env.DB.prepare("DELETE FROM episodes WHERE id = 90").run();
    }
  });

  it("has a null latest_episode_date and zero episodes on an empty corpus", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM episodes"),
    ]);
    try {
      const res = await get(bindings().env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        episodes: 0,
        latest_episode_date: null,
        corpus_version: "0",
        turnstile_site_key: "site-key-1",
      });
    } finally {
      await seed(env.DB);
    }
  });

  it("makes exactly one D1 statement (no cache TTL: nothing else reads corpus_version)", async () => {
    const b = bindings();
    const res = await get(b.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-wts-cache")).toBe("skip");
    expect(b.sql).toHaveLength(1);
    expect(b.sql[0]).toMatch(/\bepisodes\b/);
    expect(b.sql[0]).toMatch(/\bmeta\b/);
  });

  it("has a null turnstile_site_key when the var is unset or empty", async () => {
    for (const key of [undefined, ""]) {
      const body = (await (await get(bindings({ TURNSTILE_SITE_KEY: key }).env)).json()) as {
        turnstile_site_key: unknown;
      };
      expect(body.turnstile_site_key, String(key)).toBeNull();
    }
  });

  it("returns 503 unavailable when D1 fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      prepare: () => ({ first: () => Promise.reject(new Error("D1_ERROR: database unavailable")) }),
    };
    const res = await get(bindings({ DB: failing }).env);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("returns 503 unavailable when D1 fails while the cache reads corpus_version", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      prepare: () => ({ first: () => Promise.reject(new Error("D1_ERROR: database unavailable")) }),
    };
    const res = await get(bindings({ DB: failing, SEARCH_CACHE_TTL_S: "3600" }).env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("returns 500 internal when meta.corpus_version is missing, like /api/health", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare("DELETE FROM meta WHERE key = 'corpus_version'").run();
    const res = await get(bindings().env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("answers HEAD like GET, with no body", async () => {
    // Through the runtime, which is what drops the body (calling the handler directly doesn't).
    const getRes = await exports.default.fetch("https://example.com/api/info");
    const res = await exports.default.fetch("https://example.com/api/info", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(JSON_TYPE);
    expect(res.headers.get("content-type")).toBe(getRes.headers.get("content-type"));
    expect(await res.text()).toBe("");
  });

  it("is not found for other methods", async () => {
    expect((await get(bindings().env, { method: "POST" })).status).toBe(404);
  });

  it("carries the security headers", async () => {
    const res = await get(bindings().env);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("is subject to the maintenance kill switch", async () => {
    const b = bindings({ SEARCH_OVERRIDE: "maintenance" });
    const res = await get(b.env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("maintenance");
    expect(b.sql).toEqual([]);
  });
});

describe("info cache", () => {
  it("answers a repeat from the cache without touching D1", async () => {
    const first = bindings({ SEARCH_CACHE_TTL_S: "3600" });
    const miss = await get(first.env);
    expect(miss.headers.get("x-wts-cache")).toBe("miss");
    const missBody = await miss.json();

    const second = bindings({ SEARCH_CACHE_TTL_S: "3600" });
    const hit = await get(second.env);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-wts-cache")).toBe("hit");
    expect(hit.headers.get("content-type")).toBe(JSON_TYPE);
    expect(hit.headers.get("cache-control")).toBeNull();
    expect(await hit.json()).toEqual(missBody);
    // corpus_version was read a moment ago (first request), so nothing at all.
    expect(second.sql).toEqual([]);
  });

  it("misses after corpus_version changes", async () => {
    await get(bindings({ SEARCH_CACHE_TTL_S: "3600" }).env);
    await env.DB.prepare("UPDATE meta SET value = 'v-info-next' WHERE key = 'corpus_version'").run();
    forgetCorpusVersion();
    const miss = await get(bindings({ SEARCH_CACHE_TTL_S: "3600" }).env);
    expect(miss.headers.get("x-wts-cache")).toBe("miss");
    expect(((await miss.json()) as { corpus_version: string }).corpus_version).toBe("v-info-next");
    expect((await get(bindings({ SEARCH_CACHE_TTL_S: "3600" }).env)).headers.get("x-wts-cache")).toBe("hit");
  });

  it("is off without SEARCH_CACHE_TTL_S, or with a bad value", async () => {
    for (const ttl of [undefined, "", "0", "abc", "-5"]) {
      const res = await get(bindings({ SEARCH_CACHE_TTL_S: ttl }).env);
      expect(res.headers.get("x-wts-cache"), String(ttl)).toBe("skip");
    }
  });

  it("doesn't store a 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      prepare(query: string) {
        // corpus_version still reads; the info statement fails.
        if (query.trim().startsWith("SELECT value FROM meta")) return env.DB.prepare(query);
        return { first: () => Promise.reject(new Error("D1_ERROR")) };
      },
    };
    await env.DB.prepare("UPDATE meta SET value = 'v-info-503' WHERE key = 'corpus_version'").run();
    expect((await get(bindings({ DB: failing, SEARCH_CACHE_TTL_S: "3600" }).env)).status).toBe(503);
    expect((await get(bindings({ SEARCH_CACHE_TTL_S: "3600" }).env)).headers.get("x-wts-cache")).toBe("miss");
  });

  it("doesn't share entries with searches", async () => {
    await get(bindings({ SEARCH_CACHE_TTL_S: "3600" }).env);
    const search = await worker.fetch(
      new Request("https://example.com/api/search?q=info&mode=exact"),
      bindings({ SEARCH_CACHE_TTL_S: "3600" }).env,
    );
    expect(search.headers.get("x-wts-cache")).toBe("miss");
    expect(search.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await search.json()).toHaveProperty("results");
  });
});
