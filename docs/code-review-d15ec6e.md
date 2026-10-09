# wt-search codebase review — d15ec6e

- Date: 2026-10-09
- HEAD (short SHA): `d15ec6e`
- Scope: implemented Python pipeline, Cloudflare Worker, schema, configuration, and tests.
- Method: four parallel, read-only review-swarm reviewers covering correctness, security/privacy, performance/reliability, and contracts/coverage; surviving findings checked against source and relevant tests.
- Verification: isolated in-memory reproductions; full test suites and live deployment were not exercised.
- Confidence: high for all findings below.

## Summary

Found **9 actionable issues**. The most important are recovery failures that can persist incorrect published data, followed by a search-cache collision that can suppress legitimate results.

## High priority

### 1. Interrupted corrections refresh can publish new text with old embeddings

**Category:** reliability  
**Locations:** `pipeline/src/wts/chunking.py:55–70, 83–94`; `pipeline/src/wts/publish.py:99–105`

Changed chunks commit before the episode is marked for re-embedding. If the process stops between those operations, the episode remains `embedded` or `published`. On rerun, the chunks already match, so refresh skips the status reset.

Publishing validates embedding IDs, but not their text hashes. Because chunk IDs stay stable, it accepts corrected text paired with vectors for the previous text.

**Recommended fix:** Commit chunk updates and downstream invalidation atomically; also check embedding text hashes before publishing. Add an interruption-and-rerun regression test.

### 2. Reverting content after a failed publish can permanently skip remote repair

**Category:** reliability  
**Locations:** `pipeline/src/wts/publish.py:127–136, 156–192`

Consider:

1. Publish content A successfully.
2. Attempt B; remote writes apply, but the response is lost.
3. Revert local content to A.
4. Retry publishing.

The recorded successful digest still equals A, so the retry skips the episode—even though remote data contains B or partially applied changes. An in-memory reproduction left the local Spotify offset at `0` and the remote offset at `42`.

**Recommended fix:** Persist a per-episode, per-environment dirty marker before remote writes. Reconcile dirty episodes regardless of digest equality, clearing the marker only after success.

## Medium priority

### 3. Different searches share a cache key, enabling result suppression

**Categories:** security, correctness  
**Locations:** `worker/src/cache.ts:48–55`; `worker/src/query.ts:69–80`

The cache trims and collapses whitespace across the full query; the parser first truncates raw input to 200 code points.

For example, `" ".repeat(200) + "glue"` and `"glue"` share a cache key, but the former parses as an empty search. A reproduction using the actual Worker cached the empty response and subsequently served it to a legitimate `glue` search.

Anyone can populate this collision without a valid Turnstile token or an AI call. The affected cache entry can persist for the configured one-hour TTL.

**Recommended fix:** Derive execution input and cache keys from the same bounded representation. Test both request orders around the truncation boundary.

### 4. Cached smart results bypass the exact-only kill switch

**Category:** correctness  
**Location:** `worker/src/index.ts:113–126`

Cache hits return before `SEARCH_OVERRIDE="exact"` is evaluated. After enabling the switch, previously cached smart responses still contain meaning-based results and omit `smart_degraded: "off"`.

The existing override test exercises a cold cache.

**Recommended fix:** Resolve the override before accepting smart cache hits; bypass or namespace those entries while exact-only mode is active. Test warm cache → enable override → repeat query.

### 5. Report size limits do not bound streamed-body memory use

**Categories:** security, reliability  
**Location:** `worker/src/report.ts:150–155`

The early size check relies on `Content-Length`. Without that header, `request.text()` buffers the entire request before validation rejects it.

A streamed-request reproduction consumed all 1 MB before returning 400. Larger uploads can exhaust Worker memory before Turnstile verification; rate limiting bounds request count, not individual body size.

**Recommended fix:** Read incrementally with a hard byte cap and cancel the stream immediately when exceeded.

### 6. Interrupted feed updates can lose the required audio reset

**Category:** reliability  
**Location:** `pipeline/src/wts/feed.py:178–189`

A changed audio URL commits before the episode is reset to `new`. If interrupted between these operations, the next feed refresh sees the new URL already stored and performs no reset.

