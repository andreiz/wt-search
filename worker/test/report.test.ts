import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { seed } from "./seed";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOKEN = "tok-9f3c1d-secret-token";
const QUOTED = "Kremona is a violin city";

interface ReportRow {
  id: number;
  chunk_id: number | null;
  created_at: string;
  quoted_text: string | null;
  suggested_text: string | null;
  note: string | null;
  status: string;
}

// seed.ts's default corpus: chunks 101, 201 and 202 exist.
beforeAll(async () => {
  await seed(env.DB);
});

let fetchSpy: ReturnType<typeof mockSiteverify>;

/** Stand-in for Turnstile's siteverify; the Worker runs in this isolate, so the spy reaches it. */
function mockSiteverify(): ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(Response.json({ success: true })));
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM reports");
  fetchSpy = mockSiteverify();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(body: unknown, init: RequestInit = {}): Request {
  return new Request("https://example.com/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

/** A valid body, with fields overridden (or removed with `undefined`) per test. */
function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { chunk_id: 201, quoted_text: QUOTED, turnstile_token: TOKEN, ...overrides };
}

async function post(body: unknown): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await exports.default.fetch(request(body));
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function rows(): Promise<ReportRow[]> {
  return (await env.DB.prepare("SELECT * FROM reports ORDER BY id").all<ReportRow>()).results;
}

/**
 * What siteverify answers. A factory, not a Response: a body made in the test's context cannot
 * be read by the Worker's request ("Cannot perform I/O on behalf of a different request").
 */
function answerWith(make: () => Response): void {
  fetchSpy.mockImplementation(() => Promise.resolve(make()));
}

/** Counts the calls to siteverify. */
const siteverifyCalls = (): number => fetchSpy.mock.calls.length;

/** Wraps a real D1 and records every statement prepared, as in search-exact.test.ts. */
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
  } as unknown as D1Database;
  return { db, sql };
}

