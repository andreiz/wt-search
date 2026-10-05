# wt-search

Search everything said on the [Wood Talk](https://www.woodtalkshow.com) podcast — not just
show notes. Each result shows the transcript excerpt with hits highlighted and links to the
episode at that moment.

An unofficial project, built with the hosts' blessing in mind (to be confirmed before launch).

## How it works

```
Mac (offline batch)                               Cloudflare (serving)
feed → download → transcribe → chunk → embed ──▶ D1 (full-text) + Vectorize
         Acast     MLX Whisper   ~30 s    bge-base    Worker /api ◀── web UI
```

- **Pipeline** (`pipeline/`, Python CLI `wts`) runs on a Mac: pulls the RSS feed, downloads
  audio, transcribes with Whisper (word timings), cleans and corrects the text, flags
  repeated sponsor reads, cuts ~30 s chunks and embeds them.
- **Search** (planned: `worker/`, `web/`) combines keyword search with meaning-based search
  and deep-links to YouTube, Apple Podcasts, Spotify and the Wood Talk site.

More: [DESIGN.md](DESIGN.md) (one page) and the full
[spec](docs/superpowers/specs/2026-10-04-wood-talk-search-design.md).

## Status

| Milestone | What | State |
|---|---|---|
| M1 plan 1 | Pipeline core: feed → embeddings | **Done** ([plan](docs/superpowers/plans/2026-10-05-m1-pipeline-core.md)): 35 seed episodes embedded (4,034 vectors); ~17× realtime transcription |
| — | Inserted ads | **Solved** by the User-Agent: `wts` sends `WoodTalkSearchBot/…`, which Acast serves ad-free |
| M1 plan 2 | D1 schema, Worker API, `wts publish` | Planned ([plan](docs/superpowers/plans/2026-10-05-m1-publish-and-api.md)), decisions confirmed |
| M1 plans 3–5 | Frontend, review tool, test search set | Not started |
| M2 | Full archive on the Mac Mini, production, launch | Not started |

### Findings so far

- The feed has **625 episodes** (2007–2026). Episode numbers come from `itunes:episode` or
  the title (`#85`, `WT127`, `Wood Talk 595`, …); side series (Board Meetings) and
  "NNN Extra" episodes are unnumbered.
- **Acast inserts ads per download**: the same episode can come back with no ads or
  1–3 minutes of them. Files may therefore be longer than the feed's `itunes:duration`.
  Apple/Spotify links will drift by the listener's ad time; ad-free copies (length ≈ feed
  duration) give the show's own timeline. Measured on 41 ad copies: ads fill a pre-roll, a
  post-roll and, on many episodes, one or two mid-roll slots (20 of 41 copies). Which copy you
  get depends on the User-Agent: `curl` and `…Bot` (capital B) get no ads; httpx's default and
  unknown ones do. `wts` sends `WoodTalkSearchBot/<version>`.
- YouTube (@WoodTalk) has recent episodes at exactly the feed's length; older videos are
  unedited livestreams.

**Picking this up in a new session?** Start with [docs/HANDOFF.md](docs/HANDOFF.md).

## Quick start (pipeline, Mac)

```sh
brew install ffmpeg
cd pipeline && uv sync --extra mac
uv run wts paths                         # where config, state, audio and logs live
```

Put the feed in `~/Library/Application Support/wts/config.toml`:

```toml
feed_url = "https://feeds.acast.com/public/shows/…"   # from: itunes.apple.com/lookup?id=251471480
```

Then:

```sh
uv run wts feed              # add/update episodes
uv run wts scope add seed    # M1 seed: 20 most recent + 15 across the years
uv run wts run               # download → transcribe → chunk → embed (safe to Ctrl-C and re-run)
uv run wts status
```

Details, options and troubleshooting: [pipeline/README.md](pipeline/README.md).

## M1 checkpoints (manual runs on the Mac)

Full steps are in the [plan](docs/superpowers/plans/2026-10-05-m1-pipeline-core.md#checkpoints).

| Checkpoint | Run | Report back |
|---|---|---|
| **A** — seed on disk | `wts feed`, `wts scope add seed`, `wts download`; download one episode twice and compare | episode count, errors, ad-insertion result |
| **B** — transcription | `uv run pytest -m mac -k mlx`, then `wts transcribe`; commit 6 recent transcripts to `pipeline/tests/fixtures/real/` | time per episode, fixture commit |
| **C** — full seed corpus | `wts run`, then check boilerplate counts and spot-check transcripts | status, boilerplate counts, misheard terms |

Querying the state database by hand: use `sqlite3 -list -noheader` when capturing values into
shell variables (a `.sqliterc` with `.mode column` wraps long values onto several lines).

## Development

```sh
cd pipeline
uv run pytest -q          # runs anywhere; Whisper and embeddings are faked
uv run ruff check .
uv run pytest -m mac      # Mac only: real MLX Whisper and bge models
```

Conventions are in [CLAUDE.md](CLAUDE.md): design goes brainstorming → spec → plan before
code, changes are test-first, and the spec is the source of truth.

## Repository layout

```
pipeline/   Python `wts` CLI (Mac) — built
worker/     Cloudflare Worker API — planned
web/        Frontend (Vite + Preact) — planned
schema/     D1 migrations — planned
eval/       Test search set and baselines — planned
docs/       Spec and implementation plans
```
