import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { COUNT_CAP, MAX_EXACT_PAGE, MAX_EXACT_RESULTS, PAGE_SIZE, type SearchResponse } from "../src/search";
import { seed, type SeedChunk } from "./seed";

// Exact search shows at most MAX_EXACT_PAGE pages and counts at most COUNT_CAP matches
// (maintainer, 2026-10-07: nobody pages through 1000 pages; a broad query gets the best 200
// and a notice to narrow it). Its own file: it needs over a thousand matching chunks.

type Body = SearchResponse & { mode: string; sort: string };

const SHOWN = MAX_EXACT_PAGE * PAGE_SIZE; // 200

// Chunk i (0..1000) says "veneer" (1001 matches, one past the count cap), "burl" when
// i < 1000 (exactly the cap), "lathe" when i < 201 (one past what is shown) and "spalted"
// when i < 200 (exactly what is shown). 200 s apart in one episode, so nothing collapses.
const CHUNKS: SeedChunk[] = Array.from({ length: COUNT_CAP + 1 }, (_, i) => {
  const words = ["veneer"];
  if (i < COUNT_CAP) words.push("burl");
  if (i < SHOWN + 1) words.push("lathe");
  if (i < SHOWN) words.push("spalted");
  const text = `${words.join(" ")} take ${i}`;
  return { id: 50_000 + i, episode_id: 50, seq: i, start_ms: i * 200_000, end_ms: i * 200_000 + 30_000, text };
});

beforeAll(async () => {
  await seed(
    env.DB,
    [{ id: 50, guid: "g50", number: 500, title: "Every Take", published_at: "2020-01-01T08:00:00+00:00", duration_s: 3600 }],
    CHUNKS,
  );
});

async function exact(q: string, page?: number, limit?: number): Promise<Body> {
  const url = new URL("https://example.com/api/search");
  url.searchParams.set("q", q);
  url.searchParams.set("mode", "exact");
  if (page !== undefined) url.searchParams.set("page", String(page));
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  const response = await exports.default.fetch(url.toString());
  expect(response.status).toBe(200);
  return (await response.json()) as Body;
}

describe("result caps", () => {
  it("are 10 pages and a count of 1000", () => {
    expect(SHOWN).toBe(200);
    expect(MAX_EXACT_RESULTS).toBe(SHOWN);
    expect(COUNT_CAP).toBe(1000);
  });

  it("shows everything, with no flags, up to 200 matches", async () => {
    const body = await exact("spalted", MAX_EXACT_PAGE);
    expect(body).toMatchObject({ total: SHOWN, total_capped: false, truncated: false, page: 10, has_more: false });
    expect(body.results).toHaveLength(PAGE_SIZE);
  });

  it("flags truncated past 200 matches, and stops at page 10", async () => {
    const first = await exact("lathe");
    expect(first).toMatchObject({ total: SHOWN + 1, total_capped: false, truncated: true, has_more: true });

    const last = await exact("lathe", MAX_EXACT_PAGE);
    expect(last).toMatchObject({ page: 10, truncated: true, has_more: false });
    expect(last.results).toHaveLength(PAGE_SIZE);

    // The 201st match is never shown: page 11 is clamped to page 10.
    const past = await exact("lathe", MAX_EXACT_PAGE + 1);
    expect(past.page).toBe(10);
    expect(past.results.map((r) => r.chunk_id)).toEqual(last.results.map((r) => r.chunk_id));
  });

  it("keeps the 200-result cap with a smaller limit: more, shorter pages", async () => {
    // 201 matches, 10 per page: page 20 is the last (results 191–200), page 21 is page 20.
    const last = await exact("lathe", MAX_EXACT_RESULTS / 10, 10);
    expect(last).toMatchObject({ page: 20, limit: 10, truncated: true, has_more: false });
    expect(last.results).toHaveLength(10);
    expect((await exact("lathe", 21, 10)).page).toBe(20);
    expect((await exact("lathe", 19, 10)).has_more).toBe(true);
  });

  it("ends the last page at result 200 when the limit doesn't divide it", async () => {
    // 15 per page: page 14 starts at result 196 and holds only 5.
    const last = await exact("lathe", 14, 15);
    expect(last).toMatchObject({ page: 14, has_more: false });
    expect(last.results).toHaveLength(5);
    expect((await exact("lathe", 15, 15)).page).toBe(14);
  });

  it("counts exactly up to 1000 matches", async () => {
    const body = await exact("burl");
    expect(body).toMatchObject({ total: COUNT_CAP, total_capped: false, truncated: true });
  });

  it("stops counting past 1000 and flags the total as capped", async () => {
    const body = await exact("veneer");
    expect(body).toMatchObject({ total: COUNT_CAP, total_capped: true, truncated: true, has_more: true });
    expect(body.results).toHaveLength(PAGE_SIZE);
  });

  it("keeps the best matches first when truncating", async () => {
    // Chunk 200 is the 201st "lathe" match by id, but the only one without "spalted": the
    // shortest, so bm25 ranks it first. Relevance, not id order, decides which 200 are shown.
    const body = await exact("lathe");
    expect(body.truncated).toBe(true);
    expect(body.results[0]?.chunk_id).toBe(50_000 + SHOWN);
  });

  it("has no flags when there is nothing to match", async () => {
    const body = await exact("-veneer");
    expect(body).toMatchObject({ total: 0, total_capped: false, truncated: false, has_more: false, results: [] });
  });
});
