# Search API fixtures

These files are **hand-built in the shape of the Worker's `GET /api/search` response
(`worker/src/search.ts`, `worker/src/index.ts`), not recorded**. The titles are real Wood Talk
style, but the episode ids, chunk ids, video ids and offsets are made up.

`worker/test/search-contract.test.ts` imports them and compares their keys and value types
with what the real Worker returns for a seeded corpus, so a change to the response shape fails
there until these files follow it.

| File | Case |
|---|---|
| `exact.json` | Three results on page 1 of 57 (`has_more`). The first has all four links and `more_in_episode` 2; the second has an emoji before each highlighted word (ranges are UTF-16 offsets); the third has no episode number, only a page link, and ranges at the start and end of the text. |
| `exact_truncated.json` | `total_capped` and `truncated`: page 10 of a 1000+ match query. |
| `smart_degraded.json` | Smart mode that fell back to keyword results (`smart_degraded`). |
| `empty.json` | No results. |
