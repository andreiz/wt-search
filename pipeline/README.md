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
```

## Everyday use

```sh
uv run wts feed                    # add/update episodes from the feed
uv run wts scope add seed          # M1: 20 most recent + 15 across the years
uv run wts run                     # feed → download → transcribe → chunk → embed
uv run wts status                  # counts per status, errors, recent runs
uv run wts search '"hide glue" -titebond'   # search a deployed Worker (--env, --mode exact, --json)
```

`wts search` calls the Worker's `/api/search`, so it needs the Worker's URL as `api_url` under
`[env.staging]` (or `[env.production]`) in `config.toml`; the environment defaults to `run_env`.
`wts publish` doesn't need it.

Each step also runs on its own (`download`, `transcribe`, `chunk`, `embed`) and takes
`--select` (`scope`, `all`, `seed`, `recent:N`, `ep:N`, `year:YYYY`, `stem:S`; comma = union).
Everything is safe to re-run and to stop with Ctrl-C.

- Inserted ads: Acast stitches ads into downloads unless the User-Agent looks like a bot, so
  `wts` sends `WoodTalkSearchBot/<version>` (`src/wts/net.py`; keep the capital B — Acast's
  check is case-sensitive). As a safety net `wts download` tries twice for a copy whose length
  matches the feed — i.e. no ads — and otherwise keeps the shorter and marks it
  `ads_inserted`. `uv run wts download --refetch-ads` re-does stored copies that have ads.
- Misheard words: add them to `corrections.yaml`, then `uv run wts chunk` (no re-transcribing).
- Whisper's spelling hints: `vocab.txt`.
- If the audio folder is missing, unwritable or under 2 GB free, or `ffprobe` is missing, steps
  stop with exit code 3 and no episode is marked as failed.
- `wts feed` refuses to reset more than 5 episodes whose audio URL changed; use `--force`
  if the show really moved its audio.

## Development

```sh
uv run pytest -q          # Linux or Mac; ML backends are faked
uv run ruff check .
uv run pytest -m mac      # Mac only: real MLX Whisper and bge models
```
