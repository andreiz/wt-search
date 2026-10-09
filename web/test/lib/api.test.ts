// The API client (spec §4.4): every status the Worker can answer, the real response shapes,
// aborts and network failures. `fetch` is stubbed; nothing here touches a network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context, info, report, search, type ReportBody, type SearchData } from "../../src/lib/api";
import type { SearchState } from "../../src/lib/url";
import emptyFixture from "../../../pipeline/tests/fixtures/search/empty.json";
import exactFixture from "../../../pipeline/tests/fixtures/search/exact.json";
import truncatedFixture from "../../../pipeline/tests/fixtures/search/exact_truncated.json";
import smartFixture from "../../../pipeline/tests/fixtures/search/smart.json";
import debugFixture from "../../../pipeline/tests/fixtures/search/smart_debug.json";
import degradedFixture from "../../../pipeline/tests/fixtures/search/smart_degraded.json";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  fetchMock.mockResolvedValueOnce(new Response(text, { status, headers }));
}

const SMART: SearchState = { q: "hide glue", mode: "smart", sort: "relevance", page: 1 };
const FEEDBACK: ReportBody = { note: "Great site", turnstile_token: "tok" };
const PASSAGE: ReportBody = {
  chunk_id: 59031,
  quoted_text: "Kremona",
  suggested_text: "Cremona",
  note: "name",
  turnstile_token: "tok",
};

/** The URL and init of the one fetch call so far. */
function call(): { url: URL; init: RequestInit } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init] = fetchMock.mock.calls[0] ?? [];
  return { url: new URL(String(input), "https://example.test"), init: init ?? {} };
}

describe("requests", () => {
  it("search calls a relative /api/search with q, mode, sort and page", async () => {
    answer(200, emptyFixture);
    await search({ q: "a & b+c", mode: "exact", sort: "newest", page: 2 }, new AbortController().signal);
    const [input] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).startsWith("/api/search?")).toBe(true);
    const { url, init } = call();
    expect(url.searchParams.get("q")).toBe("a & b+c");
    expect(url.searchParams.get("mode")).toBe("exact");
    expect(url.searchParams.get("sort")).toBe("newest");
    expect(url.searchParams.get("page")).toBe("2");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("context calls /api/context with chunk and radius", async () => {
    answer(200, { chunk_id: 5, episode: {}, chunks: [] });
    await context(59031, 3, new AbortController().signal);
    const [input] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).startsWith("/api/context?")).toBe(true);
    const { url } = call();
    expect(url.searchParams.get("chunk")).toBe("59031");
    expect(url.searchParams.get("radius")).toBe("3");
  });

  it("info calls /api/info", async () => {
    answer(200, { episodes: 1, latest_episode_date: null, corpus_version: "v", turnstile_site_key: null });
    await info(new AbortController().signal);
    const [input] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe("/api/info");
  });

  it("report POSTs JSON to /api/report exactly as given", async () => {
    answer(200, { ok: true });
    await report(FEEDBACK);
    const [input] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe("/api/report");
    const { init } = call();
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    // Feedback must not carry quoted_text / suggested_text at all, not even null.
    expect(init.body).toBe(JSON.stringify(FEEDBACK));
    expect(JSON.parse(String(init.body))).not.toHaveProperty("quoted_text");
    expect(JSON.parse(String(init.body))).not.toHaveProperty("suggested_text");
    expect(JSON.parse(String(init.body))).not.toHaveProperty("chunk_id");
  });

  it("report sends a passage report with every field it was given", async () => {
    answer(200, { ok: true });
    await report(PASSAGE);
    expect(JSON.parse(String(call().init.body))).toEqual(PASSAGE);
  });
});

// Compile-time check that the fixtures have the Worker's response shapes. `resolveJsonModule`
// widens string literals ("keyword" becomes string) and tuples ([0, 4] becomes number[]), so the
// Worker type is widened the same way first. A missing or wrongly-typed field in a fixture, or a
// field the Worker type gains that the fixture lacks, fails `npm run typecheck`. (Extra fields in
// a fixture are not caught; that is the Worker's contract test.) Nothing runs at test time.
type Loose<T> = T extends string
  ? string
  : T extends readonly unknown[]
    ? Loose<T[number]>[]
    : T extends object
      ? { [K in keyof T]: Loose<T[K]> }
      : T;
type ExactData = Extract<SearchData, { mode: "exact" }>;
type SmartData = Extract<SearchData, { mode: "smart" }>;

describe("fixtures have the Worker's types (checked by tsc)", () => {
  it("compiles", () => {
    exactFixture satisfies Loose<ExactData>;
    truncatedFixture satisfies Loose<ExactData>;
    emptyFixture satisfies Loose<ExactData>;
    smartFixture satisfies Loose<SmartData>;
    degradedFixture satisfies Loose<SmartData>;
    debugFixture satisfies Loose<SmartData>;
    expect(true).toBe(true);
  });
});

