# Handoff — 2026-10-09 (after the seventh session; plan 3 Tasks 1–5 done, Task 6 next)

Where the project stands, so a fresh session can pick up without the conversation. Read this,
then [README.md](../README.md), then the spec sections it points to.

## Start here (next session)

**Branch:** work on `main` (CLAUDE.md), even when a cloud session is given another branch.
The seventh session worked on `claude/plan-3-handoff-etfwwc` at the maintainer's request and
fast-forwarded `main` to it; everything is on `main`, and that branch can be deleted.

**Next: plan 3 Task 6** (API client and URL state), then Tasks 7–15 and Checkpoint H:
[`docs/superpowers/plans/2026-10-08-m1-frontend.md`](superpowers/plans/2026-10-08-m1-frontend.md).
The design is in [`docs/design/system/`](design/system/) — build to its mocks and README (plan
3's "Look" constraint). The maintainer runs well-defined tasks with **Sonnet subagents** in
worktrees; the main session reviews, runs every suite and commits (one commit per task).

**Tests (2026-10-09):** pipeline **694** (`cd pipeline && uv run pytest -q`, ruff clean),
Worker **485** in 18 files (`cd worker && npm test`, `npx tsc --noEmit`), web **13** unit +
**4** e2e (`cd web && npm test`, `npm run e2e`, `npm run typecheck`).

**What the seventh session did (2026-10-08/09):**
- **Plan 3 (frontend)**: brainstorm, spec §5 rewritten, plan written; **Tasks 1–5 done**: the
  Worker changes (`year:A-B`, `folded`, `/api/info`, feedback and same-origin reports,
  robots.txt by environment) and the `web/` scaffold served by the Worker as static assets.
  Notes under "Plan 3 task notes" below.
- **Claude Design delivered** (2026-10-09): `docs/design/system/` (tokens, mocks, README). Spec
  §5.3/§5.7 record it with the maintainer's calls (group neighbouring hits; related hits fold
  at the end of each page; Source Serif 4 self-hosted). Plan 3 builds straight to it from
  Task 5; Task 16 is now a visual pass. The app stays Preact: the mocks' React is only Claude
  Design's viewer (`support.js`). To look at the mocks, serve the folder over HTTP (they
  fetch their siblings); unpkg is blocked in the cloud, so get React/Babel from npm.
- **`wts` logs applied state migrations** (`state.db: applied migrations 005–006`) on `wts
  run` and the step commands.
- **Codex review of plans 1–2** ([`docs/code-review-d15ec6e.md`](code-review-d15ec6e.md),
  2026-10-09): all nine findings reproduced and fixed on the same branch, one commit each
  (resolution table at the end of the review); #8 then became moot (next item).
- **Boilerplate detection binned** (maintainer, 2026-10-09): it flagged 2–3 of 4,210 seed
  chunks and missed the sponsor reads. Removed from the pipeline (`67e1300`); the plumbing
  stays. What to measure and try on the archive: [`docs/full-corpus-backlog.md`](full-corpus-backlog.md),
  which also gathers the other "on the full corpus" items. The chunk step now refreshes only
  when `corrections.yaml` or `CHUNKER_VERSION` (`chunking.py`; bump it after any change to
  chunking output) changes, not on every new episode.
  **Done on the Mac (2026-10-09):** `wts run --env staging` on `main` applied state
  migrations 005 (`failed_at`) and 006 (drops the fingerprint tables), re-chunked everything
  once (`refreshed=3`: ep609, ep613, ep614 each had one flagged chunk), embedded the 3
  un-flagged chunks and republished those episodes.

**Waiting on the maintainer:**
- **Deploy to staging** with `npm run deploy:staging` (from `worker/`, after `cd web && npm
  ci` once). The 2026-10-09 attempt used a bare `npx wrangler deploy --env staging`, which
  fails now (no `web/dist`). It ships plan 2 Tasks 17–19 if still pending, plan 3 Tasks 1–5
  and the Worker review fixes; then `curl -s <staging>/api/info | jq`.
- **Rate limits not triggering on staging**: the maintainer's desktop session (see "Open:
  rate limits…" below).
- **Moving the pipeline to the Mac Mini**: M2 plan A drafted, waiting on four decisions; its
  checkpoint is now **J** (plan 3 has H and I).

**Plan 2: Tasks 1–19 and Checkpoint F are done; Checkpoint G is done except the parts
that wait on Tasks 17–19's deploy** (results below). Staging runs Task 17 at least (robots.txt
and the headers are live); whether Task 18's bindings are live is the open debugging item.
**Next (maintainer):** finish deploying Tasks 17–19 (steps below), then Checkpoint G's rest: its
revised step 2 (rate limits, kill switch, budget and alerts) and the three paraphrase queries
of step 3. (Plan 3 is written and under way; plans 4–5 come after it.)

**Deploying Tasks 17–19** (from `worker/`):
1. `npx wrangler d1 migrations apply wts-staging --env staging --remote` (adds `usage`).
2. `npx wrangler secret put NTFY_URL --env staging` (your server), `… NTFY_TOPIC …`, and
   `… NTFY_TOKEN …` if the server needs one. Without a topic, budget alerts are only logged.
   Suggested: a write-only ntfy user for the Workers (`ntfy user add wts-worker`, `ntfy
   access wts-worker <topic> write-only`, `ntfy token add --label … wts-worker`); one token
   can serve both environments, since alert titles name the environment (`WTS_ENV`).
