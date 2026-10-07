# Handoff — 2026-10-05 (third session)

Where the project stands after two working sessions, so a fresh session can pick up without the
conversation. Read this, then [README.md](../README.md), then the spec sections it points to.

## Start here (next session)

1. **Plan 2, Tasks 1–9 and Checkpoint D are done** (third session). Continue with Task 10
   (Worker scaffold, `/api/health`), then stop at Checkpoint E. Test-first, one commit per task, straight to `main`. The maintainer asked for Sonnet subagents where it makes sense
   (Task 5 was done that way, then reviewed before commit), and for a short report after each
   task.
2. Before Task 7 (publish), check the plan's Review Focus. CLS pooling and FTS5 trigger
   correctness are the two easiest things to get silently wrong. **Task 7 must upsert chunks
   with `ON CONFLICT(id) DO UPDATE`, not the plan's `insert or replace`:** REPLACE doesn't fire
   the FTS delete trigger (recursive triggers are off), so the index would keep stale words.
   `test_fts_follows_upsert_on_conflict` covers the upsert path.

### Checkpoint D (maintainer, M1 Max): platform IDs on the real feed

Run every `uv run wts …` command from `pipeline/` (`cd pipeline` first). From the repo root,
`uv` finds no project and fails with ``Failed to spawn: `wts` ``.

1. `git pull`. Create a free Spotify developer app (client credentials) and a YouTube Data API
   key. Put the Wood Talk Spotify show ID in `config.toml` (`uv run wts paths` shows where) as
   `spotify_show_id = "…"`.
2. `uv run wts secrets set spotify_client_id`, `… spotify_client_secret`, `… youtube_api_key`
   (`security` prompts for each value). `uv run wts secrets check` lists them as `set`.
3. `uv run wts feed` — it prints `platform IDs (of 625 episodes): apple 200 (+0), …`: each
   platform's total, then what this run added (and any duplicate/skipped/error). Report:
   - How many of the 35 seed episodes got each ID, and of all 625:
     `sqlite3 -init /dev/null -list state.db "select count(apple_episode_id),
     count(spotify_episode_id), count(youtube_video_id) from episodes where in_scope = 1"`
     (drop the `where` for all). `-init /dev/null` skips the maintainer's `~/.sqliterc` (its
     banner and header settings).
   - The oldest episode with an Apple ID (decision 4):
     `… "select min(published_at) from episodes where apple_episode_id is not null"`.
   - YouTube matches passing the 3 s rule:
     `… "select count(*) from episodes where abs(youtube_duration_s - duration_s) <= 3"`.
   - Any `matches … leaving it unmatched` warnings (`wts` drops an episode with two candidate
     videos or Spotify items in its date window, e.g. a livestream and an edited upload).
   - Spot-check three links per platform.
4. A second `uv run wts feed` changes no IDs.
5. The platform test fixtures are hand-built in each API's documented shape (the cloud session
   can't reach iTunes and has no keys); see `pipeline/tests/fixtures/platforms/README.md`. If
   real responses differ, tell the next session.

If coverage is far below expectations (e.g. under half the 2020–2026 seed episodes on Spotify),
stop and adjust the matching before Task 6.

**Checkpoint D passed (2026-10-06).** A second `wts feed` added nothing (+0 on every
platform). Spot-check, links opened by the maintainer: Spotify WT615, WT288 and episode 1 are
the right episodes; YouTube WT615 (0 s off the feed) and WoodTalk 582 (+1 s) are right and line
up, so both get timed links.

**Results:**
- Spotify: **625 of 625** (seed 35 of 35). Spot-check of three links still to do.
- Apple: **200 of 625** (seed 25 of 35); oldest 2017-10-30 — the lookup's newest-200 limit
  (decision 4). The 10 older seed episodes get no Apple button until the M2 fallback.
- YouTube: **89 of 625** matched, **55** within 3 s of the feed (seed: 23 matched, 21 pass).
  The channel has 187 videos; the 98 unmatched are 39 unnumbered "Wood Talk Live Stream"
  videos (2016–2018, unedited, 20–125 min, so they would fail the length rule anyway), one
  "testing live", and ~57 shorts/clips (≤ 3 min). Two 1-minute clips carry "WT582" in the
  title, which would make ep582 ambiguous: matching now ignores videos under 10 minutes
  (`8a3a360`). Re-run `wts feed` to pick up ep582 if it was left unmatched.
