# Design overview

A one-page summary. The full spec, which is the source of truth, is
[`docs/superpowers/specs/2026-10-04-wood-talk-search-design.md`](docs/superpowers/specs/2026-10-04-wood-talk-search-design.md).

## What it does

Listeners search everything said on Wood Talk (about 620 episodes since
2007). Each result shows the transcript excerpt with the hits highlighted,
links to the episode on YouTube, Apple Podcasts, Spotify and the Wood Talk
site, starting about 7 s before the hit, and can expand to show more of the
transcript.

## Architecture

```
Mac (offline batch)                               Cloudflare (serving)
feed → download → transcribe → chunk → embed ──▶ D1 (FTS5) + Vectorize
        audio on NAS     mlx-whisper   bge-base     Worker /api ◀── Pages UI
```

- **Pipeline (`wts`, Python):** a status per episode (`new → … →
  published`) drives every step, and every step is safe to re-run.
  - Transcription: Whisper `large-v3-turbo` with word timestamps.
  - Chunking: about 30 s windows, with fixes from `corrections.yaml`
    applied, and repeated sponsor reads, intros and outros detected by
    text matching.
  - Embedding: `bge-base-en-v1.5`, 768 dimensions.
  - Publishing: only changed episodes, to `staging` or `production`.
- **Search (Worker):**
  - Keyword search (SQLite FTS5 with query syntax) and meaning-based search
    (Vectorize, with Workers AI embedding the query) are merged with
    reciprocal rank fusion.
  - Sort by relevance, newest or oldest.
  - Hits are cued to the exact word using stored word timings.
- **Frontend:** a static Preact app. Searches run on Enter, the whole state
  is in the URL, and each result has a "Report transcript error" form.
- **Review tool (`wts review`):** a local-only page that plays our audio in
  sync with the transcript, for fixing errors and measuring platform
  timestamp offsets.

## Key decisions

| Decision | Why |
|---|---|
| Deep-link out; host no audio | Respects the show's distribution and avoids rights issues. |
| Cloudflare (about $8–9 a month) | No servers to patch. The main variable cost is Vectorize storage. |
| Heavy compute on the Mac | Transcription and embeddings are free locally and run once. |
| Per-platform timestamp offsets | Ads inserted at download time can shift Apple and Spotify timestamps; YouTube is exact when its audio lines up. |
| Test search set with a regression check | Ranking, chunking and model changes are measured on staging, not guessed. |

## Milestones

1. **M1:** 35 seed episodes (20 recent + 15 across the years) on the M1 Max,
   audio on local disk → staging, review tool, test
   search set baseline, deep-link and alignment checks.
2. **M2:** full archive on the Mac Mini → production, scheduled runs and
   watchdog, public launch with the hosts' blessing.
3. **Later:** topic summaries per episode; compact Opus audio on the NAS.