describe("a valid report", () => {
  it("stores one open row and answers {ok: true}", async () => {
    const before = Date.now();
    const { response, body } = await post(
      valid({ suggested_text: "Cremona is a violin city", note: "It is the Italian town" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body).toEqual({ ok: true });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      chunk_id: 201,
      quoted_text: QUOTED,
      suggested_text: "Cremona is a violin city",
      note: "It is the Italian town",
      status: "open",
    });
    const created = Date.parse(stored[0]?.created_at ?? "");
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(Date.now());
    expect(stored[0]?.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("stores NULL for optional fields that are omitted, null, empty or blank", async () => {
    await post(valid());
    await post(valid({ suggested_text: null, note: null }));
    await post(valid({ suggested_text: "", note: "" }));
    await post(valid({ suggested_text: "  \n ", note: "\t" }));
    const stored = await rows();
    expect(stored).toHaveLength(4);
    for (const row of stored) {
      expect(row.suggested_text).toBeNull();
      expect(row.note).toBeNull();
    }
  });

  it("stores trimmed values", async () => {
    await post(valid({ quoted_text: "  padded quote \n", suggested_text: " better ", note: "\n why " }));
    expect((await rows())[0]).toMatchObject({ quoted_text: "padded quote", suggested_text: "better", note: "why" });
  });

  it("stores text as given, quotes and markup included", async () => {
    const text = `O'Brien said "<b>hi</b>"; DROP TABLE reports; --`;
    await post(valid({ quoted_text: text }));
    expect((await rows())[0]?.quoted_text).toBe(text);
  });

  it("takes the longest values allowed", async () => {
    const { response } = await post(
      valid({ quoted_text: "q".repeat(500), suggested_text: "s".repeat(500), note: "n".repeat(1000) }),
    );
    expect(response.status).toBe(200);
  });

  it("ignores unknown fields", async () => {
    const { response } = await post(valid({ status: "resolved", id: 77, extra: true }));
    expect(response.status).toBe(200);
    expect((await rows())[0]).toMatchObject({ status: "open" });
    expect((await rows())[0]?.id).not.toBe(77);
  });
});

describe("Turnstile", () => {
  it("is asked with the secret and the token, and nothing else about the listener", async () => {
    await post(valid());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(SITEVERIFY);
    expect(init.method).toBe("POST");
    const form = init.body as URLSearchParams;
    expect(Object.fromEntries(form)).toEqual({ secret: "test-secret", response: TOKEN });
  });

  it("is asked before anything is written", async () => {
    let rowsWhenAsked = -1;
    fetchSpy.mockImplementation(async () => {
      rowsWhenAsked = (await rows()).length;
      return Response.json({ success: true });
    });
    await post(valid());
    expect(rowsWhenAsked).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it("answers 403 and stores nothing when the token is refused", async () => {
    answerWith(() => Response.json({ success: false, "error-codes": ["invalid-input-response"] }));
    const { response, body } = await post(valid());
    expect(response.status).toBe(403);
    expect(body.error).toBe("forbidden");
    expect(body.message).toMatch(/couldn't verify you're human, please try again/);
    expect(await rows()).toEqual([]);
  });

  it("answers 503, logged, when Turnstile says our own secret is wrong, not 403 for every listener", async () => {
    for (const code of ["invalid-input-secret", "missing-input-secret"]) {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      answerWith(() => Response.json({ success: false, "error-codes": [code] }));
      const { response, body } = await post(valid());
      expect(response.status, code).toBe(503);
      expect(body.error).toBe("unavailable");
      expect(consoleError).toHaveBeenCalledTimes(1);
      const line = String(consoleError.mock.calls[0]?.[0]);
      expect(line).toContain("turnstile_unavailable");
      expect(line).toContain(code);
      expect(line).not.toContain(TOKEN);
      consoleError.mockRestore();
    }
    expect(await rows()).toEqual([]);
  });

  it("refuses a body over a megabyte from its Content-Length, before reading it", async () => {
    const big = new Request("https://example.com/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(1024 * 1024) },
      body: JSON.stringify(valid({ note: "x".repeat(1024 * 1024) })),
    });
    const textSpy = vi.spyOn(Request.prototype, "text");
    const response = await worker.fetch(big, env as unknown as Env);
    expect(response.status).toBe(400);
    expect(textSpy).not.toHaveBeenCalled();
    expect(siteverifyCalls()).toBe(0);
  });

  it("answers 503 when siteverify's JSON has no boolean success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of [{}, { success: "true" }, { success: 1 }, null, [], "ok"]) {
      answerWith(() => Response.json(bad));
      const { response } = await post(valid());
      expect(response.status, JSON.stringify(bad)).toBe(503);
    }
    expect(await rows()).toEqual([]);
  });

  it("answers 503, with one log line and no row, when siteverify cannot be reached", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy.mockRejectedValue(new Error("connection reset"));
    const { response, body } = await post(valid({ suggested_text: "secret suggestion", note: "secret note" }));
    expect(response.status).toBe(503);
    expect(body.error).toBe("unavailable");
    expect(typeof body.message).toBe("string");
    expect(await rows()).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    const text = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(text)).toMatchObject({
      level: "error",
      event: "turnstile_unavailable",
      method: "POST",
      path: "/api/report",
    });
    for (const secret of [TOKEN, QUOTED, "secret suggestion", "secret note", "test-secret"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("answers 503, with one log line and no row, when siteverify answers 500", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    answerWith(() => new Response("upstream trouble", { status: 500 }));
    const { response, body } = await post(valid());
    expect(response.status).toBe(503);
    expect(body.error).toBe("unavailable");
    expect(await rows()).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    const text = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(text)).toMatchObject({ event: "turnstile_unavailable" });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(QUOTED);
  });

  it("answers 503 when siteverify does not answer JSON", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    answerWith(() => new Response("<html>oops</html>", { status: 200 }));
    const { response } = await post(valid());
    expect(response.status).toBe(503);
    expect(await rows()).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("is not asked when the body is invalid", async () => {
    const bodies: unknown[] = [
      "not json",
      "[]",
      "null",
      valid({ chunk_id: "201" }),
      valid({ quoted_text: undefined }),
      valid({ turnstile_token: undefined }),
      valid({ turnstile_token: "" }),
      valid({ note: "n".repeat(1001) }),
    ];
    for (const body of bodies) {
      const { response } = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(siteverifyCalls()).toBe(0);
  });

  it("is asked before the chunk is looked up", async () => {
    // An unknown chunk is only found after a good token: one call, then 400.
    const { response } = await post(valid({ chunk_id: 999_999 }));
    expect(response.status).toBe(400);
    expect(siteverifyCalls()).toBe(1);
  });
});

describe("validation", () => {
  const badRequest = async (body: unknown): Promise<Record<string, unknown>> => {
    const { response, body: json } = await post(body);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(json.error).toBe("bad_request");
    expect(typeof json.message).toBe("string");
    expect(String(json.message).length).toBeGreaterThan(0);
    expect(await rows()).toEqual([]);
    return json;
  };

  it("rejects a body that is not JSON, or not an object", async () => {
    for (const body of ["", "not json", "{", "[]", "[1]", "null", "42", '"text"', "true"]) {
      await badRequest(body);
    }
  });

  it("rejects a body over 16 KB, before parsing it", async () => {
    // Valid JSON (and a note over the limit anyway), so the size is what is being tested: the
    // second body is a good report padded with spaces to one character over 16 KB.
    await badRequest(valid({ note: "x".repeat(17 * 1024) }));
    const head = JSON.stringify(valid({ note: "" }));
    const pad = " ".repeat(16 * 1024 - head.length);
    await badRequest(head + pad + " ");
    expect(siteverifyCalls()).toBe(0);
    // Exactly 16 KB is accepted: the limit is on the whole body.
    const { response } = await post(head + pad);
    expect(response.status).toBe(200);
  });

  it("rejects a chunk_id that is not a positive integer", async () => {
    for (const chunk_id of [undefined, null, "201", 201.5, 0, -1, "", true, [201], { id: 201 }, 1e21, Number.MAX_SAFE_INTEGER + 2]) {
      await badRequest(valid({ chunk_id }));
    }
  });

  it("rejects a chunk that does not exist, storing nothing", async () => {
    const json = await badRequest(valid({ chunk_id: 424242 }));
    expect(String(json.message)).toMatch(/passage/i);
  });

  it("requires quoted_text: a non-empty string after trimming", async () => {
    for (const quoted_text of [undefined, null, "", "   \n", 42, ["a"], { a: 1 }]) {
      await badRequest(valid({ quoted_text }));
    }
  });

  it("limits quoted_text to 500 characters", async () => {
    await badRequest(valid({ quoted_text: "q".repeat(501) }));
    expect((await post(valid({ quoted_text: "q".repeat(500) }))).response.status).toBe(200);
  });

  it("measures the limit after trimming", async () => {
    const { response } = await post(valid({ quoted_text: ` ${"q".repeat(500)} ` }));
    expect(response.status).toBe(200);
  });

  it("limits suggested_text to 500 characters and requires a string", async () => {
    await badRequest(valid({ suggested_text: "s".repeat(501) }));
    await badRequest(valid({ suggested_text: 7 }));
    await badRequest(valid({ suggested_text: ["x"] }));
    expect((await post(valid({ suggested_text: "s".repeat(500) }))).response.status).toBe(200);
  });

  it("limits note to 1000 characters and requires a string", async () => {
    await badRequest(valid({ note: "n".repeat(1001) }));
    await badRequest(valid({ note: false }));
    expect((await post(valid({ note: "n".repeat(1000) }))).response.status).toBe(200);
  });

  it("counts an emoji as one character", async () => {
    // 1000 emoji are 2000 UTF-16 code units, but 1000 characters.
    const emoji = "\u{1F600}";
    await badRequest(valid({ note: emoji.repeat(1001) }));
    expect((await post(valid({ note: emoji.repeat(1000) }))).response.status).toBe(200);
    expect(await rows()).toHaveLength(1);
    expect(Array.from((await rows())[0]?.note ?? "")).toHaveLength(1000);
  });

  it("requires a turnstile_token: a non-empty string of at most 2048 characters", async () => {
    for (const turnstile_token of [undefined, null, "", 123, ["t"], "t".repeat(2049)]) {
      await badRequest(valid({ turnstile_token }));
    }
    expect(siteverifyCalls()).toBe(0);
    expect((await post(valid({ turnstile_token: "t".repeat(2048) }))).response.status).toBe(200);
  });

  it("gives a message that does not echo the report text", async () => {
    const json = await badRequest(valid({ quoted_text: "q".repeat(501), note: "private note text" }));
    expect(JSON.stringify(json)).not.toContain("private note text");
  });

  it("rejects text D1 cannot store, as bad_request and not as an outage", async () => {
    // A lone surrogate, built at run time: it never appears in a test name or a source literal.
    const lone = String.fromCharCode(0xd800);
    await badRequest(valid({ quoted_text: `bad${lone}text` }));
    expect(siteverifyCalls()).toBe(0);
  });
});

describe("routing", () => {
  it("answers 404 to GET /api/report", async () => {
    const response = await exports.default.fetch(new Request("https://example.com/api/report"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(siteverifyCalls()).toBe(0);
  });

  it("answers 404 to a PUT or DELETE of /api/report", async () => {
    for (const method of ["PUT", "DELETE"]) {
      const response = await exports.default.fetch(request(valid(), { method }));
      expect(response.status, method).toBe(404);
    }
    expect(await rows()).toEqual([]);
  });
});

describe("D1", () => {
  it("makes one statement, with the report text bound and not in the SQL", async () => {
    const { db, sql } = countingDb(env.DB);
    const response = await worker.fetch(request(valid({ note: "zzmarker note" })), {
      DB: db,
      TURNSTILE_SECRET: "test-secret",
    } as Env);
    expect(response.status).toBe(200);
    expect(sql).toHaveLength(1);
    expect(sql[0]).not.toMatch(/zzmarker|201|violin/);
    expect(sql[0]).toMatch(/^INSERT INTO reports/);
  });

  it("makes one statement for an unknown chunk, and none for an invalid body", async () => {
    const unknown = countingDb(env.DB);
    const first = await worker.fetch(request(valid({ chunk_id: 424242 })), {
      DB: unknown.db,
      TURNSTILE_SECRET: "test-secret",
    } as Env);
    expect(first.status).toBe(400);
    expect(unknown.sql).toHaveLength(1);

    const invalid = countingDb(env.DB);
    const second = await worker.fetch(request(valid({ quoted_text: "" })), {
      DB: invalid.db,
      TURNSTILE_SECRET: "test-secret",
    } as Env);
    expect(second.status).toBe(400);
    expect(invalid.sql).toEqual([]);
  });

  it("returns 503 unavailable, with one log line and no text in it, when D1 fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = {
      prepare() {
        throw new Error("D1_ERROR: network connection lost");
      },
    } as unknown as D1Database;
    const response = await worker.fetch(request(valid()), { DB: failingDb, TURNSTILE_SECRET: "test-secret" } as Env);
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("unavailable");
    expect(typeof body.message).toBe("string");
    expect(consoleError).toHaveBeenCalledTimes(1);
    const text = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(text)).toMatchObject({ event: "d1_unavailable", method: "POST", path: "/api/report" });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(QUOTED);
  });
});
