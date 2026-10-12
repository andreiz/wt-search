# M1 Plan 4 — Review Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At his desk, the maintainer can check a transcript by ear, fix a misheard word safely, and work through what listeners reported: `wts review` opens an episode in the browser with the audio and the transcript in step, `wts reports` lists and closes reports, and the daily run tells his phone when new reports arrive.

**Architecture:** Everything is in `pipeline/` and runs only on the Mac. `wts review` starts a small HTTP server from Python's standard library, bound to `127.0.0.1` on a random port, and opens the browser at it. The server serves one static page (plain HTML, CSS and JavaScript, no build step), the episode's words and chunks as JSON, the audio file with Range support, and a few write endpoints. The words shown are the cleaned and corrected ones `wts chunk` produces (`chunking.prepare_episode`), so the page shows what search has. Reports live in D1 and are read and updated through the Cloudflare REST client plan 2 built (`cloudflare.D1`).

**Tech Stack:** plan 1 and 2's stack (Python 3.12, click, httpx, PyYAML, pytest, respx, ruff). No new runtime dependency. The page is hand-written ES modules. The one browser test runs in `web/`'s Playwright, which is already installed, as a third project.

**Spec:** `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` §3.7 (the review tool), §3.2 (`wts reports`), §3.3 (corrections), §4.4 (reports), §8.2 (the reports digest). This is **plan 4 of 5 for milestone M1**.

**Not in this plan:**
- **Flagging boilerplate.** Detection was removed from `wts chunk` on 2026-10-09 (spec §3.5, `docs/full-corpus-backlog.md` §1), so there is nothing for a flag to override. The page greys a chunk whose `is_boilerplate` is 1, which costs nothing and is none of them today.
- **Platform sync mode** (the YouTube and Spotify embeds and "Sync here"). The spec calls it optional, downloads are ad-free since 2026-10-05 and every offset is 0. It gets its own plan if a real drift turns up.
- **Maintainer marks** (spec §4.9). That design is awaiting review; `wts reports` is written so a `source` column can be added to its listing later.
- **Adding to `vocab.txt`** from the page. The corrections skill still does that.
- The test search set (plan 5), production (M2).

## Checkpoints

Continuing plan 3's lettering. Results go into `docs/HANDOFF.md` before the next task starts:

- **J** (after Task 10): on the Mac, the maintainer reviews two seed episodes with `wts review` (one flagged by the guards, one not), saves one correction through the page and sees it in `git diff`, opens a reported passage with `--report`, and closes the test reports on staging with `wts reports`.

## Global Constraints

