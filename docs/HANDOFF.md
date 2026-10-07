# Handoff — 2026-10-07 (after the third session)

Where the project stands, so a fresh session can pick up without the conversation. Read this,
then [README.md](../README.md), then the spec sections it points to.

## Start here (next session)

**Plan 2: Tasks 1–13a and Checkpoints D and E are done. Next: Checkpoint F** (maintainer:
deploy the Worker, add `api_url` under `[env.staging]`, exact search on staging with
`wts search`, cue times, rows read), then Task 14 (smart search).

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
  environments, platform IDs, `wts publish`, ntfy notifications, `wts check-embeddings`.
  **484 tests**, ruff clean (`cd pipeline && uv run pytest -q`).
- **Worker** (`worker/`): scaffold, wrangler environments, `/api/health`, query parser,
  word times, highlights, cue times, deep links, exact `/api/search`. **191 tests**,
  type-check clean.
  Pipeline: **575 tests** (with `wts search`).
- **Schema** (`schema/0001_init.sql`): the D1 contract, tested from both halves.
- **Maintainer's M1 Max** (`~/Library/Application Support/wts/`): 625 episodes ingested;
  **36 in scope** (35 seed + ep71, added 2026-10-07 for its poor-audio call-ins — a good source
  of plan 5 test-search-set queries), all `published` to staging. Platform IDs filled
  (Checkpoint D). Notifications go to the maintainer's own ntfy server.
- **Cloudflare staging:** D1 `wts-staging` (`74cacf06-bbbe-4112-b7b0-8206f3db367b`, committed
  in `worker/wrangler.jsonc`), Vectorize `wts-chunks-staging` (768, cosine, metadata index on
  `year`). 36 episodes, 4,210 chunks, 4,208 vectors (2 boilerplate chunks aren't embedded).
  API token: D1 Read+Write, Vectorize Read+Write, Workers AI Read, entire account, expires
  2027-10; in the Keychain and in 1Password (Homelab). The Worker is **not deployed** yet.

## Checkpoint results

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
  - Apple link `https://podcasts.apple.com/podcast/id251471480?i=<id>` (no country or slug:
    to be checked by hand). Apple and Spotify carry no time until `docs/deep-links.md` says
    a format works; a test pins that.
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
    response. **When Task 14 drops `total` from smart mode, that test fails on purpose:
    update `smart_degraded.json`.**
  - Checked end to end against `wrangler dev --local` with a hand-seeded D1: exclusion,
    cue times, highlights after an emoji, `include:ads`, `--json`, missing `api_url`.
  - `click.get_text_stream` is deprecated in click 8.5; the CLI uses `sys.stdout.isatty()`.

Checkpoints still ahead: **F** after Task 13a (deploy, exact search, cue times), **G** after
Task 16 (smart search, report, caching, `wts run --env staging` end to end). Plans 3–5
(frontend, review tool, test search set) are written after Checkpoint G.

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
- Plan 2 (Tasks 1–13a, Checkpoints D–E done; Checkpoint F next): [`docs/superpowers/plans/2026-10-05-m1-publish-and-api.md`](superpowers/plans/2026-10-05-m1-publish-and-api.md)
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
  `suspects`, `issues <ep>`) and `check_corrections.py`.
- **Done, deletable:** `ad_fingerprint.py` (pair comparison by Chromaprint; its cross-episode
  mode is untested) and `preroll_finder.py` + results (finds the pre-roll on 2014–2026 copies,
  but mid-rolls make it insufficient). Ad-free downloads made timeline correction unnecessary;
  the length check and `ads_inserted` flag stay as a safety net (`AD_FREE_ATTEMPTS = 2`).

## Open decisions for the maintainer

1. ~~Timeline correction~~ — resolved: bot User-Agent.
2. ~~Retries~~ — resolved: `AD_FREE_ATTEMPTS` 2, as a safety net.
3. M2: new feed episodes aren't auto-added to scope, so a scheduled `wts run` would skip them.
   Options: auto-scope new episodes, or default `--select all`.
4. `wts vocab suggest` (candidate terms from feed titles/show notes into `vocab.txt`) —
   proposed, not approved.
5. ~~Is the repo public~~ — it is; real fixtures are trimmed to 15 minutes.
6. ~~Plan 2's six decisions~~ — confirmed. D1 REST (non-atomic, idempotent) for now; an
   atomic publish route in the Worker before production (spec §10 item 9).
7. ~~Boilerplate detection on real data~~ — deferred to phase 2 (spec §3.5, §9);
   `test_real_sponsor_reads_flagged` is `xfail(strict=True)`, so it errors once the rework
   makes it pass (then remove the mark).
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
- Boilerplate refresh is single-pass; after a corrections change it converges next run.
- Refresh can reset episodes outside `--select` to `chunked`; `wts embed` covers the selection.
- Boilerplate 6-word minimum counts tokens, not distinct words.
- Correction matches can cross a sentence end.
- Embedding cache doesn't record model/dim; a corrupt `.npz` fails the episode.
- Weak ETags can't be used with `If-Range`; Ctrl-C can wait up to the 60 s timeout.
- ~~A feed fetch failure stops `wts run`~~ — fixed in plan 2 Task 8.
- Process slips (all normal diffs): a heredoc append in plan 1 Task 12 and in plan 2 Task 3's
  tests; `sed` edits to `preroll_finder.py` (session 2) and two one-line handoff edits
  (session 3).
