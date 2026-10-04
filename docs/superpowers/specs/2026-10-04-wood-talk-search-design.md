# Wood Talk Transcript Search — Design

Date: 2026-10-04
Status: Approved in brainstorming; awaiting written-spec review
Source: `VISION.md`

## 1. Goal

A public website that lets listeners search everything said on the Wood Talk
podcast (about 620 episodes since 2007), not just show notes and tags. Each
result shows the matching part of the transcript with the hits highlighted,
links to the official episode at the right time, and can expand to show more
of the transcript.

### Agreed decisions

| Topic | Decision |
|---|---|
| Audience | Public, with the hosts' blessing (the maintainer contacts Marc, Shannon and Matt before launch). |
| Playback | Deep-link out to Apple Podcasts and Spotify at a timestamp, plus the episode's Wood Talk page. No audio is hosted. |
| Search | Keyword search (with query syntax) combined with meaning-based search. |
| Hosting | Cloudflare Workers paid plan: Pages, one Worker, D1, Vectorize and Workers AI. Target $5–7 a month. |
| Upkeep | As close to zero as possible: no servers to patch. |
| Heavy compute | The maintainer's Mac Mini (M5 Pro): transcription and embeddings. |
| Pipeline language | Python. |
| Notifications | Push notifications through ntfy.sh. |

### Success criteria

- Every published episode can be searched; a new episode is searchable
  within 7 days of release, with no manual steps.
- On the test search set (§7.2), Recall@10 is at least 0.85 overall and at
  least 0.75 for the `paraphrase` cases. The time hit rate (cue within ±45 s)
  is at least 0.80 for the `exact` and `jargon` cases.
- p95 search latency of 800 ms or less at the API, measured from Workers Logs.
- Running cost of $10 a month or less.

### Non-goals (phase 1)

- Hosting or re-serving audio.
- Identifying which host is speaking.
- User accounts, saved searches, comments.
- Topic summaries and chapters (phase 2, §9).

## 2. Architecture

```
Mac Mini (offline, batch)                      Cloudflare (online, serving)
──────────────────────────                     ────────────────────────────
feed → download → transcribe → chunk → embed ──publish──▶ D1 (episodes, chunks, FTS5)
                                                         Vectorize (chunk vectors)
                                                         Worker /api/* ◀── Pages frontend
```

The two halves share only data: the D1 schema and the Vectorize index. They
can be developed and tested separately. There are two Cloudflare
environments, `staging` and `production`. Each has its own D1 database,
Vectorize index and Worker. The frontend is deployed to the same domain as
the API.

### Repository layout

```
pipeline/     Python package + `wts` CLI (Mac Mini)
worker/       Cloudflare Worker (TypeScript)
web/          Frontend (Vite + TypeScript + Preact) → Cloudflare Pages
schema/       D1 SQL migrations (shared contract)
eval/         Test search set, baseline, eval reports
docs/         Specs, plans, deep-link format notes
```

## 3. Pipeline (Mac Mini)

A Python CLI called `wts`. Every command can be re-run safely. State is kept
in a local SQLite file (`~/.wts/state.db`). Large artifacts live under
`~/.wts/data/`.

### 3.1 Episode lifecycle

Each episode moves through these statuses:

`new → downloaded → transcribed → chunked → embedded → published`

Each step only picks up episodes in the status before it. On failure the
episode is set to `error` with a reason and a retry counter. Episodes in
`error` are retried on later runs up to 3 times, then left for a person to
look at. If an episode's audio URL or GUID changes in the feed, it resets to
`new`.

### 3.2 Commands

