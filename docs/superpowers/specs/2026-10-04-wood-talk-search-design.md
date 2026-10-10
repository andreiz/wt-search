# Wood Talk Transcript Search — Design

Date: 2026-10-04 (revised 2026-10-05)
Status: Approved 2026-10-05
Source: `VISION.md`

## 1. Goal

A public website that lets listeners search everything said on the Wood Talk
podcast (about 620 episodes since 2007), not just show notes and tags. Each
result shows the matching part of the transcript with the hits highlighted,
links to the episode at the right time on YouTube, Apple Podcasts, Spotify
and the Wood Talk site, and can expand to show more of the transcript.

### Agreed decisions

| Topic | Decision |
|---|---|
| Audience | Public, with the hosts' blessing (the maintainer contacts Marc, Shannon and Matt before launch). |
| Playback | Deep-link out at a timestamp: YouTube (where the episode is there and lines up), Apple Podcasts, Spotify, plus the episode's Wood Talk page. No audio is hosted. |
| Search | Keyword search with query syntax, combined with meaning-based search (§4.3). Started on Enter or the Search button, not while typing. |
| Result order | Relevance (default), Newest, Oldest. |
| Repeated content | Sponsor reads, plugs, the standard intro and outro, and inserted ads are detected and hidden by default (`include:ads` shows them). *(Binned 2026-10-09 until the full corpus: §3.5.)* |
| Hosting | Cloudflare Workers paid plan: one Worker (the site's static files and the API), D1, Vectorize and Workers AI. Estimated about $8–9 a month (§11). |
| Upkeep | As close to zero as possible: no servers to patch. |
| Heavy compute | The maintainer's M1 Max desktop at first; the Mac Mini (M5 Pro) once it's set up. |
| Pipeline language | Python. |
| Notifications | Push notifications through ntfy.sh. |
| Listener feedback | A "Report transcript error" form on each result, and a "Send feedback" link in the footer. |

### Milestones

- **M1 — seed set on staging.** 35 episodes (the 20 most recent plus 15
  sampled evenly across the years), run end to end on the M1 Max and
  published to `staging`. Audio stays on the Mac's local disk (`audio_dir`
  unset); the NAS comes in with M2. The seed transcripts are spot-checked with the
  review tool (§3.7). The test search set (§7.2) is built and the baseline
  recorded. Deep-link formats and YouTube alignment are checked.
- **M2 — full archive and launch.** The pipeline moves to the Mac Mini, the
  rest of the archive is processed, `production` is published, scheduled
  runs and the watchdog are turned on, and the site launches with the hosts'
  blessing.

### Success criteria

- M1: the seed set can be searched on staging, and the test set targets
  below are met on it.
- M2: every published episode can be searched; a new episode is searchable
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

Sizing and running-cost estimates are in §11.

## 2. Architecture

```
Mac (offline, batch)                           Cloudflare (online, serving)
────────────────────                           ────────────────────────────
feed → download → transcribe → chunk → embed ──publish──▶ D1 (episodes, chunks, FTS5, reports)
                                                         Vectorize (chunk vectors)
                                                         Worker: /api/* + the site's static files
```

The two halves share only data: the D1 schema and the Vectorize index. They
can be developed and tested separately. There are two Cloudflare
environments, `staging` and `production`. Each has its own D1 database,
Vectorize index and Worker. The Worker serves the frontend's static files
and the API on one host (§5.1).

### Repository layout

```
pipeline/     Python package + `wts` CLI (runs on the Mac)
worker/       Cloudflare Worker (TypeScript)
web/          Frontend (Vite + TypeScript + Preact) → the Worker's static assets
schema/       D1 SQL migrations (shared contract)
eval/         Test search set, baseline, eval reports
docs/         Specs, plans, deep-link format notes
```

## 3. Pipeline (Mac)

A Python CLI called `wts`. Every command can be re-run safely. Scheduling
(launchd) and the watchdog (§8.2) are turned on only on the Mini. On the
desktop, `wts run` is run by hand.

### 3.0 Where files live

Paths follow macOS conventions, resolved with the `platformdirs` library so
nothing is hard-coded and nothing goes directly in `$HOME`:

| What | Default location | Notes |
|---|---|---|
| Config (`config.toml`) | `~/Library/Application Support/wts/` | Non-secret settings: environment names, feed URL, `audio_dir`. Secrets live in the Keychain (§3.6). |
| State (`state.db`, `analytics.db`) | `~/Library/Application Support/wts/` | |
| Transcripts, chunks, embeddings | `~/Library/Application Support/wts/data/` | Small (under 1 GB) but valuable: transcripts are expensive to redo. |
| Audio | `<audio_dir>` on the NAS (§3.0.1); defaults to `~/Library/Application Support/wts/audio/` when unset (tests, quick local runs) | Large (§11). Never in `~/Library/Caches`, because macOS may purge that, and a re-download can come with different inserted ads. |
| Backups | `<backup_dir>` on the NAS | A copy of the Application Support folder (§3.0.1). |
| Logs | `~/Library/Logs/wts/` | Shows up in Console.app. |

Every location can be overridden with `WTS_HOME` (one root for everything),
which tests use for an isolated temporary root. `wts paths` prints the
resolved locations. Moving from the M1 Max to the Mac Mini is an `rsync` of
the Application Support folder; the audio is already on the NAS.

#### 3.0.1 Audio on the NAS

- **Mount.** The NAS share is mounted over SMB, for example at
  `/Volumes/media`. `config.toml` sets `audio_dir` (for example
  `/Volumes/media/wts/audio`) and `backup_dir` (for example
  `/Volumes/media/wts/backup`). On the Mini, the share is mounted at login
  (a Login Item, or automount via `/etc/auto_master`), so scheduled runs find
  it.
- **Checking before use.** Any step that needs audio (`download`,
  `transcribe`, `review`) first checks that `audio_dir` is reachable and
  writable, and that it has at least 2 GB free. If not, the step stops and
  sends a notification. Episodes are **not** moved to `error` and no retries
  are used up, because a missing mount is a problem with the machine, not
  with the episode.
- **Safe writes.** Downloads go to `<audio_dir>/.partial/<stem>.mp3`. They
  are renamed into place only after the `ffprobe` check passes, so an
  interrupted network transfer never leaves a half-written file that looks
  complete.
- **Transcribing.** Before Whisper runs, the episode's file is copied to a
  local temporary folder, so a network hiccup can't break a long GPU run
  halfway through. The local copy is deleted afterwards.
- **Review tool.** Streams audio straight from the NAS, with HTTP Range
  support so jumping around in the file is instant.
- **Backups.** At the end of each `wts run`, the Application Support folder
  (state, transcripts, chunks, embeddings, corrections overrides: under
  1 GB) is copied with `rsync` to `backup_dir`. Transcripts are the
  expensive part to recreate, so they also get a copy on the NAS.
  *(Implemented 2026-10-08, plan 2 Task 16:)* `state.db` is first
  snapshotted with SQLite's backup API (safe while another connection
  writes) and saved as a single file (rollback journal, not WAL); then
  `rsync -a --delete` copies the folder to `<backup_dir>/wts/`, leaving out
  `audio/`, the live `state.db` and its `-wal`/`-shm`, `*.tmp` and
  `.partial/`; only after rsync succeeds does the snapshot replace
  `state.db` there, so it never sits beside transcripts that weren't all
  copied. An unreachable `backup_dir` or an rsync error is a warning and a
  notification, not a failed run; no `backup_dir` means no backup.
  `wts backup` runs one by hand.

#### 3.0.2 Audio retention: originals now, compact copies later

- **M1 and M2:** keep the original MP3s. The `audio_format` setting is
  `original`.
- **Later (not part of M1 or M2):** `wts audio compact` moves to
  `audio_format = opus32`:
  1. Re-encode each episode to 32 kbps mono Opus (`<stem>.opus`, about
     14 MB per hour, about 9 GB for the full archive).
  2. Check that the length matches the original to within 50 ms. Whisper
     downsamples to 16 kHz mono anyway, so re-transcribing from the compact
     copy loses nothing.
  3. Delete the original only after that check passes, and only if
     `keep_originals` is false.
  - New episodes would then be compacted right after transcription.
  - The review tool and the `transcribe` command read either format, so the
    switch needs no other changes.

### 3.1 Episode state machine

Each episode has a `status` column in `state.db`. Every step is a batch
command that selects episodes in the status it takes as input. The
statuses themselves act as the work queue; there is no separate queue
system.

`new → downloaded → transcribed → chunked → embedded → published`

- Allowed status changes are defined in one table in the code, and every
  status update goes through one function that enforces it.
- On failure the episode is set to `error` with a reason, the step it failed
  in, and a retry counter. Episodes in `error` are retried on later runs, up
  to 3 times, and are then left for a person to look at.
