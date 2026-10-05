# Handoff — 2026-10-05

Where the project stands after the first working session, so a fresh session can pick up
without the conversation. Read this, then [README.md](../README.md), then the spec sections it
points to.

## Read first

- Spec (source of truth): [`docs/superpowers/specs/2026-10-04-wood-talk-search-design.md`](superpowers/specs/2026-10-04-wood-talk-search-design.md)
- Plan 1 (built): [`docs/superpowers/plans/2026-10-05-m1-pipeline-core.md`](superpowers/plans/2026-10-05-m1-pipeline-core.md)
- Plan 2 (written, decisions confirmed, not started): [`docs/superpowers/plans/2026-10-05-m1-publish-and-api.md`](superpowers/plans/2026-10-05-m1-publish-and-api.md)
- Conventions: [`CLAUDE.md`](../CLAUDE.md) — Edit tool for changes, test-first, brainstorm → spec →
  plan before new features, commit straight to `main` (maintainer's choice for initial build).
- Superpowers skills install from `.claude/settings.json`.

## State

**Code:** `pipeline/` (`wts` CLI) is complete for plan 1: feed → download → transcribe → chunk →
embed, plus fixes from two fresh-reviewer passes and the real-feed follow-ups below. All HTTP
requests now send `WoodTalkSearchBot/<version> (+https://github.com/andreiz/wt-search)`
(`wts/net.py`), which Acast serves ad-free; `AD_FREE_ATTEMPTS` is 2. `wts transcribe` goes
newest first. 178 tests, ruff clean (`cd pipeline && uv run pytest -q`).

**Maintainer's M1 Max** (`~/Library/Application Support/wts/`): feed ingested (625 episodes),
seed scope = 35 episodes (20 most recent + 15 across 2007–2025), **all 35 downloaded**.
`wts download --refetch-ads` (second session) re-fetched the 29 ad-laden copies: 29 ok, no
`ads_inserted` warnings, so all 35 should be ad-free (confirm with the `ads_inserted=1` count →
0). Its `refetched: 4` means 25 of them were already `new`, probably from an earlier
interrupted re-fetch. Checkpoint B is in progress.

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
  use `sqlite3 -list -noheader` when capturing values in shell.

## Spikes: locate inserted ads (no longer needed)

Ad-free downloads (bot User-Agent) make timeline correction unnecessary, so both spikes are
done; `pipeline/spikes/` can be deleted, or kept as tools for checking a stray ad-laden copy.

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
5. Whether the GitHub repo is public (decides if real transcript fixtures can be committed whole
   or must be trimmed to the first 15 minutes).
6. ~~Plan 2's six decisions~~ — all confirmed. Decision 2: D1 REST (non-atomic, idempotent) for
   now; an atomic publish route in the Worker before production (spec §10 item 9).

## Next steps (in order)

1. **Checkpoint B** (maintainer, in progress): `uv run pytest -m mac -k mlx`, then
   `uv run wts transcribe`. Commit 6 recent transcripts to `pipeline/tests/fixtures/real/` →
   enables the two real-data tests (guards drop < 5% of words; boilerplate flags reads in ≥ 5 of
   6 without exceeding 15%).
2. **Plan 2** (written, decisions confirmed): execute task by task. Its checkpoints:
   - **D** after Task 5: platform IDs on the real feed (Spotify/YouTube keys, no Cloudflare).
   - **E** after Task 10: staging D1 + Vectorize, pooling check, ntfy test, seed corpus published
     (needs Checkpoint C).
   - **F** after Task 13: Worker deployed, exact search on real data, cue times checked.
   - **G** after Task 16: smart search, report, caching, `wts run --env staging` end to end.
3. **Checkpoint C**: full seed corpus (`wts run`), boilerplate counts, correction candidates.
   Needed before plan 2's Checkpoint E.
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
- A feed fetch failure stops `wts run` entirely (downloaded backlog isn't processed).
- Weak ETags can't be used with `If-Range` (resume restarts); Ctrl-C can wait up to the 60 s timeout.
- One process slip: in Task 12 `run_chunk` was appended with a shell heredoc instead of the Edit
  tool (content is a normal diff).
- Second session, same kind of slip: one `sed` edit to the new `preroll_finder.py` (clip length
  `+ 1` → `+ 5`) and a script-generated `preroll_finder_results.txt`. Both files are new in
  this commit, so the diff still shows everything.