The episode can retain audio, transcripts, and embeddings from the previous recording while exposing the new URL.

**Recommended fix:** Make the metadata update and required state reset atomic; cover interruption and recovery.

### 7. Successful publishing can lose its owed cache invalidation

**Category:** reliability  
**Location:** `pipeline/src/wts/publish.py:248–264`

Successful publication digests commit per episode, but the pending `corpus_version` flag is written only after the loop. Interrupt after publication succeeds but before that flag is recorded, and the next run sees neither changed content nor pending invalidation.

Cached results can remain stale for their remaining TTL. Existing tests cover a failed version bump, but not interruption before recording the obligation.

**Recommended fix:** Persist the invalidation obligation before remote mutations or atomically with each successful publication.

### 8. Corrections refresh produces order-dependent boilerplate flags

**Category:** correctness  
**Locations:** `pipeline/src/wts/chunking.py:43–45, 77–94`; `pipeline/src/wts/steps.py:244–247`

Refresh updates one episode’s fingerprints and immediately classifies it against an index containing older fingerprints for later episodes.

A five-episode reproduction produced flags `[0,0,0,0,1]` for a shared passage that the completed index classified as boilerplate in all five. The corrections hash is then saved, so an idle next run skips the second pass needed to correct the flags.

**Recommended fix:** Update all affected fingerprints first, then classify chunks against the completed index. The handoff’s statement that this “converges next run” does not match the current refresh trigger.

### 9. Feed refresh makes old exhausted failures appear newly failed

**Category:** reliability  
**Locations:** `pipeline/src/wts/feed.py:180–184`; `pipeline/src/wts/notify.py:135–143`

Every existing feed item receives a fresh `updated_at`, including unchanged items. Notifications use that timestamp to identify failures from the current run.

Consequently, an exhausted historical error generates another high-priority notification after each successful feed refresh, even though no retry occurred.

**Recommended fix:** Track failure timestamps separately or collect the episodes that actually failed during the run. Add a feed-refresh-plus-notification integration test.

## Recommended fix order

1. **Data integrity:** atomic chunk/feed transitions and per-environment publish recovery markers.
2. **Public API:** cache/parser consistency, override-aware cache lookup, and bounded report-body reading.
3. **Operational correctness:** durable cache invalidation, two-phase boilerplate refresh, and accurate failure notifications.

## Resolution (2026-10-09, seventh session)

All nine reproduced: each fix has a regression test that failed on the old code. Branch
`claude/plan-3-handoff-etfwwc`; Worker 485 tests, pipeline 698.

| # | Commit | Fix |
|---|---|---|
| 1 | `fb94399`, `deba323` | Changed chunks and the requeue to `chunked` in one transaction (`state.requeue_embedding`); publish also checks each vector's stored `text_sha` against the chunk's current text. |
| 2 | `f2bfeb5` | Before an episode's first remote write, its `publications` digest is blanked (`DIRTY = ""`) in the same transaction as `published_vectors`; restored on success. No migration. |
| 3 | `6a89629` | The cache key starts from `boundQuery()`, the parser's own 200-code-point cut. `\s` collapsing kept: the scanner splits on exactly `\s` (tested over every `\s` code unit). |
| 4 | `a7c2057` | A smart search under `SEARCH_OVERRIDE=exact` skips the cache (no read, no write); exact mode still uses it. |
| 5 | `77c1169` | `readCapped()` reads the body with a 48 KiB byte cap and cancels the stream past it; the Content-Length fast path stays. |
| 6 | `23bffbe` | URL update and reset to `new` in one transaction. |
| 7 | `b237e40` | The owed `corpus_version` flag is written in each episode's publication transaction, not after the loop. (Not before the first remote write: that would bump after runs that only hit parked errors.) |
| 8 | `49963e6` | Refresh is two passes: fingerprints for every episode, then classification against the finished index. Costs a second read of each transcript. |
| 9 | `c82e6e1` | Migration 005 adds `episodes.failed_at`, set only by `state.fail`; notifications select on it. Existing errors backfilled from `updated_at`. |