- The User-Agent is not a problem for Spotify (bot and curl UAs both answer in < 0.2 s). The
  first run's Spotify `ReadTimeout` didn't recur; signed-in calls take < 0.3 s. Errors now name
  the failed request (host and path). If timeouts come back, add a retry to platform lookups.
- The real Apple response shape matched the hand-built fixture well enough to match by guid.
3. Corrections/vocabulary are a separate, out-of-band session (`.claude/skills/corrections/`);
   don't mix them into plan 2 work.

**Pending with the maintainer** (not blocking plan 2's first tasks):
- Apply the session-2 corrections to the seed corpus and add **ep71** to scope (maintainer's
  request, 2026-10-07: call-ins with poor audio, a hard case for transcription and search):
  `git pull`, `uv run wts scope add ep:71`, `uv run wts run`. Scope becomes **36** episodes,
  so Checkpoint E expects 36 published, not the plan's 35. ep71 is a good source of plan 5
  test-search-set queries (something said in a bad call-in).
- Before Checkpoint E, the maintainer can set up the staging account pieces that need no new
  code: `wrangler d1 create wts-staging`, the Vectorize index and its `year` metadata index
  (before any upsert), an API token (D1 Edit, Vectorize Edit, Workers AI Read) stored with
  `wts secrets set cloudflare_api_token`, and `cloudflare_account_id` + `[env.staging]` in
  `config.toml`. Not the schema: Task 10's `wrangler d1 migrations apply` does that.
- Ask GitHub Support to purge cached views of commit `a44eec9` (open decision 8).

**Cloud session environment** (checked in session 3):
- Reachable: Acast (`feeds.acast.com`, `sphinx.acast.com`), PyPI, the npm registry, GitHub,
  and **`developers.cloudflare.com`** (session 2's note that it was blocked was wrong or is
  stale; check with `curl` before assuming). Append `index.md` to a docs URL for Markdown, e.g.
  `https://developers.cloudflare.com/d1/platform/limits/index.md`. Node 22 and npm are
  installed (for `worker/`).
- Blocked: `itunes.apple.com` and every `spotify.com` host. Platform tests use hand-built
  fixtures.

**Cloudflare API, checked against the docs (session 3):**
- D1 limits: 100 bound parameters and 100 KB per statement (as planned). Workers on the Free
  plan get only 50 D1 queries per invocation (1000 on Paid): keep the Worker's queries per
  request small.
- D1 REST `query`: body `{sql, params}` or `{batch: [{sql, params}]}`; result is one
  `{results, success?, meta}` per statement. Per-statement `success` is optional (the client
  now fails only on `false`). **`params` are documented as strings**; `wts` sends JSON numbers
  (plan decision). Checkpoint E will show whether D1 accepts them; if not, send strings
  (INTEGER column affinity converts them on insert, but check `where id = ?` comparisons).
- Vectorize HTTP: upsert up to 5000 vectors and 100 MB per request (we send 1000); response
  `result.mutationId`. Upsert body: the API reference shows `Content-Type: application/x-ndjson`
  (what `wts` sends, raw), but its example and the Python guide upload the NDJSON as a multipart
  file (`files={"vectors": f}`). If the raw body is refused at Checkpoint E, switch to multipart.
- Vectorize query `topK`: at most 50 with values or metadata, 100 without (Task 14 uses 50).
- **Pricing that matters for republishing** (pricing pages, session 3): D1 bills *rows
  written* — Free 100,000/day, Paid 50M/month included. Each chunk write also writes its index
  row and several FTS rows (~5–10 rows per chunk, estimated). Publish upserts skip unchanged
  rows (`614c6be`), so a one-sentence correction writes one chunk, and an offset change writes
  only the episode row. A full re-chunk of the archive (~72k chunks) would still be
  ~400–700k rows: over Free's daily limit, trivial on Paid. Vectorize bills stored and
  queried dimensions, not upserts (re-sending vectors costs only upload time, ~1 GB for the
  archive); Free stores 5M dimensions (~6,500 vectors at 768) — enough for the seed (~4k), not
  the archive (~55M), which needs Workers Paid (cents a month).
- Only the 15-minute fixtures of ep001 and ep610–615 are available; full transcripts, audio and
  `state.db` live on the maintainer's Mac.

## Read first

- Spec (source of truth): [`docs/superpowers/specs/2026-10-04-wood-talk-search-design.md`](superpowers/specs/2026-10-04-wood-talk-search-design.md)
- Plan 1 (**done**, Checkpoint C 2026-10-05): [`docs/superpowers/plans/2026-10-05-m1-pipeline-core.md`](superpowers/plans/2026-10-05-m1-pipeline-core.md)
- Plan 2 (Tasks 1–9 and Checkpoint D done; Task 10 next): [`docs/superpowers/plans/2026-10-05-m1-publish-and-api.md`](superpowers/plans/2026-10-05-m1-publish-and-api.md)
- Conventions: [`CLAUDE.md`](../CLAUDE.md) — Edit tool for changes, test-first, brainstorm → spec →
  plan before new features, commit straight to `main` (maintainer's choice for initial build).
- Superpowers skills install from `.claude/settings.json`.

## State

**Code:** `pipeline/` (`wts` CLI) is complete for plan 1: feed → download → transcribe → chunk →
embed, plus fixes from two fresh-reviewer passes and the real-feed follow-ups below. All HTTP
requests now send `WoodTalkSearchBot/<version> (+https://github.com/andreiz/wt-search)`
(`wts/net.py`), which Acast serves ad-free; `AD_FREE_ATTEMPTS` is 2. `wts transcribe` goes
newest first. Steps report as they go: transcribe (time, speed, time left), chunk (chunks,
boilerplate, quality flags per episode and in a summary), embed (new vs cached vectors, time);
every step's time is stored in `runs.counts.seconds`, and `wts run` ends with a per-step summary
and total. 186 tests, ruff clean (`cd pipeline && uv run pytest -q`).

**Maintainer's M1 Max** (`~/Library/Application Support/wts/`): feed ingested (625 episodes),
seed scope = 35 episodes (20 most recent + 15 across 2007–2025), **all 35 downloaded**.
`wts download --refetch-ads` (second session) re-fetched the 29 ad-laden copies: 29 ok, no
`ads_inserted` warnings, so all 35 should be ad-free (confirm with the `ads_inserted=1` count →
0). Its `refetched: 4` means 25 of them were already `new`, probably from an earlier
interrupted re-fetch. **All 35 seed episodes are `embedded`** (Checkpoint C, below).

## What we learned from the real feed

- **Feed:** Acast, `https://feeds.acast.com/public/shows/65a70f971a69290016a72737` (found via
  `itunes.apple.com/lookup?id=251471480` → `feedUrl`). 625 episodes, 2007–2026.
- **Episode numbers** come in many title styles (`#85`, `WT127`, `WT 607`, `Wood Talk 595`,
  `552 -`, `| 609`, `Wood Talk #603`); a side series (**Board Meetings #1–3**, 2011) and seven
  **"NNN Extra"** episodes (2016) are stored unnumbered. Every main episode has a unique number.
  (Spec §3.4.)
- **Acast inserts ads per download — unless the User-Agent looks like a bot** (spec §3.2,
  §4.6). **The cause was the User-Agent, not IP or timing:** `curl` and `…Bot` (capital B;
  the check is case-sensitive, `wts-bot` got ads) get no ads; `python-httpx/…` (what `wts`
  sent before) and unknown User-Agents do. `wts` now sends `WoodTalkSearchBot/<version> (+…)`.
  The notes below describe the ad-laden copies.
  - Files run 24–182 s longer than `itunes:duration`; inserted spots are ~30 s (some 15–20 s),
    1–6 per download. The feed's duration is the show's own, ad-free length.
  - Ads change between downloads over minutes–hours, but rapid retries (5× at 2 s) almost always
    get the same ads — retries cost ~8 GB for 2 GB kept. Two downloads of ep615 minutes apart
    were byte-identical (no ads); ep613 came back once with +96 s and once ad-free.
  - Patreon does **not** offer ad-free audio.
  - **Ad slots (measured on 41 ad copies, second session):** a pre-roll at 0:00, a post-roll,
    and on many episodes one or two **mid-roll** slots at fixed show times (same in every copy
    of an episode). Each download fills each slot with 0–4 min of ads. 20 of 41 copies had
    mid-rolls (2 of 14 from 2026; most 2013–2023). ep613 (32 s pre + 62 s post) was a lucky
    first sample: a pre-roll correction alone would not have given the show's timeline.
    This is what Apple/Spotify listeners get at play time, so platform links land early
    (spec §4.6).
  - Evidence for the User-Agent: from a cloud container, plain `curl` got ad-free files for
    26 of 26 episodes and Apple Podcasts / Spotify app User-Agents got ads in 41 of 52 copies;
    the maintainer confirmed `curl` and `…Bot` vs `wts-bot`/httpx on the Mac. One oddity: a
    single `python-httpx/0.28.1` download of ep613 from the cloud container came back ad-free.
    If ad-laden copies reappear, check the IP before the User-Agent.
  - Acast re-encodes the whole stitched file (44.1 kHz mono 64 kbps, no per-piece headers), so
    ad boundaries can't be read from the MP3 frames.
  - **The show opens with a ~2 s sting** at 0:00, identical 2020–2026, a close variant
    2014–2017, none 2007–2013. Nothing else in the first minute is shared between episodes.
- **YouTube** (@WoodTalk): sporadic from WT322 (2016); livestream-era videos are unedited and
  longer (WT379 1:04:15 vs 50:39 podcast); recent videos match the feed length exactly. Rule:
  link YouTube only when video length is within 3 s of `itunes:duration` (spec §4.6). Exact links
  need timestamps on the show's own (ad-free) timeline.
- **sqlite tip:** the maintainer's `.sqliterc` uses column mode, which wraps long values —
  use `sqlite3 -init /dev/null -list -noheader` when capturing values in shell (`-init
  /dev/null` skips `.sqliterc`, whose settings otherwise win and which prints a banner).

## Spikes: locate inserted ads (no longer needed)

Ad-free downloads (bot User-Agent) make timeline correction unnecessary, so both ad spikes are
done; `ad_fingerprint.py`, `preroll_finder.py` and its results file can be deleted, or kept for
checking a stray ad-laden copy. **Keep** the other two scripts in `pipeline/spikes/`, which are
in use until plan 4's review tool replaces them:
- `transcript_peek.py`: `read <ep>` (raw text, unsure words marked, ffplay command),
  `suspects` (likely mishearings across all transcripts), `issues <ep>` (what `loop_cut` and
  `bad_word_times` caught).
- `check_corrections.py`: every sentence a `corrections.yaml` change would alter.

### Pre-roll finder (done, second session)

`pipeline/spikes/preroll_finder.py` locates the sting in the first `extra + 5` s of an ad copy
(templates: first 2 s of a few ad-free copies from different eras). Results in
`pipeline/spikes/preroll_finder_results.txt`, run in the cloud container on 22 episodes ×
(1 ad-free curl copy + Apple and Spotify UA copies), truth from `ad_fingerprint.py --pair`:

- 2014–2026: pre-roll within +0.0…+0.4 s on all 34 ad copies (match ≤ 2.2 bits vs runner-up
  ≥ 9.7 of 32; zero-pre-roll copies found at 0.0). 2007–2013: no sting, finder says so.
- But mid-rolls (above) mean this only fixes the first slot. Not run on the Mac's seed copies.

### Pair comparison

`pipeline/spikes/ad_fingerprint.py` (throwaway; Chromaprint via ffmpeg-decoded WAV — Acast
stitches ads in a different MP3 format, which raw `fpcalc` can't read):

- `--pair AD_FREE.mp3 AD.mp3` — scans every offset with fingerprint bit-error (exact matches
  are too rare on speech), reports offset steps and inserted spans. Verified on synthetic music,
  synthetic speech (espeak) and the real ep613 pair (median 2.4 bit errors; found 95 of 95.4 s).
  Second session: ground truth for 41 ad copies (~40 s each). On 2007–2013 audio it shows brief
  false matches at some ad/show boundaries (an extra offset step ~1 s long); harmless for
  totals, but read the first span, not the first offset step.
- No-argument mode (cross-episode, finds identical ad audio shared between seed episodes) is
  **untested** and still uses exact-match voting, which fails on speech — rework before use.

### Resolution

Decided by the maintainer (second session): download ad-free with the bot User-Agent; keep the
length check and `ads_inserted` flag as a safety net with `AD_FREE_ATTEMPTS = 2`. Slot mapping
and drift acceptance were the alternatives; neither is needed.

## Open decisions for the maintainer

1. ~~Timeline correction approach~~ — resolved: bot User-Agent (above).
2. ~~Retries~~ — resolved: `AD_FREE_ATTEMPTS` 5 → 2, kept as a safety net.
3. M2: new feed episodes aren't auto-added to scope — scheduled `wts run` would skip them.
   Options: auto-scope new episodes, or default `--select all`.
4. `wts vocab suggest` (pull candidate terms from feed titles/show notes into `vocab.txt`) —
   proposed, not approved.
5. ~~Whether the GitHub repo is public~~ — it is; real fixtures are trimmed to 15 minutes.
6. ~~Plan 2's six decisions~~ — all confirmed. Decision 2: D1 REST (non-atomic, idempotent) for
   now; an atomic publish route in the Worker before production (spec §10 item 9).
7. ~~Boilerplate detection on real data~~ — **deferred to phase 2** (spec §3.5, §9): word-run
   matching plus cutting chunks at boilerplate edges. Until then the existing detector stays and
   most sponsor reads are searchable; `test_real_sponsor_reads_flagged` is `xfail(strict=True)`,
   so it errors once the rework makes it pass (then remove the mark).
8. ~~Full transcripts in public history~~ — removed (second session): `main` was rewritten with
   `git filter-branch` so every commit carries only the trimmed fixtures, and force-pushed. The
   old commit `a44eec9` is unreachable from any branch. Left to do (maintainer): ask GitHub
   Support to purge cached views of `a44eec9` in `andreiz/wt-search`. Clones made before the
   rewrite must `git fetch && git reset --hard origin/main` before committing.

## Next steps (in order)

Plan 1 is finished; plan 2 is next.

1. **Plan 1, Checkpoint B** — **done** (second session). Transcripts of ep001 and ep610–615 are in
   `pipeline/tests/fixtures/real/`, trimmed to the first 15 minutes (the repo is public; the
   full files were removed from history, open decision 8). Results:
   - `test_real_transcripts_clean` **passes** (on full and trimmed files).
   - `test_real_sponsor_reads_flagged` **fails** (now an expected failure; the fix is deferred to
     phase 2, open decision 7): 1 of 7 episodes has a boilerplate chunk (needs ≥ 5). Cause,
     measured on the fixtures:
     1. *Sentence matching:* Whisper punctuates the same sponsor read differently per
        episode (ep610/612 merge "Woodcraft is your trusted source…" with the next sentence),
        so word-set Jaccard drops to ~0.6 < 0.8 and the sentence matches in < 5 episodes. LSH
        itself is fine (identical sentences share 16/16 bands).
     2. *Chunk share:* the read comes in short pieces (≈0:29–0:42, 0:43–0:46, 1:08–1:15) with
        live host talk between them, so a 30 s chunk is only 25–40% boilerplate, under the 60%
        rule. Only ep614 gets one flagged chunk.
   - Experiment: word 6–8-grams shared by ≥ 5 episodes (no sentence boundaries) find the read
     and merch plug in all 6 recent episodes (~110–130 words, ~4% of 15 min) and nothing in
     ep001 — detection works that way, but chunks still need cutting at boilerplate edges.
   - **Speed** (M1 Max, `large-v3-turbo`, from the log's `duration_ms`): 16.4–18.5× realtime,
     about 3.3 min per hour of audio (ep611: 4.4 min for 78.8 min; ep001: 2.0 min for
     33.4 min). The full archive (~620 h, spec §11) ≈ 35 h on the M1 Max; the Mini should be
     faster. `wts transcribe` now prints each episode's time, speed and the time left in the
     run, plus a summary line.
   - No transcription errors.
2. **Plan 1, Checkpoint C** — **done** (second session). Plan 1 is complete.
   - `wts status`: 35 `embedded`, no errors. `wts run`: transcribe 28 episodes in 1:21:55
     (~2.9 min each), chunk 35 → 4,036 chunks in 0:10, embed 4,034 vectors in 0:34.
   - Boilerplate: 2 chunks (0%), as expected with the deferred detector (open decision 7).
   - Flags, reviewed with `transcript_peek.py issues`: all harmless.
     - `loop_cut` on ep602 ("and you, and you, and you, and you.") and ep613 ("Would whisper 1.0
       like do, do, do, …"): real repetition, nothing searchable lost.
     - `bad_word_times` on ep597 ("besser.") and ep602 ("Company.", "debug."): words Whisper
       invented after the audio ends, kept and re-timed. **Possible guard tweak** (needs the
       maintainer's OK and spec §3.3): drop words that start after the audio's end instead.
   - Spot-check: misheard brands/terms became corrections (Festool Systainers, workbench,
     T-9 Boeshield, Cremona, Container Store; commit `cbffe4e`). The seed corpus was chunked
     before that commit: after `git pull`, `uv run wts chunk` + `uv run wts embed` applies them.
     Marc vs Mark has no safe global rule. Whisper also splits long run-on sentences into short
     ones; cosmetic except for boilerplate matching (phase 2).
   - Further corrections and vocabulary are an out-of-band task: a separate session using
     `.claude/skills/corrections/` and `pipeline/spikes/check_corrections.py`.
3. **Plan 2**: Tasks 1–5 done (third session, 283 tests, ruff clean):
   - Task 1: `schema/0001_init.sql` (spec §4.1 + `episodes.year`, FTS5 with sync triggers),
     contract test applies it to in-memory SQLite.
   - Task 2: `wts secrets set/check` (Keychain on the Mac, `WTS_SECRET_<NAME>` elsewhere).
   - Task 3: config `cloudflare_account_id`, `[env.staging|production]`, `run_env`,
     `backup_dir`, platform settings. `[env.*]` tables are kept raw (`env_tables`) and `envs`
     is derived, so `cfg.env(name)` can name each missing key.
   - Task 4: migration 004 (platform IDs, offsets, `publications`, `published_vectors`),
     `state.publish_ready()`.
   - Task 5: `wts.platforms` (Apple lookup by guid, Spotify title ±2 days, YouTube uploads
     playlist by number/title ±14 days). Calls not in the plan: an episode with two candidates
     in its window stays unmatched (logged); an ID already stored on another episode is not
     claimed (the stored one stays); Spotify items with month/year-precision dates are ignored;
     errors are logged as status + Google `reason` only (httpx messages carry the YouTube key).
     After Checkpoint D: `wts feed` prints totals; YouTube ignores videos under 10 minutes.
   - Task 6: `wts/cloudflare.py` (Sonnet subagent, reviewed): `D1.query/batch`,
     `Vectorize.upsert/delete_by_ids` (≤ 1000 per request), retries, token scrubbed from
     errors, `chunked_inserts(table, columns, rows, upsert_on=…)` within 100 params / 50 KB.
   - Task 7: `wts publish --env staging|production [--select] [--dry-run]` (`wts/publish.py`).
     Calls not spelled out in the plan:
     - `published_vectors` is written *before* the Vectorize upsert (insert-or-ignore) and
       trimmed after the delete, so it lists every id that may be in the index; vectors sent
       before a failure are still deleted if a re-chunk then drops their chunk (tested).
     - Gone chunks are deleted with `id not in (select value from json_each(?))` (one JSON
       param; D1's docs recommend this), so any episode size fits the 100-parameter limit.
     - `due_episodes(conn, env, ids, embeddings_dir)` takes the embeddings dir (the digest
       covers the vectors). The digest includes a `DIGEST_VERSION`.
     - A failed `corpus_version` bump sets `kv` `publish.corpus_version_pending.<env>` and is
       retried on the next run even if nothing else is due.
     - The CLI checks config and the token before starting (not for `--dry-run`).
     - Known gap (pre-existing): an episode in `error` isn't re-chunked by a corrections
       refresh (`refresh_chunks` takes chunked/embedded/published only). A publish failure on
       an already-published episode puts it in `error` until a publish succeeds.
     - Follow-up: upserts skip unchanged rows (D1 bills rows written; see the pricing note).
   - Task 8: `wts/notify.py` (Sonnet subagent, reviewed), `wts notify test`. Sent with ntfy's
     JSON publishing (`POST https://ntfy.sh/` with topic/title/message/priority/tags), not the
     plan's headers: titles are non-ASCII, and the secret topic stays out of URLs and so out of
     httpx error text. `wts run` sends one summary at the end (published, failed this run,
     feed quiet > 21 days), a high-priority message for a `MachineProblem` (then re-raises),
     and one for a feed fetch failure, after which the run continues. An episode out of
     retries is reported only in the run that used its last retry (not every run; `wts status`
     lists them). The quiet-feed note does repeat every run while the feed is quiet (default
     priority). `net.describe_http_error()` formats httpx errors without the query string.
     Task 16 must keep `notify_run` last in `run_all`, after publish and backup.
   - Task 9: `wts check-embeddings [--n 5]` (`wts/embedcheck.py`, Sonnet subagent, reviewed).
     Request/response checked against Cloudflare's model page: body `{text: [...], pooling:
     "cls"}` (`mean` is the default and incompatible), result `{shape, data, pooling}`. One
     middle chunk from each of up to n episodes spread by date, one request; cosine with both
     sides normalised; exit 1 below 0.99. Needs `cloudflare_account_id` and the token (Workers
     AI Read), not an `[env.*]` table.
   Its checkpoints:
   - **D** after Task 5: platform IDs on the real feed (Spotify/YouTube keys, no Cloudflare).
   - **E** after Task 10: staging D1 + Vectorize, pooling check, ntfy test, seed corpus published.
   - **F** after Task 13: Worker deployed, exact search on real data, cue times checked.
   - **G** after Task 16: smart search, report, caching, `wts run --env staging` end to end.
4. Plans 3–5: frontend, review tool, test search set (write them after plan 2's Checkpoint G).

## Rulings made during plan 1 (with cost if wrong)

- Steps take episode ids; the CLI and `run_all` resolve selectors. — none.
- Checkpoint A didn't block coding. — a feed quirk found later needs a small fix (it did: stems).
- Log-dir test made platform-neutral. — none.
- `wts feed` refuses > 5 URL-change resets without `--force` (spec §3.1 adds the guard). — one
  extra `--force` run on a real host move.
- Boilerplate similarity uses word sets, not 5-word shingles (one misheard word broke matching);
  spec §3.5 updated. — more false positives on generic sentences; Checkpoint B test will tell.
- Repetition-loop guard stricter than first spec (single word needs 8 repeats; loop ≥ 50% of the
  segment); spec §3.3 updated. — some short hallucination loops survive.
- Empty correction value deletes words, moving sentence-end punctuation to the previous word.
- Download length check: fail only if > 2% shorter or > 10 min longer than the feed (ads make
  files longer); spec §3.2 updated.
- Side-series numbers dropped when > 30 from the median number within ±120 days (applies to
  `itunes:episode` too); spec §3.4 updated.

## Deferred minor issues (from the two code reviews)

- `db.py`: `executescript` commits before the `user_version` bump (crash window during migration).
- No `fsync` before transcript/embedding renames (power loss could leave an empty file).
- `storage`: `mkdir` `PermissionError` isn't mapped to `StorageUnavailable`; no mount-point check.
- Runs stopped by `MachineProblem` or a feed HTTP error are recorded with `errors=0`.
- `FeedResult.updated` counts every row; `reset` also counts episodes already `new`.
- `httpx.Client` never closed. (User-Agent fixed in the second session.)
- Whisper prompt cap counts words, not tokens (~87 words today; fine until `vocab.txt` grows).
- Stem date is the UTC date (US-evening releases get the next day).
- `seed_ids(sampled=1)` divides by zero (not reachable from the CLI).
- Very long unpunctuated sentences are cut at 45 s, not ~30 s (no overlap there).
- Boilerplate refresh is single-pass; after a corrections change it converges on the next run.
- Refresh can reset episodes outside `--select` to `chunked`; `wts embed` only covers the selection.
- Boilerplate 6-word minimum counts tokens, not distinct words.
- Correction matches can cross a sentence end.
- Embedding cache doesn't record model/dim; a corrupt `.npz` fails the episode instead of being ignored.
- ~~A feed fetch failure stops `wts run` entirely~~ — fixed in plan 2 Task 8: it is logged,
  counted, notified, and the run continues with the downloaded backlog.
- Weak ETags can't be used with `If-Range` (resume restarts); Ctrl-C can wait up to the 60 s timeout.
- One process slip: in Task 12 `run_chunk` was appended with a shell heredoc instead of the Edit
  tool (content is a normal diff).
- Second session, same kind of slip: one `sed` edit to the new `preroll_finder.py` (clip length
  `+ 1` → `+ 5`) and a script-generated `preroll_finder_results.txt`. Both files are new in
  this commit, so the diff still shows everything.
- Third session: the Task 3 config tests were appended to `test_config.py` with a shell heredoc
  instead of the Edit tool (content is a normal diff). Later, one `sed` edit to the handoff's
  title and one to its "Start here" line (both one-line, normal diffs).