- **The server is local and private.** It binds `127.0.0.1` only, never `0.0.0.0`. It is never deployed and nothing in `worker/` or `web/src/` refers to it.
- **Every request is checked** (Task 2): the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`; every `/api/` and `/audio/` request must carry the run's token; a write must also be a `POST` with `Content-Type: application/json` and, if it has an `Origin`, that origin must be the server's own. No response has an `Access-Control-Allow-Origin` header.
- **The raw transcript JSON is never edited.** A fix is a rule in `pipeline/corrections.yaml` (spec §3.3).
- **A rule is never saved unseen.** Saving requires a preview of that exact rule over every transcript on the Mac, and the save is refused if what it would change is no longer what the preview showed.
- **`corrections.yaml` keeps its comments and order.** The file is edited as text, one inserted line (plus headers when a block is new), and the result is loaded again and compared before it is written.
- **No secrets in output.** The Cloudflare token goes only through `CloudflareApi`; errors shown are `CloudflareError`'s own text. Report text from listeners is untrusted: the page inserts it with `textContent`, never `innerHTML`.
- **The page follows the same CSP habits as `web/`:** no inline script, no inline style attributes, no third-party origin. The server sends `Content-Security-Policy: default-src 'self'; media-src 'self'; frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`.
- Tests are written first and run with `cd pipeline && uv run pytest -q && uv run ruff check .`. They use `WTS_HOME` temporary roots (`wts_home`, `paths`, `conn` fixtures in `tests/conftest.py`) and never the network (`respx` for Cloudflare).
- Commit straight to `main`, one commit per task. Every commit message ends with the repo's attribution lines, if the session provides them.

## Decisions this plan makes (for the maintainer to confirm before Task 1)

1. **Boilerplate flagging and platform sync mode are left out** (see "Not in this plan"). Spec §3.7 is revised to say so in Task 10.
2. **The page shows corrected words, not raw Whisper words.** What you read is what search indexes. A word that an existing rule produced cannot be the key of a new rule; the preview then shows no changes, which is the signal.
3. **Saving a rule re-chunks the open episode at once**, so the page shows the fix. Every other episode is re-chunked by the next `wts chunk`, as today (the `corrections.yaml` hash changes).
4. **The tool edits `corrections.yaml` in the repo's working tree and does not commit.** The maintainer reviews `git diff` and commits, as with any other change.
5. **"Reviewed" is recorded** (`episodes.reviewed_at`, migration 007), so `--next-flagged` moves on. It is set by a button on the page, never automatically.
6. **`wts reports` reads D1 directly**, joined to D1's own chunks and episodes, so it shows what the listener saw even if the Mac has re-chunked since. It takes `--env` like `wts search` (default `run_env`).
7. **The reports digest is part of `wts run`'s notification**, at most once a day: the number of open reports newer than the last digest and the first three, each cut to 80 characters. With no `run_env` there is no digest.
8. **The browser test lives in `web/e2e/`** as a Playwright project named `review`, started with `npm run e2e:review`. It reuses the installed Chromium instead of adding Python Playwright and a second browser download.
9. **The spike scripts stay** for what the page does not do (`suspects` across all episodes, `issues`); `check_corrections.py` becomes a thin wrapper over the module Task 3 extracts, so the corrections skill keeps working.

## Review Focus

1. **Another website reaching the local server.** A page open in the same browser can send requests to `127.0.0.1` and, with DNS rebinding, read the answers. The token, the `Host` check and the `Origin` check on writes (Task 2) each get a test that fails without them; a wrong `Host` gets 403 even with a valid token.
2. **A rule that changes correct text elsewhere.** `mark → Marc` is the known example. The preview runs over every transcript, the page shows every changed sentence, and the save recomputes and compares (Task 3: a transcript added between preview and save makes the save answer 409).
3. **A damaged `corrections.yaml`.** A key with a colon, a quote or a leading dash, an empty value (a deletion), a value like `no`, a duplicate key, a file with no `episodes:` block yet, and a file that does not end in a newline each have a test (Task 3). The file is written only if loading the new text gives exactly the old rules plus the new one.
4. **Seeking in a large audio file.** Browsers seek with `Range` requests and Safari will not play without `206` answers. Open-ended, suffix and out-of-range ranges, and audio that is missing (the NAS not mounted), each have a test (Task 2); the page still shows the transcript without audio.
5. **Files outside the tool.** `/static/` serves only names from a fixed list, and audio is addressed by episode id and read from `episodes.audio_path`, so no request path reaches the file system (Task 2: `/static/../config.toml` and an encoded variant get 404).

## File Structure

```
pipeline/src/wts/
  corrections_check.py     Task 3: what a rule would change, across all transcripts
  corrections_edit.py      Task 3: insert one rule into corrections.yaml as text
  migrations/007_reviewed_at.sql   Task 4
  reports.py               Task 6: list, resolve, reject (D1); Task 9: digest query
  review/
    __init__.py
    data.py                Task 1: the episode payload (words, chunks, flags, worst stretches)
    server.py              Task 2: the HTTP server and its checks; Tasks 3, 4, 7: write endpoints
    static/index.html      Task 5
    static/review.css      Task 5
    static/review.js       Task 5 (player, transcript, keys), Tasks 5 and 7 (dialogs)
  cli.py                   Tasks 4, 6, 7: `wts review`, `wts reports`
  notify.py                Task 9: the digest section
pipeline/tests/
  test_review_data.py, test_review_server.py, test_corrections_check.py,
  test_corrections_edit.py, test_reports.py, test_review_cli.py