describe("search: real response shapes", () => {
  const signal = new AbortController().signal;

  it("exact.json parses as the exact arm", async () => {
    answer(200, exactFixture);
    const r = await search({ ...SMART, mode: "exact" }, signal);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok" || r.data.mode !== "exact") throw new Error("expected an exact ok");
    // `total` exists only on the exact arm, so reading it needs the narrowing above. The fixture's
    // own shape is checked in "fixtures have the Worker's types".
    expect(r.data.total).toBe(exactFixture.total);
    expect(r.data.has_more).toBe(true);
    expect(r.data.results).toHaveLength(3);
    expect(r.data.results[0]?.more_in_episode).toBe(2);
    expect(r.data.results[0]?.ranges[0]).toEqual([28, 36]);
  });

  it("exact_truncated.json keeps total_capped and truncated", async () => {
    answer(200, truncatedFixture);
    const r = await search({ ...SMART, mode: "exact", page: 10 }, signal);
    if (r.kind !== "ok" || r.data.mode !== "exact") throw new Error("expected an exact ok");
    expect(r.data.total_capped).toBe(true);
    expect(r.data.truncated).toBe(true);
    expect(r.data.page).toBe(10);
  });

  it("empty.json is an exact ok with no results", async () => {
    answer(200, emptyFixture);
    const r = await search({ ...SMART, mode: "exact" }, signal);
    if (r.kind !== "ok" || r.data.mode !== "exact") throw new Error("expected an exact ok");
    expect(r.data.results).toEqual([]);
    expect(r.data.total).toBe(0);
  });

  it("smart.json parses as the smart arm, with a related hit", async () => {
    answer(200, smartFixture);
    const r = await search(SMART, signal);
    if (r.kind !== "ok" || r.data.mode !== "smart") throw new Error("expected a smart ok");
    expect(r.data.smart_degraded).toBeUndefined();
    expect(r.data.results.map((x) => x.match)).toEqual(["keyword", "related", "related"]);
    expect("total" in r.data).toBe(false);
  });

  it("smart_degraded.json carries its reason", async () => {
    answer(200, degradedFixture);
    const r = await search(SMART, signal);
    if (r.kind !== "ok" || r.data.mode !== "smart") throw new Error("expected a smart ok");
    expect(r.data.smart_degraded).toBe("unavailable");
  });

  it("smart_debug.json carries debug", async () => {
    answer(200, debugFixture);
    const r = await search(SMART, signal);
    if (r.kind !== "ok" || r.data.mode !== "smart") throw new Error("expected a smart ok");
    expect(r.data.debug?.keyword_hits).toBe(3);
    expect(r.data.results[0]?.debug).toBeDefined();
  });
});

describe("context and info: real shapes", () => {
  it("context returns the parsed body", async () => {
    // exact.json is a search answer; the context shape is built here from its first result.
    const hit = exactFixture.results[0];
    const body = {
      chunk_id: 59031,
      episode: hit?.episode,
      chunks: [
        {
          chunk_id: 59031,
          seq: 7,
          start_ms: 1,
          end_ms: 2,
          text: "t",
          boilerplate: false,
          cue_s: hit?.cue_s,
          links: hit?.episode.links,
        },
      ],
    };
    answer(200, body);
    const r = await context(59031, 3, new AbortController().signal);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.data.chunk_id).toBe(59031);
    expect(r.data.chunks[0]?.boilerplate).toBe(false);
  });

  it("info returns the parsed body", async () => {
    answer(200, { episodes: 625, latest_episode_date: "2026-09-17", corpus_version: "abc", turnstile_site_key: "k" });
    const r = await info(new AbortController().signal);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.data.episodes).toBe(625);
    expect(r.data.latest_episode_date).toBe("2026-09-17");
    expect(r.data.turnstile_site_key).toBe("k");
  });
});

