import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { highlightRanges, hitMs } from "../src/highlight";
import { seed } from "./seed";
import type { SeedChunk, SeedEpisode } from "./seed";

const OPEN = "\u0001";
const CLOSE = "\u0002";

describe("highlightRanges", () => {
  it("returns plain text with no ranges and no first token", () => {
    expect(highlightRanges("plain")).toEqual({ text: "plain", ranges: [], firstToken: null });
  });

  it("marks only part of a token", () => {
    const out = highlightRanges(`the ${OPEN}SawStop${CLOSE}, saw`);
    expect(out.text).toBe("the SawStop, saw");
    expect(out.ranges).toEqual([[4, 11]]);
    expect(out.firstToken).toBe(1);
    expect(out.text.slice(4, 11)).toBe("SawStop");
  });

  it("gives one range per highlight and the first token from the first", () => {
    const out = highlightRanges(`use ${OPEN}hide${CLOSE} and ${OPEN}glue${CLOSE} today`);
    expect(out.text).toBe("use hide and glue today");
    expect(out.ranges).toEqual([
      [4, 8],
      [13, 17],
    ]);
    expect(out.firstToken).toBe(1);
  });

  it("keeps a phrase match over two words as one range", () => {
    const out = highlightRanges(`use ${OPEN}hide glue${CLOSE} now`);
    expect(out.text).toBe("use hide glue now");
    expect(out.ranges).toEqual([[4, 13]]);
    expect(out.firstToken).toBe(1);
  });

  it("gives two ranges inside one token, as T-square does", () => {
    const out = highlightRanges(`a ${OPEN}T${CLOSE}-${OPEN}square${CLOSE} b`);
    expect(out.text).toBe("a T-square b");
    expect(out.ranges).toEqual([
      [2, 3],
      [4, 10],
    ]);
    expect(out.firstToken).toBe(1);
  });

  it("handles a highlight at the very start", () => {
    const out = highlightRanges(`${OPEN}Glue${CLOSE} now`);
    expect(out.ranges).toEqual([[0, 4]]);
    expect(out.firstToken).toBe(0);
  });

  it("handles a highlight that ends at the text end", () => {
    const out = highlightRanges(`go ${OPEN}glue${CLOSE}`);
    expect(out.text).toBe("go glue");
    expect(out.ranges).toEqual([[3, 7]]);
    expect(out.firstToken).toBe(1);
  });

  it("counts offsets in UTF-16 code units after non-BMP text", () => {
    const out = highlightRanges(`🪚 ${OPEN}glue${CLOSE}`);
    expect(out.text).toBe("🪚 glue");
    expect(out.ranges).toEqual([[3, 7]]);
    expect(out.text.slice(3, 7)).toBe("glue");
    expect(out.firstToken).toBe(1);
  });

  describe("bad markers", () => {
    it("closes a range left open at the end of the text", () => {
      const out = highlightRanges(`a ${OPEN}b c`);
      expect(out.text).toBe("a b c");
      expect(out.ranges).toEqual([[2, 5]]);
      expect(out.firstToken).toBe(1);
    });

    it("ignores a stray close", () => {
      expect(highlightRanges(`a${CLOSE} b`)).toEqual({ text: "a b", ranges: [], firstToken: null });
    });

    it("ignores an open while a range is open", () => {
      const out = highlightRanges(`${OPEN}a ${OPEN}b${CLOSE} c`);
      expect(out.text).toBe("a b c");
      expect(out.ranges).toEqual([[0, 3]]);
      expect(out.firstToken).toBe(0);
    });

    it("drops empty ranges, including an open at the very end", () => {
      expect(highlightRanges(`a${OPEN}${CLOSE}b`)).toEqual({ text: "ab", ranges: [], firstToken: null });
      expect(highlightRanges(`ab${OPEN}`)).toEqual({ text: "ab", ranges: [], firstToken: null });
    });

    it("never throws on markers alone or empty input", () => {
      for (const s of ["", OPEN, CLOSE, OPEN + OPEN, CLOSE + CLOSE, CLOSE + OPEN]) {
        expect(() => highlightRanges(s)).not.toThrow();
        expect(highlightRanges(s).text).toBe("");
      }
    });
  });
});