3. `npm run deploy:staging` (from `worker/`; since plan 3 Task 5 it builds `web/` first —
   run `cd web && npm ci` once. A bare `npx wrangler deploy --env staging` fails: "assets
   directory … web/dist does not exist").
4. Reports now need `-H 'origin: http://localhost:5173'` (`REPORT_ORIGINS`).
5. A homelab monitor (e.g. Uptime Kuma → ntfy) on `<staging>/api/health`: the only error
   alerting, since the in-Worker 5xx alert was dropped.

**Open: rate limits don't trigger on staging (to debug on the desktop, 2026-10-08).**
- Live: Task 17 is (robots.txt 200, `nosniff` present). 70 and then 200 sequential `GET
  /api/health` all answered 200; 4 reports in a row (`chunk_id` 999999999, origin
  `http://localhost:5173`) all 400, the 4th should be 429.
- The local config has the bindings (`deploy --dry-run` lists `RL_READ` 60/60s, `RL_REPORT`
  3/60s), but the live version predated the last commit (no `WTS_ENV`; the maintainer's tree
  had a local-only commit `d10355d` on top of the Task 18 commit `6e1e092`), and the dashboard
  had made a version of its own (`SEARCH_OVERRIDE` = `exact` was added there).
- A redeploy was started: wrangler warned that the dashboard's `SEARCH_OVERRIDE` would be
  overridden. That warning ignores `keep_vars` (wrangler 4.148 `cli.js`: the diff check
  doesn't read it, while the upload sends `keep_bindings: ["plain_text", "json"]`), so answer
  yes; never let wrangler patch `SEARCH_OVERRIDE` into `wrangler.jsonc`.
- Next: after the redeploy, `curl -s "$U/api/search?q=glue+zz$RANDOM" | jq .smart_degraded`
  should still be `"off"` (keep_vars works), then the 200-request loop with `npx wrangler tail
  --env staging` open. 429s → it was the old version. All 200 with `rate_limiter_unavailable`
  in the tail → `limit()` throws (read the error). All 200 and nothing logged → `limit()`
  answers success or `cf-connecting-ip` is missing: add a temporary log of
  `{hasIp, hasBinding, success}` in `ratelimit.ts` to tell which. The binding is "permissive,
  eventually consistent" per location, but 200 requests in a row should still trip 60/60 s.
- Then finish Checkpoint G step 2 (remove `SEARCH_OVERRIDE`; `maintenance`; the budget test
  with `SMART_DAILY_BUDGET` = 3; Production, not Previews, in the dashboard's variable dialog)
  and step 3's paraphrase queries.

§4.8 decisions (maintainer, 2026-10-08): `smart_degraded` reason strings; `REPORT_ORIGINS`
with `http://localhost:5173` on staging; `keep_vars: true` for the kill switch; the 5xx alert
is a homelab monitor on `/api/health`, not Worker code.

**Since Checkpoint G (session 6; on the Mac since the 2026-10-09 run):** new releases join the scope in
`wts feed` (open decision 3, option a; spec §3.1). The next `wts run` after a release shows
`scoped=1` and processes it in the same run.

**Corrections candidate** (for the corrections session): "Urlex HV2900" in #71 at ~1:09:51 is
very likely **Earlex** HV2900 (an HVLP sprayer); check with `check_corrections.py`.

## Plan 3: start here (frontend, `web/`)

**Status (2026-10-09, seventh session):** brainstorm done; spec §5 rewritten (§5.1–§5.8) with
knock-on edits in §1, §2, §4.3, §4.4, §4.8, §7.1, §10 item 7; the brief's *(proposed)* items
marked settled; plan written: [`2026-10-08-m1-frontend.md`](superpowers/plans/2026-10-08-m1-frontend.md)
(Tasks 1–4 Worker changes, 5–15 the app, Checkpoint H on staging's `workers.dev`, Task 16 a
visual pass against the mocks, Checkpoint I, Task 17 the domain). **Tasks 1–5 are done**;
Task 6 is next.

Decisions from the brainstorm (maintainer, 2026-10-08; all took the recommended option):
- **Hosting:** the API Worker serves the site as **static assets** (not Pages + a Worker
  route): `run_worker_first: ["/api/*", "/robots.txt"]`, one deploy, staging's `workers.dev`
  URL serves the whole site, the domain only in each env's `routes`.
- **Configuration:** one web build for every environment; the Turnstile site key comes from a
  new `GET /api/info` (with the episode count and latest date for the empty state). Reports
  accept the request's own origin, so `REPORT_ORIGINS` is only for the dev server.
- **Year chip:** new inclusive `year:2015-2020` syntax, written into the box (parser sugar for
  `after:2014 before:2021`; no API parameter).
- **Open decision 9:** yes — footer "Send feedback" posts to `/api/report` with no `chunk_id`.
- **"+n more nearby"** (was "+n more in this episode"): folded hits are always within 120 s,
  so searching the episode would fold them into the same card again. It expands the
  transcript (radius 6) with the folded chunks marked; results gain `folded: [chunk_id…]`
  (replacing `debug.folded`). "Search this episode" sits in the expanded view.
- **Extras:** j/k kept; Enter-plays-first-platform and the 400 ms hover preview dropped.
- **Designs:** not started at the brainstorm; delivered 2026-10-09 (see "Start here"), so
  the app is built to them from Task 5.

### Plan 3 task notes (calls the plan didn't spell out)

- **Task 5** `web/` scaffold (Sonnet, 2026-10-09; web 13 unit + 4 e2e tests): Preact 11.0.1
  (the current release; plan said 10), Vite 8, Vitest 4.1 (as `worker/`; 5 exists), Playwright
  1.64 (uses `/opt/pw-browsers/chromium-1194` when present). Turnstile's CSP docs (2026-05-05)
  need only `script-src` and `frame-src https://challenges.cloudflare.com`: `_headers` as
  planned. Source Serif 4 400/600 Latin woff2 from `@fontsource/source-serif-4` (~20 KB each;
  own `@font-face`, the package's CSS would also ship legacy woff); `assetsInlineLimit: 0` so
  fonts never become `data:` URIs. `vite preview` serves the real `_headers` through
  `web/vite-plugin-headers.ts`, so e2e fails on any CSP violation or third-party request.
  `env.e2e` carries Cloudflare's public always-pass Turnstile test keys as vars.
  `npm run deploy:staging` (in `worker/`) builds `web/` first; `--dry-run` reads 8 asset files.
  `<main>` holds the empty-state heading until Task 11.

Tasks 1–4 were written by four Sonnet subagents in parallel worktrees (none committed),
reviewed, applied and committed one per task in the main session. Worker **470 tests** in 18
files, pipeline **685**, type-check and ruff clean. Deploying them to staging needs only
`npm run deploy:staging` from `worker/` (no migration; it builds `web/` first).
- **Task 1** `year:A-B`: each filter key keeps its last value, so a range (two keys) and a
  single year (one key) intersect: `year:2010-2012 year:2015` matches nothing (pinned in the
  parser table). The web app's chip rewrites every year token, so it never produces this.
  Malformed spans (`year:2015-`, `year:2015-20`, three parts, mixed dashes) are plain words.
- **Task 2** `folded`: on every result (degraded too); exact lists only that page's folds.
  The Python fixtures' folded ids are invented (`README` says hand-built).
- **Task 3** `/api/info`: with the cache on, a miss on a cold `corpus_version` memo costs two
  D1 statements (version, then info); a warm hit none. `cache.ts` gained `pathCacheKey`;
  search keys are byte-identical. `TURNSTILE_SITE_KEY` unset or `""` → null.
- **Task 4** feedback: `quoted_text`/`suggested_text` keys are refused when present at all
  (even `null` or `""`), so the web form must omit them; the check runs before the note and
  the token, so a bad body never costs a siteverify call. robots.txt opens only for exactly
  `WTS_ENV` = `production`.

The notes below were gathered before the brainstorm; the spec now supersedes them where they
differ (e.g. Pages, the domain list).

**Design runs separately** (maintainer, 2026-10-08): a design system, then the UI on it, made
in **Claude Design** from [`docs/design/BRIEF.md`](design/BRIEF.md) — a standalone brief with
the UI specified screen by screen, every state, the syntax popover, and real sample excerpts.
Plan 3 settles the brief's *(proposed)* items, takes the design system's tokens as CSS
custom properties, and builds against the designs. Facts and decisions gathered so far, so the
brainstorm doesn't rediscover them:

- **Domain** (maintainer, 2026-10-08; spec §10 item 7): most likely a subdomain of
  `10fathoms.org`, name not chosen, and **configurable** — no hard-coded host anywhere. It
  reaches: the Pages custom domain; a Worker route for `/api/*` on that host (spec §5 puts
  site and API on one domain, so the frontend calls relative `/api/...` and no CORS is
  needed — the Worker sends none on purpose, §4.8 item 6); `REPORT_ORIGINS`; the Turnstile
  widget's hostname; `api_url` in the Mac's `config.toml`. Staging and production each get
  their own host. A custom domain also enables Cloudflare's "block AI crawlers" (§4.8 item 5).
- **API contract:** spec §4.4 and the Worker (`worker/src/index.ts` routes, `search.ts`
  response types). Real responses to copy shapes from: `pipeline/tests/fixtures/search/*.json`
  (checked against the Worker by `worker/test/search-contract.test.ts`). Smart responses have
  no `total`; exact ones have `total`, `total_capped` ("1,000+") and `truncated` (past 200:
  "Showing the best 200 of N matches — add words, a "phrase" or `year:`").
- **States the UI must cover:** `smart_degraded` is `"unavailable"`, `"budget"` or `"off"`
  (say why, subtly); every `/api/*` can answer 503 `{error: "maintenance", message}` (show a
  notice) or 429 `{error: "rate_limited"}` with `retry-after`; reports answer 400/403/429/503
  with a friendly `message`. When every hit is `related`, say "no exact matches" before them
  (the `hvlp sprayer year:2020` case: all 50 meaning hits were padding).
- **Result cards:** `related` hits read as secondary (no highlights; cue = chunk start).
  Feed titles repeat the number ("552 – Embarrassed…", "… | Wood Talk 598"): strip it for
  "Ep. N · Title". YouTube first (precise); a small "may start early because of ads" note by
  Apple and Spotify (Checkpoint F, phones). Links come from the API (`episode.links`,
  per-platform `cue_s`); never rebuild them in the frontend (spec §4.6, one link builder).
- **Query syntax** (for the `?` popover; `worker/src/query.ts`): `"phrase"`, `-exclude`,
  `OR`, `word*` prefixes, `year:2015`, `before:2018`, `after:2020` (both exclusive, combine
  into a range), `ep:613`, `include:ads`; 200 characters max. Open question for the
  year-range chips: write `after:`/`before:` into the box (no API change, teaches the
  syntax; the previous session leaned this way) or separate URL params (a Worker change).
  A user-facing `docs/search-syntax.md` is an open idea that would serve both.
- **Reports:** Turnstile was postponed to this plan: one widget per environment, mode
  Managed, "Add widget manually" (not the dashboard's AI "Spin" setup), its site key into
  `wrangler.jsonc` `TURNSTILE_SITE_KEY` (a placeholder now), its secret via `wrangler secret
  put TURNSTILE_SECRET` (staging has Cloudflare's always-pass test secret until then). The
  report's `Origin` must be in `REPORT_ORIGINS` (staging: `http://localhost:5173`, Vite's dev
  server; production: unset, refusing all). After a failed submit the widget must be reset
  before retrying (Task 15 note). Open decision 9 (a footer "Send feedback" link with no
  passage) is to be decided in this plan.
- **"N episodes indexed through <date>"** (spec §5, empty state): no endpoint returns this
  yet (`/api/health` gives only `corpus_version`). `meta.last_published_at` exists in D1.
- **Security** (§4.8 item 6): the frontend's CSP includes `frame-ancestors 'none'`; the site
  gets its own `robots.txt` (allow pages, `Disallow: /api/`) — the Worker's own
  `/robots.txt` (`Disallow: /`) is for the API host on `workers.dev`.
- **Footer** says "made with the hosts' blessing": that is spec §10 item 1, not yet asked.
- Worker tooling notes (Vitest pool, npm 11 for installs) are under "Worker test pointers"
  below; `web/` will need its own `package.json`.

**Waiting on the maintainer (none blocks Checkpoint G):**
- **Turnstile is postponed to plan 3** (maintainer, 2026-10-08). A widget is tied to the
  hostname of the page that embeds it, and there is no web app or domain yet. Use "Add
  widget manually", not the dashboard's AI "Spin" setup, which edits code. Plan 3: one
  widget per environment, mode Managed, real site key into `wrangler.jsonc`
  (`TURNSTILE_SITE_KEY`, a placeholder now) and the secret via `wrangler secret put`.
  Until then reports on staging fail closed (503, no secret set); for Checkpoint G's
  report step, set Cloudflare's always-pass test secret
  `1x0000000000000000000000000000000AA` as `TURNSTILE_SECRET` and use any token.
- **A custom domain (spec §10 item 7)** for the per-IP rate-limit rules (§4.7), which need
  a zone. The edge cache doesn't need one: on `workers.dev` a repeated search answered
  `x-wts-cache: hit` (2026-10-08). Check headers with a GET (`curl -s -D - -o /dev/null
  …`) until Task 16's HEAD routing is deployed, then `curl -sI`.
- ~~Deploy with the re-added `ANALYTICS` binding~~ — done 2026-10-08, no code 10089.

Checkpoint F results (2026-10-07): Worker deployed to staging (`wts-api-staging`,
without the Analytics binding, below); `wts search --env staging` works on the real corpus;
YouTube and Spotify links open at the cue on desktop (Spotify now `?t=<s>`, the format its
own share sheet makes; phones not checked yet; `docs/deep-links.md`). Apple links now
carry `&t=` too, in the form Apple's share sheet makes.
- **Latency** (exact mode, `curl` time to first byte from the maintainer's Mac, no edge
  cache yet, 5 queries × 3): typical 74–141 ms (median ~112 ms), worst 251 ms (the first
  request, a cold start). The common word `wood` (92–132 ms) is no slower than rare ones on
  the 36-episode corpus; the archive has ~17× the chunks.
- **Rows read** (step 6, D1 `meta.rows_read` of the count query): ~3 per matching chunk
  (FTS + `chunks` + `episodes`): `wood` 638 matches → 1,914 rows, `spokeshave` 2 → 6. The
  page query ranks every match, so a search costs ~6 rows per match (count capped at 1,001
  matches). Archive estimate for `wood` (~10,800 matches): ~35k rows per search, i.e. ~140
  such searches a day on Free (5M/day), negligible on Paid (25B/month), which the archive
  needs anyway. No change now; Task 15's edge cache absorbs repeats. If it ever matters:
  rank on `chunks_fts` alone in a subquery and join only the page's 20 rows.
- **Links on the phone** (iOS assumed): YouTube precise, which also confirms the cue times
  on the show's own timeline; Apple a little early; Spotify sometimes 30–60 s early. That is
  the per-listen play-time ad gap (spec §4.6): early, never late, so no offset is applied.
  For plan 3: a small "may start early because of ads" note by the Apple and Spotify
  buttons, and YouTube first on the card (already in spec §5).
- Checkpoint F is done. Android links remain unchecked (`docs/deep-links.md`).

Checkpoint F testing also brought (2026-10-07): corrections for Titebond, Bessey, Roubo,
Schwarz and lumber thickness (`eight quarter` → 8/4; 4/4–16/4), each checked with
`check_corrections.py` on all 36 transcripts on the Mac; `wts search` saying when hits were
folded; and `wts chunk` joining Whisper's split hyphenated words ("split -top" → "split-top",
spec §3.3). Open ideas from that testing: a user-facing `docs/search-syntax.md`; fractions
heard as `3-8` could become `3/8`; porter treats glue/glued/gluing as different words
(`glu*` works) — measure in plan 5's test search set before changing anything.

Analytics Engine (2026-10-07): the first `wrangler deploy --env staging` failed with code
10089 "You need to enable Analytics Engine", and again after enabling it in the dashboard.
Task 15 re-added the binding and the 2026-10-08 deploy accepted it (no 10089 the second
time). `Env.ANALYTICS` stays optional.

How the maintainer works:
- Test-first, one commit per task, straight to `main` (CLAUDE.md). Edit tool for changes.
- Use **Sonnet subagents** where a task is well defined; review their diff, run both test
  suites and commit yourself. Give subagents the API facts below — don't let them work from
  memory (Cloudflare tooling has changed; the docs site is reachable).
- After each task, a **short report** to the maintainer: what was built, test counts, and any
  call made that the plan didn't spell out.
- Record design changes in the spec (source of truth) and in this file.

**Worker test pointers:**
- Pattern: `worker/test/health.test.ts` and `query.test.ts` (import `env` from
  `cloudflare:workers`, seed with `test/seed.ts`; storage is isolated per test file;
  `test/apply-migrations.ts` applies `schema/` before each file). Use
  `env.DB.prepare(...).bind(...).all()`.
- **Never put a raw lone surrogate or NUL in a test name**: Vitest's WebSocket rejects it as
  invalid UTF-8 and the whole file silently drops out of the run (title with
  `JSON.stringify`). Check the test count after a run.
- Workers on the Free plan get only **50 D1 queries per invocation**: keep search to a
  handful of queries per request (Tasks 13–15).
- Commands: `cd worker && npm test`, `npx tsc --noEmit` (strict, `noUncheckedIndexedAccess`).
  **Add npm packages with `npx npm@11 install …`** — npm 10.9 crashes installing vitest 4.1
  (`reading 'edgesOut'`); `npm ci` with npm 10 is fine.

**Pending with the maintainer** (not blocking):
- Ask GitHub Support to purge cached views of commit `a44eec9` (open decision 8).

## State

- **Pipeline** (`pipeline/`, `wts` CLI): plan 1 complete; plan 2 adds secrets, config for
  environments, platform IDs, `wts publish`, ntfy notifications, `wts check-embeddings`,
  `wts search` (with `--limit N`, `--debug`), hyphen joining in `wts chunk`, `wts run --env`
  (publish, backup), `wts backup`, `wts logs`, `wts links`, split-number joining in `wts
  chunk`, new releases scoped by `wts feed`. Session 7: the review fixes, boilerplate
  detection binned (`CHUNKER_VERSION` refresh trigger), state migrations 005–006 and their
  log line. **694 tests**, ruff clean (`cd pipeline && uv run pytest -q`).
- **Worker** (`worker/`): scaffold, wrangler environments, `/api/health`, query parser,
  word times, highlights, cue times, deep links (all three platforms with a time), exact
  `/api/search` with result caps and `?limit=` (page size), smart search (RRF of FTS5 and
  Vectorize) with degraded mode and `?debug=1`, `/api/context`, `/api/report` (Turnstile),
  the edge cache, request logs and Analytics Engine; HEAD answered like GET (Task 16);
  kill switch, per-IP rate limits, daily smart budget with ntfy alerts, security headers,
  report Origin, robots.txt (Tasks 17–19). Plan 3 Tasks 1–4 (`year:A-B`, `folded`,
  `/api/info`, feedback and same-origin reports, robots.txt by environment), the review
  fixes (#3–#5), and since Task 5 the static assets from `web/dist`. **485 tests**,
  type-check clean.
  **Deployed to staging** (2026-10-08; whether Tasks 17–19 are live is the open rate-limit
  item; plan 3 Tasks 1–5 are not deployed yet):
  `https://wts-api-staging.andrei-b94.workers.dev` (`api_url` in the Mac's `config.toml`).
- **Web** (`web/`, plan 3): Task 5's scaffold: Vite + Preact 11, the design's tokens, the
  self-hosted serif, `_headers` with the CSP, the page shell. **13 unit + 4 e2e tests**.
- **Schema** (`schema/0001_init.sql`, `0002_usage.sql`): the D1 contract, tested from both
  halves. `0002` is applied to staging if the maintainer ran step 1 of "Deploying Tasks 17–19".
- **Maintainer's M1 Max** (`~/Library/Application Support/wts/`): 625 episodes ingested;
  **36 in scope** (35 seed + ep71, added 2026-10-07 for its poor-audio call-ins — a good source
  of plan 5 test-search-set queries), all `published` to staging. Platform IDs filled
  (Checkpoint D). Notifications go to the maintainer's own ntfy server.
- **Cloudflare staging:** D1 `wts-staging` (`74cacf06-bbbe-4112-b7b0-8206f3db367b`, committed
  in `worker/wrangler.jsonc`), Vectorize `wts-chunks-staging` (768, cosine, metadata index on
  `year`). 36 episodes, ~4,210 chunks, every chunk now embedded (the 2026-10-09 run
  un-flagged the last boilerplate chunks; exact counts with `wts publish --dry-run` or D1).
  API token: D1 Read+Write, Vectorize Read+Write, Workers AI Read, entire account, expires
  2027-10; in the Keychain and in 1Password (Homelab).

## Checkpoint results

**Checkpoint G, all but the §4.8 parts (2026-10-08)** — everything on staging:
- **Deploy:** Task 16 deployed; `TURNSTILE_SECRET` is Cloudflare's always-pass test secret
  until plan 3's widget.
- **Smart search:** works, not degraded. Relevance notes in the Task 14 entry (bench top,
  #171, `hvlp sprayer`): on-topic hits score ~0.73, padding 0.52–0.60. `hvlp sprayer` found
  #71's real HVLP segment as keyword #2 + meaning #1 (0.731). `year:` works in smart mode.
  The three paraphrase queries are still to do.
- **Context and report:** a report on chunk 625 stored (`id 1`, `open`) and deleted.
- **Caching:** a repeat answers `x-wts-cache: hit` (`curl -sI` now works); a new
  `corpus_version` misses within a minute.
- **Latency** (`time_starttransfer` from the Mac, default smart mode, 5 queries × 3): first
  request 122–250 ms (worst `wood`, 250 ms), repeats mostly 41–97 ms (cache hits; one 142 ms).
  `glue after:2019` used the `after:` filter (exclusive: 2020 on), which smart mode also
  sends to Vectorize as a `$gt` range (spec §4.4).
- **End to end:** `pytest -m mac -k real_rsync` passed with macOS's rsync. `wts run --env
  staging` with nothing new: every step, `backup: ok=1` to the SMB share (`-a` was fine, no
  exit 23). A second run took the new #616 (scoped by hand) through download, transcription
  (2:10 for 35:45, 16.5×), chunk (78; `bad_word_times`, harmless), embed, publish, backup and
  a "published 2 episodes" push in 2:31. The refresh also republished #613: #616 tipped one
  of its chunks into boilerplate (vector removed). `wts logs --level warning` showed nothing
  from these runs (only setup warnings from Oct 5–6).
- **Found and fixed during G (session 6):** `wts chunk` joins split numbers (`10 %` → `10%`,
  re-chunked and published); `wts links`; `transcript_peek.py worst`; new releases are scoped
  by `wts feed` (open decision 3).
- **Offered, not done:** listing only first-time publications in the run notification (#613
  appeared as "published"); turning off Hugging Face's progress bars and HF_TOKEN warning on
  model load; keeping a few dated `state.db` snapshots (the backup is a mirror, not a
  history).

**Checkpoint E passed (2026-10-07)** — seed corpus in staging D1 and Vectorize:
- `wts check-embeddings`: cosine **1.0000** on all 5 chunks (ep085 2011 … ep612 2026), so
  Workers AI with `pooling: "cls"` matches the Mac's vectors.
- `wts notify test` arrived (own ntfy server: `ntfy_url` in config, topic `wts` in the Keychain).
- `wts publish --env staging`: `ok=36 chunks=4210 vectors=4208 in 0:36`; a second publish sent
  nothing. D1 counts match; `corpus_version` `20261007040924`; `chunks_fts match 'dovetail'`
  returns rows; Vectorize reports 4,208 vectors.
- First real use of the APIs settled both open questions: **D1 accepts JSON numbers as params,
  and Vectorize accepts the raw NDJSON upsert body** (no multipart).
- Gotchas met: TOML keys must come before `[env.staging]` or they land in that table; an
  unquoted string now gives a clear config error instead of a traceback.
- Quieter wrangler for the maintainer: `WRANGLER_HIDE_BANNER=true` (works; missing from the
  env-var docs page) and a `d1 "<sql>"` shell function (`… --remote --json --command "$1" |
  jq -c '.[].results[]'`). Running wrangler from any directory leaves a `.wrangler/` cache
  there; it is git-ignored everywhere. `npx` outside `worker/` may pick an older cached wrangler.

**Checkpoint D passed (2026-10-06)** — platform IDs on the real feed:
- Spotify **625 of 625** (seed 35/35). Apple **200 of 625** (seed 25/35), oldest 2017-10-30:
  the lookup's newest-200 limit (decision 4); older episodes get no Apple button until an M2
  fallback. YouTube **89 of 625** matched, **55** within 3 s of the feed (seed 23 matched, 21
  pass). A second `wts feed` added nothing. Spot-checked links (Spotify WT615, WT288, ep1;
  YouTube WT615 0 s off, WoodTalk 582 +1 s) were right.
- The channel's 98 unmatched videos: 39 unnumbered "Wood Talk Live Stream" (2016–2018,
  unedited, would fail the length rule anyway), one "testing live", ~57 shorts/clips ≤ 3 min.
  Clips titled "WT582" led to: matching ignores videos under 10 minutes.
- Spotify's User-Agent handling is fine (bot and curl UAs both answer in < 0.2 s); a first-run
  `ReadTimeout` didn't recur. Platform errors name the failed request (host and path, no query).
  If timeouts return, add a retry. Platform test fixtures are hand-built in each API's shape
  (`pipeline/tests/fixtures/platforms/README.md`); the real Apple response matched.

## Plan 2 task notes (calls the plan didn't spell out)

- **Task 1** `schema/0001_init.sql`: spec §4.1 + `episodes.year`, FTS5 external content with
  insert/update/delete triggers (old values on delete). Chunk writes must upsert with `ON
  CONFLICT(id) DO UPDATE`, never `INSERT OR REPLACE` (REPLACE skips the FTS delete trigger).
- **Task 2** `wts secrets set/check`: Keychain on the Mac (`security` prompts; the value never
  in argv), `WTS_SECRET_<NAME>` elsewhere. Names: `cloudflare_api_token`, `spotify_client_id`,
  `spotify_client_secret`, `youtube_api_key`, `ntfy_topic`, `ntfy_token`.
- **Task 3** config: `[env.*]` tables kept raw (`env_tables`), `envs` derived, so `cfg.env()`
  names each missing key. Also `ntfy_url` (default `https://ntfy.sh`).
- **Task 4** migration 004: platform IDs, offsets, `publications`, `published_vectors`;
  `state.publish_ready()`.
- **Task 5** `wts.platforms`: Apple by guid; Spotify by normalized title ±2 days (day-precision
  dates only); YouTube uploads playlist by number (any title style) or title ±14 days, videos
  ≥ 10 min. Two candidates in a window → unmatched (logged). An ID already stored on another
  episode isn't claimed. `wts feed` prints totals beside this run's matches.
- **Task 6** `wts/cloudflare.py` (Sonnet): `D1.query/batch`, `Vectorize.upsert/delete_by_ids`
  (≤ 1000 per request), retries on 429/5xx/network (1, 2, 4, 8 s or `Retry-After`), token
  scrubbed from errors. `chunked_inserts(table, columns, rows, upsert_on=…)` stays within 100
  params / 50 KB per statement and **skips unchanged rows** (`do update … where a is not
  excluded.a or …`): D1 bills rows written, and each chunk update rewrites its FTS rows.
- **Task 7** `wts publish --env staging|production [--select] [--dry-run]`:
  - `published_vectors` is written *before* the Vectorize upsert and trimmed after the delete,
    so it lists every id that may be in the index; vectors sent before a failure are still
    deleted if a re-chunk then drops their chunk (tested).
  - Gone chunks: `delete … where id not in (select value from json_each(?))`, one JSON param.
  - The digest covers the episode row (platform IDs after the 3 s YouTube rule, offsets),
    chunks and vectors, plus `DIGEST_VERSION`.
  - A failed `corpus_version` bump is retried on the next run (`kv` flag).
  - The CLI checks config and token before starting (not for `--dry-run`).
  - Known gap: an episode in `error` isn't re-chunked by a corrections refresh; a publish
    failure on an already-published episode leaves it in `error` until a publish succeeds.
- **Task 8** `wts/notify.py` (Sonnet), `wts notify test`: ntfy JSON publishing (`POST
  <ntfy_url>/`, topic in the body — titles are non-ASCII and the topic stays out of URLs and
  error text), optional bearer `ntfy_token`. `wts run` sends one summary (published; failed
  this run, marked when out of retries — not repeated every run; feed quiet > 45 days, when a
  spell starts then weekly), a high-priority push for a `MachineProblem`, and one for a feed
  fetch failure, after which the run continues. Tests pin the quiet threshold (`quiet_feed`
  fixture) so they don't depend on today's date. Task 16 must keep `notify_run` last.
- **Task 9** `wts check-embeddings [--n 5]` (Sonnet): one middle chunk from each of up to n
  episodes spread by date, one Workers AI request with `pooling: "cls"`, exit 1 below 0.99.
- **Task 10** `worker/` (Sonnet):
  - `@cloudflare/vitest-plugin` 1.3.x (Cloudflare's replacement for vitest-pool-workers;
    `readD1Migrations` imported from the package root), vitest 4.1, wrangler 4.148, TS 7.
  - Runtime types from `wrangler types`, committed as `worker-configuration.d.ts` (623 KB, as
    the docs suggest; `npm run types:check`). `Env` hand-written in `src/env.ts`; `VEC` is
    `Vectorize` (v2).
  - `wrangler.jsonc`: top level is local/test only (just `DB`) — with `ai` in the tested
    config the plugin opens a remote proxy and needs a token. **Fake AI, Vectorize and
    Analytics in tests through `miniflare` options** (Cloudflare's ai-vectorize recipe).
    `env.staging` / `env.production` declare all five bindings (`wts-api-staging` /
    `wts-api-production`). Never deploy without `--env`.
  - `/api/health`: one D1 query; query throws → 503 `unavailable`; missing `corpus_version` →
    500; unknown route → 404 `not_found`; one JSON `console.error` line per error, no IP,
    query string or stack.
- **Task 11** `worker/src/query.ts` (Sonnet): `parseQuery()` → `{fts, semantic, filters,
  includeAds, terms, exclude}`; rules in spec §4.3. Calls beyond the plan:
  - `exclude` (excluded terms ORed, an FTS5 expression) added for Task 14, which must drop
    excluded vector hits (`rowid not in (… match exclude)`).
  - `terms` are already FTS5-quoted (`"pref"*` keeps its star): Task 14 joins them with
    ` OR ` and never quotes user text itself.
  - Malformed filters (`year:abc`, `ep:`) are searched as plain words; `OR` with nothing on
    one side is ignored; `"phrase"*` drops the `*` (prefixes are on words only).
  - Tests: 63 table cases, each run against the test D1 (with expected rows where it
    matters); 500 seeded fuzz inputs checked to be quoted strings plus operators only and
    accepted by FTS5; the worst case (100 ANDed terms, 66 exclusions) within FTS5's depth.
- **Run cadence (for M2's launchd job):** daily, early morning local time. Releases are mostly
  Wednesdays, every ~13 days (breaks up to 36 days in 2026, 68 in 2025); an idle run is a few
  requests and ~8 YouTube quota units; daily runs also catch YouTube uploads that land late.

- **Task 12** `worker/src/{wordtimes,highlight,links}.ts` (Sonnet). How they fit together,
  with real `highlight()` output: [`docs/word-times-and-highlights.md`](word-times-and-highlights.md).
  - Codec contract `worker/test/fixtures/word_times.json`, checked by both halves
    (`test_word_times_match_worker_fixture`). Decoding never throws; bad input → cue from
    `start_ms`.
  - Highlight ranges are UTF-16 offsets (spec §4.4); `firstToken` = spaces before the first
    range. FTS5 marks a phrase (and a quoted `T-square`) as one span.
  - `cueTimes()` gives the API's `cue_s`; `deepLinks()` omits a link whose ID (or
    `page_url`) is null, so `page` is optional (the plan had it always present).
  - All platform links carry the cue (revised at Checkpoint F): YouTube `&t=<s>s`, Spotify
    `?t=<s>`, Apple `…/us/podcast/wood-talk-woodworking/id251471480?i=<id>&t=<s>`, the last
    two copied from each app's own "share from current time" link (`docs/deep-links.md`).
- **Task 13** `worker/src/search.ts`, `GET /api/search` (Sonnet). Response shape and
  collapsing rules in spec §4.4.
  - One `env.DB.batch()` of two statements (count, page) per search; none when `fts` is
    null. SQL only from fixed fragments (ORDER BY from a table); `fts`, filters, LIMIT and
    OFFSET bound. A test checks query text never reaches the SQL.
  - **Until Task 14, `mode=smart` (the default) returns the exact results with
    `smart_degraded: true`**, the same keyword-only answer smart mode gives when AI or
    Vectorize fail. Task 14 replaces it.
  - `sort` is case-insensitive; `page` must be digits (else 1), clamped to 1–10.
  - bm25 favours short chunks, even with one occurrence (a test had to use `sort=oldest`
    to pin collapse behaviour).
  - **Result caps (maintainer, 2026-10-07):** exact shows at most 10 pages (200 results);
    past that `truncated: true` and the client suggests narrowing ("Showing the best 200
    of N matches — add words, a "phrase" or `year:`"). The count stops at 1,000
    (`total_capped`, "1,000+"). Tests in `worker/test/search-caps.test.ts` (1,001 chunks).
  - **Watch: rows read.** The count is capped now, but the sorts still look at every
    matching chunk to find the best 20. Checkpoint F step 6 measures it; Task 15's edge
    cache helps.
  - The test search set gets a `collapse` tag (spec §7.2) for `more_in_episode`
    scenarios — maintainer's request, for plan 5.
- **Task 13a** `wts search` (`pipeline/src/wts/search.py`, Sonnet; added 2026-10-07, the
  maintainer's idea): a terminal client of `/api/search` for the maintainer only (no listener
  tool, no offline search over `state.db`). Spec §3.2, plan Task 13a.
  - `search()` (plan 5's `wts eval` and smoke search reuse it) retries network errors, 429
    and 5xx at 1 and 2 s; errors never contain the query. `format_results()` converts the
    UTF-16 ranges; bold on a TTY, `[brackets]` otherwise.
  - New optional `[env.<name>] api_url` (`Config.api_url()`); `wts publish` doesn't need it.
  - Unknown options pass into the query so `wts search hide glue -titebond` works; a
    mistyped option is therefore searched for as words (said in `--help`).
  - The Python fixtures (`pipeline/tests/fixtures/search/`) are hand-built; a Worker test
    (`worker/test/search-contract.test.ts`) checks their keys and types against a real
    response, each fixture against a response of its own mode (Task 14).
  - Checked end to end against `wrangler dev --local` with a hand-seeded D1: exclusion,
    cue times, highlights after an emoji, `include:ads`, `--json`, missing `api_url`.
  - `click.get_text_stream` is deprecated in click 8.5; the CLI uses `sys.stdout.isatty()`.
- **Task 14** `worker/src/fusion.ts` (`rrf`, `sortByDate`, `collapse`, moved out of
  `search.ts`), `smartSearch()` in `search.ts`. Response and steps in spec §4.4. Written in
  the main session, not by a subagent: the shape decisions and the code were intertwined.
  Calls the plan didn't spell out:
  - **Smart response shape:** `{page, limit, has_more, results, mode, sort,
    smart_degraded?}`, no `total`/`total_capped`/`truncated`, degraded or not. Degraded is
    the keyword list (FTS5 top 50) through the same fusion, date sort, collapse and paging,
    so it has the smart caps, not exact's 200.
  - **Collapse the whole fused list, then page** (exact collapses per page): all ≤ 100 hits
    are in hand. A related hit can absorb a keyword hit ranked below it (same rule as exact).
  - **Pages:** `maxSmartPage(limit) = ceil(100 / limit)`; the route picks the cap by mode.
  - **RRF ties** keep first-appearance order (keyword list first), so a keyword hit wins a
    tie with a meaning hit of the same rank.
  - **`related`** = not in the FTS5 top 50, even if the chunk has every query word (ranked
    51+). Its cue is always `start_ms` (spec §4.5), highlights or not.
  - **Related highlights split phrases into words** (maintainer, after staging showed
    `"lacquer spray"` giving 20 unhighlighted `related` hits: the exact phrase is rare,
    speakers say "spray lacquer"). `parseQuery().terms` now lists a phrase's words, not the
    phrase; it has no other consumer. **`terms` also leaves out `HIGHLIGHT_STOPWORDS`**
    (`query.ts`, ~100 function words, none with a shop meaning: "up", "top", "back", "off"
    stay; maintainer's call), so "how do I flatten a workbench top" marks only flatten,
    workbench, top. Prefixes (`the*`) are kept. All-stopword queries skip the highlight
    statement (MATCH '' is an error). Matching, ranking and embedding are unchanged.
    Exact `"lacquer spray"` finds 0 on staging, so its all-`related` answer was right.
  - **Keyword hits drop stopword highlights too, and cue on the first remaining word**
    (maintainer, after `flattening a bench top` on staging marked eight `[a]`s in one
    chunk and cued #611 on "a job" ~15 words before "flatten"; spec §4.5 revised).
    `withoutStopwords()` in `highlight.ts`; phrase spans stay whole; all-stopword
    highlights are kept so a hit never loses its cue. Matching still requires the
    stopwords (harmless: nearly every chunk has "a").
  - **Relevance, for plan 5** (maintainer, same search): related hit **#127 at 44:28**
    ("put the cup side down … into the bench top. And plane it") is about planing a
    workpiece *on* a bench top, not flattening the top itself; the embedding matches the
    vocabulary. Add it to the test search set as a non-relevant judgement for
    `flattening a bench top`. Candidate fixes to measure there, not before: bge's query
    instruction (`Represent this sentence for searching relevant passages: `, which BAAI
    suggests for short queries; plan 2 chose none), a similarity floor for `related`
    hits (needs Vectorize scores, so the debug output offered in session 5), or fewer
    vector hits (topK 50 → 20–30). **`--debug` on staging (2026-10-08): #127 is meaning
    #1 at cosine 0.734**, above another related hit at #4 (0.708), so no floor can drop it
    without dropping every meaning hit for this query; it folds 3 more chunks (the
    episode planes a cupped board on the bench for ~2 minutes). RRF already holds it at
    1/61 below hits found both ways (~0.03). Maintainer: leave the fix to plan 5; test the
    query instruction first, then keyword-weighted RRF; smaller chunks only if both fail.
    **Second data point (2026-10-08):** `how do I flatten a workbench top` returned #171's
    listener-question answer on strengthening miters (glue size, sanding) as a `related`
    hit: meaning #26 at cosine 0.660, RRF 0.0116, folding chunk 623. The off-topic hits span
    0.734 (#1) to 0.660 (#26), so a floor still can't separate them; topK 20–30 would drop
    this one. The question form ("how do I…") seems to pull in Q&A answers by tone, which is
    what bge's query instruction targets. Add it to the test search set as non-relevant.
    **Third data point (2026-10-08):** `hvlp sprayer year:2020`: 0 keyword hits, all 50
    meaning hits from #466 (outdoor oil; likely the seed's only 2020 episode) at cosine
    0.519–0.592, e.g. a chunk on sawhorses and a shave horse. With a filter that leaves a
    tiny pool, topK 50 returns padding. Here an **absolute floor** (~0.6) on related hits
    would have given the honest "nothing" — unlike the bench-top case, where off-topic hits
    scored 0.66–0.73. Tune it on the test search set (short and acronym queries may score
    low overall); plan 3 should say "no exact matches" when every hit is `related`.
  - **For plan 3:** feed titles repeat the number ("552 – Embarrassed…", "… | Wood Talk
    598"), so a card's "Ep. N · Title" shows it twice; strip it for display.
- **Task 15** `worker/src/{context,report}.ts` (Sonnet subagent, reviewed and amended),
  `worker/src/{cache,analytics,http}.ts`, the router in `index.ts`, `?debug=1` in
  `search.ts`, `wts search --debug`. Shapes and layouts in spec §4.4, §4.7, §8.3. Calls the
  plan didn't spell out:
  - **The cache is switched on by a var, `SEARCH_CACHE_TTL_S`** ("3600" in both deployed
    envs), not always on: tests repeat queries with different fake Vectorize answers and
    would otherwise get each other's cached results. Every search answer has
    `x-wts-cache: hit|miss|skip` (for Checkpoint G). Key = whitespace-normalized `q` (case
    kept: `OR`), mode, sort, page, limit as the route read them, `corpus_version` (read ≤ once
    a minute per isolate). Not stored: degraded, `debug=1`, errors. The put is awaited, not
    `waitUntil` (deterministic in tests, a millisecond-scale local write).
  - **Logs and analytics live in the router**, from a `RequestInfo` the search route fills,
    so every request gets exactly one line (404s and 503s too) and `report.ts` doesn't know
    about analytics. Report data points carry only the status.
  - **Debug output:** smart mode only (exact ignores `debug=1`). `dropped` lists meaning hits
    not shown; `vector_hits` is null when degraded. `collapse()` takes an `onFold` callback.
  - **Report, amended after review:** Turnstile refusing *our* secret
    (`invalid-input-secret`, `missing-input-secret`) is 503 + log, not a silent 403 for
    every listener (the subagent's flag); a Content-Length over 48 KB is refused before the
    body is read. `json`/`logError` moved to `http.ts` (the subagent had copies).
  - Subagent's calls kept: a chunk id must be a JSON number; lone surrogates in report text
    → 400; siteverify gets a 5 s timeout and no client IP; an unknown chunk is found after
    Turnstile (the frontend must reset the widget before a retry); mocking siteverify needs
    a Response built inside the mock (`answerWith`), else "Cannot perform I/O on behalf of a
    different request". The subagent's worktree was cut from `main`, not the session branch;
    its commit was cherry-picked.
  - Mutation-checked (cache degraded/debug/version/memo/headers, log cut, analytics
    warn-once and report point): each fails a test.
  - **Vectorize:** `topK: 50`, `returnValues: false`, `returnMetadata: "none"`; anything past
    50 and ids that aren't digits are dropped. `year:` sends `$eq` alone (Vectorize can't
    combine `$eq` with a range); D1 re-applies every filter and the exclusions when loading
    related chunks, so a filter Vectorize misses (vectors from before the metadata index)
    still holds.
  - **D1 per smart search:** one query for the keyword list (in parallel with the
    embedding), then one batch of two (related rows; their highlights) only when Vectorize
    added new chunks. No count query, so fewer rows read than exact.
  - **Degraded triggers:** `AI.run` or `VEC.query` throwing, a missing binding, or an AI
    answer without a numeric embedding. One log line, `ai_unavailable` or
    `vectorize_unavailable` (error text, no query). D1 errors still give 503.
  - **Tests fake AI and Vectorize by passing them in the env to `worker.fetch()`** (the
    unit style of Cloudflare's ai-vectorize recipe), not through miniflare options: each
    test picks its own vector hits or failures. `exports.default.fetch()` has neither
    binding, so smart mode through it is degraded. Tests were written alongside the code;
    each key behaviour was then checked by mutation (pooling, exclusion, topK, date sort,
    related cue/highlight/filters, RRF math): every mutation fails a test. The 100 cap
    can't be reached (50 + 50) and has no test of its own.
  - `wts search` prints `related` after the time on a meaning-only hit's title line; new
    fixture `smart.json`.
  - Open (plan 5): ep filter isn't in Vectorize (only `year` is indexed), so `ep:250` in
    smart mode gets few meaning hits — only the corpus-wide top 50 that fall in ep 250.
    A metadata index on `episode_id` would fix it if the test search set shows a need.

- **Task 16** `pipeline/src/wts/{backup,logs}.py`, `run_all(…, env=)`, `wts run --env`,
  `wts backup`, `wts logs`; Worker HEAD routing. Written in the main session. Calls the plan
  didn't spell out:
  - **Order:** publish → backup → `notify_run` (still last). Backup runs whether or not
    anything was published, and also without an env; a `MachineProblem` still stops the run
    before publish and backup (the NAS is likely gone for both).
  - **The CLI resolves the env** (`--env`, else `run_env`) and checks config and token
    before starting, like `wts publish`: a bad `run_env` or missing token fails at once
    (exit 2 or 1), not after hours of transcribing. `run_all(env=None)` skips publish.
  - **Backup:** `backup_dir` is created if its parent exists, else `BackupFailed` "not
    reachable (is the share mounted?)", like the audio folder. The snapshot is written as a
    single file (`journal_mode = DELETE`): copied from a WAL database it would otherwise
    stay WAL, and opening the backup would leave `-wal`/`-shm` beside it — which the next
    rsync keeps (excluded files are safe from `--delete`), a stale `-wal` beside a newer
    snapshot. Excludes also cover the live `state.db-wal` and `-shm`. rsync exit 24 (files
    vanished mid-copy) is a logged warning, not a failure; 30-minute timeout; missing rsync
    → `BackupFailed`. Counts: `backup: ok=1`, `error=1`, or nothing when `backup_dir` is
    unset. **Watch at Checkpoint G:** `-a` sets permissions; if the SMB share refuses
    (`failed to set permissions`, exit 23), switch to `-rlt`.
  - **`wts logs`:** `--episode` matches part of a stem (`ep312`), not only the whole stem;
    `--run` is exact (the id printed after the time). Readable lines are `local time, run
    id, [level step episode] msg` plus the last line of any traceback. `--since` takes a
    positive number and `m`/`h`/`d`; anything else is a usage error. A line without string
    `ts`, `level` and `msg` is skipped; with `--since`, so is one whose `ts` doesn't parse.
    Note: log `run_id`s (one per command) are not the `runs` table's ids (one per step).
  - **HEAD** runs the GET route; workerd drops the body itself (checked by mutation: an
    explicit empty body changed no test, so it isn't there). The log line says `HEAD`; a
    HEAD search writes no Analytics Engine point (a header check isn't a search), but does
    fill the cache.
  - `test_real_rsync_copies_the_app_folder_but_not_audio` is `mac`-marked (handoff: no real
    rsync in the default run); it also passes on Linux with rsync installed.
- **Tasks 17–19** (spec §4.8; main session, 2026-10-08): `worker/src/{guard,ratelimit,
  budget}.ts`, `schema/0002_usage.sql`. Calls the plan didn't spell out:
  - The router order: maintenance (503, no D1) → rate limit (429, no D1) → route; security
    headers are added to whatever comes out, cache hits and 500s included.
  - `smart_degraded` is `"unavailable"`, `"budget"` or `"off"`; `wts search` prints the
    reason (an older Worker's `true` still prints without one).
  - Budget: counted after the cache lookup and before the embedding (one more D1 statement
    per uncached smart search; the existing statement-count tests now include it). Half
    alert at `smart >= ceil(budget/2)`, full at `smart > budget`; whichever request flips
    `alerted_*` posts (mutation-checked). Debug searches count; an empty query doesn't.
  - `NTFY_URL` is a secret, not a var, so the homelab address stays out of the public repo.
  - A 429 for a search is in the request log, but writes no Analytics Engine point.
  - `RL_*` and the budget vars are optional: without them (tests, local) nothing is limited
    and the budget is 20,000.
- **`wts links <ep> [--at 12:34]`** (after Task 16, maintainer's request): an episode's
  links from `state.db`, by the Worker's rules (`wts/links.py` mirrors `links.ts`; YouTube
  via `publish.youtube_id_for_publish`), plus the feed's audio URL. A YouTube match that
  fails the 3 s rule is printed with its drift instead of a link. `--at` applies the
  platform offsets but no 7 s lead-in. Takes a number or any selector.

Checkpoint G's rest (the rate-limit binding, the paraphrase queries) follows the §4.8 tasks.
Plans 3–5 (frontend, review tool, test search set) are written after that.

## Cloudflare facts (checked against the docs, session 3)

- Docs are reachable here; append `index.md` to a page URL for Markdown, e.g.
  `https://developers.cloudflare.com/d1/platform/limits/index.md`.
- D1: 100 bound params and 100 KB per statement; Free plan 50 D1 queries per Worker
  invocation (1000 on Paid). REST `query` body `{sql, params}` or `{batch: [...]}`, one
  `{results, success?, meta}` per statement (`success` optional). JSON number params work.
  `json_each(?)` is the documented way to pass a list.
- Vectorize HTTP: upsert ≤ 5000 vectors and 100 MB per request (we send 1000), raw NDJSON
  works; response `result.mutationId`. Query `topK` ≤ 50 with values/metadata, ≤ 100 without.
  A metadata index only covers vectors upserted after it exists.
- Workers AI `@cf/baai/bge-base-en-v1.5`: body `{text: [...], pooling: "cls"}` (default `mean`
  is incompatible with the Mac's vectors); result `{shape, data, pooling}`.
- **Pricing that matters:** D1 bills rows written (Free 100k/day; Paid 50M/month). A chunk
  write costs ~5–10 rows with its index and FTS rows. Unchanged rows are skipped, so a
  one-sentence correction writes one chunk. A full re-chunk of the archive (~72k chunks,
  ~400–700k rows) needs Paid. Vectorize bills stored + queried dimensions, not upserts; Free
  stores 5M dimensions (~6,500 vectors) — the seed fits, the archive (~55M) needs Workers Paid
  (cents a month).

## Cloud session environment (session 3)

- Reachable: Acast (`feeds.acast.com`, `sphinx.acast.com`), PyPI, npm, GitHub,
  `developers.cloudflare.com`. Node 22 and npm 10 are installed.
- Blocked: `itunes.apple.com` and every `spotify.com` host; no Cloudflare credentials.
- Only the 15-minute fixtures of ep001 and ep610–615 are here; full transcripts, audio and
  `state.db` live on the maintainer's Mac.
- Maintainer tips: run `uv run wts …` from `pipeline/` (from the repo root `uv` fails with
  ``Failed to spawn: `wts` ``); use `sqlite3 -init /dev/null -list` (skips their `~/.sqliterc`,
  whose column mode and headers otherwise win). `uv run wts paths` shows `config.toml`.
- Corrections and vocabulary are a separate, out-of-band session
  (`.claude/skills/corrections/`); don't mix them into plan 2 work.

## Read first

- Spec (source of truth): [`docs/superpowers/specs/2026-10-04-wood-talk-search-design.md`](superpowers/specs/2026-10-04-wood-talk-search-design.md)
- Plan 3 (frontend; written 2026-10-08, Tasks 1–5 done, Task 6 next): [`docs/superpowers/plans/2026-10-08-m1-frontend.md`](superpowers/plans/2026-10-08-m1-frontend.md)
- Design: [`docs/design/system/README.md`](design/system/README.md) (with tokens and mocks) and
  the brief [`docs/design/BRIEF.md`](design/BRIEF.md)
- Full-corpus backlog (what waits on the archive): [`docs/full-corpus-backlog.md`](full-corpus-backlog.md)
- Plan 2 (Tasks 1–19, Checkpoints D–F done; G all but the §4.8 parts): [`docs/superpowers/plans/2026-10-05-m1-publish-and-api.md`](superpowers/plans/2026-10-05-m1-publish-and-api.md)
- M2 plan A, moving the pipeline to the Mac Mini (draft 2026-10-08, four decisions open; dev
  stays on the M1): [`docs/superpowers/plans/2026-10-08-m2-mac-mini-migration.md`](superpowers/plans/2026-10-08-m2-mac-mini-migration.md)
- Plan 1 (done, Checkpoint C 2026-10-05): [`docs/superpowers/plans/2026-10-05-m1-pipeline-core.md`](superpowers/plans/2026-10-05-m1-pipeline-core.md)
- Conventions: [`CLAUDE.md`](../CLAUDE.md). Superpowers skills install from `.claude/settings.json`.

## Plan 1 results (Checkpoints B and C, second session)

- **Checkpoint B:** transcripts of ep001 and ep610–615 in `pipeline/tests/fixtures/real/`,
  trimmed to 15 minutes (the repo is public). `test_real_transcripts_clean` passes;
  `test_real_sponsor_reads_flagged` is an expected failure (open decision 7): Whisper
  punctuates the same sponsor read differently per episode (word-set Jaccard ~0.6 < 0.8), and
  reads come in short pieces between live talk, so 30 s chunks are only 25–40% boilerplate.
  Word 6–8-grams shared by ≥ 5 episodes do find the reads — the phase 2 approach.
- **Speed** (M1 Max, `large-v3-turbo`): 16–18× realtime, ~3.3 min per hour of audio; the full
  archive (~620 h) ≈ 35 h.
- **Checkpoint C:** 35 embedded; chunk 35 → 4,036 chunks, 2 boilerplate. Flags all harmless:
  `loop_cut` on ep602/ep613 (real repetition); `bad_word_times` on ep597/ep602 (words Whisper
  invented after the audio ends, kept and re-timed — **possible guard tweak**, needs the
  maintainer's OK and spec §3.3: drop words that start after the audio's end). Misheard
  brands/terms became corrections (`cbffe4e`, applied to the seed in session 3). Marc vs Mark
  has no safe global rule.

## What we learned from the real feed

- **Feed:** Acast, `https://feeds.acast.com/public/shows/65a70f971a69290016a72737` (via
  `itunes.apple.com/lookup?id=251471480` → `feedUrl`). 625 episodes, 2007–2026.
- **Episode numbers** come in many title styles (`#85`, `WT127`, `WT 607`, `Wood Talk 595`,
  `552 -`, `| 609`, `Wood Talk #603`); a side series (**Board Meetings #1–3**, 2011) and seven
  **"NNN Extra"** episodes (2016) are stored unnumbered (spec §3.4).
- **Acast inserts ads per download unless the User-Agent looks like a bot** (spec §3.2, §4.6):
  `curl` and `…Bot` (capital B; case-sensitive) get none; httpx's default and unknown UAs do.
  `wts` sends `WoodTalkSearchBot/<version> (+https://github.com/andreiz/wt-search)`
  (`wts/net.py`). If ad-laden copies reappear, check the IP before the User-Agent.
  - Ad copies: 24–182 s longer than `itunes:duration` (the show's own length); slots are a
    pre-roll, a post-roll and on many episodes one or two mid-rolls at fixed show times,
    each filled with 0–4 min of ads per download (20 of 41 copies had mid-rolls). This is what
    Apple/Spotify listeners get at play time, so platform links land early (spec §4.6).
  - Acast re-encodes the stitched file, so ad boundaries can't be read from MP3 frames.
  - The show opens with a ~2 s sting (2014–2026); none 2007–2013.
- **YouTube** (@WoodTalk): sporadic from WT322 (2016); livestream-era videos are unedited and
  longer; recent videos match the feed exactly. Rule: link only within 3 s of
  `itunes:duration` (spec §4.6), applied at publish.

## Spikes (`pipeline/spikes/`)

- **Keep** until plan 4's review tool replaces them: `transcript_peek.py` (`read <ep>`,
  `suspects`, `issues <ep>`, `worst <ep>`) and `check_corrections.py`. `worst` (session 6,
  for finding ep71's call-ins) ranks 60 s stretches by the share of words below probability
  0.5, every word counted, stretches under 20 words skipped; plan 4's review tool could
  borrow it to point reviewers at poor audio.
- **Done, deletable:** `ad_fingerprint.py` (pair comparison by Chromaprint; its cross-episode
  mode is untested) and `preroll_finder.py` + results (finds the pre-roll on 2014–2026 copies,
  but mid-rolls make it insufficient). Ad-free downloads made timeline correction unnecessary;
  the length check and `ads_inserted` flag stay as a safety net (`AD_FREE_ATTEMPTS = 2`).

## Open decisions for the maintainer

1. ~~Timeline correction~~ — resolved: bot User-Agent.
2. ~~Retries~~ — resolved: `AD_FREE_ATTEMPTS` 2, as a safety net.
3. ~~New feed episodes aren't auto-added to scope~~ — resolved 2026-10-08 (option a): `wts
   feed` scopes a new item at least as new as the newest stored one (spec §3.1).
4. `wts vocab suggest` (candidate terms from feed titles/show notes into `vocab.txt`) —
   proposed, not approved.
5. ~~Is the repo public~~ — it is; real fixtures are trimmed to 15 minutes.
6. ~~Plan 2's six decisions~~ — confirmed. D1 REST (non-atomic, idempotent) for now; an
   atomic publish route in the Worker before production (spec §10 item 9).
7. ~~Boilerplate detection on real data~~ — **binned 2026-10-09** (maintainer): the detector
   flagged 2–3 of 4,210 seed chunks and missed the sponsor reads; it is removed until the full
   corpus can be measured ([`docs/full-corpus-backlog.md`](full-corpus-backlog.md) §1, spec
   §3.5). `test_real_sponsor_reads_flagged` went with it.
9. ~~General listener feedback~~ — resolved 2026-10-08 (plan 3 brainstorm): a footer "Send
   feedback" link posts to `/api/report` with no `chunk_id` (spec §4.4, §5.5; plan 3 Task 4,
   plan 4's `wts reports` lists them as feedback). Corrections stay an ongoing background
   effort while the app gets built.
8. ~~Full transcripts in public history~~ — removed by rewriting `main` (second session).
   Left: ask GitHub Support to purge cached views of `a44eec9`. Clones from before the rewrite
   must `git fetch && git reset --hard origin/main` before committing.

## Rulings made during plan 1 (with cost if wrong)

- Steps take episode ids; the CLI and `run_all` resolve selectors. — none.
- Checkpoint A didn't block coding. — a feed quirk found later needed a small fix (stems).
- Log-dir test made platform-neutral. — none.
- `wts feed` refuses > 5 URL-change resets without `--force` (spec §3.1). — one extra
  `--force` run on a real host move.
- Boilerplate similarity uses word sets, not 5-word shingles; spec §3.5. — more false
  positives on generic sentences.
- Repetition-loop guard stricter than first spec; spec §3.3. — some short loops survive.
- Empty correction value deletes words, moving sentence-end punctuation to the previous word.
- Download length check: fail only if > 2% shorter or > 10 min longer than the feed; spec §3.2.
- Side-series numbers dropped when > 30 from the median within ±120 days; spec §3.4.

## Deferred minor issues

- `db.py`: `executescript` commits before the `user_version` bump (crash window in migration).
- No `fsync` before transcript/embedding renames.
- `storage`: `mkdir` `PermissionError` isn't mapped to `StorageUnavailable`; no mount check.
- Runs stopped by `MachineProblem` are recorded with `errors=0`.
- `FeedResult.updated` counts every row; `reset` also counts episodes already `new`.
- `httpx.Client` never closed.
- Whisper prompt cap counts words, not tokens (fine until `vocab.txt` grows).
- Stem date is the UTC date (US-evening releases get the next day).
- `seed_ids(sampled=1)` divides by zero (not reachable from the CLI).
- Very long unpunctuated sentences are cut at 45 s, not ~30 s.
- ~~Boilerplate refresh is single-pass; after a corrections change it converges next run~~ —
  that was wrong (nothing re-ran it); now two-pass (review #8, 2026-10-09).
- Refresh can reset episodes outside `--select` to `chunked`; `wts embed` covers the selection.
- Boilerplate 6-word minimum counts tokens, not distinct words.
- Correction matches can cross a sentence end.
- Embedding cache doesn't record model/dim; a corrupt `.npz` fails the episode.
- Weak ETags can't be used with `If-Range`; Ctrl-C can wait up to the 60 s timeout.
- ~~A feed fetch failure stops `wts run`~~ — fixed in plan 2 Task 8.
- Process slips (all normal diffs): a heredoc append in plan 1 Task 12 and in plan 2 Task 3's
  tests; `sed` edits to `preroll_finder.py` (session 2) and two one-line handoff edits
  (session 3); one `sed` edit to the handoff's plan-status line (session 4); a Python edit
  to `worker/src/index.ts`, `sed` edits to five import lines and the handoff's test count,
  and a heredoc append to `highlight.test.ts` (session 5, Task 14 and its follow-ups); a
  heredoc append of Task 16's tests to `test_run.py` and `sed` edits to the handoff's test
  count and title line (session 6); a `sed` edit to the handoff's plan 3 line in "Read
  first" (session 7); the docs commit `8988c73` also took two staged `git rm`s of a subagent
  working in the same checkout, so it doesn't build alone (`67e1300` completes it; session 7).