pipeline/spikes/check_corrections.py   Task 3: becomes a wrapper
web/e2e/review.spec.ts, web/e2e/review-home.py, web/playwright.config.ts   Task 8
```

## Part A — The server and its data

### Task 1: The episode payload

**Files:**
- Create: `pipeline/src/wts/review/__init__.py`, `pipeline/src/wts/review/data.py`, `pipeline/tests/test_review_data.py`

**Interfaces:**
- Consumes: `chunking.prepare_episode(row, corrections) -> (list[Sentence], list[str])`, `corrections.load_corrections`, the `chunks` table.
- Produces:
  - `LOW_PROB = 0.5`
  - `episode_payload(conn, row, corrections) -> dict` with keys:
    - `episode`: `{id, number, title, published_at, stem, duration_s, flags: list[str], reviewed_at, has_audio: bool}` (`has_audio` is `audio_path` set and the file existing).
    - `words`: a list of `[text, start_ms, end_ms, prob]`, in order, from the sentences of `prepare_episode`.
    - `sentences`: a list of the index of each sentence's first word.
    - `chunks`: a list of `{id, seq, start_ms, end_ms, is_boilerplate}` from `chunks` ordered by `seq` (empty before the episode is chunked).
    - `worst`: the 5 worst 60 s stretches, `[{start_ms, share}]`, by the share of words under `LOW_PROB`, skipping stretches with fewer than 20 words (the rule of `spikes/transcript_peek.py worst`), worst first.
  - `worst_stretches(words, window_ms=60_000, top=5, min_words=20) -> list[dict]`
  - `chunk_position(conn, chunk_id) -> tuple[int, int] | None`: `(episode_id, start_ms)` of a local chunk.

**Tests:** the words equal `prepare_episode`'s, one entry per token, with a correction applied (a `tx(...)` transcript and a rule `glue: Glew`); an episode with no chunks gives `chunks: []`; `has_audio` false for a missing file; `worst_stretches` orders by share, skips a sparse stretch, and gives `[]` for an empty transcript; `chunk_position` of an unknown id is `None`.

- [ ] Write the tests, see them fail, implement, see them pass (`uv run pytest tests/test_review_data.py -q`).
- [ ] **Commit:** `review: the episode payload`

### Task 2: The HTTP server, audio and the request checks

**Files:**
- Create: `pipeline/src/wts/review/server.py`, `pipeline/tests/test_review_server.py`, `pipeline/src/wts/review/static/index.html` (a stub: a title and `<script type="module" src="/static/review.js">`), `static/review.css` and `static/review.js` (empty for now)

**Interfaces:**
- Produces:
  - `ReviewApp(conn_factory, paths, corrections_file=CORRECTIONS_FILE, token=None)`: holds the token (`secrets.token_urlsafe(24)` when none is given) and opens its own SQLite connection per request through `conn_factory` (the server answers on threads; a connection must not cross them).
  - `serve(app, port=0) -> ThreadingHTTPServer` bound to `("127.0.0.1", port)`; the caller runs `serve_forever()` and reads `server.server_address[1]`.
  - `app.url(port, episode_id, at_ms=None, report_id=None) -> str`: `http://127.0.0.1:<port>/?t=<token>&episode=<id>[&at=<ms>][&report=<id>]`.
  - Routes:
    - `GET /` → `index.html`. It needs no token (it holds no data); the page reads `t` from its own URL and sends it as the header `X-Review-Token` on every `fetch`, and as `?t=` on the audio URL (a media element cannot set headers).
    - `GET /static/<name>` for `review.css` and `review.js` only.
    - `GET /api/episode?id=<n>` → `episode_payload` as JSON; 404 for an unknown id; 409 `{error: "not_transcribed"}` when there is no `transcript_path`.
    - `GET /audio/<id>` → the file at `episodes.audio_path`, with `Accept-Ranges: bytes`, `206` and `Content-Range` for a `Range` header, `416` for a range past the end, `404` when the file is missing. The body is streamed in 64 KB pieces, never read whole. The content type comes from the file's suffix (`.mp3` → `audio/mpeg`, `.m4a` → `audio/mp4`).
  - The checks of Global Constraints, in this order: `Host` (403), route known (404), token where needed (401), method and content type and `Origin` for writes (405, 415, 403). Every answer carries the CSP and `nosniff` headers and `Cache-Control: no-store`.
  - `log_message` is overridden to log nothing (the token is in URLs).

