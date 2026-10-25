# wts — Wood Talk transcript pipeline

Turns the Wood Talk RSS feed into a local corpus: audio → Whisper transcripts → cleaned,
corrected, ~30 s chunks (sponsor reads flagged) → bge embeddings. Design:
`docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` §3.

## Setup (Mac)

```sh
brew install ffmpeg
cd pipeline
uv sync --extra mac          # mlx-whisper + sentence-transformers (Apple Silicon)
uv run wts paths             # where config, state, audio and logs live
```

Create `~/Library/Application Support/wts/config.toml`:

```toml
feed_url = "https://…"       # the show's RSS feed
# audio_dir = "/Volumes/media/wts/audio"   # from M2: audio on the NAS (default: local)
# backup_dir = "/Volumes/media/wts/backup" # wts run copies the app folder here (not audio)
# run_env = "staging"                      # where wts run publishes (else: --env)
```

Top-level keys go before any `[env.*]` table, or TOML puts them inside it.

## Everyday use

```sh
uv run wts feed                    # add/update episodes from the feed
uv run wts scope add seed          # M1: 20 most recent + 15 across the years
uv run wts run --env staging       # feed → download → transcribe → chunk → embed → publish → smoke → backup
uv run wts status                  # counts per status, errors, recent runs
uv run wts status --flagged        # the episodes the guards flagged, and which are reviewed
uv run wts logs --since 1d --level warning  # log lines (--run ID, --episode ep312, --json)
uv run wts backup                  # back up to backup_dir now
uv run wts links 71 --at 12:34     # an episode's YouTube/Apple/Spotify/page/audio links
uv run wts search '"hide glue" -titebond'   # search a deployed Worker (--env, --mode exact, --json)
uv run wts search --debug 'flattening a bench top'   # plus each hit's ranks and scores (smart mode)
```

## Reviewing transcripts and reports

```sh
uv run wts review 71               # an episode in the browser: audio and transcript in step
uv run wts review 71 --at 12:34    # opened at a time
uv run wts review --next-flagged   # the oldest episode the quality guards flagged, not yet reviewed
uv run wts reports                 # open listener reports and feedback (--all, --json, --env)
uv run wts review --report 12      # the passage a listener reported
uv run wts reports resolve 12 13   # also: reject, reopen
```

`wts review` serves a page on `127.0.0.1` only, on a free port, and stops on Ctrl-C. The URL
it prints holds that run's secret token. The page shows the corrected words (what search has),
with words Whisper was unsure of underlined. The "Open another episode…" menu in the header
switches to any transcribed episode without restarting the server.

| Key | Does |
|---|---|
| Space | play or pause |
| ← / → | back or forward 5 s |
| `[` / `]` | previous or next chunk |
| `n` | next unsure word |
| `e` | make a correction from the selected words |
| `t` | add a test search for the selected words (or the current passage) to `eval/queries.yaml` |

A correction is a rule in `corrections.yaml`, for every episode or only this one. The page
first lists every sentence the rule would change, in all transcripts on this Mac; it can only
be saved after that preview. Saving edits the file (comments and order are kept) and re-chunks
the open episode; it does not commit. Review `git diff`, commit, and run `uv run wts chunk` for
the other episodes.

A test search (`t`) takes what you'd type to find the passage, and whether search should find it
or not return it. **Check** runs it against `run_env` and shows where the passage lands in
Exact and Related. **Save** appends the case to `eval/queries.yaml`. Commit it like a correction.

`wts reports` reads D1 through the Cloudflare API, for `--env` or `run_env`. `wts run` sends
at most one notification a day about new reports.

`wts search` calls the Worker's `/api/search`, so it needs the Worker's URL as `api_url` under
`[env.staging]` (or `[env.production]`) in `config.toml`; the environment defaults to `run_env`.
`wts publish` doesn't need it.

## Test search set

```sh
uv run wts eval run                # score staging against eval/*.yaml; exit 1 on a drop > 0.02
uv run wts eval run --only paraphrase   # one tag or case id (no baseline comparison)
uv run wts eval run --update       # also make this report eval/baseline.json
uv run wts eval generate --model qwen2.5:7b   # ~100 synthetic cases (Ollama app running)
```

`wts eval generate` takes the model from `--model` or `eval_model` in `config.toml`, and the
Ollama server from `--ollama-url` or `ollama_url` (default `http://localhost:11434`).

The cases are in `../eval/` (see its README). A run sends about one request a second; reports go
to `eval/reports/` (not committed).

Each step also runs on its own (`download`, `transcribe`, `chunk`, `embed`) and takes
`--select` (`scope`, `all`, `seed`, `recent:N`, `ep:N`, `year:YYYY`, `stem:S`; comma = union).
Everything is safe to re-run and to stop with Ctrl-C.

- Inserted ads: Acast stitches ads into downloads unless the User-Agent looks like a bot, so
  `wts` sends `WoodTalkSearchBot/<version>` (`src/wts/net.py`; keep the capital B — Acast's
  check is case-sensitive). As a safety net `wts download` tries twice for a copy whose length
  matches the feed — i.e. no ads — and otherwise keeps the shorter and marks it
  `ads_inserted`. `uv run wts download --refetch-ads` re-does stored copies that have ads.
- Misheard words: add them to `corrections.yaml` (by hand, or from `wts review`), then
  `uv run wts chunk` (no re-transcribing).
- Whisper's spelling hints: `vocab.txt`.
- If the audio folder is missing, unwritable or under 2 GB free, or `ffprobe` is missing, steps
  stop with exit code 3 and no episode is marked as failed.
- `wts run` publishes to `--env`, else `run_env`; with neither it skips publishing (a warning).
  It then backs up to `backup_dir` (a consistent `state.db` snapshot plus `rsync` of the app
  folder, without audio) and sends one summary notification. A failed backup is a warning and
  a notification, not a failed run.
- `wts feed` refuses to reset more than 5 episodes whose audio URL changed; use `--force`
  if the show really moved its audio.

## Development

```sh
uv run pytest -q          # Linux or Mac; ML backends are faked
uv run ruff check .
uv run pytest -m mac      # Mac only: real MLX Whisper and bge models, and the Mac's rsync
```
