# Title Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A query word that is in an episode's title finds that episode, shown as an "Episodes" row above the passage results.

**Architecture:** A second FTS5 index over `episodes.title` (migration 0003, kept in sync by triggers). On page 1 the search route runs the query's FTS expression against it and adds `episodes` to the answer. The page renders the row; `wts search` prints it.

**Tech Stack:** D1 (SQLite FTS5), the Cloudflare Worker (TypeScript, Vitest), `web/` (Preact, Vitest, Playwright), the `wts` CLI (Python, pytest).

**Spec:** `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` §4.1 (`episodes_fts`), §4.4 ("Title hits: `episodes`"), §5.2 ("Episodes whose title matches").

## Global Constraints

- The constraints of `docs/superpowers/plans/2026-10-08-m1-frontend.md` ("Global Constraints") hold: no host in `web/`, the frontend never builds a play link, no inline styles, API types imported type-only from `worker/src/api-types`, accessibility in the component itself.
- `schema/` is the contract between pipeline and Worker: the pipeline's tests load `schema/*.sql`, so a migration must pass both halves.
- Passage results, their order, `total` and the cache TTL do not change.
- Files are changed with Edit/Write only. One commit per task, on `main`. No push without the maintainer's word.

## Review Focus

1. **Deploy order.** The Worker may be deployed before migration 0003 is applied: the title query then fails and the search must still answer, with `episodes: []`. (Task 1 test.)
2. **Stale titles.** The pipeline upserts episodes with `ON CONFLICT DO UPDATE`; a changed title must replace the old terms in the index, and existing rows must be indexed by the migration itself. (Task 1 tests, both halves.)
3. **A query with no words** (only filters or exclusions) has no FTS expression: no title query, `episodes: []`. (Task 1 test.)
4. **Old cached answers** have no `episodes`: `API_VERSION` goes to 3, and the page still treats a missing field as none. (Tasks 1 and 2.)
5. **Title hits with no passages** must not show "Nothing found." (Task 2 test.)

---

### Task 1: Migration, Worker and CLI

**Files:**
- Create: `schema/0003_title_search.sql`, `worker/src/titles.ts`, `worker/test/titles.test.ts`
- Modify: `worker/src/api-types.ts`, `worker/src/index.ts`, `worker/src/cache.ts`, `worker/src/search.ts` (export `filterSql`'s episode part if needed), `worker/test/cache.test.ts`, `pipeline/src/wts/search.py`, `pipeline/tests/test_search.py`, `pipeline/tests/test_schema_contract.py` (if it lists tables)

**Interfaces:**
- Produces: `EpisodeHit { id: number; number: number | null; title: string; date: string; links: DeepLinks }` in `api-types.ts`; `episodes: EpisodeHit[]` on `ExactResponse` and `SmartResponse`; `titleHits(db: D1Database, parsed: ParsedQuery): Promise<EpisodeHit[]>` in `titles.ts` (throws on a D1 error; the route catches); `MAX_TITLE_HITS = 5`; `API_VERSION = 3`.

- [ ] **Step 1: The migration.** `episodes_fts` as an external-content FTS5 table over `episodes.title` (`tokenize='porter unicode61'`), insert/delete/update triggers that pass the old values on delete and update (as `chunks_fts` does), and `INSERT INTO episodes_fts(episodes_fts) VALUES ('rebuild')` for the rows already there.
- [ ] **Step 2: Failing Worker tests** (`titles.test.ts`, seeded episodes): a title word finds its episode; stemming ("kreggers" finds "Kregger"); all words are needed; a phrase; `-word` excludes; `year:`, `before:`, `after:`, `ep:` apply; at most 5, best match then newest; links from the start with offsets and no lead-in; a query with no words makes no statement; a title updated by `ON CONFLICT DO UPDATE` is found by its new words and not its old.
- [ ] **Step 3: Failing route tests:** `episodes` is in both modes' page 1 answers and `[]` on page 2; a failing title statement gives `episodes: []`, a logged error and a 200; the cache key has `api=3`.
- [ ] **Step 4: Implement** `titles.ts`, the route change (title query in parallel with the search on page 1, caught), the types and `API_VERSION`.
- [ ] **Step 5:** `cd worker && npm test && npx tsc --noEmit`.
- [ ] **Step 6: CLI.** `format_results` prints the title hits before the results: a line "Episodes with this in the title:" then "  #613 Shove a Kregger in the Hole (2026-08-19)" each; nothing when `episodes` is missing or empty. Tests first, then `cd pipeline && uv run pytest -q && uv run ruff check .`.
- [ ] **Step 7: Commit.** `worker, schema, pipeline: search finds episodes by title`

### Task 2: The "Episodes" row in the page

**Files:**
- Create: `web/src/components/TitleHits.tsx`, `web/test/title-hits.test.tsx`
- Modify: `web/src/app.tsx`, `web/src/styles/components.css`, `web/test/helpers.ts` (bodies gain `episodes: []`), `web/e2e/states.spec.ts` or a new `web/e2e/title-hits.spec.ts`

**Interfaces:**
- Consumes: `EpisodeHit` and `episodes` from Task 1 (type-only import).
- Produces: `TitleHits({ episodes, onSearchEpisode })`.

- [ ] **Step 1: Failing tests:** the row shows on page 1 with one entry per episode ("Ep. 613", the cleaned title, the date); the title is a link to `links.youtube`, else `links.page`, else plain text, with the name from the spec; "Search this episode" puts `ep:613` alone in the box, focuses the box and makes no request; no row when `episodes` is empty or missing; with title hits and no passages the row shows and "Nothing found." does not; the row is not a j/k stop.
- [ ] **Step 2: Implement,** to the look of the existing cards' header line and the "TRY" label of the empty state.
- [ ] **Step 3:** `cd web && npm run typecheck && npm test && npm run e2e`.
- [ ] **Step 4: Commit.** `web: episodes whose title matches, above the results`

### After both

- The maintainer applies the migration to staging, then deploys:
  `cd worker && npx wrangler d1 migrations apply wts-staging --env staging --remote && npm run deploy:staging`
- `docs/HANDOFF.md`: the feature, the migration step, test counts.