describe("hitMs", () => {
  const chunk = { start_ms: 1000, word_times: "0,400,400,-100" };

  it("returns the decoded time of the token", () => {
    expect(hitMs(chunk, 0)).toBe(1000);
    expect(hitMs(chunk, 1)).toBe(1400);
    expect(hitMs(chunk, 2)).toBe(1800);
    expect(hitMs(chunk, 3)).toBe(1700);
  });

  it("falls back to start_ms when there is no token", () => {
    expect(hitMs(chunk, null)).toBe(1000);
  });

  it("falls back to start_ms when the token is out of range", () => {
    expect(hitMs(chunk, 4)).toBe(1000);
    expect(hitMs(chunk, -1)).toBe(1000);
  });

  it("falls back to start_ms when the word times do not decode", () => {
    expect(hitMs({ start_ms: 1000, word_times: "" }, 1)).toBe(1000);
    expect(hitMs({ start_ms: 1000, word_times: "0,x,400" }, 1)).toBe(1000);
  });
});

// Against the real FTS5: the markers its highlight() emits, with the Worker's own SQL shape.
const EPISODE: SeedEpisode = {
  id: 41,
  guid: "guid-highlight-41",
  number: 300,
  title: "Highlight fixtures",
  published_at: "2016-02-01T08:00:00Z",
  duration_s: 3600,
};

const CHUNK_TEXT = "we love the SawStop, saw and a T-square with hide glue";

const CHUNK: SeedChunk = {
  id: 401,
  episode_id: EPISODE.id,
  seq: 0,
  start_ms: 60_000,
  end_ms: 80_000,
  text: CHUNK_TEXT,
};

beforeAll(async () => {
  await seed(env.DB, [EPISODE], [CHUNK]);
});

async function marked(query: string): Promise<string> {
  const row = await env.DB.prepare(
    "select highlight(chunks_fts, 0, char(1), char(2)) as marked from chunks_fts where chunks_fts match ? and rowid = ?",
  )
    .bind(query, CHUNK.id)
    .first<{ marked: string }>();
  if (row === null) throw new Error(`no row for ${query}`);
  return row.marked;
}

describe("highlightRanges on real FTS5 output", () => {
  it("marks SawStop without its comma", async () => {
    const out = highlightRanges(await marked('"sawstop"'));
    expect(out.text).toBe(CHUNK_TEXT);
    expect(out.ranges).toEqual([[12, 19]]);
    expect(out.text.slice(12, 19)).toBe("SawStop");
    expect(out.firstToken).toBe(3);
  });

  it("marks the matched part of T-square", async () => {
    const out = highlightRanges(await marked('"square"'));
    expect(out.text).toBe(CHUNK_TEXT);
    expect(out.ranges).toEqual([[33, 39]]);
    expect(out.text.slice(33, 39)).toBe("square");
    expect(out.firstToken).toBe(7);
  });

  // The hyphen is a token separator but inside a phrase match, so FTS5 marks T-square as one span.
  it("marks the hyphenated word as one span when the query is the hyphenated word", async () => {
    const out = highlightRanges(await marked('"T-square"'));
    expect(out.text).toBe(CHUNK_TEXT);
    expect(out.ranges).toEqual([[31, 39]]);
    expect(out.text.slice(31, 39)).toBe("T-square");
    expect(out.firstToken).toBe(7);
  });

  it("marks a phrase as one span over both words", async () => {
    const out = highlightRanges(await marked('"hide glue"'));
    const start = CHUNK_TEXT.indexOf("hide");
    expect(out.text).toBe(CHUNK_TEXT);
    expect(out.ranges).toEqual([[start, CHUNK_TEXT.length]]);
    expect(out.text.slice(start, CHUNK_TEXT.length)).toBe("hide glue");
    expect(out.firstToken).toBe(9);
  });

  it("marks ANDed words separately", async () => {
    const out = highlightRanges(await marked('"hide" AND "glue"'));
    const start = CHUNK_TEXT.indexOf("hide");
    expect(out.ranges).toEqual([
      [start, start + 4],
      [start + 5, CHUNK_TEXT.length],
    ]);
    expect(out.firstToken).toBe(9);
  });

  it("marks several terms ORed, first token from the earliest range", async () => {
    const out = highlightRanges(await marked('"glue" OR "sawstop"'));
    expect(out.text).toBe(CHUNK_TEXT);
    expect(out.ranges).toEqual([
      [12, 19],
      [CHUNK_TEXT.length - 4, CHUNK_TEXT.length],
    ]);
    expect(out.firstToken).toBe(3);
  });

  it("gives the first highlighted word's own time end to end", async () => {
    const row = await env.DB.prepare("select start_ms, word_times from chunks where id = ?")
      .bind(CHUNK.id)
      .first<{ start_ms: number; word_times: string }>();
    if (row === null) throw new Error("chunk is missing");
    const { firstToken } = highlightRanges(await marked('"sawstop"'));
    // seed's wordTimes puts every word 400 ms after the one before, from start_ms.
    expect(hitMs(row, firstToken)).toBe(CHUNK.start_ms + 3 * 400);
  });
});
