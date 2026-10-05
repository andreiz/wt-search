# Handoff — 2026-10-05

Where the project stands after the first working session, so a fresh session can pick up
without the conversation. Read this, then [README.md](../README.md), then the spec sections it
points to.

## Read first

- Spec (source of truth): [`docs/superpowers/specs/2026-10-04-wood-talk-search-design.md`](superpowers/specs/2026-10-04-wood-talk-search-design.md)
- Plan 1 (built): [`docs/superpowers/plans/2026-10-05-m1-pipeline-core.md`](superpowers/plans/2026-10-05-m1-pipeline-core.md)
- Conventions: [`CLAUDE.md`](../CLAUDE.md) — Edit tool for changes, test-first, brainstorm → spec →
  plan before new features, commit straight to `main` (maintainer's choice for initial build).
- Superpowers skills install from `.claude/settings.json`.

## State

**Code:** `pipeline/` (`wts` CLI) is complete for plan 1: feed → download → transcribe → chunk →
embed, plus fixes from two fresh-reviewer passes and the real-feed follow-ups below. 174 tests,
ruff clean (`cd pipeline && uv run pytest -q`).

**Maintainer's M1 Max** (`~/Library/Application Support/wts/`): feed ingested (625 episodes),
seed scope = 35 episodes (20 most recent + 15 across 2007–2025), **all 35 downloaded**; 6 are
ad-free copies, 29 carry inserted ads. **Nothing transcribed yet** (Checkpoint B not started).

## What we learned from the real feed

- **Feed:** Acast, `https://feeds.acast.com/public/shows/…` (found via
  `itunes.apple.com/lookup?id=251471480` → `feedUrl`). 625 episodes, 2007–2026.
- **Episode numbers** come in many title styles (`#85`, `WT127`, `WT 607`, `Wood Talk 595`,
  `552 -`, `| 609`, `Wood Talk #603`); a side series (**Board Meetings #1–3**, 2011) and seven
  **"NNN Extra"** episodes (2016) are stored unnumbered. Every main episode has a unique number.
  (Spec §3.4.)
- **Acast inserts ads per download** (spec §3.2, §4.6):
  - Files run 24–182 s longer than `itunes:duration`; inserted spots are ~30 s (some 15–20 s),
    1–6 per download. The feed's duration is the show's own, ad-free length.
  - Ads change between downloads over minutes–hours, but rapid retries (5× at 2 s) almost always
    get the same ads — retries cost ~8 GB for 2 GB kept. Two downloads of ep615 minutes apart
    were byte-identical (no ads); ep613 came back once with +96 s and once ad-free.
  - Patreon does **not** offer ad-free audio.
  - **ep613 measured exactly** (ad-free `/tmp/second.mp3` vs ad copy, via the spike below):
    **32 s pre-roll at 0:00 + 62 s post-roll at the end, no mid-rolls**; show audio sits at a
    constant +32.1 s offset. If this holds generally, the show's timeline needs only the
    **pre-roll length per episode**.
- **YouTube** (@WoodTalk): sporadic from WT322 (2016); livestream-era videos are unedited and
  longer (WT379 1:04:15 vs 50:39 podcast); recent videos match the feed length exactly. Rule:
  link YouTube only when video length is within 3 s of `itunes:duration` (spec §4.6). Exact links
  need timestamps on the show's own (ad-free) timeline.
- **sqlite tip:** the maintainer's `.sqliterc` uses column mode, which wraps long values —
  use `sqlite3 -list -noheader` when capturing values in shell.

## Spike in progress: locate inserted ads

`pipeline/spikes/ad_fingerprint.py` (throwaway; Chromaprint via ffmpeg-decoded WAV — Acast
stitches ads in a different MP3 format, which raw `fpcalc` can't read):

- `--pair AD_FREE.mp3 AD.mp3` — scans every offset with fingerprint bit-error (exact matches
  are too rare on speech), reports offset steps and inserted spans. Verified on synthetic music,
  synthetic speech (espeak) and the real ep613 pair (median 2.4 bit errors; found 95 of 95.4 s).
- No-argument mode (cross-episode, finds identical ad audio shared between seed episodes) is
  **untested** and still uses exact-match voting, which fails on speech — rework before use.

**Next step proposed (not started):** a *pre-roll finder* — use the show's opening from an
ad-free copy as a template, locate it near the start of each ad-laden copy → pre-roll length;
check `extra − pre-roll` looks like a post-roll (~30/60 s) to confirm no mid-rolls. Recent
episodes first (they have YouTube); older eras need their own opening template. If it holds,
design the pipeline step (store per-episode pre-roll; map transcript times to show time) via
brainstorming → spec → plan.

## Open decisions for the maintainer

1. Pre-roll finder spike — go ahead? (Proposed above.)
2. Retries: reduce `AD_FREE_ATTEMPTS` from 5 to 2 (rapid retries rarely help), or drop retrying
   once timeline correction exists.
3. M2: new feed episodes aren't auto-added to scope — scheduled `wts run` would skip them.
   Options: auto-scope new episodes, or default `--select all`.
4. `wts vocab suggest` (pull candidate terms from feed titles/show notes into `vocab.txt`) —
   proposed, not approved.
5. Whether the GitHub repo is public (decides if real transcript fixtures can be committed whole
   or must be trimmed to the first 15 minutes).

## Next steps (in order)

1. **Checkpoint B** (maintainer): `uv run pytest -m mac -k mlx`, then `uv run wts transcribe`.
   Can start now on the 6 ad-free episodes
   (`q "select stem from episodes where in_scope=1 and audio_duration_s <= duration_s + 5"`).
   Commit 6 recent transcripts to `pipeline/tests/fixtures/real/` → enables the two real-data
   tests (guards drop < 5% of words; boilerplate flags reads in ≥ 5 of 6 without exceeding 15%).
2. Pre-roll finder spike → if it holds, design the timeline-correction step.
3. **Checkpoint C**: full seed corpus (`wts run`), boilerplate counts, correction candidates.
4. **Plan 2**: D1 schema, Worker API, `wts publish`, platform ID matching (Apple, Spotify,
   YouTube @WoodTalk with the length rule), Keychain secrets, ntfy, backups, `wts logs`.
   Write it with `superpowers:writing-plans` from spec §4, §6–§8.
5. Plans 3–5: frontend, review tool, test search set.

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
- `httpx.Client` never closed; default User-Agent.
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
