# wt-search

Full-text and meaning-based search over Wood Talk podcast transcripts. A
Python pipeline on a Mac transcribes episodes; a Cloudflare Worker, D1,
Vectorize and a Pages frontend serve search.

## Key docs

- `VISION.md` — the original idea.
- `DESIGN.md` — a one-page overview.
- `docs/HANDOFF.md` — current state, findings, open decisions and next steps. Read it first
  when resuming; update it at the end of a working session.
- `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` — the full
  design spec. This is the source of truth; update it when a design decision
  changes.

## Skills

- `.claude/skills/corrections/` — turning reported transcript mistakes into safe
  `corrections.yaml` rules and `vocab.txt` entries (checked with `pipeline/spikes/check_corrections.py`).

## Commands

- `cd pipeline && uv run pytest -q` — pipeline tests (ML backends faked; runs on Linux)
- `cd pipeline && uv run ruff check .` — lint
- `cd pipeline && uv run pytest -m mac` — Mac only: real MLX Whisper and bge models
- `cd worker && npm test` — Worker tests (Vitest in the Workers runtime, local D1; runs on Linux)
- `cd worker && npx tsc --noEmit` — Worker type-check

## Layout

- `pipeline/` — Python `wts` CLI (Mac); see `pipeline/README.md`
- `worker/` — Cloudflare Worker (TypeScript)
- `web/` — frontend (Vite + TypeScript + Preact) — planned
- `schema/` — D1 migrations, the shared contract between pipeline and Worker
- `eval/` — test search set and baselines — planned

## Conventions

- Edit files with the Edit tool, not ad-hoc Python, sed or other scripts, so
  every change is a reviewable diff. Use Write only for new files or full
  rewrites.
- Design work goes through brainstorming → spec → implementation plan before
  any code.
- No secrets in the repo. They live in the macOS Keychain (spec §3.6).
- Commit and push straight to `main`. Don't create branches unless the
  maintainer asks for one.
