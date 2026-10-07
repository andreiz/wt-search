# M1 Plan 2 — Publish and Search API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The seed corpus from plan 1 can be searched on `staging`. `wts publish` sends episodes to D1 and Vectorize. A Cloudflare Worker serves `/api/search`, `/api/context`, `/api/report` and `/api/health`. Episodes carry Apple, Spotify and YouTube IDs. Secrets live in the Keychain, runs notify through ntfy and back up to `backup_dir`, and `wts logs` filters the pipeline logs.

**Architecture:** The two halves share only data (spec §2):

- `schema/` holds the D1 migrations. The Worker applies them with wrangler; the pipeline's tests apply the same files to an in-memory SQLite database, so the publish SQL is tested against the real contract.
- **Mac side:** `wts publish` talks to the Cloudflare REST API (D1 query, Vectorize v2), with a token from the Keychain. What has been published lives per environment in `state.db`, so `staging` and `production` are independent.
- **Cloudflare side:** one TypeScript Worker per environment, with bindings for D1, Vectorize, Workers AI and Analytics Engine. Search logic is a set of pure modules (query parser, fusion, collapsing, cue/links) with table-driven tests; the endpoints are thin.

**Tech Stack:**
- Pipeline: plan 1's stack (Python 3.12, uv, click, httpx, pytest, respx, ruff). No new Python dependencies.
- Worker: TypeScript (strict), wrangler, Vitest with `@cloudflare/vitest-pool-workers`, npm. Use current stable versions and commit `package-lock.json`.
- External: macOS `security` (Keychain), `rsync`, ntfy.sh.

**Spec:** `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` (§3.0.1 backups, §3.2, §3.6, §4, §6, §7.1, §8). This is **plan 2 of 5 for milestone M1**. It starts once plan 1 (pipeline core) is finished, including its Checkpoints B and C.

**Not in this plan:**
- Frontend (plan 3). Search is checked with `curl` here.
- Review tool, `wts reports` and the daily reports digest (plan 4).
- Test search set, `wts eval`, the smoke search after `wts run`, `wts analytics pull` and the weekly search digest (plan 5).
- Launchd scheduling, the healthchecks.io watchdog and `production` (M2).

## Checkpoints

Four manual checkpoints, continuing plan 1's lettering. At each one the maintainer runs the real thing on the M1 Max, and the results go into `docs/HANDOFF.md` before the next task starts:

- **D** (after Task 5): platform IDs on the real feed. Spotify and YouTube secrets go in the Keychain, then `wts feed` runs; this shows the match coverage for the seed set and how far back Apple's lookup reaches. No Cloudflare account needed yet.
- **E** (after Task 10): staging data, Worker not deployed yet. Create the staging D1 and Vectorize resources and the API token, pass the embedding pooling check, receive an ntfy test push, then **publish the seed corpus** and inspect it with `wrangler d1 execute`. A second publish must send nothing.
- **F** (after Task 13a): exact search on staging. Deploy the Worker with `/api/health` and exact search, and search the real corpus with `wts search` (Task 13a) and `curl`. Check a few cue times against the audio and YouTube.
- **G** (after Task 16): everything on staging. Smart search, context and reports, rate limits, then `wts run --env staging` end to end with backup and notifications.

## Global Constraints