| Command | What it does |
|---|---|
| `wts feed` | Reads the RSS feed and upserts `episodes`: guid, number, title, published_at, duration_s, audio_url, and page_url (the item's `<link>`, the episode's Wood Talk page). It also matches Apple Podcasts episode IDs (iTunes lookup API) and Spotify episode IDs (Spotify Web API, client-credentials app) on normalized title plus publish date ±2 days. Episodes with no match keep a null ID. |
| `wts download` | Resumable HTTP download to `data/audio/<guid>.mp3`. Checks size against the `Content-Length` header. |
| `wts transcribe` | `mlx-whisper` with `large-v3-turbo` and word-level timestamps. A starter prompt seeds woodworking vocabulary (`pipeline/vocab.txt`: brand names, host names, joinery terms). Output goes to `data/transcripts/<guid>.json` and is kept permanently; later steps never need to re-transcribe. |
| `wts chunk` | Builds windows of about 30 s, cut on sentence boundaries and overlapping by one sentence. Each chunk records `start_ms`, `end_ms`, its text, and `word_times` (each word's start time, relative to the chunk start). |
| `wts embed` | `bge-base-en-v1.5` (768 dimensions) through `sentence-transformers` on the Mac's GPU (MPS). It must be the same model Workers AI runs for query embeddings (`@cf/baai/bge-base-en-v1.5`). |
| `wts publish --env staging\|production` | Sends only the episodes that changed. Each episode is one D1 batch (delete the old chunks, then insert the new ones) plus a Vectorize upsert by chunk ID. Vectors for chunks that were removed are deleted. Bumps `meta.corpus_version`. |
| `wts run` | Runs `feed → download → transcribe → chunk → embed → publish --env production`, then a smoke search (§8.1) and notifications. Scheduled weekly by launchd. |
| `wts status` | Episode counts by status, episodes in `error` with their reasons, and the last 10 runs. |
| `wts eval` | See §7.2. |

### 3.3 Transcript quality guards

- Drop segments Whisper marks as probably not speech (`no_speech_prob > 0.6`
  and low average log probability).
- Detect repetition loops: the same n-gram repeated 4 or more times in a row.
  Those segments are cut.
- Flag an episode for a manual look (it still publishes) if it has fewer than
  80 or more than 260 words per minute.

### 3.4 Secrets

The Cloudflare API token, limited to D1 and Vectorize edit on this account,
and the Spotify client credentials are stored in the macOS Keychain and read
by `wts` when it runs. They are never committed.

## 4. Data model and API (Cloudflare)

### 4.1 D1 schema (`schema/`)

```sql
episodes(
  id INTEGER PRIMARY KEY, guid TEXT UNIQUE, number INTEGER, title TEXT,
  published_at TEXT, duration_s INTEGER, audio_url TEXT, page_url TEXT,
  apple_episode_id TEXT, spotify_episode_id TEXT,
  offset_s INTEGER NOT NULL DEFAULT 0
)
chunks(
  id INTEGER PRIMARY KEY, episode_id INTEGER REFERENCES episodes(id),
  seq INTEGER, start_ms INTEGER, end_ms INTEGER, text TEXT,
  word_times TEXT            -- compact delta-encoded word start offsets (ms)
)
chunks_fts USING fts5(text, content='chunks', content_rowid='id',
                      tokenize='porter unicode61')
meta(key TEXT PRIMARY KEY, value TEXT)   -- corpus_version, last_published_at
```

### 4.2 Vectorize

Index `chunks`: 768 dimensions, cosine similarity. Vector ID = `chunks.id`.
Metadata: `{episode_id, year}`, with a metadata index on `year` for
filtering.

### 4.3 Query syntax

| Syntax | Meaning |
|---|---|
| `word word` | All words (AND), with stemming. |
| `"exact phrase"` | Phrase match. |
| `-word`, `-"phrase"` | Exclude. |
| `a OR b` | Either. |
| `pref*` | Prefix. |
| `year:2015`, `before:2018`, `after:2020` | Filter by publish year (before/after are exclusive). |
| `ep:250` | Limit to one episode. |

The parser turns the query into an FTS5 MATCH expression plus SQL filters.
The text for meaning-based search is the query with operators, exclusions and
filters removed. If the input can't be parsed, fall back to plain quoted
words; never return an error for bad syntax.

### 4.4 Endpoints

- `GET /api/search?q=&mode=smart|exact&page=`
  - `exact`: FTS5 only, ranked by BM25.
  - `smart` (default):
    1. Take the FTS5 top 50, then embed the query with Workers AI and take the
       Vectorize top 50 (year filter applied in Vectorize).
    2. Merge the two lists with reciprocal rank fusion (k = 60).
    3. Apply the exclusion and episode filters to the merged list.
  - Collapse hits from the same episode that are less than 120 s apart into
    one result carrying `more_in_episode: n`.
  - 20 results per page, at most 100 in total.
  - Each result includes: episode (number, title, date, links), chunk text,
    highlight ranges, `hit_ms`, `cue_s`, `match: keyword|related`.
- `GET /api/context?chunk=&radius=3`: neighboring chunks, ±radius, with
  timestamps.
- `GET /api/health`: `corpus_version` plus a single trivial D1 query.

### 4.5 Highlighting and cue time

- Keyword hits: highlight ranges come from matching the query terms (stemmed
  the same way) against the chunk's words. `hit_ms` is the start time of the
  first highlighted word, from `word_times`.
- Meaning-only hits: tagged `related`. Any query words that happen to appear
  are highlighted. `hit_ms` is the chunk's `start_ms`.
- One function computes the cue time:
  `cue_s = max(0, floor(hit_ms/1000) − 7 + episode.offset_s)`.

### 4.6 Deep links

Built from the episode row and `cue_s`:

- **Apple Podcasts:** the episode URL (`…/id251471480?i=<apple_episode_id>`)
  plus a time parameter.
- **Spotify:** `https://open.spotify.com/episode/<spotify_episode_id>` plus a
  time parameter.
- **Wood Talk page:** `page_url`, always shown. When an episode has no
  platform ID, the card shows "jump to mm:ss" next to this link.

The exact time-parameter formats are checked by hand on iOS, Android and
desktop as the first implementation task. Results go in
`docs/deep-links.md`, and the link builder lives in one module.

**Known limitation:** Acast may insert ads at download time, so platform
playback can drift from our timestamps. Mitigations:

- The card always shows the time as text.
- `episodes.offset_s` allows per-episode correction without code changes.

### 4.7 Worker hardening

- Queries are capped at 200 characters; `page` at 5.
- If Workers AI or Vectorize fails, return keyword-only results with
  `smart_degraded: true`.
- Search responses are cached at the edge (Cache API) for 1 h, keyed by the
  normalized query plus `corpus_version`.
- A Cloudflare rate-limiting rule: 60 requests per minute per IP on `/api/*`.
- The frontend sets a strict CSP. There are no cookies, no secrets, and no
  user data.

## 5. Frontend (`web/`)

Vite + TypeScript + Preact, deployed to Cloudflare Pages on the same domain
as the API.

- **Search bar**, pinned to the top:
  - A large input that searches as you type, waiting 300 ms after the last
    keystroke.
  - A Smart/Exact switch, a `?` syntax popover, and year-range chips.
  - The whole state is in the URL (`?q=&mode=&page=`), so searches can be
    shared.
- **Result card:**
  - **Ep. N · Title** · date · **at mm:ss**.
  - A 2–3 line excerpt with `<mark>` highlights, and a `related` tag for
    meaning-only hits.
  - Buttons: **▶ Apple**, **▶ Spotify**, **Wood Talk page**,
    **More transcript**, and **+n more in this episode** when hits were
    collapsed.
- **More transcript:**
  - Expands the card in place with about ±90 s of transcript from
    `/api/context`, each paragraph labelled with its timestamp and each label
    a deep link.
  - On desktop, hovering over the excerpt for 400 ms shows a preview; on
    touch devices, a tap expands.
- **Other states:**
  - Before any search: example searches plus "N episodes indexed through
    <date>".
  - No results: suggest Smart mode or looser filters.
  - Degraded: a subtle note. Error: a friendly retry message.
- **Look and feel:**
  - Warm wood-tone accent, automatic dark mode.
  - `/` focuses search; arrow keys move through results.
  - Works on phones and meets WCAG AA.
  - Footer: "Unofficial · made with the hosts' blessing", show links, and
    "searches are logged anonymously to improve results".

## 6. Error handling summary

| Failure | Behavior |
|---|---|
| Feed unreachable | The run logs an error and notifies; nothing else changes. |
| Download, transcribe, chunk or embed fails | The episode goes to `error` and is retried on the next runs, up to 3 times. |
| Publish fails partway | Safe to re-run; the episode stays `embedded` until both D1 and Vectorize succeed. |
| Workers AI or Vectorize down | Keyword-only results with `smart_degraded`. |
| D1 down | 503 from the API; the frontend shows the retry message. |
| Bad query syntax | Fall back to plain quoted words. |

## 7. Testing

### 7.1 Automated tests

- **Pipeline (pytest):**
  - Feed parsing (saved sample RSS files) and platform ID matching.
  - Chunker: boundaries, overlap, and timings that add up.
  - Quality guards (deliberately bad sample transcripts).
  - Status-machine moves.
  - Publish diffing against a mocked Cloudflare API.
- **Worker (Vitest with `@cloudflare/vitest-pool-workers`):**
  - Table-driven tests of the query parser and the FTS5 expression it
    produces.
  - Reciprocal rank fusion, collapsing, `cue_s`, the deep-link builder.
  - Degraded mode and input limits.
- **Frontend:** one Playwright smoke test: search → results → expand → check
  that the Apple, Spotify and Wood Talk links are well-formed with the right
  time.

### 7.2 Test search set (`eval/`)

- **`eval/queries.yaml`:** each case has an `id`, `query`, `mode`, optional
  filters, and either `expect: [{episode, at_s}]` (time tolerance ±45 s) or
  `expect_absent: [episode]`. Each case is tagged with one of:
  - `exact`: phrase lookups.
  - `jargon`: brand names and woodworking terms (also tests Whisper's
    spelling).
  - `paraphrase`: meaning-based queries.
  - `filter`: year and episode filters.
  - `negative`: things that should not come back.
- **Where the cases come from:**
  1. About 30 written by the maintainer from memory.
  2. About 100 synthetic ones: a local LLM on the Mini paraphrases a question
     answered by a randomly sampled chunk, so the right answer is that chunk.
  3. Topics from the show notes, mapped to their episodes.
- **`wts eval --target staging|production`** sends every case to the API and
  reports, overall and per tag:
  - Recall@10 (did the right episode appear in the top 10?).
  - MRR (how high did the first right answer rank?).
  - nDCG@10 (overall quality of the top 10 ordering).
  - Time hit rate (did the cue land within ±45 s?).
- The report is written to `eval/reports/<timestamp>.json`. With `--update`
  it also becomes `eval/baseline.json`. The command exits with an error if any
  score drops more than 0.02 below the baseline.
- Ranking, chunking and model changes are published to `staging` and
  evaluated there before being promoted to `production`.
- **Optional transcription check:** 3 five-minute clips corrected by hand
  (`eval/wer/`) measure Whisper's word error rate when changing the model or
  the vocabulary prompt.

## 8. Logs and notifications

### 8.1 Pipeline

- **Logs:** JSON lines in `~/Library/Logs/wts/wts-YYYY-MM-DD.log`, kept for
  30 days. Each line has `run_id`, `episode`, `step`, `duration_ms`, `level`,
  `msg`, `error`. The console shows the same events in readable form.
- **Run history:** a `runs` table in the local state file records start,
  end, per-step counts and errors. `wts status` shows it.
- **Smoke search:** after each `wts run`, 5 fixed queries from `eval/` are
  sent to production. Each must return its expected episode in the top 10.

### 8.2 Notifications (ntfy.sh)

A private, hard-to-guess topic name, stored in the Keychain. `wts` sends a
push for:

- New episodes published (number, title, chunk count).
- Episodes that hit `error`, or ran out of retries.
- A failed smoke search.
- No new feed item for 21 days (the feed may have moved).
- A weekly digest: top searches and zero-result searches (§8.3).

**Watchdog:** each successful `wts run` pings a healthchecks.io check with an
8-day timeout. healthchecks.io alerts (email, or its ntfy integration) when
the pings stop, which covers the Mini being off or launchd being broken.

### 8.3 Worker

- **Cloudflare Workers Logs** enabled. One structured line per search:
  shortened query, mode, latency, result count, degraded flag. No IP
  addresses. Cloudflare's default retention.
- **Cloudflare Workers Analytics Engine:** one data point per search (query,
  mode, result count). `wts run` reads the past week through the SQL API for
  the weekly digest. The output feeds new test cases and new vocabulary
  terms.
- **Optional:** a free UptimeRobot check on `/api/health` every 5 minutes.

## 9. Phase 2 (separate spec): topic summaries

A local LLM on the Mini generates chapter-style topics for each episode, in a
new `topics(episode_id, start_ms, title)` table. They show as chips that link
to the right time, and can be searched. It reuses the phase 1 transcripts and
chunks unchanged.

## 10. Prerequisites and open items

1. **Hosts' blessing:** contact Marc, Shannon and Matt before the public
   launch. Ask whether ads are inserted at download time and whether they'd
   share ad insertion offsets or ad-free audio for timestamp accuracy.
2. **Deep-link formats:** check by hand (first implementation task, §4.6).
3. **Ad drift:** check whether the feed's audio has ads inserted at download
   time (download the same episode twice and compare duration and hash).
   Measure the drift on about 5 episodes.
4. **Feed history:** confirm the RSS feed lists the whole archive. If old
   episodes are missing, find another source for their audio before
   transcribing.
5. **Spotify API access:** register a free developer app for client
   credentials.
6. **Domain:** pick a domain or subdomain for Pages and the Worker.