**Tests** (a real server on port 0 in a thread, called with `httpx`): the stub page loads without a token; `/api/episode` needs the token (401 without, 401 with a wrong one, compared with `hmac.compare_digest`); a wrong `Host` is 403 even with the token; `Range: bytes=0-3`, `bytes=4-`, `bytes=-3`, a range past the end, and no range (200 with the full length); missing audio is 404; `/static/../config.toml`, `/static/%2e%2e/config.toml` and an unlisted name are 404; no answer has `Access-Control-Allow-Origin`; every answer has the CSP.

- [ ] Write the tests, see them fail, implement, see them pass.
- [ ] **Commit:** `review: local server with audio ranges and request checks`

### Task 3: Previewing and saving a correction

**Files:**
- Create: `pipeline/src/wts/corrections_check.py`, `pipeline/src/wts/corrections_edit.py`, `pipeline/tests/test_corrections_check.py`, `pipeline/tests/test_corrections_edit.py`
- Modify: `pipeline/spikes/check_corrections.py` (import `sentences` and the diff from `corrections_check`; its output and options stay the same), `pipeline/src/wts/review/server.py`, `pipeline/tests/test_review_server.py`

**Interfaces:**
- Produces, in `corrections_check.py`:
  - `Change(stem: str, start_ms: int, before: str, after: str)` (frozen dataclass).
  - `rule_changes(transcripts_dir, before: Sequence[CorrectionRule], after: Sequence[CorrectionRule]) -> list[Change]`: for every `*.json` in `transcripts_dir`, the sentences that differ (the logic of today's `check_corrections.py`: `clean_transcript` → `apply_corrections` → `join_split_words` → `split_sentences`, keyed by `start_ms`), ordered by stem then time.
  - `changes_digest(changes) -> str`: a SHA-256 over the changes, so a save can prove it matches a preview.
- Produces, in `corrections_edit.py`:
  - `RuleExists(Exception)`, `EditFailed(Exception)`.
  - `add_rule(text: str, key: str, value: str, episode: str | None) -> str`: the file's text with one rule inserted. Global: a line `  <key>: <value>` after the last line of the `global:` block. Episode: under `episodes:` → `  <stem>:`, creating either header at the end of the file when it is missing. Keys and values are written plain when they match `[A-Za-z0-9][A-Za-z0-9 '.-]*` and are not empty, else as a double-quoted YAML scalar (`json.dumps`); an empty value is `""`.
  - It raises `RuleExists` when the scope already has a rule with the same match words, and `EditFailed` when `load_corrections` of the new text is not exactly the old rules plus the new one (the safety net of Review Focus 3).
- Produces, in `server.py`:
  - `POST /api/corrections/preview` with `{key, value, episode_id | null}` → `{changes: [{stem, start_ms, before, after}], digest, count}`. `episode_id` null is a global rule; otherwise the rule is for that episode's stem. An empty key, or one with no match words, is 400.
  - `POST /api/corrections` with `{key, value, episode_id | null, digest, open_episode_id}` → recomputes the changes; a different digest is 409 `{error: "changed"}`; `RuleExists` is 409 `{error: "exists"}`; then writes the file (to a temporary file beside it, then `replace`), re-chunks `open_episode_id` with `chunking.chunk_episode`, and answers the new `episode_payload`.

**Tests:** `rule_changes` finds a change in two transcripts and none for a rule that matches nothing; the digest differs when a change does. `add_rule`: a plain global rule lands at the end of `global:` with the comments above and below untouched (compare whole texts); an episode rule with no `episodes:` block, with the block but not the stem, and with the stem; a key with a colon; a value `no`; an empty value; a file without a final newline; a duplicate raises `RuleExists`; after each, `load_corrections` gives the old rules plus one. Server: preview then save writes the file and the payload's words show the fix; a save with a stale digest (a transcript added in between) is 409 and the file is unchanged; a save without `Origin` trouble but with `Origin: http://evil.example` is 403.