describe("status mapping, GET calls", () => {
  const signal = new AbortController().signal;
  const calls = [
    ["search", () => search(SMART, signal)],
    ["context", () => context(1, 3, signal)],
    ["info", () => info(signal)],
  ] as const;

  describe.each(calls)("%s", (_name, run) => {
    it("503 maintenance is maintenance, with the message", async () => {
      answer(503, { error: "maintenance", message: "Search is down for maintenance. Please try again later." });
      expect(await run()).toEqual({
        kind: "maintenance",
        message: "Search is down for maintenance. Please try again later.",
      });
    });

    it("503 maintenance without a message still gets one", async () => {
      answer(503, { error: "maintenance" });
      const r = await run();
      expect(r.kind).toBe("maintenance");
      if (r.kind === "maintenance") expect(r.message.length).toBeGreaterThan(0);
    });

    it("503 unavailable is unavailable", async () => {
      answer(503, { error: "unavailable" });
      expect(await run()).toEqual({ kind: "unavailable" });
    });

    it("503 that is not JSON is unavailable", async () => {
      answer(503, "<html>upstream</html>");
      expect(await run()).toEqual({ kind: "unavailable" });
    });

    it("500 is unavailable", async () => {
      answer(500, { error: "internal" });
      expect(await run()).toEqual({ kind: "unavailable" });
    });

    it("429 is rate_limited with retry-after as seconds", async () => {
      answer(429, { error: "rate_limited" }, { "retry-after": "17" });
      expect(await run()).toEqual({ kind: "rate_limited", retryAfterS: 17 });
    });

    it("429 without retry-after waits 60", async () => {
      answer(429, { error: "rate_limited" });
      expect(await run()).toEqual({ kind: "rate_limited", retryAfterS: 60 });
    });

    it.each(["soon", "", "0", "-5", "1.5s", "Wed, 21 Oct 2026 07:28:00 GMT"])(
      "429 with retry-after %j waits 60",
      async (value) => {
        answer(429, { error: "rate_limited" }, { "retry-after": value });
        expect(await run()).toEqual({ kind: "rate_limited", retryAfterS: 60 });
      },
    );

    it("200 that is not JSON is unavailable, not a throw", async () => {
      answer(200, "<html>not json</html>");
      expect(await run()).toEqual({ kind: "unavailable" });
    });

    it.each(["null", "\"text\"", "[]", "7"])("200 with the JSON body %s is unavailable, not ok", async (text) => {
      answer(200, text);
      expect(await run()).toEqual({ kind: "unavailable" });
    });

    it("404 and 400 are unavailable (no other status is promised)", async () => {
      answer(404, { error: "not_found" });
      expect(await run()).toEqual({ kind: "unavailable" });
      answer(400, { error: "bad_request" });
      expect(await run()).toEqual({ kind: "unavailable" });
    });

    it("a fetch failure that is not an abort is network", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      expect(await run()).toEqual({ kind: "network" });
    });

    it("an abort rejects with an AbortError", async () => {
      fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));
      await expect(run()).rejects.toMatchObject({ name: "AbortError" });
    });
  });

  it("an abort that surfaces as another error still rejects as AbortError when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new TypeError("terminated"));
    await expect(search(SMART, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an abort while the body is being read rejects with an AbortError", async () => {
    const res = new Response("{}", { status: 200 });
    vi.spyOn(res, "json").mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    fetchMock.mockResolvedValueOnce(res);
    await expect(search(SMART, signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("status mapping, report", () => {
  it("200 is ok", async () => {
    answer(200, { ok: true });
    expect(await report(PASSAGE)).toEqual({ kind: "ok", data: { ok: true } });
  });

  it.each([
    [400, { error: "bad_request", message: "That report is too long." }],
    [403, { error: "forbidden", message: "The human check was refused." }],
    [429, { error: "rate_limited", message: "Too many reports from here. Please wait a minute and try again." }],
  ])("%i with a message is refused with that message", async (status, body) => {
    answer(status, body, status === 429 ? { "retry-after": "30" } : {});
    expect(await report(PASSAGE)).toEqual({ kind: "refused", status, message: body.message });
  });

  it("429 without a message is rate_limited, with retry-after", async () => {
    answer(429, { error: "rate_limited" }, { "retry-after": "12" });
    expect(await report(PASSAGE)).toEqual({ kind: "rate_limited", retryAfterS: 12 });
  });

  it("400 and 403 without a message are unavailable", async () => {
    answer(400, { error: "bad_request" });
    expect(await report(PASSAGE)).toEqual({ kind: "unavailable" });
    answer(403, "nope");
    expect(await report(PASSAGE)).toEqual({ kind: "unavailable" });
  });

  it("503 maintenance is maintenance", async () => {
    answer(503, { error: "maintenance", message: "Search is down for maintenance. Please try again later." });
    expect(await report(PASSAGE)).toEqual({
      kind: "maintenance",
      message: "Search is down for maintenance. Please try again later.",
    });
  });

  it("503 unavailable with a friendly message is unavailable", async () => {
    answer(503, { error: "unavailable", message: "We couldn't save your report just now, please try again in a minute." });
    expect(await report(PASSAGE)).toEqual({ kind: "unavailable" });
  });

  it("500 is unavailable", async () => {
    answer(500, "boom");
    expect(await report(PASSAGE)).toEqual({ kind: "unavailable" });
  });

  it("200 that is not JSON is unavailable", async () => {
    answer(200, "ok");
    expect(await report(PASSAGE)).toEqual({ kind: "unavailable" });
  });

  it("a fetch failure is network", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await report(PASSAGE)).toEqual({ kind: "network" });
  });
});
