# wt-search

Full-text and meaning-based search over Wood Talk podcast transcripts. A
Python pipeline on a Mac transcribes episodes; a Cloudflare Worker, D1,
Vectorize and a Pages frontend serve search.

## Key docs

- `VISION.md` — the original idea.
- `DESIGN.md` — a one-page overview.
- `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` — the full
  design spec. This is the source of truth; update it when a design decision
  changes.

## Layout (planned; no code yet)

- `pipeline/` — Python `wts` CLI (Mac)
- `worker/` — Cloudflare Worker (TypeScript)
- `web/` — frontend (Vite + TypeScript + Preact)
- `schema/` — D1 migrations, the shared contract between pipeline and Worker
- `eval/` — test search set and baselines

## Conventions

- Edit files with the Edit tool, not ad-hoc Python, sed or other scripts, so
  every change is a reviewable diff. Use Write only for new files or full
  rewrites.
- Design work goes through brainstorming → spec → implementation plan before
  any code.
- No secrets in the repo. They live in the macOS Keychain (spec §3.6).
