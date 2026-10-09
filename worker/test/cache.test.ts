import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetCorpusVersion, VERSION_TTL_MS } from "../src/cache";
import type { Env } from "../src/env";
import worker from "../src/index";
import { MAX_QUERY_CHARS, parseQuery } from "../src/query";
import { seed } from "./seed";

// The edge cache for /api/search (spec §4.7): keyed by the normalized query, mode, sort, page,
// limit and corpus_version, for SEARCH_CACHE_TTL_S. Each test uses its own query words, since
// the Cache API keeps entries for the whole file.

beforeAll(async () => {
  await seed(env.DB);
});

beforeEach(() => {
  forgetCorpusVersion();
});

afterEach(() => {
  vi.restoreAllMocks();
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
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  return { db, sql };
}

const VECTOR = [0.1, 0.2, 0.3];

function bindings(overrides: Partial<Record<keyof Env, unknown>> = {}) {
  const { db, sql } = countingDb();
  const ai = { run: vi.fn(async () => ({ shape: [1, 3], data: [VECTOR], pooling: "cls" })) };
  const vec = { query: vi.fn(async () => ({ count: 1, matches: [{ id: "202", score: 0.5 }] })) };
  const e = { DB: db, AI: ai, VEC: vec, SEARCH_CACHE_TTL_S: "3600", ...overrides } as unknown as Env;
  return { env: e, sql, ai, vec };
}

async function get(params: string, e: Env): Promise<Response> {
  return worker.fetch(new Request(`https://example.com/api/search?${params}`), e);
}

describe("search cache", () => {
  it("answers a repeated search from the cache, without D1, Workers AI or Vectorize", async () => {
    const first = bindings();
    const miss = await get("q=dovetails", first.env);
    expect(miss.headers.get("x-wts-cache")).toBe("miss");
    const missBody = await miss.json();

    const second = bindings();
    const hit = await get("q=dovetails", second.env);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-wts-cache")).toBe("hit");
    expect(hit.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await hit.json()).toEqual(missBody);
    // corpus_version was read a moment ago (first request), so nothing at all.
    expect(second.sql).toEqual([]);
    expect(second.ai.run).not.toHaveBeenCalled();
    expect(second.vec.query).not.toHaveBeenCalled();
  });

  it("caches exact searches too", async () => {
    expect((await get("q=router&mode=exact", bindings().env)).headers.get("x-wts-cache")).toBe("miss");
    expect((await get("q=router&mode=exact", bindings().env)).headers.get("x-wts-cache")).toBe("hit");
  });

  it("keys on the normalized query and the parameters as the Worker reads them", async () => {
    await get("q=gluing&page=1&limit=20&sort=relevance&mode=smart", bindings().env);
    for (const same of ["q=%20gluing%20%20&page=abc", "q=gluing&sort=RELEVANCE&limit=99", "q=gluing&mode=bogus"]) {
      expect((await get(same, bindings().env)).headers.get("x-wts-cache"), same).toBe("hit");
    }
    for (const other of ["q=Gluing", "q=gluing&mode=exact", "q=gluing&sort=newest", "q=gluing&page=2", "q=gluing&limit=5"]) {
      expect((await get(other, bindings().env)).headers.get("x-wts-cache"), other).toBe("miss");
    }
  });

  // The parser reads only the first MAX_QUERY_CHARS code points (review #3), so the key must too.
  describe("the parser's 200-code-point cut", () => {
    const blank = " ".repeat(MAX_QUERY_CHARS);
    const resultCount = async (res: Response): Promise<number> => ((await res.json()) as { results: unknown[] }).results.length;

    it("an empty-parsing query cached first doesn't answer the one that follows", async () => {
      const empty = await get(`q=${encodeURIComponent(`${blank}glue`)}`, bindings().env);
      expect(empty.headers.get("x-wts-cache")).toBe("miss");
      expect(await resultCount(empty)).toBe(0);
      const real = await get("q=glue", bindings().env);
      expect(real.headers.get("x-wts-cache")).toBe("miss");
      expect(await resultCount(real)).toBeGreaterThan(0);
    });

    it("and the other way round", async () => {
      // Exact mode: the test above already cached the smart search for the empty query.
      const real = await get("q=woodworking&mode=exact", bindings().env);
      expect(real.headers.get("x-wts-cache")).toBe("miss");
      expect(await resultCount(real)).toBeGreaterThan(0);
      const empty = await get(`q=${encodeURIComponent(`${blank}woodworking`)}&mode=exact`, bindings().env);
      expect(empty.headers.get("x-wts-cache")).toBe("miss");
      expect(await resultCount(empty)).toBe(0);
    });

    it("a query cut at exactly 200 code points shares its entry with the longer one", async () => {
      const cut = `show${" ".repeat(MAX_QUERY_CHARS - 4)}`;
      expect(Array.from(cut)).toHaveLength(MAX_QUERY_CHARS);
      const first = await get(`q=${encodeURIComponent(cut)}`, bindings().env);
      expect(first.headers.get("x-wts-cache")).toBe("miss");
      const longer = await get(`q=${encodeURIComponent(`${cut}ignored words`)}`, bindings().env);
      expect(longer.headers.get("x-wts-cache")).toBe("hit");
      expect(await longer.json()).toEqual(await first.json());
    });

    it("counts code points, not UTF-16 units", async () => {
      // 199 two-unit emoji fill the 200 code points with 1 left: "x" is in, the next is cut.
      const emoji = "\u{1F600}".repeat(MAX_QUERY_CHARS - 1);
      const first = await get(`q=${encodeURIComponent(`${emoji}x`)}`, bindings().env);
      expect(first.headers.get("x-wts-cache")).toBe("miss");
      expect((await get(`q=${encodeURIComponent(`${emoji}xyz`)}`, bindings().env)).headers.get("x-wts-cache")).toBe("hit");
      expect((await get(`q=${encodeURIComponent(`${emoji}y`)}`, bindings().env)).headers.get("x-wts-cache")).toBe("miss");
    });
  });

  describe("whitespace in the key", () => {
    it("is exactly what the parser splits words on, so the key merges nothing the parser tells apart", () => {
      const spaced = parseQuery("a b");
      for (let code = 0; code <= 0xffff; code++) {
        const ch = String.fromCharCode(code);
        if (!/\s/.test(ch)) continue;
        expect(parseQuery(`a${ch}b`), code.toString(16)).toEqual(spaced);
      }
    });

    it("NBSP, U+2028 and a BOM share an entry with the plain space, which parses the same", async () => {
      const first = await get(`q=${encodeURIComponent("router tables")}`, bindings().env);
      expect(first.headers.get("x-wts-cache")).toBe("miss");
      for (const sep of [" ", " ", "﻿", "   "]) {
        const res = await get(`q=${encodeURIComponent(`router${sep}tables`)}`, bindings().env);
        expect(res.headers.get("x-wts-cache"), JSON.stringify(sep)).toBe("hit");
      }
    });

    it("characters the scanner keeps inside a word don't share an entry with the space", async () => {
      // U+200B is not `\s`: it stays in the word, so "dust​collection" is one other word.
      await get(`q=${encodeURIComponent("dust collection")}`, bindings().env);
      const res = await get(`q=${encodeURIComponent("dust​collection")}`, bindings().env);
      expect(res.headers.get("x-wts-cache")).toBe("miss");
    });
  });

  it("misses after corpus_version changes", async () => {
    await get("q=tangent", bindings().env);
    await env.DB.prepare("UPDATE meta SET value = 'v-next' WHERE key = 'corpus_version'").run();
    try {
      forgetCorpusVersion();
      expect((await get("q=tangent", bindings().env)).headers.get("x-wts-cache")).toBe("miss");
      expect((await get("q=tangent", bindings().env)).headers.get("x-wts-cache")).toBe("hit");
    } finally {
      await env.DB.prepare("UPDATE meta SET value = '0' WHERE key = 'corpus_version'").run();
    }
  });

  it("reads corpus_version from D1 at most once a minute", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const a = bindings();
    await get("q=welcome", a.env);
    expect(a.sql.filter((s) => s.includes("corpus_version"))).toHaveLength(1);
    const b = bindings();
    await get("q=everybody", b.env);
    expect(b.sql.filter((s) => s.includes("corpus_version"))).toHaveLength(0);
    now.mockReturnValue(1_000_000 + VERSION_TTL_MS);
    const c = bindings();
    await get("q=everybody", c.env);
    expect(c.sql.filter((s) => s.includes("corpus_version"))).toHaveLength(1);
  });

  it("doesn't store degraded answers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { run: vi.fn(async () => Promise.reject(new Error("InferenceUpstreamError"))) };
    const first = await get("q=collection", bindings({ AI: broken }).env);
    expect(((await first.json()) as { smart_degraded?: string }).smart_degraded).toBe("unavailable");
    expect(first.headers.get("x-wts-cache")).toBe("skip");
    const healthy = bindings();
    const second = await get("q=collection", healthy.env);
    expect(second.headers.get("x-wts-cache")).toBe("miss");
    expect(healthy.ai.run).toHaveBeenCalledTimes(1);
  });

  it("doesn't store or serve debug answers", async () => {
    expect((await get("q=hide&debug=1", bindings().env)).headers.get("x-wts-cache")).toBe("skip");
    expect((await get("q=hide", bindings().env)).headers.get("x-wts-cache")).toBe("miss");
    const dbg = await get("q=hide&debug=1", bindings().env);
    expect(dbg.headers.get("x-wts-cache")).toBe("skip");
    expect(await dbg.json()).toHaveProperty("debug");
  });

  it("doesn't store a 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      prepare(query: string) {
        // corpus_version still reads; the search itself fails.
        if (query.includes("corpus_version")) return env.DB.prepare(query);
        return { bind: () => ({ all: () => Promise.reject(new Error("D1_ERROR")) }) };
      },
      batch: () => Promise.reject(new Error("D1_ERROR")),
    };
    expect((await get("q=arguing", bindings({ DB: failing }).env)).status).toBe(503);
    expect((await get("q=arguing", bindings().env)).headers.get("x-wts-cache")).toBe("miss");
  });

  it("is off without SEARCH_CACHE_TTL_S, or with a bad value", async () => {
    for (const ttl of [undefined, "", "0", "abc", "-5"]) {
      const e = bindings({ SEARCH_CACHE_TTL_S: ttl }).env;
      const res = await get("q=tables", e);
      expect(res.headers.get("x-wts-cache"), String(ttl)).toBe("skip");
    }
    expect((await get("q=tables", bindings().env)).headers.get("x-wts-cache")).toBe("miss");
  });

  it("doesn't tell browsers to cache for the hour", async () => {
    await get("q=dust", bindings().env);
    const hit = await get("q=dust", bindings().env);
    expect(hit.headers.get("x-wts-cache")).toBe("hit");
    expect(hit.headers.get("cache-control")).toBeNull();
  });
});
