import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { seed } from "./seed";

const JSON_TYPE = "application/json; charset=utf-8";

async function setCorpusVersion(value: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('corpus_version', ?)")
    .bind(value)
    .run();
}

/** Call the handler directly with a replacement DB (the other bindings are not used by these routes). */
function fetchWithDb(db: unknown, request: Request): Promise<Response> {
  return worker.fetch(request, { DB: db } as Env);
}

/** A D1 stand-in that counts the statements run against the real test database. */
function countingDb(real: D1Database): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare(query: string) {
      sql.push(query);
      return real.prepare(query);
    },
    batch(statements: D1PreparedStatement[]) {
      sql.push("<batch>");
      return real.batch(statements);
    },
    exec(query: string) {
      sql.push(query);
      return real.exec(query);
    },
  } as unknown as D1Database;
  return { db, sql };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await setCorpusVersion("0");
});

describe("GET /api/health", () => {
  it("returns ok and corpus_version '0' on a fresh database", async () => {
    const response = await exports.default.fetch("https://example.com/api/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await response.json()).toEqual({ ok: true, corpus_version: "0" });
  });

  it("follows the meta table", async () => {
    await setCorpusVersion("42");
    const response = await exports.default.fetch("https://example.com/api/health");
    expect(await response.json()).toEqual({ ok: true, corpus_version: "42" });
  });

  it("makes exactly one D1 query", async () => {
    const { db, sql } = countingDb(env.DB);
    const response = await fetchWithDb(db, new Request("https://example.com/api/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, corpus_version: "0" });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/\bmeta\b/);
  });

  it("returns 503 unavailable when the D1 query fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          first: () => Promise.reject(new Error("D1_ERROR: database unavailable")),
        };
      },
    };
    const response = await fetchWithDb(failingDb, new Request("https://example.com/api/health"));
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("returns 500 internal, with one log line and no details, on an unexpected error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // A missing corpus_version row means the schema contract is broken: that is not "D1 down".
    await env.DB.prepare("DELETE FROM meta WHERE key = 'corpus_version'").run();

    const response = await exports.default.fetch("https://example.com/api/health?q=secret-query", {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "internal" });
    expect(text).not.toMatch(/corpus_version|Error|at /);

    expect(consoleError).toHaveBeenCalledTimes(1);
    const args = consoleError.mock.calls[0] ?? [];
    expect(args).toHaveLength(1);
    const line = String(args[0]);
    expect(line).not.toContain("\n");
    expect(line).toContain("/api/health");
    expect(line).not.toContain("203.0.113.9");
    expect(line).not.toContain("secret-query");
  });
});

describe("routing", () => {
  it("returns 404 not_found JSON for unknown routes", async () => {
    for (const path of ["/", "/api", "/api/nope", "/api/health/", "/nope"]) {
      const response = await exports.default.fetch(`https://example.com${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toBe(JSON_TYPE);
      expect(await response.json(), path).toEqual({ error: "not_found" });
    }
  });

  it("treats a known path with another method as not found", async () => {
    const response = await exports.default.fetch("https://example.com/api/health", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("answers HEAD like GET, with the same status and headers and no body (curl -I)", async () => {
    for (const path of ["/api/health", "/api/search?q=dovetails&mode=exact", "/api/context?chunk=3005", "/api/nope"]) {
      const get = await exports.default.fetch(`https://example.com${path}`);
      const head = await exports.default.fetch(`https://example.com${path}`, { method: "HEAD" });
      expect(head.status, path).toBe(get.status);
      expect(head.headers.get("content-type"), path).toBe(get.headers.get("content-type"));
      expect(await head.text(), path).toBe("");
    }
  });

  it("does not answer HEAD on a POST-only route", async () => {
    const response = await exports.default.fetch("https://example.com/api/report", { method: "HEAD" });
    expect(response.status).toBe(404);
  });
});

describe("test D1 (schema/*.sql applied by the migrations helper)", () => {
  beforeAll(async () => {
    await seed(env.DB);
  });

  it("has FTS5, and the insert trigger indexes chunks with porter stemming", async () => {
    // Seeded text is "gluing dovetails"; the query is the singular stem.
    const { results } = await env.DB.prepare(
      "select rowid from chunks_fts where chunks_fts match 'dovetail'",
    ).all<{ rowid: number }>();
    expect(results).toEqual([{ rowid: 201 }]);

    const none = await env.DB.prepare(
      "select rowid from chunks_fts where chunks_fts match 'banjo'",
    ).all();
    expect(none.results).toEqual([]);
  });

  it("keeps the index in step when a chunk is deleted", async () => {
    await env.DB.prepare("DELETE FROM chunks WHERE id = 202").run();
    const { results } = await env.DB.prepare(
      "select rowid from chunks_fts where chunks_fts match 'router'",
    ).all();
    expect(results).toEqual([]);
  });
});