- [ ] Write the tests, see them fail, implement, see them pass. Run `uv run python spikes/check_corrections.py --dir tests/fixtures/real` and check its output is what it was before the change.
- [ ] **Commit:** `review: preview and save a correction`

### Task 4: `wts review` and "reviewed"

**Files:**
- Create: `pipeline/src/wts/migrations/007_reviewed_at.sql` (`ALTER TABLE episodes ADD COLUMN reviewed_at TEXT;`), `pipeline/tests/test_review_cli.py`
- Modify: `pipeline/src/wts/cli.py`, `pipeline/src/wts/review/server.py`, `pipeline/tests/test_review_server.py`

**Interfaces:**
- Produces:
  - `wts review [EPISODE] [--at 12:34] [--next-flagged] [--port N] [--no-open]`. `EPISODE` is a number or a selector, as in `wts links`; more than one match is an error naming them. `--at` uses `links.parse_time`. `--next-flagged` picks the oldest episode with `flags != '[]'` and `reviewed_at` null, and says "no flagged episodes left to review" when there is none. Exactly one of `EPISODE`, `--next-flagged` (and, from Task 7, `--report`) is required. An episode with no transcript is an error naming its status.
  - It prints the URL, opens it with `webbrowser.open` unless `--no-open`, and serves until Ctrl-C, then prints nothing more and exits 0.
  - `next_flagged(conn) -> sqlite3.Row | None` in `review/data.py`.
  - `POST /api/reviewed` with `{episode_id, reviewed: bool}` → sets `reviewed_at` to now, or null; answers `{reviewed_at}`.