- Resets:
  - If an episode's audio URL or GUID changes in the feed, it goes back to
    `new`. *(2026-10-09, review #6:)* the new URL and the reset commit in one
    transaction, so a crash between them can't keep the old recording.
  - Re-chunking (after a `corrections.yaml` edit, §3.3) moves the affected
    episodes from their current status back to `transcribed`. *(As built,
    revised 2026-10-09, review #1:)* an `embedded` or `published` episode whose
    chunks changed goes back to `chunked` in the same transaction as the chunk
    write, so stale vectors can't survive a crash; `wts publish` also refuses
    vectors whose stored `text_sha` doesn't match the chunk's current text.
- Concurrency: downloads run 4 at a time. Transcription runs one at a time
  because it fully uses the GPU. Embedding runs in batches.
- Selecting episodes: every step takes `--select` (for example `seed`,
  `recent:50`, `ep:312`, `year:2015`, `all`). The default is the episodes
  marked as in scope. `wts scope add <selector>` marks them; M1 uses the
  `seed` selection (§1). **New releases join the scope by themselves**, so a
  scheduled `wts run` processes them in the same run: `wts feed` puts an added
  item in scope when it is at least as new as the newest episode already
  stored. Not on the first import (nothing stored yet: that would queue the
  whole archive), nor for an old item that turns up later. *(Added
  2026-10-08, open decision 3, option a.)*

### 3.2 Commands

| Command | What it does |
|---|---|
| `wts feed` | Reads the RSS feed and upserts `episodes`: guid, number, title, published_at, duration_s, audio_url, and page_url (the item's `<link>`). Matches platform IDs, with no match leaving the ID null: **Apple** via the iTunes lookup API; **Spotify** via the Web API with a client-credentials app, matched on normalized title plus publish date ±2 days; **YouTube** via the YouTube Data API search of the show's channel, matched on title and date. |
| `wts download` | Resumable HTTP download, then an `ffprobe` check that the file can be decoded and is neither more than 2% shorter than `duration_s` (truncated) nor more than 10 minutes longer. *(Revised 2026-10-05: Acast inserts ads per download, so real files run 1–3 min longer than `itunes:duration`; the original ±2% rule rejected 20 of 35 seed episodes.)* The probed length is stored as `audio_duration_s`. **Ad-free copies:** every HTTP request (feed and downloads) sends the User-Agent `WoodTalkSearchBot/<version> (+https://github.com/andreiz/wt-search)`, one constant in `wts/net.py`. Acast inserts no ads for User-Agents it treats as bots (plain `curl`, and `…Bot` with a capital B; the check is case-sensitive, so `wts-bot` got ads), while httpx's default and unknown User-Agents get ads stitched into each download (*revised 2026-10-05*: the cause is the User-Agent, not IP or timing). A copy within 5 s of `duration_s` has no ads and carries the show's own timeline. As a safety net, `wts download` still checks this: it tries twice (2 s apart); if both copies have ads it keeps the shorter and sets `ads_inserted`. `--refetch-ads` re-downloads stored copies that have ads (resetting them to `new`). File: `<audio_dir>/<stem>.mp3` (§3.0, §3.4). |
| `wts transcribe` | `mlx-whisper` with `large-v3-turbo`, keeping word-level timestamps and word probabilities. A starter prompt seeds woodworking vocabulary from `pipeline/vocab.txt` (brand names, host names, joinery terms). Output is `<data>/transcripts/<stem>.json` (§3.0), kept permanently; later steps never need to re-transcribe. Episodes are transcribed **newest first**, so on a long backlog run recent episodes become searchable before the archive. |
| `wts chunk` | Applies `corrections.yaml` (§3.3), marks boilerplate (§3.5; binned 2026-10-09), and builds windows of about 30 s cut on sentence boundaries and overlapping by one sentence. Each chunk records `start_ms`, `end_ms`, its text, `word_times`, and `is_boilerplate`. |
| `wts embed` | `bge-base-en-v1.5` (768 dimensions) through `sentence-transformers` on the Mac's GPU (MPS). It must be the same model Workers AI runs for query embeddings (`@cf/baai/bge-base-en-v1.5`), **with `pooling: "cls"`**: sentence-transformers uses CLS pooling for bge, while Workers AI defaults to `mean`, and the two aren't compatible. `wts check-embeddings` compares the two before publishing. Boilerplate chunks are not embedded. |
| `wts publish --env staging\|production` | Sends only the episodes that changed, per environment: `state.db` keeps a `publications` row (episode, environment, digest) for each, and an episode is due when the digest of what it would send (D1 row with platform IDs and offsets, chunks, vectors) differs. Per episode: a Vectorize upsert of its non-boilerplate chunks by chunk ID; one D1 batch (upsert the episode row, delete its chunks that are gone, upsert its chunks with `ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`, which would skip the FTS delete trigger); a Vectorize delete of vectors for chunks that were removed or became boilerplate (ids from `published_vectors`, which lists every id that may be in that environment's index). Bumps `meta.corpus_version`. *(Revised 2026-10-06, plan 2 decisions 1–2: D1's REST API is not atomic across a batch's statements, so publishing is idempotent instead; before production, D1 writes move to an authenticated Worker route using the atomic `env.DB.batch()`, §10.)* `--dry-run` shows what would be sent. |
| `wts run [--env staging\|production]` | Runs `feed → download → transcribe → chunk → embed → publish → backup` (§3.0.1) for the selected environment, then a smoke search (§8.1) and notifications; the summary notification goes last, so it covers publish and backup. The environment defaults to `run_env`; with neither, publish is skipped with a warning. Config and the API token are checked before the run starts. *(Revised 2026-10-08, plan 2 Task 16; the smoke search comes in plan 5.)* |
| `wts backup` | Backs up the Application Support folder to `backup_dir` now (§3.0.1). |
| `wts links <ep> [--at 12:34]` | Prints an episode's links from `state.db` (YouTube, Apple, Spotify, show page, feed audio) by the rules of §4.6: missing IDs left out, YouTube only within 3 s of the feed's length (otherwise the match and the reason are shown), `--at` shifted by each platform's offset, with no lead-in. Takes a number or a selector. *(Added 2026-10-08, maintainer's request.)* |
| `wts search "<query>" [--env staging\|production] [--mode smart\|exact] [--sort relevance\|newest\|oldest] [--page N] [--json]` | Searches a deployed environment from the terminal, for the maintainer. A thin client of the Worker's `/api/search` (§4.4), so results are exactly what the web app shows: the query syntax, ranking, collapsing, cue times and links all stay in the Worker, with no second implementation in Python. Prints one block per result (episode number, title, date, `mm:ss` and `related` for a meaning-only hit, the text with hits in bold, `+N more in episode`, then the links); `--json` prints the raw response. The environment defaults to `run_env`; its URL is `[env.<name>] api_url` in `config.toml`. The same client serves `wts eval` and the smoke search after `wts run` (§7.2, §8.1). *(Added 2026-10-07.)* |
| `wts status` | Episode counts by status, episodes in `error` with their reasons, and the last 10 runs. |
| `wts reports` | Lists listener transcript-error reports (§4.4) and marks them resolved. |
| `wts logs` | Filters the pipeline logs (§8.4). |
| `wts analytics pull` | Copies Worker search analytics to a local file (§8.4). |
| `wts eval` | See §7.2. |
| `wts review` | Local transcript review tool (§3.7). |
| `wts paths` | Prints the resolved file locations (§3.0). |

### 3.3 Transcription errors

| Kind | Handling |
|---|---|
| Hard failure (corrupt audio, crash, out of memory) | The `ffprobe` check after download catches bad files early. Failures set `error`, and the episode is retried up to 3 times. |
| Made-up text over silence | Drop segments Whisper marks as probably not speech (`no_speech_prob > 0.6` and low average log probability). |
| Repetition loops | Cut segments where the same phrase (2–8 words) repeats 4 or more times in a row, or a single word 8 or more times, and the repeats make up at least half the segment; flag the episode `loop_cut`. *(Revised 2026-10-05: the original "any n-gram 4 times" rule dropped normal speech like "yeah, yeah, yeah, yeah".)* |
| Suspicious episode | Flag it for a manual look (it still publishes) if it has fewer than 80 or more than 260 words per minute. |
| Bad timestamps | Word start times must never go backwards and must stay within the episode's length (the downloaded file's probed length, which can exceed the feed's when ads are inserted). If a segment's words don't, flag the episode and spread that segment's words evenly across it; other segments keep their word timings. |
| Split hyphenated words | Whisper's word timings split "split-top" into "split" and "-top", so chunk text read "split -top". `wts chunk` joins a word starting with `-` and a letter or digit to the word before it, after corrections (so "Rubo -style" is still corrected), keeping the first half's start time so `word_times` stays one per word. A lone `-`/`–` is speech punctuation and stays; nothing joins across a sentence end. *(Added 2026-10-07: 1,259 joins over the 36 seed episodes, all real hyphenations, including numbers like 623-242-2450, CARB-2 and catch-22; no minus numbers.)* Numbers split the same way ("22" ".5", "45" ",000", "10" "%", read as "22 .5", "45 ,000", "10 %"): after a word ending in a digit, a word starting with `.` or `,` and a digit, or `%`, is joined too. A lone `,` stays. *(Added 2026-10-08; search was unaffected, since FTS5 splits on `.`, `,` and `%`; only the displayed text was.)* |
| Misheard words | `pipeline/corrections.yaml` holds whole-word replacements (`Kremona → Cremona`, `saw stop → SawStop`), applied in `wts chunk`. Fixing one means a re-chunk, not a re-transcription. New entries come from listener reports (§4.4) and the weekly zero-result searches (§8.2). |

### 3.4 File naming

Each episode has a file name `stem`: `YYYY-MM-DD_epNNN_<title-slug>`. The
`epNNN` part is left out when the episode has no number. Example:
`2017-03-14_ep312_dado-stacks-and-shop-safety`.

The episode number comes from `itunes:episode` when present, otherwise from
the title, in any of the show's styles: `#85`, `WT127`, `WT 607`,
`Wood Talk 595`, `WoodTalk 599`, `Ep. 313`, `Episode 400`, a leading `552 -`,
or a trailing `| 609`. Bare leading or trailing numbers are accepted only
when they match `itunes:episode`, or when there is none and they are 10–1899
(not years). The number marker is removed from the title before slugging, and
apostrophes are dropped (`doesn't` → `doesnt`).

A number must also fit the main show's sequence: if it is more than 30 away
from the median number of episodes published within 120 days, it belongs to a
side series (e.g. "Board Meetings #1" in 2011) and the episode is stored as
unnumbered, keeping the number in its slug (`2011-03-29_board-meetings-1`).
"NNN Extra – …" companion episodes are also unnumbered.

The stem is generated once, stored in `state.db`, and never re-derived. Code
always looks up paths through the database, never by parsing file names.

Each transcript JSON starts with a metadata header: guid, title, number,
published_at, model, model version, vocab file hash, machine,
transcribed_at.

### 3.5 Repeated content (boilerplate)

> **Binned 2026-10-09 (maintainer):** detection is removed from `wts chunk`
> until the full corpus can be measured; every chunk has `is_boilerplate = 0`.
> The plumbing stays (the flag, embed/publish skipping flagged chunks,
> `include:ads`), and the chunk step refreshes when `corrections.yaml` or
> `CHUNKER_VERSION` changes, not when new episodes arrive. Why, and what to
> try next: [`docs/full-corpus-backlog.md`](../../full-corpus-backlog.md) §1.
> The design below is kept as the record of what was built and measured.

A deterministic, local text-matching step in `wts chunk`. It needs no AI
model and no API call.

1. **Normalize** each sentence: lowercase, strip punctuation, write numbers
   out as words, collapse whitespace.
2. **Fingerprint** each sentence of 6 or more words with MinHash (the
   `datasketch` library, 128 permutations) over the sentence's set of words.
   Index the fingerprints in an LSH index (16 bands × 8 rows), which finds
   near-identical items quickly. The index is kept in `state.db` and updated
   as episodes are chunked.
   - *Revised during implementation (2026-10-05):* the original design used
     overlapping 5-word phrases. One misheard word in a 16-word sponsor read
     drops 5-word-phrase similarity to about 0.4, while word-set similarity
     stays at about 0.87, so word sets are used instead.
3. **Count** how many *different* episodes have a sentence with an exact
   word-set Jaccard similarity of at least 0.8 (LSH only proposes
   candidates). If it's 5 or more, the sentence is boilerplate.
   - This catches sponsor reads, Patreon plugs, and the standard intro and
     outro, even with small transcription differences.
   - It also catches ads inserted into our downloads, because the same ad
     appears in every episode downloaded in the same period.
4. **Mark the chunk:** a chunk is `is_boilerplate` when at least 60% of its
   words are in boilerplate sentences.

The 5-episode threshold depends on how many episodes have been chunked, so
whenever the index grows, `wts chunk` re-checks earlier chunks (cheap: no
re-embedding unless a chunk's flag changes). Music and silence are already
dropped by the not-speech guard (§3.3). *(2026-10-09, review #8:)* that
re-check was order-dependent: it classified an episode against older
fingerprints of later ones, and nothing revisited it. The fix (two passes,
reading every transcript twice per run) was dropped with the detector.

**Known gap:** ad-libbed host reads ("I've been using the new Festool…") are
worded differently each time and won't match. The `negative` test cases
(§7.2) measure how much this matters. If needed, a later step can classify
the remaining sponsor mentions with a local LLM on the Mac. Manual
boilerplate and not-boilerplate flags from the review tool (§3.7) override
the detector.

**Measured on real transcripts (2026-10-05, Checkpoint B; deferred to phase
2):** the detector above misses most sponsor reads. On the first 15 minutes
of ep610–615 only 1 of 6 episodes got a boilerplate chunk, for two reasons:

1. Whisper punctuates the same read differently per episode (one episode
   merges "Woodcraft is your trusted source…" with the next sentence), so
   sentence word-set similarity falls to ~0.6, below 0.8.
2. The read comes in short pieces with live host talk between them, so a
   30 s chunk is only 25–40% boilerplate, under the 60% rule.

Matching runs of 6–8 words shared by 5+ episodes, ignoring sentence
boundaries, found the read and the merch-code plug in all 6 episodes. The
rework (§9) pairs that with cutting chunks at boilerplate edges, so a read
becomes its own flagged chunk. Until then, most sponsor reads are searchable
like any other speech. `test_real_sponsor_reads_flagged` is marked as an
expected failure until the rework lands.

### 3.6 Secrets

Stored in the macOS Keychain, read by `wts` when it runs, and never
committed:

- The Cloudflare API token, limited to D1 and Vectorize edit on this
  account.
- The Spotify client credentials.
- The YouTube Data API key.
- The ntfy topic name, and an access token when the ntfy server requires one.

### 3.7 Review tool (`wts review`)

A local web page for checking transcript quality by ear. It runs only on the
Mac and is never deployed.

- **Launch:**
  - `wts review <episode>` opens an episode.
  - `--at mm:ss` opens it at a given time.
  - `--report <id>` opens the passage a listener reported.
  - `--next-flagged` opens the next episode the quality guards flagged.
- **How it runs:** a small server built into `wts`, using Python's standard
  library plus a JSON handler, bound to `127.0.0.1` on a random port. It
  serves one static HTML/JS page, the episode's audio file, its transcript
  and chunks, and a few write endpoints. It opens the browser automatically.
- **Playback:**
  - Plays our downloaded audio with an HTML5 `<audio>` element. This is the
    exact file Whisper heard, so the transcript lines up perfectly, and
    transcription errors aren't mixed up with platform ad drift.
  - Speed control from 0.75× to 2×.
- **Transcript view:**
  - Scrolls along with playback and highlights the current word, using the
    word timings.
  - Words with low Whisper confidence (probability below 0.5) are tinted.
  - Boilerplate chunks are greyed out, and chunk boundaries are marked.
  - Clicking a word jumps playback to it.
- **Keyboard:**
  - Space: play or pause.
  - ← / →: back or forward 5 s.
  - `[` / `]`: previous or next chunk.
  - `n`: next low-confidence word.
  - `e`: edit the selection.
- **Edits (written locally, never pushed live directly):**
  - Fix a misheard word or phrase. It's saved to `corrections.yaml`, either
    as a **global** rule or **this episode only**, and the episode is
    queued for re-chunking (§3.1).
  - Flag a passage as boilerplate or not boilerplate. The flag overrides the
    detector (§3.5).
  - Mark a listener report as resolved or rejected (updates D1 through the
    Cloudflare API).
- **Optional platform sync mode:**
  - Shows a YouTube embed (IFrame Player API: `seekTo`, `getCurrentTime`) or
    a Spotify embed (iFrame API: `seek`, `playback_update` events) next to
    our player.
  - You line up the same spoken moment in both and press **Sync here**. The
    difference is saved to `offset_youtube_s` or `offset_spotify_s` for the
    episode, or for a range of episodes, and published on the next `wts
    publish`. This is the manual version of the alignment check in §4.6.
  - Spotify full-episode playback in the embed needs a signed-in Spotify
    session in the browser.
  - Apple Podcasts has no controllable embed, so it is offered only as a
    link at the current time.
- **Tests:** server endpoints with pytest (`WTS_HOME` temporary root), plus
  one Playwright test: load a sample episode, click a word, check the audio
  position, make a correction, check `corrections.yaml`.

## 4. Data model and API (Cloudflare)

### 4.1 D1 schema (`schema/`)

```sql
episodes(
  id INTEGER PRIMARY KEY, guid TEXT UNIQUE, number INTEGER, title TEXT,
  published_at TEXT, duration_s INTEGER, audio_url TEXT, page_url TEXT,
  apple_episode_id TEXT, spotify_episode_id TEXT, youtube_video_id TEXT,
  offset_apple_s INTEGER NOT NULL DEFAULT 0,
  offset_spotify_s INTEGER NOT NULL DEFAULT 0,
  offset_youtube_s INTEGER NOT NULL DEFAULT 0
)
chunks(
  id INTEGER PRIMARY KEY, episode_id INTEGER REFERENCES episodes(id),
  seq INTEGER, start_ms INTEGER, end_ms INTEGER, text TEXT,
  word_times TEXT,           -- compact delta-encoded word start offsets (ms)
  is_boilerplate INTEGER NOT NULL DEFAULT 0
)
chunks_fts USING fts5(text, content='chunks', content_rowid='id',
                      tokenize='porter unicode61')
reports(
  id INTEGER PRIMARY KEY, chunk_id INTEGER, created_at TEXT,
  quoted_text TEXT, suggested_text TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'open'   -- open | resolved | rejected
)
meta(key TEXT PRIMARY KEY, value TEXT)   -- corpus_version, last_published_at
```

`word_times` exists so the cue lands on the hit word itself. Chunks are about
30 s long, so cueing from the chunk start could be up to 30 s early. It adds
about 50 MB in total.

### 4.2 Vectorize

One index per environment (index names are account-wide):
`wts-chunks-staging` and `wts-chunks-production`. 768 dimensions, cosine
similarity. Vector ID = `chunks.id`. Metadata: `{episode_id, year}`, with a
metadata index on `year` for filtering. The metadata index must be created
before the first upsert; vectors inserted earlier aren't indexed for
filtering. Boilerplate chunks are not indexed. Query embeddings use Workers
AI with `pooling: "cls"` (§3.2 `wts embed`).

### 4.3 Search modes and query syntax

**Meaning-based search.**
- Each chunk is stored as an embedding: 768 numbers that encode what the
  passage is about. A query is embedded the same way, and the nearest chunks
  are returned.
- This finds passages that match what the query means even when they share
  no words with it.
- It always returns its nearest matches, however weak, so meaning-only
  results are labelled `related` and combined with keyword results (§4.4).

**Query syntax**

| Syntax | Meaning |
|---|---|
| `word word` | All words (AND), with stemming. |
| `"exact phrase"` | Phrase match. |
| `-word`, `-"phrase"` | Exclude. |
| `a OR b` | Either. |
| `pref*` | Prefix. |
| `year:2015`, `before:2018`, `after:2020` | Filter by publish year (before/after are exclusive). |
| `year:2015-2020` | Years 2015 to 2020, both included: the same as `after:2014 before:2021`. Either order; one year (`year:2015-2015`) is `year:2015`. *(Added 2026-10-08, plan 3: what the year chip writes, §5.2.)* |
| `ep:250` | Limit to one episode. |
| `include:ads` | Include boilerplate chunks (keyword search only). No effect while detection is binned (§3.5); the web app doesn't mention it. |

The parser turns the query into an FTS5 MATCH expression plus SQL filters.
Unless `include:ads` is given, the SQL adds `is_boilerplate = 0`. The text
for meaning-based search is the query with operators, exclusions and filters
removed. If the input can't be parsed, fall back to plain quoted words;
never return an error for bad syntax.

Parser rules (`worker/src/query.ts`):
- User text reaches FTS5 only inside double-quoted strings (`"` doubled);
  operators come only from parsed syntax. FTS5 syntax typed by a user
  (`text:foo`, `NEAR(`, `^x`) is plain text.
- Input is cut to 200 code points. Curly quotes act as straight ones;
  control characters and lone surrogates become spaces.
- `OR` is uppercase only and is ignored when either side isn't a word
  (start, end, next to an exclusion or a filter). An unbalanced `"` is
  dropped. Words with no letter or digit (emoji, lone `-` or `*`) are dropped.
- A malformed filter (`year:abc`, `ep:` with no number) is searched as a
  plain word. A repeated filter: the last one wins.
- Only exclusions, or only filters → nothing to match (no results).
- The parser also returns the excluded terms as their own expression, so
  smart search can drop excluded vector hits.

### 4.4 Endpoints

- `GET /api/search?q=&mode=smart|exact&sort=relevance|newest|oldest&page=&limit=`
  - `limit` is the page size, 1–20 (default 20; bigger is clamped, bad is
    20), echoed in the response. The result caps stay in results, not pages:
    exact mode's 200 is 10 pages at 20, 40 at 5; the last page stops at
    result 200. *(Added 2026-10-07, maintainer.)* `wts search --limit N`
    is separate: it trims the printed page after collapsing.
  - `exact`: FTS5 only. With `sort=relevance` it is ranked by BM25;
    otherwise it is ordered by `published_at`, then by position in the
    episode. The response includes `total` (the match count, up to 1,000).
  - `smart` (default):
    1. Take the FTS5 top 50, then embed the query with Workers AI (`pooling: "cls"`) and take
       the Vectorize top 50 (year filter applied in Vectorize).
    2. Merge the two lists with reciprocal rank fusion (k = 60).
    3. Apply the exclusion and episode filters to the merged list.
    4. With `sort=newest|oldest`, re-sort the top 100 merged results by date.
       Meaning-based search matches everything a little, so date order over
       every match would be noise.
    5. Collapse the whole list (not per page, unlike exact), then page.
    - No `total`. *(Settled 2026-10-07, plan 2 Task 14.)* A smart response is
      `{page, limit, has_more, results, mode, sort, smart_degraded?}`: no
      `total`, `total_capped` or `truncated`, degraded or not. Pages stop at
      `ceil(100 / limit)` (5 at 20).
    - The year filters also go to Vectorize (`year: {$eq}`, or `{$gt, $lt}`
      for `after:`/`before:`; Vectorize can't combine `$eq` with a range, so
      `year:` sends `$eq` alone). D1 applies every SQL filter again, and the
      exclusions (`rowid NOT IN (… MATCH <excluded terms>)`), when it loads the
      chunks only Vectorize found; ids with no chunk (a publish in progress)
      are dropped.
    - Hits only Vectorize found are `related` even when they contain every
      query word (they ranked past the FTS5 top 50); a second FTS5 query
      (`rowid IN (…)`, the query's words ORed, a quoted phrase split into its
      words) highlights any query words in them: `"lacquer spray"` marks
      "spray lacquer". FTS5 has no stopwords, so function words ("a", "the",
      "how", "I"; `HIGHLIGHT_STOPWORDS` in `query.ts`) are left out of these
      highlights, or a question would mark every "a"; matching, ranking and
      the embedding keep them. D1: one query for the keyword list (run while the query is
      embedded), then one batch of two for the related chunks, if any.
    - When Workers AI or Vectorize fails (or AI returns no embedding), the
      keyword list alone goes through the same steps, with
      `smart_degraded: "unavailable"`, and one log line (`ai_unavailable` or
      `vectorize_unavailable`). The value says why: `"unavailable"`,
      `"budget"` (§4.8 item 2) or `"off"` (the kill switch, §4.8 item 3), so
      the frontend can explain it. *(Revised 2026-10-08: was `true`; a reason
      string is still truthy for clients that test it as a flag.)*
  - Collapse hits from the same episode that are less than 120 s apart into
    one result carrying `more_in_episode: n`. When sorting by date, results
    are grouped by episode in date order.
  - 20 results per page, at most 100 in total (smart) and 200 (exact, 10
    pages). *(Revised 2026-10-07, maintainer: nobody pages through a
    thousand pages.)* A broad query gets its best 200, in the chosen sort,
    and a notice to narrow it: "Showing the best 200 of 640 matches — add
    words, a "phrase" or `year:` to narrow", or "1,000+ matches — …" past
    the count cap. The API returns the flags (`truncated`, `total_capped`);
    each client writes the sentence.
  - Each result includes: episode (number, title, date, links), chunk ID and
    text, highlight ranges, `hit_ms`, per-platform `cue_s`,
    `match: keyword|related`.
  - Highlight ranges are `[start, end)` offsets into `text` in UTF-16 code
    units (JavaScript string indices, what the frontend slices with). Other
    clients convert; Python indexes by code point.
  - Exact response (as built in plan 2 Task 13): `{total, total_capped,
    truncated, page, limit, has_more, results, mode, sort}`; smart's is above.
    `total` stops at 1,000 (`total_capped` when there are more), so a
    common word isn't read in full just to be counted; `truncated` when
    there are more than 200 matches; `has_more` never runs past page 10. Each result: `{episode: {id, number,
    title, date, links}, chunk_id, text, ranges, hit_ms, cue_s, match,
    more_in_episode, folded}`; `more_in_episode` is always present (0 when nothing
    collapsed). `folded` is the chunk ids collapsed into the result, in
    the order they were folded (`[]` when none; its length is
    `more_in_episode`), so the web app can mark them (§5.4). *(Added
    2026-10-08, plan 3; was `debug.folded` only.)*
  - Exact mode collapses **per page**: a hit is folded into an earlier *kept*
    result on the same page from the same episode less than 120 s away, so a
    page can show fewer than 20 results. `total` counts matching chunks
    before collapsing. Pages past 10 are clamped.
  - Clients say when hits were folded, or "5 matches" over 4 results looks
    like a lost hit (Checkpoint F): `wts search` prints "5 matches; 4
    results (1 folded into a nearby hit)", and the web app does the same.
    A phrase in the sentence two chunks share counts twice in `total` and
    shows once.
  - Bad parameters fall back to defaults (`sort` → relevance, `page` → 1);
    the only error is D1 being down (503).
  - `debug=1` (smart mode only; added 2026-10-07, maintainer): each result
    gets `debug: {keyword_rank, vector_rank, vector_score, rrf_score}`
    (ranks from 1 or null; `folded` moved out to every result, 2026-10-08)
    and the response `debug: {keyword_hits, vector_hits, dropped}`
    (`vector_hits` null when degraded; `dropped` the meaning hits excluded,
    filtered out or gone). Same order as without it; never cached.
    `wts search --debug` prints it.
- `GET /api/context?chunk=&radius=3`: the chunk and its neighbours in the
  same episode, ±radius (0–6; bad → 3), in episode order: `{chunk_id,
  episode: {id, number, title, date, links}, chunks: [{chunk_id, seq,
  start_ms, end_ms, text, boilerplate, cue_s, links}]}`, each chunk's cue
  and links at its start. A bad `chunk` is 400, an unknown one 404. One D1
  statement. *(Built 2026-10-07.)*
- `POST /api/report`
  - Body: `{chunk_id, quoted_text, suggested_text?, note?, turnstile_token}`.
  - Checks the Cloudflare Turnstile token, limits lengths (quoted 500,
    suggested 500, note 1000 characters), then inserts into `reports`.
  - As built (2026-10-07): the body is checked first (400 with a friendly
    `message`; a Content-Length over 48 KB or a body over 16 K characters is
    refused unread or unparsed), then siteverify (no client IP sent; 5 s
    timeout), then one `INSERT … WHERE EXISTS` the chunk (an unknown chunk is
    400, after the token is spent). A refused token is 403; siteverify
    unreachable, or refusing *our* secret (`invalid-input-secret`,
    `missing-input-secret`), is 503 and logged, so a misconfiguration isn't a
    silent 403 for every listener. Characters count as code points, after
    trimming; empty optional fields are NULL. Answer `{ok: true}`.
  - **General feedback** *(added 2026-10-08, plan 3; open decision 9)*: a
    body with no `chunk_id` (absent or `null`) is feedback from the
    footer's "Send feedback": `{note, turnstile_token}`, `note` required
    (1–1000), `quoted_text` and `suggested_text` not allowed (400). Same
    Turnstile, Origin and rate limit; stored with `chunk_id` NULL (no chunk
    check). Plan 4's `wts reports` lists these as feedback.
- `GET /api/health`: `corpus_version` plus a single trivial D1 query.
- `GET /api/info` *(added 2026-10-08, plan 3)*: what the web app needs on
  load, `{episodes, latest_episode_date, corpus_version,
  turnstile_site_key}`: the number of episodes in D1, the newest one's
  `published_at` date ("625 episodes indexed through Sep 17, 2026", §5.6),
  and the `TURNSTILE_SITE_KEY` var (so one web build serves every
  environment, §5.1). One D1 statement; edge-cached like a search (keyed by
  `corpus_version`, same TTL var).

### 4.5 Highlighting and cue time

- Keyword hits: highlight ranges come from matching the query terms (stemmed
  the same way) against the chunk's words. `hit_ms` is the start time of the
  first highlighted word, from `word_times`. *(Revised 2026-10-07,
  maintainer.)* Highlights of stopwords the query happened to contain
  (`HIGHLIGHT_STOPWORDS` in `query.ts`: "a", "the", "I", …) are dropped, and
  the cue is the first remaining one: "flattening a bench top" neither marks
  every "a" nor cues on one. A phrase span stays whole, and if only stopwords
  were marked they all stay.
- Meaning-only hits: tagged `related`. Any query words that happen to appear
  are highlighted. `hit_ms` is the chunk's `start_ms`.
- One function computes the cue time for each platform `p`:
  `cue_s[p] = max(0, floor(hit_ms/1000) − 7 + episode.offset_<p>_s)`.
- The Wood Talk page has no player, so it gets no cue; the card shows
  "jump to mm:ss" next to its link.
- How word times, FTS5 highlights and cues fit together, with real
  `highlight()` output: [`docs/word-times-and-highlights.md`](../../word-times-and-highlights.md).

### 4.6 Deep links

Built from the episode row and `cue_s`, in this order on the card:

1. **YouTube:** `https://www.youtube.com/watch?v=<youtube_video_id>&t=<cue>s`.
   Shown first when the episode has a matched video that lines up (see
   below). YouTube ads are not spliced into the video, so if the audio is the
   same recording, the timestamp is exact.
2. **Apple Podcasts:**
   `https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480?i=<apple_episode_id>&t=<cue>`.
3. **Spotify:** `https://open.spotify.com/episode/<spotify_episode_id>?t=<cue>`.
4. **Wood Talk page:** `page_url`, always shown.

*(Settled 2026-10-07, Checkpoint F.)* The Apple and Spotify formats are the
ones each app's own "share from current time" link uses. Which devices honour
them (iOS, Android, desktop) is tracked in `docs/deep-links.md`, and the link
builder lives in one module (`worker/src/links.ts`).

**YouTube (findings 2026-10-05).** Channel: **@WoodTalk**. Videos exist
sporadically from WT322 (2016) and regularly for recent episodes.
Livestream-era videos are unedited streams (WT379: 1:04:15 on YouTube vs
50:39 in the feed), but recent videos have exactly the feed's length.

**Rule:** a YouTube link is shown only when the matched video's length
(YouTube Data API `contentDetails.duration`) is within 3 s of the feed's
`itunes:duration`, which is the show's own ad-free length. Other episodes
get no YouTube button; no manual alignment is needed. Exact links also
require our timestamps to be on the show's own timeline (see the ad
timeline below).

**Our timeline:** `wts download` fetches with a bot User-Agent, which
Acast serves without inserted ads (§3.2), so transcripts and `hit_ms` are
on the show's own timeline: the same as `itunes:duration` and the
length-matched YouTube videos. A copy that still comes with ads is flagged
`ads_inserted` (§3.2); its timestamps run late by the ads before each
point and it should be re-fetched before publishing.

**Known limitation:** Apple and Spotify listeners get ads inserted at play
time, so those links land early by the listener's own ads before that
point. Ads go into fixed **slots** per episode: a pre-roll at 0:00, a
post-roll, and on many episodes one or two **mid-roll** slots at fixed show
times; each listen fills each slot with 0–4 minutes of ads. *Measured
2026-10-05* on 41 ad copies of 22 episodes from 2007–2026, each compared
with an ad-free copy by fingerprint: 20 of 41 had mid-rolls (2 of 14 from
2026; most 2013–2023). Because our timestamps are on the show's timeline,
these links are early, never late. Mitigations:

- The card always shows the time as text.
- YouTube comes first where available.
- The per-platform offset columns allow corrections without code changes.

### 4.7 Worker hardening

- Queries are capped at 200 characters; smart-mode `page` at 5.
- If Workers AI or Vectorize fails, return keyword-only results with
  `smart_degraded: "unavailable"` (§4.4).
- Search responses are cached at the edge (Cache API) for 1 h, keyed by the
  normalized query, mode, sort and page, plus `corpus_version`.
  *(As built, Task 15.)* Also `limit`; the parameters as the route read them
  (`page=abc` shares page 1's entry); only whitespace in the query is
  normalized (case matters: `OR`). `corpus_version` is read at most once a
  minute per isolate. Degraded and `debug=1` answers are not stored, nor
  errors. The TTL is the `SEARCH_CACHE_TTL_S` var (3600 in staging and
  production; unset locally and in tests, so no caching). Every search answer
  says `x-wts-cache: hit|miss|skip`; browsers get no `cache-control`.
  Cloudflare's docs only promise the Cache API on custom domains, but it
  works on `workers.dev` too: a repeated staging search answered
  `x-wts-cache: hit` (2026-10-08).
- Cloudflare rate-limiting rules, per IP: 60 requests per minute on
  `/api/*`, and 10 per hour on `/api/report`.
- `/api/report` requires a valid Turnstile token.
- The frontend sets a strict CSP. There are no cookies and no secrets. The
  only stored user input is report text and anonymous search analytics.

### 4.8 Abuse and cost protection

*(Added 2026-10-08, maintainer. Builds on §4.7; not yet in plan 2's tasks:
add them before Checkpoint G.)* *(Settled 2026-10-08, maintainer: plan 2
Tasks 17–19; the 5xx alert moved to an external check, item 4.)*

The threat that matters most is **cost**, not downtime. Cloudflare absorbs
raw traffic, and there is no spending cap. Every **uncached** smart search
costs a Workers AI embedding and a Vectorize query, so a bot sending unique
queries from many IPs gets past both the edge cache and per-IP limits. The
design keeps the worst case bounded and cheap rather than trying to stop
every bot.

**1. Per-IP rate limits in code.** Use the Workers rate-limiting binding
(`ratelimits` in `wrangler.toml`), keyed by the client IP, which isn't
stored. This replaces the dashboard rules planned for Checkpoint G, for two
reasons: dashboard rules don't apply on `workers.dev`, where staging runs,
and the free zone plan allows only one short-window rule.

| Limit | Binding (period ≤ 60 s) | Over the limit |
|---|---|---|
| `/api/*` reads | 60 per 60 s | 429 `{error: "rate_limited"}` with `retry-after` |
| `POST /api/report` | 3 per 60 s (with Turnstile; replaces "10 per hour") | 429 with a friendly `message` |

The binding counts per Cloudflare location and is approximate. That is
enough for this purpose; exact counting would need a Durable Object.
Cloudflare's docs advise against IP keys because many people can share
one address (mobile carriers, offices); 60 a minute is generous enough for
that. The binding's `period` must be 10 or 60, and bindings that share a
`namespace_id` share counters account-wide, so each environment gets its own
ids. Without the binding (local runs, tests that don't set it) nothing is
limited.

**2. A global daily budget for smart search.** A D1 table, `usage(day TEXT
PRIMARY KEY, smart INTEGER, alerted_half INTEGER, alerted_full INTEGER)`
(`schema/0002_usage.sql`), counts uncached smart searches per UTC day
with one `INSERT … ON CONFLICT … RETURNING` per uncached smart search, made
before the embedding is asked for (one more D1 round trip on a cache miss).
- Past `SMART_DAILY_BUDGET` (a Worker var, default **20,000**), searches
  run keyword-only, the existing degraded path, with
  `smart_degraded: "budget"`, until midnight UTC.
- At 20,000 a day the AI and Vectorize cost is a few dollars a month at
  most (§11.2), so a runaway bot can't produce a surprise bill.
- Cached answers and exact-mode searches don't count.

**3. Kill switch.** A Worker var, `SEARCH_OVERRIDE`, changed in the
dashboard with no code deploy:
- unset or `""`: normal.
- `"exact"`: smart search off for everyone: keyword-only answers with
  `smart_degraded: "off"`, no AI or Vectorize call, nothing counted.
- `"maintenance"`: every `/api/*` returns 503 `{error: "maintenance"}`,
  and the frontend shows a notice.
- Any other value is treated as unset, with one log line.

`wrangler deploy` overwrites dashboard vars unless the config sets
`keep_vars: true` (Cloudflare docs, 2026-10-08), which it does; so
`SEARCH_OVERRIDE` (and any dashboard override of `SMART_DAILY_BUDGET`) is
never in `wrangler.jsonc`, and a deploy during an incident leaves the
switch where it was.

**4. Alerts.** The Worker posts to ntfy once per UTC day each when the
smart-search counter passes 50% of the budget and when it passes 100%. The
server (the maintainer's own), topic and optional token are Worker secrets
(`NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN`), so the server's address stays out
of the public repo; without a topic, alerts are only logged. Titles name the
environment (`WTS_ENV` var: "wts staging: …"), so one topic and one
write-only ntfy user can serve both Workers. The `usage` row records which alerts were sent (an
`UPDATE … WHERE alerted_half = 0` decides which request sends), so nothing
repeats. The post runs after the response (`waitUntil`) and its failure is
only logged.

Errors are watched from outside *(revised 2026-10-08, maintainer)*: a
monitor in the maintainer's homelab (e.g. Uptime Kuma, which posts to ntfy
itself) polls `/api/health`, whose one D1 query fails when the Worker or
D1 is down. The planned in-Worker "5xx over 5% in an hour" alert is
dropped: the Worker can't see global request counts without a write per
request, and counting in D1 goes blind exactly when D1 is the failure.
Together with Cloudflare's own usage notifications for Workers, Workers AI
and Vectorize (where the account offers them), a spike or attack reaches
the maintainer's phone while it's happening, not in the weekly digest.

**5. Bots, crawlers and probes.**
- `robots.txt` on the site: allow the pages, `Disallow: /api/`. Until the
  site exists, the Worker answers `/robots.txt` itself with `Disallow: /`
  (on `workers.dev` the API host is all there is). *(Revised 2026-10-08,
  plan 3: the site is served by the same Worker, §5.1, so `/robots.txt`
  stays a Worker route and depends on the environment: production allows
  the pages and disallows `/api/`; every other environment, staging
  included, answers `Disallow: /`.)*
- Once there is a custom domain: turn on Cloudflare's **block AI
  crawlers**. Turn on **Bot Fight Mode** only after checking it doesn't
  challenge `wts search`, which sends the bot User-Agent, or the frontend's
  own requests.
- Unknown paths already get a cheap JSON 404 (plan 2 Task 10), so probes
  for `/wp-admin`, `/.env` and the like cost one Worker invocation and no
  D1 or AI. Logs count 404s per path prefix, without IPs.
- No endpoint writes anything except `/api/report`. Publishing goes
  through the Cloudflare API with the Mac's scoped token (spec §3.6),
  never through the Worker.

**6. Browser and cross-site rules.**
- API responses send no `Access-Control-Allow-Origin`, so other sites
  can't use the API from browsers. `wts search` isn't a browser and is
  unaffected.
- `POST /api/report` also requires an `Origin` header matching the site
  (403 otherwise), on top of Turnstile. The allowed origins are the var
  `REPORT_ORIGINS` (comma-separated, exact match). Until plan 3's site,
  staging allows `http://localhost:5173` (Vite's dev server); a curl test
  adds `-H 'origin: http://localhost:5173'`. Unset (production for now)
  refuses every report, like a missing Turnstile secret. *(Revised
  2026-10-08, plan 3: the site and the API share a host, §5.1, so a report
  whose `Origin` equals the request's own origin is allowed too;
  `REPORT_ORIGINS` lists only extra origins, such as the dev server. The
  domain then lives only in `routes`.)*
- Every response sets `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`. Static files get them from
  `web/public/_headers` (§5.1).
- The frontend's CSP includes `frame-ancestors 'none'` (§5.1).

**7. Bulk scraping (accepted risk).** Search plus `/api/context` (±6
chunks) could be paged through slowly to copy the transcripts. The rate
limits and the 100/200 result caps make that slow, but can't prevent it.
That's acceptable if the hosts are happy for the transcripts to be public;
ask them when getting their blessing (§10 item 1). Mitigations if needed
later: a lower `/api/context` limit, or Turnstile on `/api/context`.

**Tests:**
- The rate limit returns 429 (binding mocked).
- Budget exhaustion gives `smart_degraded: "budget"` with no AI call.
- Each `SEARCH_OVERRIDE` value behaves as described.
- Alerts are sent once per day per threshold (ntfy mocked).
- A wrong or missing `Origin` on report gets 403.
- The security headers are present on every route, and no
  `Access-Control-Allow-Origin` on any.

## 5. Frontend (`web/`)

Vite + TypeScript + Preact, built to static files that **the Worker serves
as static assets** on the same host as the API. *(Revised 2026-10-08, plan 3
brainstorm, maintainer: was Cloudflare Pages plus a Worker route.)* The look
comes from a design system and UI designs made in Claude Design from
`docs/design/BRIEF.md`, which elaborates this section screen by screen; this
spec wins on any conflict, and the brief's *proposed* items are settled
below. *(2026-10-09:)* the result is in `docs/design/system/` (tokens,
HTML mocks rendered in React by Claude Design's own viewer, and a README
with every measurement); the app rebuilds it in Preact. Its layout
decisions and the deviations from it are in §5.3 and §5.7.

### 5.1 Hosting and configuration

*(Settled 2026-10-08, maintainer.)*
- **One Worker per environment serves both** (`wts-api-staging`,
  `wts-api-production`): `assets.directory` is `web/dist`, and
  `run_worker_first: ["/api/*", "/robots.txt"]` sends the API and robots.txt
  to the Worker code; every other path is a static file. Static requests are
  free, don't invoke the Worker and don't count against the rate limits
  (§4.8). One deploy (`wrangler deploy --env <env>` after `vite build`)
  ships both halves, so they can't drift apart.
- Staging's `workers.dev` URL serves the whole site, so it can be used
  before a domain is chosen.
- **The domain is configured in one place:** each environment's
  `wrangler.jsonc` `routes` (`{pattern: "<host>", custom_domain: true}`).
  The frontend calls relative `/api/...` and holds no host. Reports accept
  the request's own origin (§4.8 item 6), so `REPORT_ORIGINS` is only for
  extra origins (Vite's dev server on staging). The Turnstile widget's
  hostname is set in the Cloudflare dashboard. `api_url` in the Mac's
  `config.toml` follows the domain by hand. Once production has its domain,
  it sets `workers_dev: false`, so the site isn't also served from a second
  host.
- **One build serves every environment:** nothing environment-specific is
  baked into `web/dist`. The Turnstile site key comes from `GET /api/info`
  (§4.4), which reads the existing `TURNSTILE_SITE_KEY` var.
- **Headers on static files** come from `web/public/_headers` (the Worker's
  own header code doesn't see static responses): `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, and a strict CSP: `default-src
  'self'`, scripts and frames from `'self'` and
  `https://challenges.cloudflare.com` (Turnstile) only, no inline scripts or
  `style` attributes, `connect-src 'self'`, `font-src 'self'` (the
  self-hosted serif, §5.7), `frame-ancestors 'none'`,
  `base-uri 'none'`, `object-src 'none'`. Hashed asset files get a long
  `Cache-Control: immutable`; `index.html` keeps the default revalidation.

### 5.2 Search bar

Pinned to the top (compacting on scroll on phones):
- A large input with a clear button, and a **Search** button (Enter also
  searches). Searching happens only on Enter or the button, not while
  typing; changing mode, sort or years re-runs the current search.
- **The query is normalised before it is searched or written to the URL**
  *(maintainer, 2026-10-09)*: trimmed, emoji removed (pictographs, skin
  tones, flags, keycap marks and the joiners between them; digits, `#`, `*`
  and every script's letters stay), and the whitespace left behind collapsed.
  A `q` arriving in a URL gets the same treatment, so a shared link behaves
  like typing; a query that was only emoji is no search. The box shows the
  normalised text and takes at most 200 characters. The Worker is unchanged:
  it already drops words with no letter or digit and cuts at 200 code points
  (§4.3).
- A row: a **Smart / Exact** segmented switch (one-line tooltips), a sort
  menu (Relevance / Newest / Oldest), a **year range** chip, and a `?`
  syntax popover (the table in §4.3 as examples, as in the brief §5).
- **Year range** *(settled 2026-10-08)*: a chip "Any year" opens from–to
  pickers (2007 to this year); once set it reads "2015–2020 ×". The chip
  and the query box are two views of one state: setting the chip removes
  any `year:`, `before:` and `after:` from the box and appends `year:2015-2020`
  (or `year:2015` when both ends are one year); × removes them. The chip
  always shows the box's effective range (`after:2019` shows "2020–<this
  year>"). No API parameter: the range travels in `q` (§4.3).
- **The whole state is in the URL**: `?q=&mode=&sort=&page=` (defaults
  omitted), so searches can be shared; Back and Forward re-run them.
- Below the bar, one summary line: Smart: "Smart search" (+ "page n");
  Exact: "**318 matches**" or "**1,000+ matches**", and when hits were
  folded on the page, "5 matches; 4 results (1 folded into a nearby hit)"
  (§4.4).

### 5.3 Result card

*(Revised 2026-10-09: the Claude Design product, `docs/design/system/`, is
the visual reference. Its README has the measurements; its **dense card**
(canvas section 4, `DenseResult.dc.html`) is the results layout, and the
roomy card stays the reference for the expanded, report and feedback
states. Behaviour from the design, with the maintainer's calls:)*
- **Grouping:** consecutive results from the same episode (in the API's
  order, never reordered) share one card header, with "N matches" before
  the date, and one hit row each. Date sorts group naturally; relevance
  groups only neighbours. *(Maintainer, 2026-10-09.)*
- **Related hits fold at the end of each page** (Smart): keyword hits
  first, then one dashed row "Show N related passages — Matched on meaning,
  not the exact words"; opened, a "Related passages" heading with Hide,
  then the related cards (dashed border, "Related" pill, muted excerpt, no
  filled buttons). A page with no keyword hits shows its related hits open,
  under "No exact matches — passages about similar things:".
  *(Maintainer, 2026-10-09; was "mixed in by rank".)*
- **Hit row:** a timestamp play link (desktop: a 76 px column; phone: none),
  the excerpt clamped to 3 lines (serif), and an actions row. Clicking the
  excerpt opens More transcript, unless text is selected (so selecting to
  report still works).
- **Actions:** desktop shows every platform as a pill (the first filled);
  phone shows only the first platform, as "▶ YouTube 1:09:51", and moves
  the others into the ⋯ menu. ⓘ (ads note) when Apple or Spotify shows;
  "+N nearby"; then ⋯ with More transcript, Episode page and Report
  transcript error. The timestamp link plays on the first platform. The ⋯
  button stays on the actions row (mock 4c wraps it onto a line of its own).
- What the items below say about content, names and links still holds;
  their layout is the design's.

- **Ep. N · Title** · date · timestamp chip **mm:ss** (or h:mm:ss).
  Feed titles repeat the number ("552 – Embarrassed…", "… | Wood Talk
  598"); the card strips it (one tested function over the known title
  styles, §3.4). Unnumbered episodes show the title only. The card is the
  only place titles are cleaned (the API sends the feed title as stored),
  and it strips **only the episode's own number**: "Ep. 5 Recap | 608" on
  episode 608 shows "Ep. 5 Recap", and a marker that names another number
  is left alone *(2026-10-09, plan 3 Task 9)*.
- **Excerpt**, about 2–3 lines on a phone: a window of the chunk's text
  around the first highlight (whole words, "…" at cut ends), with `<mark>`
  on the ranges (UTF-16 offsets, §4.4). **Related** hits: no marks unless
  the API sent ranges, a "Related" tag by the timestamp, quieter styling.
- **Actions:** ▶ YouTube, ▶ Apple, ▶ Spotify, only those in `episode.links`,
  YouTube first, each named for screen readers around its visible text
  (WCAG 2.5.3, label in name), with where playback starts added when that
  platform's cue differs from the hit time, which the 7 s lead-in makes the
  usual case: "Play on YouTube 1:09:51, starts at 1:09:44"; a desktop pill
  that shows only the platform: "Play on Apple, starts at 1:09:40"
  *(2026-10-09, plan 3 Task 9; was "Play on YouTube at 1:09:44", the cue
  time alone, which the visible hit time contradicted)*. Apple and Spotify carry a small info note "May start a bit
  early because of ads" (§4.6). Then **Episode page** (with "jump to
  mm:ss", it has no player) · **More transcript** · **+n more nearby** when
  hits were folded. Links come from the API only; the frontend never
  builds one (§4.6).
- A small **Report transcript error** link (§5.5).

### 5.4 More transcript and "+n more nearby"

- **More transcript** expands the card in place with `/api/context`
  (radius 3, about ±90 s): paragraphs labelled with their timestamp, each
  label a play link (the first platform the episode has) at that moment;
  the hit's paragraph emphasised. Collapsing returns to the excerpt.
  *(2026-10-09: the "Sponsor read" label for `boilerplate` chunks is dropped
  while detection is binned, §3.5.)*
- **+n more nearby** *(settled 2026-10-08, replaces "+n more in this
  episode")*: folded hits are always within 120 s of the card's hit (§4.4),
  so searching the episode would fold them into the same card again.
  Instead it opens the same expanded view at radius 6 (about ±180 s) and
  marks the paragraphs of the folded chunks (`folded` in each result, §4.4).
  For a numbered episode, the expanded view also offers **Search this
  episode** (the query plus `ep:N`).
- The brief's 400 ms hover preview is dropped *(maintainer, 2026-10-08)*:
  More transcript does the same, and hovering gets in the way of selecting
  text to report.

### 5.5 Reports and feedback

- **Report transcript error** opens an inline form in the card: **Quoted
  text** (pre-filled from the user's selection inside the card, else the
  excerpt; editable, ≤ 500), **Suggested correction** (optional, ≤ 500),
  **Note** (optional, ≤ 1000), with live counters; the Turnstile widget
  (Managed mode, rendered explicitly when the form opens); **Send**.
  Success: "Thanks — we'll review it." Errors are inline, keep what was
  typed and use the API's `message` (400/403/429/503); after any failed
  send the widget is reset before the next try (§4.4).
- **Send feedback** *(settled 2026-10-08, open decision 9)*: a footer link
  opening the same kind of form with only a **Message** (≤ 1000) and
  Turnstile, for "search didn't find it" and ideas. It posts to
  `/api/report` without a `chunk_id` (§4.4).
- The Turnstile script loads only when a form first opens.

### 5.6 States

As in the brief §4.5; the wording there is the copy, and the design's
`Screen.dc.html` shows each state *(2026-10-09)*. In short:
- **Before any search:** example searches as chips, and "625 episodes
  indexed through Sep 17, 2026" from `GET /api/info`.
- **Loading:** skeleton cards; the controls stay usable, and a newer search
  cancels an older one (its answer is ignored).
- **Only related hits** (no keyword hit on the page): "No exact matches —
  passages about similar things:" before them, shown open (§5.3).
- **No results:** suggest Smart mode, or fewer words or looser years.
  (`include:ads` is left out while boilerplate detection is binned, §3.5.)
- **Exact, truncated:** "Showing the best 200 of N matches — add words, a
  "phrase" or a year to narrow it" (or "1,000+ matches — …").
- **Degraded** (`smart_degraded`): a subtle notice by reason —
  `unavailable`: "Meaning search is unavailable right now; these are keyword
  matches."; `budget` and `off`: "Meaning search is paused; these are
  keyword matches."
- **Maintenance** (503 `maintenance` from any `/api/*`): a banner.
- **Rate limited** (429): "Too many searches from here; try again in a
  minute." with a countdown from `retry-after`.
- **Error** (other failures, network): "Something went wrong." with Retry.
- **Pagination:** Previous / Next; Exact also shows page numbers up to 10.

### 5.7 Look, keyboard and accessibility

- Warm wood-tone accent on calm neutrals, light and dark following the
  system; tokens from the design system as CSS custom properties. System
  fonts unless the design system picks one webfont. Until the design
  system exists, neutral placeholder tokens with the same names.
  *(2026-10-09: the design system exists: `docs/design/system/tokens.css`
  is used as is, light and dark. Its one webfont, **Source Serif 4** (400
  and 600, excerpts and large headings only), is **self-hosted** under
  `/assets/` (SIL Open Font License), not loaded from Google Fonts: that
  would need a CSP exception and send every visitor's IP to Google. UI text
  stays on the system font stack.)*
- Deviations from the design export: no "Sponsor read" label and no
  `include:ads` hint (detection is binned, §3.5); no separate `years` URL
  parameter (the range travels in `q`, §5.2); the "why is this related?"
  open item waits on a backend that can say why
  ([`docs/full-corpus-backlog.md`](../../full-corpus-backlog.md) §2).
- `/` focuses search; arrow keys **and j/k** move between results
  *(settled 2026-10-08)*; Esc closes popovers and forms. Enter on a result
  does nothing special (no "play first platform").
- Results are a list; buttons are real buttons or links with names;
  visible focus everywhere; motion respects `prefers-reduced-motion`;
  WCAG AA in both themes, `<mark>` and disabled states included.
- Works on phones first (results ~720–760 px wide on desktop).
- **Footer:** "Unofficial · made with the hosts' blessing" (§10 item 1),
  show links (YouTube, podcast, site), "Searches are logged anonymously to
  improve results.", **Send feedback**.
- No analytics or cookies in the frontend; the Worker's anonymous search
  logs (§8.3) are all there is.

### 5.8 Code and tests

- No router and no state library: one page, state in the URL, Preact
  hooks. The API's response types are imported type-only from
  `worker/src/` (one source of truth, checked by `tsc`).
- Pure modules with unit tests (Vitest): URL ↔ state, the year chip ↔
  query box, title stripping, the excerpt window and highlight segments,
  the API client's handling of every status.
- Components with Testing Library on happy-dom.
- End to end with Playwright (Chromium): every state above against stubbed
  `/api/*` answers built from real response shapes, plus an axe
  accessibility check of the main states in both colour schemes; one smoke
  run against `wrangler dev` with a seeded local D1 and the built assets
  (routing, headers, CSP, same-origin report with Turnstile's test keys).

## 6. Error handling summary

| Failure | Behavior |
|---|---|
| Feed unreachable | The run logs an error and notifies; nothing else changes. |
| NAS not mounted, read-only, or nearly full | Steps that need audio stop with a notification; episodes keep their status and no retries are used up (§3.0.1). |
| Download, transcribe, chunk or embed fails | The episode goes to `error` and is retried on the next runs, up to 3 times (§3.3). |
| Publish fails partway | The episode goes to `error` (step `publish`) and its `publications` row for that environment is unchanged, so the next run repeats every call for it; the result is the same as a clean publish. The Worker may briefly see a half-updated episode (acceptable on staging; see §3.2). If only the `corpus_version` bump fails, it is retried on the next run. |
| Platform ID match fails | The ID stays null and that button is hidden; matching is retried on the next `wts feed`. |
| Workers AI or Vectorize down | Keyword-only results with `smart_degraded`. |
| D1 down | 503 from the API; the frontend shows the retry message. |
| Bad query syntax | Fall back to plain quoted words. |
| Report fails Turnstile or rate limit | 4xx with a friendly message; nothing is stored. |

## 7. Testing

### 7.1 Automated tests

- **Pipeline (pytest):**
  - Feed parsing (saved sample RSS files) and platform ID matching.
  - Status-machine moves, including the rules for invalid moves and resets.
  - Stem generation.
  - `corrections.yaml` application.
  - Boilerplate detection (sample episodes sharing a sponsor read). *(Binned
    with the detector, 2026-10-09; the plumbing tests stay.)*
  - Chunker: boundaries, overlap, timings that add up, and `word_times`
    encoding round-trip.
  - Quality guards and timestamp checks (deliberately bad sample
    transcripts).
  - Publish diffing against a mocked Cloudflare API.
- **Worker (Vitest with `@cloudflare/vitest-pool-workers`):**
  - Table-driven tests of the query parser and the FTS5 expression it
    produces, including `include:ads`.
  - Reciprocal rank fusion, date sorting, collapsing, per-platform `cue_s`,
    the deep-link builder.
  - Degraded mode and input limits.
  - `/api/report` validation, with Turnstile mocked.
- **Frontend:** one Playwright smoke test: search on Enter → results → change
  sort → expand → check that every link is well-formed with the right time
  → submit a report (Turnstile test key). *(Revised 2026-10-08, plan 3:
  this is the `wrangler dev` smoke run; unit, component and stubbed-API
  Playwright tests of every state are in §5.8.)*

### 7.2 Test search set (`eval/`)

- **`eval/queries.yaml`:** each case has an `id`, `query`, `mode`, optional
  filters and sort, and either `expect: [{episode, at_s}]` (time tolerance
  ±45 s) or `expect_absent: [episode]`. Each case is tagged with one of:
  - `exact`: phrase lookups.
  - `jargon`: brand names and woodworking terms (also tests Whisper's
    spelling).
  - `paraphrase`: meaning-based queries.
  - `filter`: year and episode filters.
  - `negative`: things that should not come back, including boilerplate
    sponsor reads without `include:ads`.
  - `collapse`: `more_in_episode` (§4.4). Cases assert the result count and
    `more_in_episode` per episode, not just which episode comes back
    (`expect: [{episode, at_s, more_in_episode}]`). Scenarios (maintainer's
    request, 2026-10-07): a topic discussed for several minutes (adjacent
    chunks fold into one card); the same word twice in one episode, more
    than 120 s apart (two cards); the overlap sentence shared by two
    chunks (one card, not two); a run of hits longer than 120 s (one card
    per 120 s of distance from the kept hit); a run across a page boundary
    in exact mode (appears on both pages, by design); hits in different
    episodes on the same date (never folded); collapsing under each sort
    and in smart mode, where related hits fold too.
- **Where the cases come from:**
  1. About 30 written by the maintainer from memory.
  2. About 100 synthetic ones: a local LLM on the Mac paraphrases a question
     answered by a randomly sampled chunk, so the right answer is that chunk.
  3. Topics from the show notes, mapped to their episodes.
  - In M1 every case points at a seed-set episode. More cases are added as
    M2 grows the archive.
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
  (`eval/wer/`) measure Whisper's word error rate when changing the model,
  the vocabulary prompt or `corrections.yaml`.

## 8. Logs, notifications and analysis

### 8.1 Pipeline logs

- **Logs:** JSON lines in `~/Library/Logs/wts/wts-YYYY-MM-DD.log`, kept for
  30 days. Each line has `ts`, `run_id`, `episode`, `step`, `duration_ms`,
  `level`, `msg`, `error`. The console shows the same events in readable
  form.
- **Run history:** a `runs` table in `state.db` records start, end, machine,
  per-step counts and errors. `wts status` shows it.
- **Smoke search:** after each `wts run`, 5 fixed queries from `eval/` are
  sent to the target environment. Each must return its expected episode in
  the top 10.

### 8.2 Notifications (ntfy)

A private, hard-to-guess topic name, stored in the Keychain. The server is
ntfy.sh unless `ntfy_url` in `config.toml` names another; the maintainer runs
their own, which can require an access token (Keychain `ntfy_token`, sent as a
bearer header). *(Revised 2026-10-07.)* `wts` sends a push for:

- New episodes published (number, title, chunk count).
- Episodes that hit `error`, or ran out of retries. *(2026-10-09, review #9:)*
  "failed this run" is read from `episodes.failed_at` (migration 005, set only
  when a step fails), not `updated_at`, which every feed refresh bumps.
- A failed smoke search.
- New transcript-error reports (a daily digest: count plus the first few).
- No new feed item for 45 days (the feed may have moved): sent when the quiet spell is first
  seen, then at most weekly. *(Revised 2026-10-07: episodes come out about every 13 days, with
  normal breaks of up to 36 days in 2026 and 68 in 2025; 21 days fired on ordinary breaks, and
  repeated on every daily run.)*
- A weekly digest: top searches and zero-result searches.

**Watchdog (Mac Mini only):** each successful scheduled run pings a
healthchecks.io check with an 8-day timeout. healthchecks.io alerts when the
pings stop, which covers the Mini being off or launchd being broken.

### 8.3 Worker logs

- **Cloudflare Workers Logs** enabled. One structured line per request:
  endpoint, shortened query, mode, sort, latency, result count, degraded
  flag. No IP addresses. Cloudflare's default retention, which is a few
  days. *(As built, Task 15.)* `{level: "info", event: "request", method,
  path, status, ms}` for every request, plus for searches `q` (80 code
  points), `mode`, `sort`, `page`, `results`, `degraded`, `cache`. Errors
  keep their own `level: "error"` lines (`d1_unavailable`, `ai_unavailable`,
  `vectorize_unavailable`, `turnstile_unavailable`, `analytics_unavailable`),
  which never carry the query, report text or tokens.
- **Cloudflare Workers Analytics Engine:** one data point per search (query,
  mode, sort, result count, latency) and per report. Retention is about 3
  months. Columns (`worker/src/analytics.ts`): search — index1 `search`,
  blob1 query (≤ 200 characters), blob2 mode, blob3 sort, blob4 cache;
  double1 results, double2 latency ms, double3 degraded, double4 page,
  double5 status. Report — index1 `report`, double1 status. The binding is
  optional; a failed write is logged once per isolate and never fails a
  request.

### 8.4 Getting logs for analysis

| Source | How |
|---|---|
| Pipeline logs | `wts logs [--run ID] [--episode STEM] [--level error] [--since 7d] [--json]` for day-to-day use: one readable line each (local time, run id, `[level step episode]`, message, the last line of any traceback), or the JSON lines. `--episode` also takes part of a stem (`ep312`); `--level` is a minimum. For ad-hoc analysis, query the files directly: `duckdb -c "select … from read_json_auto('~/Library/Logs/wts/*.log')"` or `jq`. |
| Pipeline run history | `wts status`, or SQL on `state.db` (location from `wts paths`). |
| Worker, live | `wrangler tail --env production` (filterable by status or text). |
| Worker, last few days | Workers Logs query builder in the Cloudflare dashboard. |
| Search analytics, long term | `wts analytics pull` (run weekly by `wts run`) copies Analytics Engine data through its SQL API into `analytics.db` (§3.0). That file keeps the full history for SQL or DuckDB analysis, and drives the weekly digest. |
| Transcript reports | `wts reports` (reads the `reports` table in D1). |

Optional: a free UptimeRobot check on `/api/health` every 5 minutes.

## 9. Phase 2 (separate spec): topic summaries

A local LLM on the Mac generates chapter-style topics for each episode, in a
new `topics(episode_id, start_ms, title)` table. They show as chips that link
to the right time, and can be searched. It reuses the phase 1 transcripts and
chunks unchanged.

**Boilerplate detection rework** (deferred from phase 1, §3.5; binned
2026-10-09, to be measured on the full corpus first:
[`docs/full-corpus-backlog.md`](../../full-corpus-backlog.md) §1): detect
repeated content by word runs shared across episodes instead of whole
sentences, and cut chunks at boilerplate edges. Changing chunk boundaries
re-chunks and re-embeds the corpus, so it needs its own brainstorm, spec
and plan.

## 10. Prerequisites and open items

1. **Hosts' blessing:** contact Marc, Shannon and Matt before the public
   launch (M2). Ask whether ads are inserted at download time and whether
   the YouTube uploads are the same edit as the podcast audio.
2. **Deep-link formats:** check by hand during M1 (§4.6).
3. **YouTube:** ~~confirm the channel~~ @WoodTalk; length-match rule in §4.6.
4. **Ad drift:** ~~check whether ads are inserted~~ confirmed per download
   (29 of 35 seed copies have 24–182 s of ads; Patreon offers no ad-free
   audio). ~~Recover the show's timeline~~ resolved 2026-10-05: the cause
   is the User-Agent. `curl` and `…Bot` User-Agents get no ads; httpx's
   default and unknown ones do. `wts` now sends `WoodTalkSearchBot/…`
   (§3.2), so downloads are ad-free and no timeline correction is needed.
5. **Feed history:** confirm the RSS feed lists the whole archive. If old
   episodes are missing, find another source for their audio before M2.
6. **API keys:**
   - A free Spotify developer app (client credentials).
   - A YouTube Data API key.
   - A Cloudflare Turnstile site key.
7. **Domain:** pick a domain or subdomain for Pages and the Worker.
   *(Maintainer, 2026-10-08:)* most likely a subdomain of `10fathoms.org`
   (exact name not chosen), and it must be **configurable**: nothing may
   hard-code it. It reaches the Worker route (`/api/*` on the site's host),
   the Pages custom domain, `REPORT_ORIGINS`, the Turnstile widget's
   hostname, `api_url` in the Mac's `config.toml`, and any absolute URL in
   the frontend (prefer relative `/api/...`). Plan 3 settles how.
   *(Settled 2026-10-08, §5.1:)* one Worker serves the site and the API, so
   the domain is each environment's `routes` entry in `wrangler.jsonc`;
   reports accept their own origin; the frontend holds no host; the
   Turnstile hostname (dashboard) and `api_url` (Mac) are set by hand.
8. **NAS (M2):** create the SMB share and folders, set up automatic mounting
   on the Mini, and move the M1 audio there.
9. **Atomic publish (before production, M2):** D1's REST API doesn't apply a
   batch all-or-nothing, so on staging a search can briefly see a
   half-updated episode while it publishes. Before production, `wts publish`
   sends D1 writes to an authenticated publish route in the Worker that uses
   `env.DB.batch()`. Vectorize stays on its REST API. (Plan 2, decision 2.)

## 11. Sizing and cost estimates

These are estimates; `wts feed` reports the real total duration and audio
size from the feed, and §10 item 5 confirms the archive's extent.

### 11.1 Local storage (Mac)

Assumption: about 620 episodes averaging about 1 hour, so about 620 hours of
audio.

| Item | Estimate |
|---|---|
| Audio at 128 kbps | about 58 MB/h, about **36 GB** |
| Audio at 64–96 kbps (likely for older episodes) | about 18–27 GB |
| Transcript JSON with word timings and probabilities | about 0.6 MB per episode, about 0.4 GB |
| Chunks and embeddings (100k × 768 float32) | about 0.3 GB |
| State (`state.db`: chunks plus the boilerplate index of ~16 band keys per sentence), analytics, logs | about 0.4–0.5 GB |
| **Total** | **about 20–40 GB**, about 95% of it audio |

The seed set (M1, 35 episodes) needs about 2 GB, kept on the Mac's local
disk. From M2, audio lives on the NAS (§3.0.1), so the Mac itself needs only
about 1 GB plus a temporary copy of the episode being transcribed. Audio is
not deleted after transcription
because the review tool needs it, and a re-download may come with different
inserted ads. Later, `wts audio compact` (§3.0.2) cuts the NAS footprint to
about 9 GB.

### 11.2 Cloudflare running cost

| Item | Basis | Estimate per month |
|---|---|---|
| Workers Paid plan | Flat fee; includes 10M requests, D1 and Vectorize allowances | **$5.00** |
| Vectorize storage | about 90k non-boilerplate chunks × 768 dims ≈ 69M stored dims; 10M included, then $0.05 per million | **about $3.00**, growing about 0.5% a month with new episodes |
| Vectorize queries | Billed as (stored vectors + queries) × dims per month; 50M included, then $0.01 per million | 10k searches ≈ $0.27; 100k ≈ $0.96; 1M ≈ $7.10 |
| Workers AI (query embeddings) | bge-base costs about 6,058 neurons per million tokens; 10k neurons a day are free | $0 up to about 150k searches a day |
| D1 | under 0.5 GB stored; reads well within the included allowance | $0 |
| Static assets, Turnstile, Workers Logs, Analytics Engine | Included or free | $0 |
| **Total** | at ordinary traffic (up to about 100k searches a month) | **about $8–9** |

**What drives the cost:**
1. The flat $5 plan fee.
2. **Vectorize storage.** Number of chunks × vector dimensions is the main
   variable cost at ordinary traffic. Levers:
   - Larger chunks (fewer vectors).
   - A 384-dimension model such as `bge-small-en-v1.5` (about half the
     cost; the test search set decides whether the quality loss is
     acceptable).
   - Leaving boilerplate out (already done).
3. **Search volume** matters only around 1M searches a month or more, for
   example after an on-air mention. Edge caching (§4.7) absorbs repeated
   popular queries, and the per-IP rate limits cap abuse.