- Every HTTP request from `wts` uses `wts.net.new_client()`, so it sends the bot User-Agent.
- Secrets are never written to config, logs, command lines (argv) or exception messages.
- Environment names are exactly `staging` and `production`.
- Per-environment Cloudflare resource names:
  - D1: `wts-staging`, `wts-production`.
  - Vectorize: `wts-chunks-staging`, `wts-chunks-production` (index names are account-wide, so the spec's single `chunks` name becomes one per environment).
- Vectorize index: 768 dimensions, `cosine` metric, metadata index on `year` (type `number`). **The metadata index must exist before the first upsert**: vectors inserted earlier aren't indexed for filtering.
- Vector ID = `str(chunks.id)`. Metadata = `{"episode_id": int, "year": int}`. Boilerplate chunks are never sent to Vectorize but are inserted in D1 (`include:ads` searches them).
- Query embeddings: Workers AI `@cf/baai/bge-base-en-v1.5` with **`pooling: "cls"`**. Its default is `mean`, which is not compatible with the CLS pooling sentence-transformers uses on the Mac. No query instruction prefix (the test search set may revisit this in plan 5).
- **D1's REST API is not atomic across statements**, even with its `batch` body. Publishing is designed to be idempotent: an episode counts as published in an environment only after every call for it has succeeded, and re-running repairs any partial state.
- D1 REST limits: at most 100 bound parameters per statement, and each statement under 100 KB. Chunk inserts are split to fit (8 columns → at most 12 rows per statement).
- Worker:
  - Queries are capped at 200 characters; smart-mode `page` is capped at 5.
  - 20 results per page.
  - RRF uses k = 60.
  - Hits from one episode less than 120 s apart collapse into one result.
  - `cue_s[p] = max(0, floor(hit_ms/1000) − 7 + offset_p_s)`.
- Commit straight to `main`. Every commit message ends with the repo's attribution lines, if the session provides them.

## Decisions this plan makes (all six confirmed by the maintainer, 2026-10-05)

1. **Publish state per environment.** A new `publications(episode_id, env, digest, published_at)` table plus `published_vectors(env, chunk_id)`. Status `published` means "published to at least one environment"; which environments have the current content is decided by digest. Re-chunking still resets status as before, and a change that doesn't touch the chunks (platform IDs, offsets) republishes because the digest changes.
2. **Atomicity.** The spec's "one D1 batch" per episode becomes "one D1 `batch` request, made idempotent". The Worker may briefly see a half-updated episode during a publish. Acceptable on staging. **Before production (M2)**, D1 writes move to an authenticated publish route in the Worker that uses `env.DB.batch()`, which is atomic (spec §10). Not built in this plan.
3. **Highlighting uses FTS5's own `highlight()`**, not a stemmer reimplemented in TypeScript. Highlights then match exactly what FTS5 matched. For meaning-only hits, a second FTS5 query restricted to those chunk IDs highlights any query words that appear.
4. **Apple IDs** come from the iTunes lookup API, matched on `episodeGuid` = RSS guid. The lookup returns at most the newest ~200 episodes, so older episodes get no Apple button until a fallback is added (M2). Checkpoint D reports how far back it reaches.
5. **YouTube** uses the channel's uploads playlist (`channels.list forHandle=@WoodTalk` → `playlistItems.list` → `videos.list`), about 1 quota unit per 50 videos. The spec's channel search costs 100 units per call. The 3 s length rule is applied when publishing: `youtube_video_id` goes to D1 as null when the lengths don't match, but the match stays in `state.db` for the review tool's sync mode.
6. **The YouTube length rule's input** is the matched video's `contentDetails.duration`, stored locally as `youtube_duration_s`.

## Review Focus

1. **Pooling.** Workers AI must embed queries with `pooling: "cls"`, or smart search quietly returns poor results. Task 9 adds `wts check-embeddings`, which compares Mac vectors with Workers AI vectors for the same text (cosine ≥ 0.99). Checkpoint E runs it before any publish.
2. **FTS5 external-content triggers.** With `content='chunks'`, the delete trigger must pass the *old* row values (`insert into chunks_fts(chunks_fts, rowid, text) values('delete', old.id, old.text)`). Otherwise the index silently keeps stale terms. The schema test covers insert, update and delete (Task 1).
3. **Partial publishes.** If any call fails, the episode's `publications` row isn't written and its status doesn't change. The next run repeats everything for that episode, and the result is the same as a clean publish. Tests inject a failure at each of the four calls (Task 7).
4. **FTS5 syntax injection.** User input must never reach `MATCH` unquoted. Every term is emitted as a double-quoted string, with `"` doubled, and the Worker adds operators only from parsed syntax (`AND`, `OR`, `NOT`, `*` after a quoted prefix). Inputs like `text:foo`, `NEAR(a b)`, `^x`, unbalanced quotes and lone `-` must parse into plain terms or fall back, never into an error (Task 11).
5. **Removed chunks.** After a re-chunk, chunk IDs that disappeared must be deleted from both D1 and Vectorize, or search returns ghosts. Vector IDs to delete come from `published_vectors` for that environment, not from the current chunks (Task 7).
6. **Secrets in argv.** `security add-generic-password -w <value>` would expose the secret in `ps`. `wts secrets set` lets `security` prompt for the value instead (Task 2).

---

## File Structure

```
schema/
  0001_init.sql                 # D1: episodes, chunks, chunks_fts + triggers, reports, meta
pipeline/src/wts/
  migrations/004_platforms_and_publish.sql
  secrets.py                    # SecretStore protocol, KeychainStore, EnvStore, get_secret()
  config.py                     # + cloudflare/env, backup_dir, platform and ntfy settings
  platforms/
    __init__.py                 # match_platform_ids() orchestration
    text.py                     # normalize_title() shared by the matchers
    apple.py                    # iTunes lookup → apple_episode_id
    spotify.py                  # client credentials, show episodes → spotify_episode_id
    youtube.py                  # uploads playlist → youtube_video_id, youtube_duration_s
  cloudflare.py                 # D1Client (query/batch), VectorizeClient (upsert/delete), retries
  publish.py                    # digest(), due_episodes(), publish_episode(), run_publish()
  embedcheck.py                 # check_embeddings(): Mac vs Workers AI cosine
  notify.py                     # Notifier protocol, NtfyNotifier, NullNotifier, run summary
  backup.py                     # sqlite snapshot + rsync to backup_dir
  logs.py                       # read/filter JSON-lines logs
  steps.py                      # + publish, backup and notify in run_all
  cli.py                        # + secrets, publish, check-embeddings, backup, logs; run --env
pipeline/tests/
  test_schema_contract.py  test_secrets.py  test_platforms.py  test_cloudflare.py
  test_publish.py  test_embedcheck.py  test_notify.py  test_backup.py  test_logs.py
  fixtures/platforms/           # recorded API responses (iTunes, Spotify, YouTube)
worker/
  package.json  package-lock.json  tsconfig.json  wrangler.jsonc  vitest.config.ts
  src/
    index.ts                    # router, error handling, request logging
    env.ts                      # Env bindings type
    query.ts                    # parseQuery() → {fts, semantic, filters, includeAds}
    search.ts                   # exactSearch(), smartSearch()
    fusion.ts                   # rrf(), collapse(), sortByDate()
    highlight.ts                # markers → ranges, token index → hit_ms
    wordtimes.ts                # decodeWordTimes()
    links.ts                    # cueSeconds(), deepLinks() — the one link builder (spec §4.6)
    context.ts                  # /api/context
    report.ts                   # /api/report + Turnstile verify
    cache.ts                    # Cache API key with corpus_version
    analytics.ts                # Analytics Engine data points
  test/
    *.test.ts                   # one per module, plus endpoints against a seeded D1
    seed.ts                     # small seeded corpus for endpoint tests
docs/deep-links.md              # time-parameter formats checked by hand (spec §4.6, §10)
```

---

### Task 1: D1 schema and contract test

**Files:**
- Create: `schema/0001_init.sql`, `pipeline/tests/test_schema_contract.py`

**Interfaces:**
- Produces: the D1 schema from spec §4.1, plus:
  - `episodes.year INTEGER` (from `published_at`, used for filters).
  - `chunks` index on `(episode_id, seq)`.
  - `chunks_fts` external-content FTS5 table (`tokenize='porter unicode61'`) with insert, update and delete triggers.
  - `meta` seeded with `corpus_version = '0'`.
- `chunks.id` is assigned by the pipeline (its stable AUTOINCREMENT id), never by D1.

- [ ] **Step 1: Write failing tests** (apply every `schema/*.sql` in order to `sqlite3.connect(":memory:")`)

```python
def test_fts_follows_inserts_updates_and_deletes(d1):
    d1.execute("insert into episodes(id, guid, title, published_at, year) values (1,'g','T','2017-03-14',2017)")
    d1.execute("insert into chunks(id, episode_id, seq, start_ms, end_ms, text, word_times) "
               "values (10, 1, 0, 0, 30000, 'gluing dovetails', '0,400')")
    assert fts(d1, "dovetail") == [10]          # porter: dovetails → dovetail
    d1.execute("update chunks set text = 'planing tenons' where id = 10")
    assert fts(d1, "dovetail") == [] and fts(d1, "tenon") == [10]
    d1.execute("delete from chunks where id = 10")
    assert fts(d1, "tenon") == []

def test_meta_starts_at_corpus_version_zero(d1): ...
def test_offsets_default_to_zero(d1): ...
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `cd pipeline && uv run pytest -q tests/test_schema_contract.py`. Expected: FAIL (no schema).
- [ ] **Step 3: Write `schema/0001_init.sql`.** The triggers follow the SQLite FTS5 external-content pattern; the update trigger is a delete with the old values followed by an insert.
- [ ] **Step 4: Run tests and lint.** Run: `cd pipeline && uv run pytest -q && uv run ruff check .`. Expected: all pass.
- [ ] **Step 5: Commit.** `git add schema pipeline/tests && git commit -m "schema: D1 tables, FTS5 with sync triggers, contract test"`

---

### Task 2: Keychain secrets

**Files:**
- Create: `pipeline/src/wts/secrets.py`, `pipeline/tests/test_secrets.py`
- Modify: `pipeline/src/wts/cli.py`

**Interfaces:**
- `SECRET_NAMES = ("cloudflare_api_token", "spotify_client_id", "spotify_client_secret", "youtube_api_key", "ntfy_topic")`.
- `SecretStore` protocol: `get(name) -> str | None`.
- `KeychainStore` reads with `security find-generic-password -s wts -a <name> -w`. An exit code of 44 (not found) means `None`.
- `EnvStore` reads `WTS_SECRET_<NAME>`, for tests and non-Mac runs.
- `get_store()`: `EnvStore` when `WTS_HOME` is set or the platform isn't macOS, otherwise `KeychainStore`.
- `MissingSecret(name)` exception, whose message says how to set the secret (no value).
- CLI:
  - `wts secrets set <name>` runs `security add-generic-password -U -s wts -a <name> -w` with no value, so `security` prompts on the terminal.
  - `wts secrets check` prints each name with `set` or `missing`, never the value.

- [ ] **Step 1: Write failing tests:** `EnvStore` round trip; `KeychainStore` with a faked `subprocess.run` (found, not found → `None`, other failure → raises); `secrets set` builds an argv without the value; `secrets check` output contains no secret value.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and lint.**
- [ ] **Step 5: Commit.** `pipeline: Keychain secrets (wts secrets set/check)`

---

### Task 3: Config for environments, platforms, backups and ntfy

**Files:**
- Modify: `pipeline/src/wts/config.py`, `pipeline/tests/test_config.py`

**Interfaces:**
- `Config` gains:
  - `cloudflare_account_id: str | None`
  - `envs: dict[str, CloudflareEnv]`, where `CloudflareEnv(d1_database_id: str, vectorize_index: str)`
  - `run_env: str | None`, the environment `wts run` publishes to
  - `backup_dir: Path | None`
  - `apple_podcast_id: int = 251471480`
  - `spotify_show_id: str | None`
  - `youtube_handle: str = "@WoodTalk"`
- TOML layout:

```toml
cloudflare_account_id = "…"
run_env = "staging"
backup_dir = "/Volumes/media/wts/backup"
spotify_show_id = "…"

[env.staging]
d1_database_id = "…"
vectorize_index = "wts-chunks-staging"
```

- `Config.env(name) -> CloudflareEnv` raises `click.UsageError` naming the missing keys.

- [ ] **Step 1: Write failing tests:** a full config parses; a missing `[env.production]` gives a clear error from `cfg.env("production")`; plan 1 configs still load.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and lint.**
- [ ] **Step 5: Commit.** `pipeline: config for Cloudflare environments, platforms, backups`

---

### Task 4: State migration for platform IDs and publishing

**Files:**
- Create: `pipeline/src/wts/migrations/004_platforms_and_publish.sql`
- Modify: `pipeline/tests/test_state.py`

**Interfaces:**
- `episodes` gains:
  - `apple_episode_id`, `spotify_episode_id`, `youtube_video_id` (TEXT)
  - `youtube_duration_s` (INTEGER)
  - `offset_apple_s`, `offset_spotify_s`, `offset_youtube_s` (INTEGER NOT NULL DEFAULT 0)
  - `platforms_checked_at` (TEXT)
- `publications(episode_id INTEGER, env TEXT, digest TEXT NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY (episode_id, env))`
- `published_vectors(env TEXT, chunk_id INTEGER, episode_id INTEGER NOT NULL, PRIMARY KEY (env, chunk_id))`
- `state.py`: `STEP_INPUT["publish"]` stays `EMBEDDED`. A new `publish_ready(conn, ids)` returns episodes in `embedded` or `published`, plus `error` with `error_step = 'publish'` and retries left. Which of those are due is decided per environment in Task 7.

- [ ] **Step 1: Write failing tests:** the migration applies on top of a plan-1 database; existing rows keep their data; offsets default to 0; `publish_ready` includes `published` episodes and excludes `chunked` ones.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and lint.**
- [ ] **Step 5: Commit.** `pipeline: state for platform IDs and per-environment publishing`

---

### Task 5: Platform ID matching in `wts feed`

**Files:**
- Create: `pipeline/src/wts/platforms/{__init__,text,apple,spotify,youtube}.py`, `pipeline/tests/test_platforms.py`, `pipeline/tests/fixtures/platforms/*.json`
- Modify: `pipeline/src/wts/steps.py` (`run_feed`), `pipeline/src/wts/feed.py` (module docstring)

**Interfaces:**
- `normalize_title(title) -> str`: lowercase; strip the episode-number markers that `stems.split_title` recognises; drop punctuation and apostrophes; collapse whitespace.
- `match_apple(client, podcast_id) -> dict[guid, apple_episode_id]`: `GET https://itunes.apple.com/lookup?id=<id>&media=podcast&entity=podcastEpisode&limit=200`, keyed on each result's `episodeGuid`; the value is `trackId`.
- `match_spotify(client, client_id, secret, show_id, episodes) -> dict[episode_id, spotify_episode_id]`:
  - Get a token with the client-credentials flow.
  - Page through `GET /v1/shows/{id}/episodes?market=US&limit=50`.
  - Match on equal normalized titles with release dates within ±2 days.
- `match_youtube(client, api_key, handle, episodes) -> dict[episode_id, (video_id, duration_s)]`:
  - `channels.list?forHandle=` → uploads playlist.
  - `playlistItems.list` (all pages), then `videos.list?part=contentDetails` in batches of 50 for the durations.
  - Match on episode number in the video title (`WT615`, `615`, `#615`, any of the title styles) with a date within ±14 days. Unnumbered episodes match on equal normalized titles with a date within ±14 days.
- `match_platform_ids(conn, cfg, client, store) -> Counter`:
  - Runs after `upsert_episodes`, only for episodes with a null ID on that platform.
  - Each platform is skipped with a warning when its secrets or config are missing.
  - A platform error is logged and the others still run (spec §6: the ID stays null and is retried on the next `wts feed`).
- Duplicate matches (one platform ID claimed by two episodes) are dropped for both and logged.

- [ ] **Step 1: Record fixtures.** Trimmed real responses, about 5 items each, with IDs kept, saved under `tests/fixtures/platforms/`. They include an unnumbered episode, a livestream-era video whose length differs from the feed, and a title with smart quotes.
- [ ] **Step 2: Write failing tests** (respx):
  - Apple matches by guid.
  - Spotify matches by title and date (±2 days in, 3 days out).
  - YouTube matches by number and stores the duration.
  - A missing Spotify secret skips only Spotify.
  - A YouTube 403 logs and keeps the Apple and Spotify matches.
  - An existing ID is never overwritten.
  - A duplicate claim is dropped.
- [ ] **Step 3: Run and confirm they fail.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run tests and lint.**
- [ ] **Step 6: Commit.** `pipeline: match Apple, Spotify and YouTube IDs in wts feed`

---

### Checkpoint D: Platform IDs on the real feed (maintainer, M1 Max)

1. **Accounts:** a free Spotify developer app (client credentials) and a YouTube Data API key (spec §10 item 6). The Spotify show ID goes in `config.toml` as `spotify_show_id`.
2. **Secrets:** `uv run wts secrets set` for `spotify_client_id`, `spotify_client_secret` and `youtube_api_key`. Then run `uv run wts secrets check`, which should list them as `set` and print no values.
3. **Match:** `uv run wts feed`. Report:
   - How many of the 35 seed episodes got each platform ID, and how many of all 625.
   - The oldest episode with an Apple ID (decision 4).
   - For YouTube: how many matches pass the 3 s length rule.
   - Spot-check three matches per platform by opening the links.
4. **Idempotence:** a second `uv run wts feed` changes no IDs.

If coverage is far below expectations (for example under half the 2020–2026 seed episodes on Spotify), stop and adjust the matching before Task 6.

---

### Task 6: Cloudflare REST client

**Files:**
- Create: `pipeline/src/wts/cloudflare.py`, `pipeline/tests/test_cloudflare.py`

**Interfaces:**
- `CloudflareApi(client, account_id, token, base="https://api.cloudflare.com/client/v4")`.
- `D1(api, database_id)`:
  - `.batch(statements: list[tuple[str, list]]) -> list[result]` posts `{"batch": [{"sql", "params"}]}` to `/accounts/{a}/d1/database/{id}/query`.
  - `.query(sql, params)`.
  - Params are sent as JSON values (numbers stay numbers).
- `Vectorize(api, index)`:
  - `.upsert(vectors: list[tuple[str, list[float], dict]])` posts NDJSON to `/accounts/{a}/vectorize/v2/indexes/{index}/upsert`, with `Content-Type: application/x-ndjson`, in requests of at most 1000 vectors.
  - `.delete_by_ids(ids)` posts `{"ids": [...]}` to `…/delete_by_ids`, at most 1000 per request.
  - Both return mutation IDs.
- `CloudflareError(status, errors)`; the message includes the API's error codes and messages but never the token.
- Retries: 429 and 5xx, up to 4 times with backoff (1, 2, 4, 8 s, honouring `Retry-After`). 4xx other than 429 fail at once.
- `chunked_inserts(rows, columns) -> list[(sql, params)]` keeps each statement within 100 parameters.

- [ ] **Step 1: Write failing tests** (respx):
  - The batch body shape.
  - The Bearer header is set.
  - A D1 `success: false` raises `CloudflareError` with the codes.
  - A 429 then 200 succeeds.
  - A 400 fails at once.
  - NDJSON lines parse back to the input.
  - 2500 vectors → 3 requests.
  - `chunked_inserts` never exceeds 100 parameters.
  - The token appears in no exception text.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and lint.**
- [ ] **Step 5: Commit.** `pipeline: Cloudflare D1 and Vectorize REST client`

---

### Task 7: `wts publish`

**Files:**
- Create: `pipeline/src/wts/publish.py`, `pipeline/tests/test_publish.py`
- Modify: `pipeline/src/wts/cli.py`, `pipeline/src/wts/steps.py`
- Modify: spec §3.2 `wts publish` row and §6 "Publish fails partway", for decisions 1–2 above

**Interfaces:**
- `episode_digest(conn, row, embeddings_dir) -> str`: SHA-256 over the published episode fields (including platform IDs after the YouTube length rule, and offsets), every chunk's `(id, seq, start_ms, end_ms, text, word_times, is_boilerplate)`, and the embeddings file's `(chunk_ids, vectors)` bytes.
- `youtube_id_for_publish(row) -> str | None` returns the ID only when `abs(youtube_duration_s − duration_s) <= 3`.
- `due_episodes(conn, env, ids) -> list[Row]` returns the `publish_ready` episodes whose digest differs from `publications` for `env` (or that have no row).
- `publish_episode(conn, d1, vectorize, env, row, embeddings_dir)`, in this order:
  1. Vectorize upsert of the episode's non-boilerplate chunks (from the `.npz`; the IDs must equal the current non-boilerplate chunk IDs, or raise).
  2. One D1 batch:
     - Upsert the episode row (`insert … on conflict(id) do update`).
     - `delete from chunks where episode_id = ? and id not in (…current ids…)`.
     - `insert or replace` the current chunks, split per the parameter limit.
  3. Vectorize `delete_by_ids` for `published_vectors(env)` IDs of this episode that are no longer current.
  4. In one local transaction: write `publications(episode_id, env, digest, now)`, replace this episode's `published_vectors` for `env`, and advance `embedded` → `published` (already `published` stays).
- `run_publish(conn, paths, cfg, env, ids, *, client, store, dry_run=False) -> Counter`:
  - Publishes due episodes one at a time.
  - A failed episode goes through `fail(…, "publish", reason)` and the run continues.
  - When at least one episode was published, it sets D1 `meta.corpus_version` to the current UTC timestamp (`YYYYMMDDHHMMSS`) and `meta.last_published_at`.
  - `--dry-run` prints what would be sent and calls nothing.
- CLI: `wts publish --env staging|production [--select …] [--dry-run]`.

- [ ] **Step 1: Write failing tests.** Fake `D1` and `Vectorize` classes record the calls and apply the D1 statements to an in-memory SQLite loaded with `schema/*.sql`, so the SQL itself is exercised.
  - A first publish creates the episode and chunks in D1, the vectors, a `publications` row and `published_vectors`, and the status becomes `published`.
  - Republishing unchanged content calls nothing (digest match).
  - A re-chunk that drops chunk 12: chunk 12 leaves D1 (and FTS) and is deleted from Vectorize.
  - Changing only `offset_spotify_s` republishes the episode row.
  - YouTube length rule: 5 s off → `youtube_video_id` null in D1; 2 s off → set.
  - Boilerplate chunks are in D1 but not in Vectorize.
  - **A failure injected at each of steps 1–4**, followed by a clean re-run, gives the same D1, Vectorize and local state as a clean publish. The failed episode is in `error` with `error_step = 'publish'` and the next run retries it.
  - Staging and production are independent: publishing to staging leaves production due.
  - `corpus_version` changes only when something was published.
  - `--dry-run` makes no calls.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Update the spec** (§3.2 publish row, §6).
- [ ] **Step 5: Run tests and lint.**
- [ ] **Step 6: Commit.** `pipeline: wts publish (idempotent, per-environment, D1 + Vectorize)`

---

### Task 8: Notifications (ntfy)

**Files:**
- Create: `pipeline/src/wts/notify.py`, `pipeline/tests/test_notify.py`
- Modify: `pipeline/src/wts/steps.py`, `pipeline/src/wts/cli.py`

**Interfaces:**
- `Notifier` protocol: `send(title, body, *, priority="default", tags=())`.
- `NtfyNotifier(client, topic)` posts the body to `https://ntfy.sh/<topic>` with `Title`, `Priority` and `Tags` headers.
- `NullNotifier` logs instead. It is used when `ntfy_topic` isn't set, with one warning per run.
- `notify_run(notifier, conn, results, run_started_at)` sends, per spec §8.2:
  - Episodes newly published in this run (number, title, chunk count).
  - Episodes that entered `error` this run, and those that ran out of retries (`retries >= 3`).
  - No feed item newer than 21 days.
- Also sent:
  - A `MachineProblem` (`StorageUnavailable`, missing tools) from `wts run`, at high priority.
  - A feed fetch failure.
- A notification failure is logged and never fails the run.
- CLI: `wts notify test` sends one test message.

- [ ] **Step 1: Write failing tests** (respx on ntfy.sh): each trigger produces exactly one message with the expected title; no topic → `NullNotifier`; ntfy 500 → logged, the run still succeeds; the topic never appears in log lines.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and lint.**
- [ ] **Step 5: Commit.** `pipeline: ntfy notifications for runs, errors and a quiet feed`

---

### Task 9: Embedding pooling check

**Files:**
- Create: `pipeline/src/wts/embedcheck.py`, `pipeline/tests/test_embedcheck.py`
- Modify: `pipeline/src/wts/cli.py`

**Interfaces:**
- `check_embeddings(conn, paths, api, n=5) -> list[(chunk_id, cosine)]`:
  - Picks `n` embedded chunks spread across episodes.
  - Embeds their text with Workers AI REST (`POST /accounts/{a}/ai/run/@cf/baai/bge-base-en-v1.5`, body `{"text": [...], "pooling": "cls"}`).
  - Compares with the stored Mac vectors.
- CLI: `wts check-embeddings` prints each cosine and exits 1 if any is below 0.99, saying "pooling or model mismatch". The API token needs the *Workers AI: Read* permission.

- [ ] **Step 1: Write failing tests:** a faked API returning the stored vector → pass; a rotated vector → exit 1; the request body contains `"pooling": "cls"`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and lint.**
- [ ] **Step 5: Commit.** `pipeline: wts check-embeddings (Mac vs Workers AI, CLS pooling)`

---

### Task 10: Worker scaffold and `/api/health`

**Files:**
- Create: `worker/package.json`, `worker/tsconfig.json`, `worker/wrangler.jsonc`, `worker/vitest.config.ts`, `worker/src/{index,env}.ts`, `worker/test/health.test.ts`, `worker/test/seed.ts`
- Modify: `.gitignore` (`worker/node_modules/`, `worker/.wrangler/`), `CLAUDE.md` (Commands: `cd worker && npm test`, `npx tsc --noEmit`)

**Interfaces:**
- `wrangler.jsonc`:
  - `migrations_dir: "../schema"`.
  - `env.staging` and `env.production`, each with `d1_databases` (binding `DB`), `vectorize` (binding `VEC`), `ai` (binding `AI`) and `analytics_engine_datasets` (binding `ANALYTICS`).
  - The D1 `database_id` values are placeholders until Checkpoint E fills in staging's (IDs aren't secrets; they're committed).
  - Var `TURNSTILE_SITE_KEY`; secret `TURNSTILE_SECRET`.
- `vitest.config.ts` uses `defineWorkersConfig` and applies `schema/` migrations to the test D1 (`readD1Migrations` + `applyD1Migrations` in a setup file).
- `GET /api/health` → `{ok: true, corpus_version}`, from one D1 query.
- Unknown routes → 404 JSON. Uncaught errors → 500 JSON (`{error: "internal"}`) with a log line.

- [ ] **Step 1: Write the first failing test:** `/api/health` returns `corpus_version` `"0"`. Also add a test that `chunks_fts` exists and matches a seeded row, **to confirm the test runtime's SQLite has FTS5. If it doesn't, stop and report.**
- [ ] **Step 2: Run and confirm it fails.** Run: `cd worker && npm test`.
- [ ] **Step 3: Implement the scaffold and route.**
- [ ] **Step 4: Run tests and type-check.** Run: `cd worker && npm test && npx tsc --noEmit`.
- [ ] **Step 5: Commit.** `worker: scaffold, wrangler environments, /api/health`

---

### Checkpoint E: Seed corpus in staging D1 and Vectorize (maintainer, M1 Max)

Needs the seed corpus embedded (plan 1's Checkpoint C). The Worker isn't deployed yet; Task 10's `wrangler.jsonc` is used only to apply the schema.

1. **Cloudflare resources:**
   - `npx wrangler d1 create wts-staging`, then put its `database_id` in `worker/wrangler.jsonc` under `env.staging` and commit.
   - `npx wrangler vectorize create wts-chunks-staging --dimensions=768 --metric=cosine`
   - `npx wrangler vectorize create-metadata-index wts-chunks-staging --property-name=year --type=number` — before any upsert.
   - Apply the schema: `cd worker && npx wrangler d1 migrations apply wts-staging --env staging --remote`.
2. **API token** scoped to this account, with D1 Edit, Vectorize Edit and Workers AI Read. Then `uv run wts secrets set cloudflare_api_token`.
3. **Config:** `cloudflare_account_id` and `[env.staging]` in `config.toml`.
4. **Notifications:** `ntfy_url = "https://…"` in `config.toml` for the maintainer's own ntfy server; `uv run wts secrets set ntfy_topic` (and `ntfy_token` if the server requires an access token with write access to that topic); subscribe to the topic on the phone, then `uv run wts notify test` — the push should arrive.
5. **Pooling check:** `uv run wts check-embeddings` must pass (cosine ≥ 0.99). If it fails, stop: smart search would be wrong.
6. **Publish:** `uv run wts publish --env staging --dry-run`, then without `--dry-run`. Expect 35 episodes published.
7. **Inspect:**
   - `npx wrangler d1 execute wts-staging --remote --command "select count(*) from episodes; select count(*) from chunks; select value from meta where key='corpus_version'"` — counts match `state.db`.
   - `… --command "select rowid from chunks_fts where chunks_fts match 'dovetail' limit 5"` returns rows (FTS5 on real data).
   - `npx wrangler vectorize info wts-chunks-staging` — the vector count equals the non-boilerplate chunk count (mutations are async; allow a minute).
8. **Idempotence:** `uv run wts publish --env staging` again sends nothing.

---

### Task 11: Query parser

**Files:**
- Create: `worker/src/query.ts`, `worker/test/query.test.ts`

**Interfaces:**
- `parseQuery(input: string) -> ParsedQuery`:

```ts
{
  fts: string | null,      // FTS5 MATCH expression, every term double-quoted
  semantic: string,        // words for embedding: operators, exclusions and filters removed
  filters: { year?: number, before?: number, after?: number, ep?: number },
  includeAds: boolean,
  terms: string[],         // positive words and phrases, for related-hit highlighting
}
```

- Syntax per spec §4.3:
  - Terms are ANDed.
  - `"phrase"`.
  - `-word` and `-"phrase"` become `NOT`.
  - `OR` between terms.
  - `pref*` becomes `"pref"*`.
  - `year:`, `before:`, `after:`, `ep:` and `include:ads`.
- A query with only exclusions becomes `fts: null` (nothing to match).
- Anything unparseable falls back to every word quoted and ANDed. **The parser never throws.**
- Input is truncated to 200 characters before parsing.

- [ ] **Step 1: Write table-driven tests** (about 30 cases): every syntax row from spec §4.3; `text:foo`; `NEAR(a b)`; `^x`; unbalanced `"`; a lone `-`; `OR` at the start or end; `year:abc`; `ep:` with no number; emoji and smart quotes; 500 characters. Each case also runs its `fts` against the test D1 to prove FTS5 accepts it.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and type-check.**
- [ ] **Step 5: Commit.** `worker: query parser with FTS5-safe output`

---

### Task 12: Word times, highlights, cue times and deep links

**Files:**
- Create: `worker/src/{wordtimes,highlight,links}.ts` with tests; `docs/deep-links.md`

**Interfaces:**
- `decodeWordTimes(startMs, encoded) -> number[]` returns absolute word start times. Mirrors the pipeline's codec. A shared fixture, `worker/test/fixtures/word_times.json` (`start_ms`, absolute word times, `encoded`), is checked by both halves: the pipeline test asserts `encode_word_times` produces `encoded`, and the Worker test asserts the decode. (Not under `schema/`, which is wrangler's migrations directory.)
- `highlightRanges(marked: string) -> {text, ranges: [start, end][], firstToken: number | null}` takes FTS5 `highlight()` output with `\u0001`/`\u0002` markers and returns the clean text, character ranges, and the space-token index of the first highlight.
- `hitMs(chunk, firstToken)` returns the word time of `firstToken`, or `start_ms` when it is null.
- `cueSeconds(hitMs, offsetS) = max(0, floor(hitMs / 1000) − 7 + offsetS)`.
- `deepLinks(episode, hitMs) -> {youtube?, apple?, spotify?, page}`:
  - YouTube is `https://www.youtube.com/watch?v=<id>&t=<cue>s`.
  - The Apple and Spotify time parameters come from `docs/deep-links.md`. Until the hand check is done there, Apple and Spotify links carry no time parameter, and a test asserts exactly that, so filling in the formats is a deliberate change.
- `docs/deep-links.md` is a table of platform × device (iOS, Android, desktop) × candidate format × result, to be filled in during M1 (spec §10 item 2).

- [ ] **Step 1: Write failing tests:**
  - The word-times shared fixture round trip.
  - Markers in the middle of a token (`"SawStop,"`).
  - Two highlights → two ranges, first token correct.
  - `cueSeconds` clamps at 0 and adds the offset.
  - Links are omitted when an ID is null.
  - The YouTube `t=` value.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.** Also add the pipeline test that checks `chunker.encode_word_times` against `worker/test/fixtures/word_times.json`.
- [ ] **Step 4: Run tests in both halves.** Run: `cd worker && npm test`; `cd pipeline && uv run pytest -q`.
- [ ] **Step 5: Commit.** `worker: word times, FTS5 highlights, cue times and deep links`

---

### Task 13: Exact search

**Files:**
- Create: `worker/src/search.ts` (exact part), `worker/test/search-exact.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- `GET /api/search?q=&mode=exact&sort=relevance|newest|oldest&page=`.
- SQL: `chunks_fts MATCH ?` joined to `chunks` and `episodes`, plus filters: year, before and after on `episodes.year`, `ep` on `episodes.number`, and `is_boilerplate = 0` unless `includeAds`.
  - `relevance` orders by `bm25(chunks_fts)`.
  - `newest` and `oldest` order by `published_at`, then `seq`.
  - Each row selects `highlight(chunks_fts, 0, char(1), char(2))`.
- `total` comes from a `count(*)` over the same match and filters.
- Collapsing: hits from the same episode less than 120 s apart become one result with `more_in_episode`. With date sorts, results are grouped by episode in date order. Exact mode pages through every match, 20 results per page; collapsing is applied per page and documented as such.
- Result shape (spec §4.4): `{episode: {number, title, date, links}, chunk_id, text, ranges, hit_ms, cue_s: {youtube, apple, spotify}, match: "keyword"}`.
- A query with `fts: null` → empty results, `total: 0`.

- [ ] **Step 1: Write failing tests against the seeded D1** (5 episodes over 3 years, one with boilerplate):
  - Stemming (`dovetails` finds `dovetail`).
  - Phrase.
  - Exclusion.
  - `OR`.
  - Prefix.
  - Each filter.
  - `include:ads` on and off.
  - Each sort.
  - `total`.
  - Paging.
  - Collapsing at 119 s vs 121 s.
  - `hit_ms` lands on the highlighted word.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and type-check.**
- [ ] **Step 5: Commit.** `worker: exact search (FTS5, filters, sorts, collapsing)`

---

### Task 13a: `wts search` (added 2026-10-07)

A terminal client for the maintainer: searches a deployed environment through the Worker's API, so it shows exactly what the web app will (spec §3.2). Not for listeners, and no offline search over `state.db` (both ruled out by the maintainer).

**Files:**
- Create: `pipeline/src/wts/search.py`, `pipeline/tests/test_search.py`, `pipeline/tests/fixtures/search/*.json`
- Modify: `pipeline/src/wts/config.py`, `pipeline/tests/test_config.py`, `pipeline/src/wts/cli.py`, `pipeline/README.md`

**Interfaces:**
- Config: `[env.<name>] api_url` (for example `https://wts-api-staging.<account>.workers.dev`). Optional, so `wts publish` doesn't need it. `Config.api_url(name) -> str` raises `click.UsageError` naming the missing key.
- `search(client, api_url, q, *, mode="smart", sort="relevance", page=1) -> dict` calls `GET <api_url>/api/search` with those parameters and returns the parsed JSON. A non-2xx response or invalid JSON raises `SearchError` with the status and the API's `error` field; network errors are retried like the other `wts` clients. It uses `wts.net.new_client()` (the bot User-Agent).
- `format_results(response, *, color: bool) -> str`:
  - Per result: `#<number> <title> (<YYYY-MM-DD>)  <mm:ss or h:mm:ss>`, then the text with each range in bold (ANSI) when `color`, or wrapped in `[` `]` otherwise, then `+N more in episode` when present, then the links in card order (YouTube, Apple, Spotify, page), one per line.
  - A header line: `total` in exact mode; `smart search degraded: keyword results only` when `smart_degraded`.
  - No results → `No results.`
- CLI: `wts search "<query>" [--env staging|production] [--mode smart|exact] [--sort relevance|newest|oldest] [--page N] [--json]`. `--env` defaults to `run_env`; with neither, a usage error. `color` follows `click`'s TTY detection. `--json` prints the response as is.
- The same `search()` is what plan 5's `wts eval` and the smoke search after `wts run` call.

- [ ] **Step 1: Write failing tests** (respx, with response fixtures in the spec §4.4 shape from Task 13):
  - The request URL and parameters (the query is URL-encoded, page and mode passed through).
  - Highlight ranges in bold, and with brackets when color is off, including two ranges in one result and ranges at the start and end of the text.
  - `mm:ss` from `hit_ms`, and `h:mm:ss` over an hour.
  - Links in card order; missing platforms are omitted.
  - `more_in_episode`, `total`, `smart_degraded` and empty results.
  - 404/500 from the API → `SearchError` with the status; the CLI exits 1 with one line.
  - `--json` output parses back to the response.
  - A missing `api_url` names `[env.staging] api_url`; no `--env` and no `run_env` is a usage error.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and lint.**
- [ ] **Step 5: Commit.** `pipeline: wts search, a terminal client for /api/search`

---

### Checkpoint F: Exact search on staging (maintainer, M1 Max)

1. **Migrations:** `cd worker && npx wrangler d1 migrations apply wts-staging --env staging --remote` — nothing new to apply unless Tasks 11–13 added a migration.
2. **Deploy:** `npx wrangler deploy --env staging`, with a `workers.dev` URL or the staging route (spec §10 item 7).
3. **Search:**
   - Add `api_url` (the deployed `workers.dev` URL) under `[env.staging]` in `config.toml`.
   - `curl '<staging>/api/health'` returns the `corpus_version` from Checkpoint E.
   - `uv run wts search --env staging --mode exact dovetail`, plus a phrase, an exclusion, `year:2015`, `ep:613` and `include:ads` — each gives sensible results. Check one with `--json` against `curl '<staging>/api/search?q=dovetail&mode=exact'`.
   - Search a sponsor read word for word: hidden by default, found with `include:ads`.
4. **Cue times:** for five hits, play the episode file from `audio_dir` at `hit_ms` (and the YouTube link where there is one). The hit word should be spoken within about 7 s after the cue.
5. **Latency:** `npx wrangler tail --env staging` during the searches; note typical latency.

---

### Task 14: Smart search and degraded mode

**Files:**
- Create: `worker/src/fusion.ts`, `worker/test/fusion.test.ts`, `worker/test/search-smart.test.ts`
- Modify: `worker/src/search.ts`

**Interfaces:**
- `rrf(lists: string[][], k = 60) -> {id, score}[]`.
- `smartSearch(env, parsed, sort, page)`:
  1. FTS5 top 50, with the boilerplate filter and other SQL filters.
  2. `env.AI.run("@cf/baai/bge-base-en-v1.5", {text: [parsed.semantic], pooling: "cls"})`, then `env.VEC.query(vector, {topK: 50, filter: <year filter>})`. Year filters map to Vectorize metadata operators (`$eq`, `$lt`, `$gt`).
  3. RRF merge.
  4. Load the merged chunks from D1, dropping vector hits whose chunk no longer exists (a publish in progress). Apply the exclusion and `ep` filters.
  5. With `newest`/`oldest`, re-sort the top 100 by date.
  6. Collapse, then page (20 per page, `page` capped at 5).
- Hits only from Vectorize get `match: "related"`. Their highlights come from one extra FTS5 query, `rowid IN (…) AND <terms ORed>`, with `highlight()`.
- No `total` in smart mode.
- If AI or Vectorize throws: keyword-only results with `smart_degraded: true`, and the error is logged.

- [ ] **Step 1: Write failing tests:**
  - RRF math (a hand-computed table).
  - With a mocked `AI` and `VEC`: fusion order, `related` tagging, related highlighting, the date re-sort limited to the top 100, `page=6` clamped to 5.
  - A dangling vector ID is dropped.
  - AI throws → degraded with keyword results.
  - The `AI.run` call includes `pooling: "cls"`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and type-check.**
- [ ] **Step 5: Commit.** `worker: smart search (RRF of FTS5 and Vectorize), degraded mode`

---

### Task 15: Context, report, caching, logs and analytics

**Files:**
- Create: `worker/src/{context,report,cache,analytics}.ts` with tests
- Modify: `worker/src/index.ts`

**Interfaces:**
- `GET /api/context?chunk=&radius=3` returns the chunk ±radius in the same episode (radius capped at 6), each with `start_ms`, `text` and per-platform `cue_s`.
- `POST /api/report`:
  - Validates the body `{chunk_id, quoted_text, suggested_text?, note?, turnstile_token}`.
  - Length limits are 500, 500 and 1000 characters.
  - Turnstile is verified with `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` using `TURNSTILE_SECRET`.
  - On success: an insert into `reports` with status `open`, response `{ok: true}`.
  - Failures return 400 or 403 with a friendly `message`, and nothing is stored.
- Caching: search responses go through the Cache API, keyed by the normalized `q`, `mode`, `sort`, `page` and `corpus_version`, for 1 h. `corpus_version` is read from D1 at most once a minute per isolate.
- Logging: one structured `console.log` per request with endpoint, query truncated to 80 characters, mode, sort, latency, result count and the degraded flag. No IP addresses.
- Analytics Engine: `writeDataPoint` per search (blobs: query, mode, sort; doubles: results, latency) and per report.
- Limits: `q` over 200 characters is truncated, not rejected; `page` is clamped.
- Rate limiting (spec §4.7) uses Cloudflare dashboard rules, set up in Checkpoint G, not code.

- [ ] **Step 1: Write failing tests:**
  - Context around the first and last chunk.
  - Report happy path with Turnstile mocked via `fetchMock`; bad token → 403, nothing stored.
  - An over-long note → 400.
  - A cache hit skips D1 (spy).
  - A `corpus_version` change misses the cache.
  - The log line has no IP.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and type-check.**
- [ ] **Step 5: Commit.** `worker: context, report (Turnstile), edge cache, logs, analytics`

---

### Task 16: Backups, `wts logs`, and `wts run --env`

**Files:**
- Create: `pipeline/src/wts/{backup,logs}.py`, `pipeline/tests/{test_backup,test_logs}.py`
- Modify: `pipeline/src/wts/steps.py`, `pipeline/src/wts/cli.py`, `pipeline/README.md`

**Interfaces:**
- `backup(paths, cfg) -> Path | None`:
  - Takes a consistent snapshot of `state.db` with `sqlite3.Connection.backup` into a temp file.
  - Then `rsync -a --delete` of the app directory to `<backup_dir>/wts/`, excluding `audio/`, the live `state.db`, `*.tmp` and `.partial/`.
  - Then copies the snapshot in as `state.db`.
  - Returns `None` (logged) when `backup_dir` isn't set.
  - Raises `BackupFailed` if `rsync` fails or `backup_dir` is unreachable. `wts run` turns that into a warning and a notification, not a failed run.
- `read_logs(log_dir, *, run=None, episode=None, level=None, since=None) -> Iterator[dict]`. `since` accepts `30m`, `12h` or `7d`; `level` is a minimum (`warning` includes `error`). Lines that don't parse are skipped.
- CLI:
  - `wts logs [--run ID] [--episode STEM] [--level LEVEL] [--since 7d] [--json]` prints readable lines like the console format, or raw JSON with `--json`.
  - `wts backup` runs a backup now.
  - `wts run --env staging|production` runs `feed → download → transcribe → chunk → embed → publish → backup → notify`. Without `--env` it uses `run_env` from config; with neither, it skips publish and logs a warning.

- [ ] **Step 1: Write failing tests:**
  - The backup snapshot is a valid SQLite database while another connection holds a write transaction.
  - `audio/` is not copied.
  - The `rsync` command line is as expected (faked runner).
  - Missing `backup_dir` → `None`.
  - Log filters by run, episode, level and since.
  - Malformed lines are skipped.
  - `run_all` with `env` calls publish then backup then notify, in order.
  - Publish is skipped without an env.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and lint.**
- [ ] **Step 5: Commit.** `pipeline: backups, wts logs, wts run --env with publish`

---

### Checkpoint G: Everything on staging (maintainer, M1 Max)

1. **Deploy:**
   - `npx wrangler secret put TURNSTILE_SECRET --env staging` (Turnstile site key from spec §10 item 6).
   - `npx wrangler deploy --env staging`.
2. **Route and rate limits:** route `/api/*` on the staging domain (spec §10 item 7); add the rate-limiting rules (60/min on `/api/*`, 10/h on `/api/report`).
3. **Smart search:**
   - `curl '<staging>/api/search?q=how+do+I+flatten+a+workbench+top'` → results with some `related` hits, not `smart_degraded`.
   - Three paraphrase queries of your own, about topics you remember from the seed episodes; note whether the right episode is in the top 10. (This previews plan 5's test search set.)
   - `newest`/`oldest` sorts, and a `year:` filter in smart mode.
4. **Context and report:**
   - `curl '<staging>/api/context?chunk=<id>'` returns neighbouring chunks with cues.
   - A report with the Turnstile test token (`XXXX.DUMMY.TOKEN.XXXX` against the always-pass test secret) is stored: `npx wrangler d1 execute wts-staging --remote --command "select * from reports"`. Then switch back to the real Turnstile secret.
5. **Caching:** the same search twice — the second is a cache hit in `wrangler tail`. A re-publish (new `corpus_version`) misses.
6. **End to end:** `uv run wts run --env staging` with nothing new. It should run every step, publish nothing, write a backup to `backup_dir` (or log that it's unset), and send no error notification. Check `uv run wts logs --since 1h` and `uv run wts logs --level warning`.
7. **Record** in `docs/HANDOFF.md`:
   - Platform ID coverage (from Checkpoint D) and YouTube links shown after the length rule.
   - Search latency (p50 and worst seen) for exact and smart modes.
   - The paraphrase results from step 3.
   - Anything surprising.