**Tests** (click's `CliRunner`, with `serve` and `webbrowser.open` replaced so nothing blocks or opens): the URL carries the episode and `at` in milliseconds; `--next-flagged` skips a reviewed episode; the errors above; `POST /api/reviewed` sets and clears the column. `test_state.py` or `test_schema_contract.py` may count migrations: update what they expect.

- [ ] Write the tests, see them fail, implement, see them pass.
- [ ] **Commit:** `wts review: open an episode, --at, --next-flagged`

## Part B — The page

### Task 5: Player, transcript and keyboard

**Files:**
- Modify: `pipeline/src/wts/review/static/index.html`, `review.css`, `review.js`

**Interfaces** (spec §3.7; what Task 8's browser test will check):
- **Header:** the episode's number, title and date; its guard flags, if any; a **Reviewed** toggle (`aria-pressed`) wired to `/api/reviewed`.
- **Player:** one `<audio controls preload="metadata">` at `/audio/<id>?t=<token>`, fixed at the top; a speed control (0.75, 1, 1.25, 1.5, 1.75, 2) setting `playbackRate`; with `has_audio` false, the line "Audio not found (is the audio folder mounted?)" in its place.
- **Transcript:** one `<p>` per sentence group between chunk starts, each word a `<span data-i="<index>">`. A chunk start shows its time in the margin (`m:ss`). Words with `prob < 0.5` have the class `low` (tinted, and underlined so the cue is not colour alone). A chunk with `is_boilerplate` has the class `boilerplate`.
- **In step:** on `timeupdate`, and on an animation frame while playing, the current word (binary search on start times) gets the class `now` and is scrolled into view when it leaves the middle of the screen, unless the reader scrolled by hand in the last 5 s. Clicking a word seeks to its start and plays.
- **Opening at a time:** `?at=<ms>` seeks there, scrolls to the word and does not play (browsers block unprompted playback).
- **Worst stretches:** a short list of the payload's `worst` (time and share); clicking one seeks there.
- **Keyboard** (ignored while typing in a field or with a dialog open): Space play or pause; ← and → back or forward 5 s; `[` and `]` the previous or next chunk start; `n` the next low-confidence word after the current time; `e` edit the selection.
- **Edit** (`e`, or an **Edit** button that appears with a selection inside the transcript): a `<dialog>` with **Wrong text** (the selected words, punctuation at the ends removed), **Right text**, **Everywhere** or **This episode only**, and **Preview**. The preview lists every changed sentence (stem, time, before, after, the changed words marked) and the count. **Save** is enabled only when the fields are what was previewed. After a save the page reloads the payload it was given, keeps its place, and says "Saved to corrections.yaml. Other episodes change on the next `wts chunk`." A 409 says the transcripts changed and asks for a new preview; "exists" says the rule is already there.
- Everything from the server goes into the page with `textContent`. Light and dark follow the system. No framework, no build.

There are no unit tests for the page; Task 8 tests it in a browser. Until then, check by hand: `uv run wts review <a seed episode> --at 5:00`.

- [ ] Build the page to the list above.
- [ ] **Commit:** `review: the page (player, transcript in step, keys, corrections)`

## Part C — Reports

### Task 6: `wts reports`

**Files:**
- Create: `pipeline/src/wts/reports.py`, `pipeline/tests/test_reports.py`
- Modify: `pipeline/src/wts/cli.py`

**Interfaces:**
- Produces, in `reports.py`:
  - `Report` (frozen dataclass): `id, created_at, status, chunk_id, quoted_text, suggested_text, note, episode_number, episode_title, start_ms`; `is_feedback` is `chunk_id is None`.
  - `list_reports(d1, status="open", limit=200) -> list[Report]`: one statement, `reports` left-joined to `chunks` and `episodes`, ordered by `id`; `status=None` lists all.
  - `get_report(d1, report_id) -> Report | None`.
  - `set_status(d1, report_id, status) -> bool`: `update reports set status = ? where id = ?` with `returning id`; `status` must be `resolved`, `rejected` or `open`; False when there is no such report.
  - `format_reports(reports, color) -> str`: transcript reports first, then feedback under its own heading. A report shows `#id`, the date, the episode and time (`ep 71 at 12:34`), the quoted text, `→` the suggestion if any, the note if any, and the command to open it (`wts review --report <id>`). A report whose chunk is gone says "passage no longer in the index".
  - `open_d1(cfg, env, store, client) -> D1`: the config and token checks `wts publish` does, shared.
- Produces, in `cli.py`: `wts reports [--env E] [--all] [--json]`, `wts reports resolve <id>…`, `wts reports reject <id>…`, `wts reports reopen <id>…` (a group with `invoke_without_command`). The environment defaults to `run_env`. Control characters in listener text are stripped before printing (a report must not be able to move the terminal's cursor).

**Tests** (`respx` on the D1 query URL, as `tests/test_cloudflare.py` does): the listing's SQL and parameters; open only by default, all with `--all`; feedback listed apart; a gone chunk; `resolve 3 4` sends two updates and says which ids were not found; `--json` is valid JSON with every field; an escape sequence in a note is removed; a missing token or `[env.*]` table is the usual error.

- [ ] Write the tests, see them fail, implement, see them pass.
- [ ] **Commit:** `wts reports: list, resolve, reject, reopen`

### Task 7: Opening a report in the review page

**Files:**
- Modify: `pipeline/src/wts/cli.py`, `pipeline/src/wts/review/server.py`, `pipeline/src/wts/review/static/review.js`, `index.html`, `review.css`, tests of Tasks 2 and 4

**Interfaces:**
- `wts review --report <id> [--env E]`: reads the report from D1, finds its chunk in `state.db` (`chunk_position`), and opens that episode at the chunk's start with `&report=<id>`. Feedback (no chunk) and a chunk the Mac no longer has are errors that say so and print the report.
- `ReviewApp` gets an optional `d1`; `GET /api/report?id=<n>` → the report's fields; `POST /api/report` with `{id, status}` → `set_status`. Without `d1` both answer 503 `{error: "no_environment"}`.
- The page, with `report` in its URL, shows a panel above the transcript: the quoted text, the suggestion and the note, and **Resolve** and **Reject** buttons. The quoted words are marked in the transcript when they are found in the chunk's words. **Edit from this report** opens the edit dialog with the quoted and suggested text filled in.

**Tests:** the CLI opens the right episode and time for a report (D1 mocked); the two errors; the endpoints (found, unknown id 404, no `d1` 503, a status outside the three 400).

- [ ] Write the tests, see them fail, implement, see them pass.
- [ ] **Commit:** `review: open a listener's report and close it`

### Task 8: One browser test

**Files:**
- Create: `web/e2e/review.spec.ts`, `web/e2e/review-home.py`
- Modify: `web/playwright.config.ts`, `web/package.json` (script `e2e:review`), `CLAUDE.md` (the command)

**Interfaces:**
- `review-home.py <dir>` builds a `WTS_HOME`: one episode in `state.db`, a transcript of about 40 words in three sentences with one low-confidence word, chunked with the real `chunk_episode`, and a 5-second silent WAV written with the standard library's `wave` module as its audio. It also writes a `corrections.yaml` copy into `<dir>` so the test never touches the repo's.
- `wts review` gains the environment variable `WTS_CORRECTIONS_FILE` (read in `corrections.py`, where `CORRECTIONS_FILE` is defined) for that.
- `playwright.config.ts`: with `E2E_REVIEW=1`, a project `review` (`testMatch: review.spec.ts`; the other projects ignore that file) whose web server is `uv run --project ../pipeline wts review ep:1 --no-open --port 8797` with `WTS_HOME` and `WTS_CORRECTIONS_FILE` set and a fixed token from `WTS_REVIEW_TOKEN` (read by the CLI, for tests only).
- The test (spec §3.7): load the episode; click a word and check `audio.currentTime` is its start; press `n` and check the current word is the low-confidence one; select a word, make a correction, preview it, save it, and check the copied `corrections.yaml` holds the rule and the page shows the new word. It fails on any console error or CSP violation, as `web/e2e` tests do.

- [ ] Write the test and the home builder, run `npm run e2e:review`. If this session cannot reach the local server (as with `wrangler dev`), say so and leave the run to the maintainer, like `e2e:smoke`.
- [ ] **Commit:** `review: browser test (seek, next low-confidence word, a correction)`

## Part D — The digest and the docs

### Task 9: The reports digest

**Files:**
- Modify: `pipeline/src/wts/reports.py`, `pipeline/src/wts/notify.py`, `pipeline/src/wts/steps.py`, `pipeline/tests/test_reports.py`, `pipeline/tests/test_notify.py`, `pipeline/tests/test_run.py`

**Interfaces:**
- `reports.new_since(d1, after_id) -> list[Report]`: open reports with `id > after_id`, oldest first, limit 50.
- `notify.notify_reports(notifier, conn, reports, *, now=None) -> bool`: nothing when the list is empty or a digest went out less than 20 hours ago (`kv` key `notify.reports_digest_at`). Otherwise one message, title `wts: 3 new reports`, body the first three as `ep 71 at 12:34: "<quoted text, 80 characters>"` or `feedback: "<note, 80 characters>"`, then `…and 2 more` and `wts reports` as the last line. On success it stores the time and the highest id (`notify.reports_last_id`).
- `steps.run_all`: after `notify_run`, when there is an `env`, fetch `new_since` and call `notify_reports`. A `CloudflareError` there is logged as a warning and never fails the run.

**Tests:** no message for no reports; one message for five with "…and 2 more"; none again within 20 hours, and the same reports are sent after it; the last id moves only when the message was sent; long text is cut; `run_all` survives D1 being down.

- [ ] Write the tests, see them fail, implement, see them pass.
- [ ] **Commit:** `wts run: a daily digest of new reports`

### Task 10: Docs

**Files:**
- Modify: `pipeline/README.md`, `CLAUDE.md`, the spec (§3.7, §3.2, §8.2), `.claude/skills/corrections/SKILL.md`, `docs/HANDOFF.md`

- [ ] `pipeline/README.md`: `wts review` and `wts reports`, with the keys.
- [ ] Spec §3.7: mark what was built and what was left out and why (decisions 1 to 5); §3.2's `wts reports` row gets its subcommands; §8.2's digest line gets the once-a-day rule.
- [ ] The corrections skill: step 1 may use `wts review <ep> --at <time>` to hear the passage; the script commands stay.
- [ ] `docs/HANDOFF.md`: what was built, the test counts, and Checkpoint J as next.
- [ ] **Commit:** `docs: the review tool and wts reports`

**Then Checkpoint J** (the maintainer, on the Mac).
