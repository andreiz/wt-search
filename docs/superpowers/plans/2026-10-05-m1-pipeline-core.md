# M1 Plan 1 — Pipeline Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `wts` Python CLI that turns the Wood Talk RSS feed into a local, searchable-ready corpus: episodes downloaded, transcribed with word timings, cleaned, chunked (with boilerplate flagged) and embedded, all on the Mac.

**Architecture:** One Python package, `pipeline/src/wts`. The state lives in a SQLite file. Each episode's `status` column is its work queue, and every step is a batch command that moves episodes forward through one guarded transition function. Steps run in this order:

1. Transcribe stores Whisper's raw output.
2. The deterministic clean-up passes, in order: guards → corrections → sentences → boilerplate → chunks.
3. All clean-up runs inside `wts chunk`, so it can be re-tuned without re-transcribing.

The ML backends (MLX Whisper, sentence-transformers) sit behind small protocols, so every test runs on Linux with fakes.

**Tech Stack:** Python 3.12, uv, click, platformdirs, httpx, feedparser, datasketch, num2words, PyYAML, numpy, pytest, respx, ruff. Mac-only extras: `mlx-whisper`, `sentence-transformers`. External tool: `ffprobe` (ffmpeg).

**Spec:** `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` (§3.0–§3.5, §8.1, §11). This is **plan 1 of 5 for milestone M1**. Later plans:

- **Plan 2:** D1 schema, Worker API, `wts publish`, platform ID matching, Keychain secrets, ntfy, backups, `wts logs`.
- **Plan 3:** Frontend.
- **Plan 4:** Review tool.
- **Plan 5:** Test search set and smoke search.

## Global Constraints

- Python `>=3.12`. The package lives in `pipeline/` and runs with `uv run wts …`.
- `mlx-whisper` and `sentence-transformers` are imported lazily, inside the backend classes only, and listed under the optional extra `mac`. The test suite must pass on Linux without them.
- File locations come from `platformdirs` (app name `wts`, no app author):
  - Config, state and data: `user_data_dir` (`~/Library/Application Support/wts/`).
  - Logs: `user_log_dir` (`~/Library/Logs/wts/`).
  - Nothing is ever written directly to `$HOME`.
- `WTS_HOME=<root>` overrides everything with this layout: `<root>/config.toml`, `<root>/state.db`, `<root>/data/`, `<root>/audio/`, `<root>/logs/`.
- Status flow: `new → downloaded → transcribed → chunked → embedded → published`, plus `error`. Retries are capped at **3**.
- Concurrency: downloads run **4** at a time; transcription runs one at a time.
- `audio_dir` must be reachable and writable, with at least **2 GB** free, before `download` or `transcribe`. If it isn't, raise `StorageUnavailable`, exit with code **3**, and change no episode's status.
- Downloads go to `<audio_dir>/.partial/<stem><ext>` and are renamed into place only after `ffprobe` succeeds. The probed length must be within **2%** of `duration_s` when the feed gives a duration.
- Stem format: `YYYY-MM-DD_epNNN_<slug>`. `epNNN` is zero-padded to 3 digits and omitted when the episode has no number. It's generated once and stored; never re-derived.
- Transcription model: `mlx-community/whisper-large-v3-turbo`, with word timestamps. The initial prompt is built from `pipeline/vocab.txt`.
- Clean-up guards:
  - Drop a segment when `no_speech_prob > 0.6` and `avg_logprob < -1.0`.
  - Drop a segment where the same n-gram (n = 1–8 words) repeats **4 or more** times in a row.
  - Flag the episode `wpm_low` below 80 words per minute and `wpm_high` above 260.
  - Flag `bad_word_times` when word starts go backwards or exceed the duration by more than 1 s, and fall back to spreading the words evenly across their segment.
- Chunks: about **30 000 ms** target, **45 000 ms** maximum. Cut on sentence boundaries; each chunk after the first starts with the previous chunk's last sentence.
- `word_times`: comma-separated integer millisecond deltas. The first is relative to the chunk's `start_ms`, each later one to the previous word's start. There is exactly one entry per space-separated token of `text`.
- Boilerplate:
  - Only sentences of **6 or more** normalized words are considered.
  - Fingerprint with MinHash (**128** permutations) over **5-word** shingles, using LSH with 16 bands × 8 rows.
  - Verify candidates with exact shingle Jaccard **≥ 0.8**.
  - A sentence is boilerplate if it appears in **5 or more** distinct episodes, counting its own.
  - A chunk is boilerplate if at least **60%** of its words are in boilerplate sentences.
- Embeddings:
  - Model `BAAI/bge-base-en-v1.5`, **768** dimensions, normalized (unit length).
  - Passages get **no** instruction prefix.
  - Boilerplate chunks are not embedded.
- Every commit message ends with the repo's attribution lines, if the session provides them.

## Review Focus

1. **Tracking parameters in enclosure URLs.** The feed can return a different query string for the same episode on every fetch. That must **not** reset the episode to `new`. Compare audio URLs with the query string and fragment removed (Task 4).
2. **Messy titles and numbers.** Non-ASCII or punctuation-heavy titles (`Ep. 312 – Café Talk: "Dovetails?"`), missing episode numbers, and two episodes on the same day with the same slug must still produce unique, ASCII-only stems (Task 4).
3. **The NAS going away mid-step.** If the share disappears during a download, the partial file stays in `.partial/`. The episode stays `new` with no retry used, and the next run resumes the download (Task 6).
4. **Interrupted transcription** (Ctrl-C, crash). No transcript file should ever exist that looks complete but isn't. Transcripts are written to a temporary file and renamed into place, and the episode stays `downloaded` (Task 7).
5. **Long passages without sentence punctuation.** Whisper sometimes produces minutes of text with no sentence-ending punctuation. That must still yield chunks of at most 45 s, split at word boundaries (Task 10).

---

## File Structure

```
pipeline/
  pyproject.toml
  vocab.txt                     # seed woodworking vocabulary, one term per line
  corrections.yaml              # whole-word fixes (starts nearly empty)
  src/wts/
    __init__.py                 # __version__
    cli.py                      # click group + subcommands (thin; calls steps.*)
    paths.py                    # Paths dataclass, resolve_paths()
    config.py                   # Config dataclass, load_config()
    db.py                       # connect(), migrations
    migrations/001_init.sql
    state.py                    # Status, TRANSITIONS, advance/fail/reset, episodes_for_step
    log.py                      # JSON-lines logging, run records
    feed.py                     # parse_feed(), upsert_episodes()
    stems.py                    # make_stem(), slugify()
    selection.py                # parse/resolve selectors, seed selection, scope
    storage.py                  # check_audio_dir(), StorageUnavailable
    download.py                 # download_episode(), probe_duration_s()
    transcribe.py               # Transcriber protocol, MlxWhisperTranscriber, transcribe_episode()
    words.py                    # Word, Sentence dataclasses; split_sentences(); normalize_text()
    guards.py                   # clean_transcript()
    corrections.py              # load_corrections(), apply_corrections()
    chunker.py                  # build_chunks(), encode/decode_word_times()
    boilerplate.py              # BoilerplateIndex
    chunking.py                 # chunk_episode(), refresh_chunks()  (orchestrates guards→chunks)
    embed.py                    # Embedder protocol, SentenceTransformerEmbedder, embed_episode()
    steps.py                    # run_feed/run_download/run_transcribe/run_chunk/run_embed/run_all
    status.py                   # status_report()
  tests/
    conftest.py                 # wts_home fixture, conn fixture, fakes
    fixtures/feed.xml           # 8-item sample RSS
    test_*.py                   # one per module
```

---

### Task 1: Scaffold, paths and config

**Files:**
- Create: `pipeline/pyproject.toml`, `pipeline/src/wts/__init__.py`, `pipeline/src/wts/cli.py`, `pipeline/src/wts/paths.py`, `pipeline/src/wts/config.py`, `pipeline/tests/conftest.py`, `pipeline/tests/test_paths.py`, `pipeline/tests/test_config.py`
- Modify: `.gitignore` (create at repo root: `pipeline/.venv/`, `__pycache__/`, `.pytest_cache/`, `.ruff_cache/`)

**Interfaces:**
- Produces:
  - `Paths(home_override: bool, app_dir, config_file, state_db, data_dir, transcripts_dir, embeddings_dir, audio_dir, log_dir)`, all `pathlib.Path`.
  - `resolve_paths(cfg: Config | None = None, env: Mapping[str, str] = os.environ) -> Paths`.
  - `Config(feed_url: str | None, audio_dir: Path | None, min_free_gb: float = 2.0)`.
  - `load_config(path: Path) -> Config`. A missing file gives defaults.
  - CLI group `wts` with `--version` and `paths`.
  - Pytest fixture `wts_home(tmp_path, monkeypatch) -> Path`, which sets `WTS_HOME`.

- [ ] **Step 1: Create `pyproject.toml`**
  - Package `wts`, `requires-python = ">=3.12"`, src layout, script `wts = "wts.cli:main"`.
  - Dependencies: `click`, `platformdirs`, `httpx`, `feedparser`, `datasketch`, `num2words`, `pyyaml`, `numpy`.
  - Optional `mac = ["mlx-whisper", "sentence-transformers"]`.
  - Dev group: `pytest`, `respx`, `ruff`.
  - `[tool.ruff]` with `line-length = 100`.

- [ ] **Step 2: Write failing tests**

```python
# tests/test_paths.py
def test_wts_home_overrides_everything(wts_home):
    p = resolve_paths()
    assert p.app_dir == wts_home
    assert p.config_file == wts_home / "config.toml"
    assert p.state_db == wts_home / "state.db"
    assert p.transcripts_dir == wts_home / "data" / "transcripts"
    assert p.embeddings_dir == wts_home / "data" / "embeddings"
    assert p.audio_dir == wts_home / "audio"
    assert p.log_dir == wts_home / "logs"

def test_config_audio_dir_wins(wts_home, tmp_path):
    nas = tmp_path / "nas"
    p = resolve_paths(Config(feed_url=None, audio_dir=nas))
    assert p.audio_dir == nas

def test_platform_defaults_without_override(monkeypatch):
    monkeypatch.delenv("WTS_HOME", raising=False)
    p = resolve_paths(env={})
    assert p.app_dir.name == "wts" and p.log_dir.name == "wts"
    assert p.app_dir != Path.home()

# tests/test_config.py
def test_load_config(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text('feed_url = "https://example.com/feed"\naudio_dir = "/Volumes/media/wts/audio"\n')
    c = load_config(f)
    assert c.feed_url == "https://example.com/feed"
    assert c.audio_dir == Path("/Volumes/media/wts/audio")
    assert c.min_free_gb == 2.0

def test_missing_config_gives_defaults(tmp_path):
    assert load_config(tmp_path / "nope.toml") == Config(feed_url=None, audio_dir=None)

# tests/test_cli.py
def test_paths_command_prints_locations(wts_home):
    out = CliRunner().invoke(main, ["paths"]).output
    assert str(wts_home / "state.db") in out
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd pipeline && uv run pytest -q`
Expected: FAIL / ImportError

- [ ] **Step 4: Implement `paths.py`, `config.py`, `cli.py`** (`main` = click group; `paths` prints `name: path` per line) **and the `wts_home` fixture**

Use `platformdirs.user_data_dir("wts", appauthor=False)` and `user_log_dir("wts", appauthor=False)`. Parse config with `tomllib`.

- [ ] **Step 5: Run tests and lint**

Run: `cd pipeline && uv run pytest -q && uv run ruff check .`
Expected: all pass, no lint errors

- [ ] **Step 6: Commit**

```bash
git add .gitignore pipeline && git commit -m "pipeline: scaffold wts CLI with paths and config"
```

---

### Task 2: State database and episode state machine

**Files:**
- Create: `pipeline/src/wts/db.py`, `pipeline/src/wts/migrations/001_init.sql`, `pipeline/src/wts/state.py`, `pipeline/tests/test_state.py`

**Interfaces:**
- Consumes: `Paths.state_db`.
- Produces:
  - `connect(path: Path) -> sqlite3.Connection`. Uses `row_factory = sqlite3.Row`, WAL mode and foreign keys on, and applies migrations by `PRAGMA user_version`.
  - Table `episodes(id INTEGER PK, guid TEXT UNIQUE NOT NULL, number INTEGER, title TEXT NOT NULL, published_at TEXT NOT NULL, duration_s INTEGER, audio_url TEXT NOT NULL, page_url TEXT, stem TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'new', error_step TEXT, error_reason TEXT, retries INTEGER NOT NULL DEFAULT 0, in_scope INTEGER NOT NULL DEFAULT 0, flags TEXT NOT NULL DEFAULT '[]', audio_path TEXT, transcript_path TEXT, updated_at TEXT NOT NULL)`.
  - Table `chunks(id INTEGER PK, episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE, seq INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL, word_times TEXT NOT NULL, is_boilerplate INTEGER NOT NULL DEFAULT 0, UNIQUE(episode_id, seq))`.
  - Table `bp_sentences(id INTEGER PK, episode_id INTEGER NOT NULL, norm_text TEXT NOT NULL)`.
  - Table `bp_bands(band_key INTEGER NOT NULL, sentence_id INTEGER NOT NULL)`, with an index on `band_key`.
  - Table `runs(id TEXT PK, command TEXT, machine TEXT, started_at TEXT, finished_at TEXT, counts TEXT, errors INTEGER)`.
  - Table `kv(key TEXT PK, value TEXT)`, plus `kv_get(conn, key) -> str | None` and `kv_set(conn, key, value) -> None` in `db.py`.
  - `class Status(StrEnum)` with values `NEW, DOWNLOADED, TRANSCRIBED, CHUNKED, EMBEDDED, PUBLISHED, ERROR`.
  - `STEP_INPUT: dict[str, Status]` = `{"download": NEW, "transcribe": DOWNLOADED, "chunk": TRANSCRIBED, "embed": CHUNKED, "publish": EMBEDDED}`.
  - `advance(conn, episode_id: int, step: str) -> None`: moves to the step's output status, clears the error fields and sets `retries = 0`.
  - `fail(conn, episode_id: int, step: str, reason: str) -> None`: sets `status = error`, `error_step`, `error_reason`, and `retries += 1`.
  - `reset(conn, episode_id: int, to: Status) -> None`: only `NEW` or `TRANSCRIBED` are allowed, otherwise `ValueError`. Sets `retries = 0`.
  - `episodes_for_step(conn, step: str, ids: Collection[int]) -> list[sqlite3.Row]`: episodes in `ids` that are in the step's input status, or in `error` with `error_step == step` and `retries < 3`, ordered by `published_at`.
  - `InvalidTransition(Exception)`.

- [ ] **Step 1: Write failing tests**

```python
def test_happy_path_advances(conn, make_episode):
    e = make_episode()
    for step, expected in [("download", "downloaded"), ("transcribe", "transcribed"),
                           ("chunk", "chunked"), ("embed", "embedded"), ("publish", "published")]:
        advance(conn, e, step)
        assert status_of(conn, e) == expected

def test_cannot_skip_a_step(conn, make_episode):
    e = make_episode()
    with pytest.raises(InvalidTransition):
        advance(conn, e, "chunk")

def test_failure_is_retried_three_times_then_parked(conn, make_episode):
    e = make_episode()
    for n in range(3):
        assert [r["id"] for r in episodes_for_step(conn, "download", [e])] == [e]
        fail(conn, e, "download", "boom")
    assert episodes_for_step(conn, "download", [e]) == []
    row = conn.execute("select * from episodes where id=?", (e,)).fetchone()
    assert (row["status"], row["retries"], row["error_reason"]) == ("error", 3, "boom")

def test_error_retry_advances_and_clears(conn, make_episode):
    e = make_episode(); fail(conn, e, "download", "boom"); advance(conn, e, "download")
    row = conn.execute("select * from episodes where id=?", (e,)).fetchone()
    assert (row["status"], row["retries"], row["error_step"]) == ("downloaded", 0, None)

def test_error_from_other_step_not_selected(conn, make_episode):
    e = make_episode(); fail(conn, e, "transcribe", "x")
    assert episodes_for_step(conn, "download", [e]) == []

def test_reset_only_to_new_or_transcribed(conn, make_episode):
    e = make_episode()
    with pytest.raises(ValueError):
        reset(conn, e, Status.CHUNKED)
```

`conftest.py` adds:
- The `conn` fixture: `connect(tmp_path / "state.db")`.
- The `make_episode(**overrides) -> int` fixture: inserts a row with unique guid and stem defaults.
- The `make_episodes(n, start=date(2007, 4, 1)) -> list[int]` fixture: `n` episodes published one week apart, oldest first.
- Query helpers that later tasks reuse: `status_of`, `retries_of`, `reason_of`, `stem_of`, `url_of`, `force_status`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd pipeline && uv run pytest tests/test_state.py -q`
Expected: FAIL / ImportError

- [ ] **Step 3: Implement `db.py`, `001_init.sql` and `state.py`**

The allowed forward moves are a module-level table: for each step, `{input statuses} → output status`, where the input statuses are `STEP_INPUT[step]` plus `ERROR` when `error_step` matches. `advance` checks the table inside the same transaction as the update and stamps `updated_at` in UTC ISO-8601.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd pipeline && uv run pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline && git commit -m "pipeline: state db with guarded episode state machine"
```

---

### Task 3: Logging, run records and `wts status`

**Files:**
- Create: `pipeline/src/wts/log.py`, `pipeline/src/wts/status.py`, `pipeline/tests/test_log.py`, `pipeline/tests/test_status.py`
- Modify: `pipeline/src/wts/cli.py` (add `status`)

**Interfaces:**
- Consumes: `Paths.log_dir`, `connect`.
- Produces:
  - `setup_logging(log_dir: Path, run_id: str, *, console: bool = True) -> logging.Logger` (logger name `wts`).
    - Writes JSON lines to `log_dir / f"wts-{date.today():%Y-%m-%d}.log"` with the keys `ts, run_id, episode, step, duration_ms, level, msg, error`. Missing ones are `null`.
    - Deletes `wts-*.log` files older than 30 days.
  - `run_record(conn, command: str) -> ContextManager[RunRecord]`. `RunRecord` has `id: str` and `counts: collections.Counter`. It inserts into `runs` on enter, and on exit writes `finished_at`, `counts`, and `errors = counts["error"]`.
  - `status_report(conn) -> str`: counts per status, every `error` row (`stem | step | retries | reason`), and the last 10 runs.

- [ ] **Step 1: Write failing tests**

```python
def test_log_line_is_json_with_fixed_keys(tmp_path):
    log = setup_logging(tmp_path, "run-1", console=False)
    log.info("downloaded", extra={"episode": "2017-03-14_ep312_x", "step": "download", "duration_ms": 12})
    line = json.loads(next(tmp_path.glob("wts-*.log")).read_text().splitlines()[-1])
    assert set(line) == {"ts", "run_id", "episode", "step", "duration_ms", "level", "msg", "error"}
    assert (line["run_id"], line["step"], line["level"]) == ("run-1", "download", "INFO")

def test_old_logs_are_pruned(tmp_path):
    old = tmp_path / "wts-2000-01-01.log"; old.write_text("{}\n")
    os.utime(old, (0, 0))
    setup_logging(tmp_path, "r", console=False)
    assert not old.exists()

def test_status_report_lists_errors_and_runs(conn, make_episode):
    e = make_episode(stem="2020-01-01_ep001_a"); fail(conn, e, "download", "404")
    with run_record(conn, "download") as r: r.counts["error"] += 1
    out = status_report(conn)
    assert "error: 1" in out and "2020-01-01_ep001_a | download | 1 | 404" in out and "download" in out
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_log.py tests/test_status.py -q`. Expected: FAIL.

- [ ] **Step 3: Implement `log.py` (a `logging.Formatter` subclass producing the JSON), `status.py`, and the `wts status` command**

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "pipeline: JSON-lines logging, run records, wts status"`

---

### Task 4: Feed parsing, stems and `wts feed`

**Files:**
- Create: `pipeline/src/wts/stems.py`, `pipeline/src/wts/feed.py`, `pipeline/tests/fixtures/feed.xml`, `pipeline/tests/test_stems.py`, `pipeline/tests/test_feed.py`
- Modify: `pipeline/src/wts/cli.py` (add `feed`)

**Interfaces:**
- Consumes: `connect`, `reset`, `Config.feed_url`.
- Produces:
  - `slugify(title: str, max_len: int = 60) -> str`: ASCII-folded with `unicodedata` NFKD, lowercase, runs of non-alphanumerics become `-`, trimmed at a word boundary.
  - `make_stem(published_at: date, number: int | None, title: str, taken: Callable[[str], bool]) -> str`: if the stem is taken, append `-2`, `-3` and so on.
  - `FeedItem(guid, number, title, published_at: datetime (UTC), duration_s: int | None, audio_url, page_url)`.
  - `parse_feed(xml: bytes) -> list[FeedItem]`:
    - `number` comes from `itunes:episode`, else from a leading `(?:Ep\.?|Episode|#)\s*(\d+)` in the title, else `None`.
    - `duration_s` parses `HH:MM:SS`, `MM:SS` or plain seconds.
  - `normalize_audio_url(url: str) -> str`: the URL without query string and fragment.
  - `upsert_episodes(conn, items) -> FeedResult(added: int, updated: int, reset: int)`:
    - New guid: insert with a fresh stem, status `new`.
    - Known guid: update title, number, page and duration. If `normalize_audio_url` changed, store the new URL and `reset(..., NEW)`; otherwise store the latest URL without resetting.
    - Stems are never regenerated.
- CLI `wts feed`: fetches `Config.feed_url` with httpx (30 s timeout, follows redirects) and prints `FeedResult`. Exits with code 2 and a clear message if `feed_url` is unset.

- [ ] **Step 1: Create `fixtures/feed.xml`.** Eight items covering:
  - A normal numbered episode.
  - `itunes:episode` missing but `Ep. 312 –` in the title.
  - A bonus episode with no number.
  - A non-ASCII title, `Café Talk: "Dovetails?"`.
  - Two items on the same day whose titles slug identically.
  - Durations in `HH:MM:SS`, `MM:SS` and plain seconds.
  - An enclosure URL with a `?tracking=abc` query.

- [ ] **Step 2: Write failing tests**

```python
def test_stem_format():
    assert make_stem(date(2017, 3, 14), 312, "Dado Stacks & Shop Safety!", lambda s: False) \
        == "2017-03-14_ep312_dado-stacks-shop-safety"
    assert make_stem(date(2020, 1, 2), 7, "x", lambda s: False) == "2020-01-02_ep007_x"
    assert make_stem(date(2020, 1, 2), None, "Bonus: Q&A", lambda s: False) == "2020-01-02_bonus-q-a"

def test_stem_is_ascii_and_unique():
    taken = {"2021-05-05_cafe-talk-dovetails"}
    s = make_stem(date(2021, 5, 5), None, 'Café Talk: "Dovetails?"', taken.__contains__)
    assert s == "2021-05-05_cafe-talk-dovetails-2" and s.isascii()

def test_parse_feed_fixture():
    items = parse_feed((FIXTURES / "feed.xml").read_bytes())
    assert len(items) == 8
    assert {i.number for i in items} >= {312, None}
    assert all(i.audio_url and i.guid for i in items)

def test_tracking_query_change_does_not_reset(conn):
    items = parse_feed(FEED)
    upsert_episodes(conn, items)
    advance_all_to(conn, "transcribed")          # helper in conftest
    changed = [replace(i, audio_url=i.audio_url.split("?")[0] + "?tracking=zzz") for i in items]
    r = upsert_episodes(conn, changed)
    assert r.reset == 0
    assert all(row["status"] == "transcribed" for row in conn.execute("select status from episodes"))

def test_real_audio_url_change_resets_to_new(conn):
    items = parse_feed(FEED); upsert_episodes(conn, items); advance_all_to(conn, "transcribed")
    r = upsert_episodes(conn, [replace(items[0], audio_url="https://cdn.example/new.mp3")] + items[1:])
    assert r.reset == 1

def test_stems_are_never_regenerated(conn):
    items = parse_feed(FEED); upsert_episodes(conn, items)
    before = dict(conn.execute("select guid, stem from episodes").fetchall())
    upsert_episodes(conn, [replace(i, title=i.title + " (remastered)") for i in items])
    assert dict(conn.execute("select guid, stem from episodes").fetchall()) == before
```

- [ ] **Step 3: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_stems.py tests/test_feed.py -q`. Expected: FAIL.

- [ ] **Step 4: Implement `stems.py`, `feed.py` (using `feedparser`) and `wts feed`**

- [ ] **Step 5: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -m "pipeline: RSS feed ingest with stable stems"`

---

### Task 5: Episode selection and scope

**Files:**
- Create: `pipeline/src/wts/selection.py`, `pipeline/tests/test_selection.py`
- Modify: `pipeline/src/wts/cli.py` (add `scope add <selector>`, `scope list`, and a shared `--select` option, default `scope`)

**Interfaces:**
- Consumes: `episodes` table.
- Produces:
  - `resolve_selector(conn, selector: str) -> list[int]`. Episode IDs ordered by `published_at`.
    - The selector is a comma-separated union of: `scope`, `all`, `seed`, `recent:N`, `ep:N`, `year:YYYY`, `stem:<stem>`.
    - Unknown terms raise `click.BadParameter`.
  - `seed_ids(conn, recent: int = 50, sampled: int = 20) -> list[int]`:
    - The newest `recent` episodes by `published_at`.
    - Plus `sampled` episodes from the rest (ordered oldest first), taken at indices `round(i * (n - 1) / (sampled - 1))` for `i` in `range(sampled)`, without duplicates.
    - Deterministic.
  - `add_to_scope(conn, ids) -> int` sets `in_scope = 1`.

- [ ] **Step 1: Write failing tests**

```python
def test_seed_is_50_recent_plus_20_spread(conn, make_episodes):
    ids = make_episodes(200)                       # published one week apart, oldest first
    seed = seed_ids(conn)
    assert len(seed) == 70 and len(set(seed)) == 70
    assert set(ids[-50:]) <= set(seed)
    older = sorted(set(seed) - set(ids[-50:]))
    assert older[0] == ids[0] and older[-1] == ids[149]   # spans the whole older range

def test_seed_with_small_feed_returns_all(conn, make_episodes):
    ids = make_episodes(30)
    assert sorted(seed_ids(conn)) == sorted(ids)

def test_union_and_filters(conn, make_episodes):
    ids = make_episodes(10, start=date(2014, 12, 1))
    got = resolve_selector(conn, "recent:2,year:2014")
    assert set(got) == set(ids[-2:]) | {i for i in ids if year_of(conn, i) == 2014}

def test_scope_default_empty_until_added(conn, make_episodes):
    ids = make_episodes(5)
    assert resolve_selector(conn, "scope") == []
    add_to_scope(conn, ids[:2])
    assert resolve_selector(conn, "scope") == ids[:2]

def test_unknown_selector_rejected(conn):
    with pytest.raises(click.BadParameter):
        resolve_selector(conn, "season:3")
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_selection.py -q`. Expected: FAIL.

- [ ] **Step 3: Implement `selection.py` and the CLI commands**

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "pipeline: episode selectors, seed set, scope"`

---

### Task 6: Storage check and `wts download`

**Files:**
- Create: `pipeline/src/wts/storage.py`, `pipeline/src/wts/download.py`, `pipeline/src/wts/steps.py`, `pipeline/tests/test_storage.py`, `pipeline/tests/test_download.py`
- Modify: `pipeline/src/wts/cli.py` (add `download`; map `StorageUnavailable` to exit code 3)

**Interfaces:**
- Consumes: `Paths.audio_dir`, `Config.min_free_gb`, `episodes_for_step`, `advance`, `fail`, `run_record`, `resolve_selector`.
- Produces:
  - `class StorageUnavailable(Exception)`.
  - `check_audio_dir(path: Path, min_free_gb: float) -> None`:
    - Creates the directory if its **parent** exists.
    - Raises `StorageUnavailable` if the path is missing, not writable (tested by writing and deleting `.wts-write-test`), or has less than `min_free_gb` free (`shutil.disk_usage`).
  - `probe_duration_s(path: Path) -> float`: runs `ffprobe -v error -show_entries format=duration -of csv=p=0`. Raises `ProbeError` on a non-zero exit or unparsable output.
  - `download_episode(client: httpx.Client, row, audio_dir: Path, probe=probe_duration_s) -> Path`:
    - Streams to `audio_dir/.partial/<stem><ext>`, where `<ext>` is the enclosure URL path's suffix, defaulting to `.mp3`.
    - Resumes with a `Range: bytes=<size>-` header when a partial file exists. On a `200` response to a range request, restarts from zero.
    - Probes the file. If `duration_s` is set and the probed length differs by more than 2%, raises `ProbeError`.
    - Renames the file into `audio_dir` and returns the final path.
  - `run_download(conn, paths, cfg, ids, *, client=None, probe=probe_duration_s, workers=4) -> Counter`:
    - Calls `storage.check_audio_dir` first, always through the module so tests can patch it.
    - Downloads up to 4 at a time with a `ThreadPoolExecutor`. Database writes stay on the calling thread.
    - On success: sets `audio_path` and calls `advance(…, "download")`.
    - On `ProbeError` or a 4xx/5xx `httpx.HTTPStatusError`: `fail(…, "download", reason)`.
    - On `OSError` while writing: re-checks the audio folder. If it's now unavailable, raises `StorageUnavailable` without failing the episode; otherwise it's an ordinary `fail`.

- [ ] **Step 1: Write failing tests** (HTTP mocked with `respx`; `probe` replaced with a fake unless the test says otherwise)

```python
def test_missing_mount_raises(tmp_path):
    with pytest.raises(StorageUnavailable):
        check_audio_dir(tmp_path / "Volumes" / "media" / "wts" / "audio", 2.0)

def test_low_free_space_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(shutil, "disk_usage", lambda p: shutil._ntuple_diskusage(10, 9, 1 * 2**30))
    with pytest.raises(StorageUnavailable):
        check_audio_dir(tmp_path, 2.0)

def test_storage_failure_leaves_episodes_untouched(conn, make_episode, paths, cfg):
    e = make_episode()
    with pytest.raises(StorageUnavailable):
        run_download(conn, replace(paths, audio_dir=Path("/nonexistent/x")), cfg, [e])
    assert status_of(conn, e) == "new" and retries_of(conn, e) == 0

@respx.mock
def test_download_resumes_with_range(tmp_path, episode_row):
    partial = tmp_path / ".partial" / f"{episode_row['stem']}.mp3"
    partial.parent.mkdir(); partial.write_bytes(b"abc")
    route = respx.get(episode_row["audio_url"]).mock(return_value=httpx.Response(206, content=b"def"))
    out = download_episode(httpx.Client(), episode_row, tmp_path, probe=lambda p: 60.0)
    assert route.calls[0].request.headers["Range"] == "bytes=3-"
    assert out.read_bytes() == b"abcdef" and not partial.exists()

@respx.mock
def test_duration_mismatch_fails_episode(conn, make_episode, paths, cfg):
    e = make_episode(duration_s=3600)
    respx.get(url_of(conn, e)).mock(return_value=httpx.Response(200, content=b"x"))
    run_download(conn, paths, cfg, [e], probe=lambda p: 3000.0)   # 16.7% off
    assert status_of(conn, e) == "error" and "duration" in reason_of(conn, e)

@respx.mock
def test_mount_vanishes_mid_download_keeps_partial(conn, make_episode, paths, cfg, monkeypatch):
    e = make_episode()
    respx.get(url_of(conn, e)).mock(side_effect=OSError("Host is down"))
    monkeypatch.setattr(storage, "check_audio_dir", fail_after_first_call(StorageUnavailable))
    with pytest.raises(StorageUnavailable):
        run_download(conn, paths, cfg, [e])
    assert status_of(conn, e) == "new" and retries_of(conn, e) == 0

@pytest.mark.skipif(shutil.which("ffprobe") is None, reason="needs ffprobe")
def test_probe_real_file(tmp_path):
    f = tmp_path / "tone.mp3"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=2", str(f)], check=True)
    assert abs(probe_duration_s(f) - 2.0) < 0.1
```

`fail_after_first_call(exc)` is a conftest helper. It returns a callable that does nothing on its first call and raises `exc` on every later call: the folder is there at the start, then gone.

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_storage.py tests/test_download.py -q`. Expected: FAIL.

- [ ] **Step 3: Implement `storage.py`, `download.py`, `steps.run_download` and the `wts download` command**

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "pipeline: resumable NAS-safe downloads with ffprobe check"`

---

### Task 7: Transcription backend and `wts transcribe`

**Files:**
- Create: `pipeline/vocab.txt`, `pipeline/src/wts/transcribe.py`, `pipeline/tests/test_transcribe.py`
- Modify: `pipeline/src/wts/steps.py` (`run_transcribe`), `pipeline/src/wts/cli.py` (`transcribe`), `pipeline/tests/conftest.py` (`FakeTranscriber`)

**Interfaces:**
- Consumes: `check_audio_dir`, `episodes_for_step`, `advance`, `fail`, `Paths.transcripts_dir`.
- Produces:
  - `RawWord(start: float, end: float, word: str, probability: float)`.
  - `RawSegment(start: float, end: float, text: str, no_speech_prob: float, avg_logprob: float, words: list[RawWord])`.
  - `RawTranscript(segments: list[RawSegment], model: str, model_version: str)`.
  - `class Transcriber(Protocol): def transcribe(self, audio: Path, initial_prompt: str) -> RawTranscript`.
  - `MlxWhisperTranscriber(repo: str = "mlx-community/whisper-large-v3-turbo")`: imports `mlx_whisper` inside `transcribe`, calls `mlx_whisper.transcribe(str(audio), path_or_hf_repo=repo, word_timestamps=True, initial_prompt=…)`, and records `mlx_whisper.__version__` as the version.
  - `get_transcriber() -> Transcriber`, the factory that tests monkeypatch.
  - `build_initial_prompt(vocab_file: Path) -> tuple[str, str]` returns `(prompt, sha256_hex_of_file)`:
    - The prompt is `"Wood Talk, a woodworking podcast with Marc Spagnuolo, Shannon Rogers and Matt Cremona. "` followed by a comma-joined list of vocab terms.
    - It's capped at 150 words in total. Blank lines and lines starting with `#` are ignored.
  - `transcribe_episode(row, transcriber, out_dir: Path, vocab_file: Path, tmp_dir: Path | None = None) -> Path`:
    - Copies `row["audio_path"]` into a temporary folder and transcribes the local copy.
    - Writes `out_dir/<stem>.json.tmp`, then renames it to `<stem>.json`.
    - JSON shape: `{"meta": {guid, title, number, published_at, duration_s, model, model_version, vocab_sha256, machine (platform.node()), transcribed_at (UTC ISO)}, "segments": [asdict(RawSegment)…]}`.
  - `run_transcribe(conn, paths, cfg, ids, *, transcriber=None, vocab_file=VOCAB_FILE) -> Counter`:
    - Calls `check_audio_dir` first, then processes episodes one at a time.
    - On success: sets `transcript_path` and calls `advance(…, "transcribe")`.
    - On an exception other than `KeyboardInterrupt`: `fail(…, "transcribe", repr(exc)[:500])`.
    - On `KeyboardInterrupt`: deletes the `.tmp` file and re-raises; the episode stays `downloaded`.

- [ ] **Step 1: Seed `pipeline/vocab.txt`** with about 60 lines covering:
  - Brands: SawStop, Festool, Lie-Nielsen, Veritas, Powermatic, Laguna, Rockler, Woodcraft, Kreg, Domino, Titebond, Osmo, Rubio Monocoat, Shapeoko.
  - Joinery: dovetail, mortise, tenon, dado, rabbet, bridle joint, drawbore.
  - Tools: spokeshave, jointer, planer, bandsaw, router table, card scraper.
  - Finishes: shellac, lacquer, Danish oil, boiled linseed oil.
  - Wood species: walnut, cherry, white oak, ash, maple, padauk, wenge.
  - People: Spagnuolo, Cremona, Rogers.
  - Use `#` comment headers for each group.

- [ ] **Step 2: Write failing tests**

```python
def test_prompt_is_capped_and_hashed(tmp_path):
    v = tmp_path / "vocab.txt"; v.write_text("# brands\n" + "\n".join(f"term{i}" for i in range(500)))
    prompt, sha = build_initial_prompt(v)
    assert prompt.startswith("Wood Talk, a woodworking podcast")
    assert len(prompt.split()) <= 150 and len(sha) == 64 and "#" not in prompt

def test_transcript_written_atomically_with_meta(conn, make_episode, paths, cfg, audio_file):
    e = make_episode(audio_path=str(audio_file), status="downloaded")
    run_transcribe(conn, paths, cfg, [e], transcriber=FakeTranscriber())
    data = json.loads((paths.transcripts_dir / f"{stem_of(conn, e)}.json").read_text())
    assert {"guid", "model", "model_version", "vocab_sha256", "machine", "transcribed_at"} <= set(data["meta"])
    assert data["segments"][0]["words"][0]["probability"] <= 1.0
    assert status_of(conn, e) == "transcribed"
    assert not list(paths.transcripts_dir.glob("*.tmp"))

def test_interrupt_leaves_no_transcript_and_status_unchanged(conn, make_episode, paths, cfg, audio_file):
    e = make_episode(audio_path=str(audio_file), status="downloaded")
    with pytest.raises(KeyboardInterrupt):
        run_transcribe(conn, paths, cfg, [e], transcriber=FakeTranscriber(raise_exc=KeyboardInterrupt))
    assert status_of(conn, e) == "downloaded" and not any(paths.transcripts_dir.glob("*"))

def test_backend_crash_fails_episode(conn, make_episode, paths, cfg, audio_file):
    e = make_episode(audio_path=str(audio_file), status="downloaded")
    run_transcribe(conn, paths, cfg, [e], transcriber=FakeTranscriber(raise_exc=MemoryError("oom")))
    assert status_of(conn, e) == "error" and "oom" in reason_of(conn, e)

@pytest.mark.mac
def test_mlx_backend_smoke(tmp_path):   # run manually on the Mac: uv run pytest -m mac
    ...  # 10 s of ffmpeg-generated speech-free tone → RawTranscript with model string set
```

`FakeTranscriber` returns a fixed two-segment `RawTranscript`, or raises `raise_exc`. Register the `mac` marker in `pyproject.toml` and skip it by default (`addopts = "-m 'not mac'"`).

- [ ] **Step 3: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_transcribe.py -q`. Expected: FAIL.

- [ ] **Step 4: Implement `transcribe.py`, `steps.run_transcribe` and the `wts transcribe` command**

- [ ] **Step 5: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -m "pipeline: whisper transcription step with atomic raw transcripts"`

---

### Task 8: Words, sentences and transcript guards

**Files:**
- Create: `pipeline/src/wts/words.py`, `pipeline/src/wts/guards.py`, `pipeline/tests/test_words.py`, `pipeline/tests/test_guards.py`

**Interfaces:**
- Consumes: the `RawTranscript` JSON shape (Task 7).
- Produces:
  - `Word(text: str, start_ms: int, end_ms: int, prob: float)` (frozen). `text` is stripped of surrounding whitespace and keeps its punctuation.
  - `Sentence(words: tuple[Word, ...])` with the properties `text`, `start_ms`, `end_ms` and `norm` (`normalize_text(text)`).
  - `split_sentences(words: Sequence[Word]) -> list[Sentence]`:
    - A sentence ends after a word ending in `.`, `?` or `!`.
    - Except when the word (lowercase) is in `{"mr.", "mrs.", "dr.", "st.", "vs.", "no."}`, or matches `^\d+\.$`.
  - `normalize_text(s: str) -> str`: lowercase; integers written out with `num2words`; punctuation except apostrophes inside words removed; whitespace collapsed.
  - `clean_transcript(data: dict, duration_s: int | None) -> tuple[list[Word], list[str]]`. Returns the cleaned words and the episode flags, applying in order:
    1. Drop segments with `no_speech_prob > 0.6 and avg_logprob < -1.0`.
    2. Drop segments where the same n-gram (n in 1..8) repeats 4 or more times in a row.
    3. Check timing: word starts non-decreasing, and each at most `duration_s + 1` seconds. If violated, flag `bad_word_times` and re-time every segment's words evenly across that segment's `[start, end]`.
    4. Flag words per minute: `wpm_low` below 80, `wpm_high` above 260, computed over `duration_s` (or the last word's end when `duration_s` is `None`).

- [ ] **Step 1: Write failing tests**

```python
def test_split_respects_abbreviations():
    s = split_sentences(ws("Mr. Cremona cut 2. pieces. Then what? Glue!"))
    assert [x.text for x in s] == ["Mr. Cremona cut 2. pieces.", "Then what?", "Glue!"]

def test_normalize():
    assert normalize_text("Head over to Patreon.com/WoodTalk — 25% off!") == \
        "head over to patreoncomwoodtalk twenty-five off"

def test_drops_no_speech_hallucination():
    words, _ = clean_transcript(tx(seg("Thanks for watching!", no_speech=0.9, logprob=-1.5),
                                   seg("Real talk here.", no_speech=0.1, logprob=-0.2)), 60)
    assert " ".join(w.text for w in words) == "Real talk here."

def test_keeps_confident_segment_even_if_no_speech_high():
    words, _ = clean_transcript(tx(seg("Quiet but real.", no_speech=0.9, logprob=-0.3)), 60)
    assert len(words) == 3

def test_drops_repetition_loop():
    loop = " ".join(["the glue"] * 4)
    words, _ = clean_transcript(tx(seg(loop), seg("Clamp it.")), 60)
    assert " ".join(w.text for w in words) == "Clamp it."

def test_backwards_timestamps_fall_back_to_even_spacing():
    data = tx(seg_with_word_starts("a b c d", starts=[0.0, 3.0, 1.0, 4.0], start=0.0, end=4.0))
    words, flags = clean_transcript(data, 60)
    assert "bad_word_times" in flags and [w.start_ms for w in words] == [0, 1000, 2000, 3000]

def test_wpm_flags():
    assert "wpm_low" in clean_transcript(tx(seg("one two three.")), 600)[1]
```

(`tx`, `seg` and `seg_with_word_starts` are test helpers in `conftest.py` that build the Task 7 JSON shape.)

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_words.py tests/test_guards.py -q`. Expected: FAIL.

- [ ] **Step 3: Implement `words.py` and `guards.py`**

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "pipeline: sentence splitting, normalization, transcript guards"`

---

### Task 9: Corrections

**Files:**
- Create: `pipeline/corrections.yaml`, `pipeline/src/wts/corrections.py`, `pipeline/tests/test_corrections.py`

**Interfaces:**
- Consumes: `Word`.
- Produces:
  - `CorrectionRule(match: tuple[str, ...], replace: str, episode: str | None)`. `match` is lowercased words with punctuation stripped.
  - `load_corrections(path: Path) -> list[CorrectionRule]`. The YAML schema is `{"global": {"saw stop": "SawStop", …}, "episodes": {"<stem>": {"kremona": "Cremona"}}}`. A missing file gives `[]`.
  - `apply_corrections(words: list[Word], rules: list[CorrectionRule], stem: str) -> list[Word]`:
    - Matching is greedy left to right, longest rule first, case-insensitive, and ignores each word's punctuation.
    - A multi-word match becomes **one** `Word` with the first word's `start_ms`, the last word's `end_ms`, the lowest `prob` among them, and the last word's trailing punctuation.
    - Episode rules apply only to the matching `stem` and take priority over global rules.
  - `corrections_sha(path: Path) -> str`, used by Task 12 to notice edits.

- [ ] **Step 1: Create `pipeline/corrections.yaml`** with `global: {"saw stop": "SawStop", "kremona": "Cremona", "fest tool": "Festool"}` and `episodes: {}`.

- [ ] **Step 2: Write failing tests**

```python
def test_multiword_merge_keeps_timing_and_punctuation():
    out = apply_corrections(ws_timed("I love my saw stop, really."), rules(g={"saw stop": "SawStop"}), "s")
    assert [w.text for w in out] == ["I", "love", "my", "SawStop,", "really."]
    merged = out[3]; assert (merged.start_ms, merged.end_ms) == (3000, 4999)

def test_episode_rule_only_for_that_episode():
    r = rules(e={"2017-03-14_ep312_x": {"marc": "Mark"}})
    assert apply_corrections(ws_timed("marc said"), r, "2017-03-14_ep312_x")[0].text == "Mark"
    assert apply_corrections(ws_timed("marc said"), r, "other")[0].text == "marc"

def test_case_insensitive_whole_word_only():
    out = apply_corrections(ws_timed("KREMONA kremonas"), rules(g={"kremona": "Cremona"}), "s")
    assert [w.text for w in out] == ["Cremona", "kremonas"]
```

- [ ] **Step 3: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_corrections.py -q`. Expected: FAIL.

- [ ] **Step 4: Implement `corrections.py`**

- [ ] **Step 5: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -m "pipeline: corrections.yaml word fixes"`

---

### Task 10: Chunker and word-times codec

**Files:**
- Create: `pipeline/src/wts/chunker.py`, `pipeline/tests/test_chunker.py`

**Interfaces:**
- Consumes: `Sentence`, `Word`.
- Produces:
  - `Chunk(seq: int, start_ms: int, end_ms: int, text: str, word_times: str, is_boilerplate: bool)`.
  - `encode_word_times(starts_ms: Sequence[int], chunk_start_ms: int) -> str`.
  - `decode_word_times(s: str, chunk_start_ms: int) -> list[int]`.
  - `build_chunks(sentences: Sequence[Sentence], boilerplate: Sequence[bool], target_ms: int = 30_000, max_ms: int = 45_000) -> list[Chunk]`:
    - `boilerplate[i]` says whether sentence `i` is boilerplate.
    - Fill a chunk with whole sentences until its span is at least `target_ms`, without passing `max_ms`.
    - Each later chunk starts with the previous chunk's last sentence (overlap).
    - A single sentence longer than `max_ms` is split at word boundaries into pieces of at most `max_ms`, and those pieces take part in the overlap rule like sentences.
    - `is_boilerplate` is true when at least 60% of the chunk's words come from boilerplate sentences.
    - `text` is the words joined by single spaces, and `word_times` has one entry per word.

- [ ] **Step 1: Write failing tests**

```python
def test_word_times_roundtrip():
    starts = [12_000, 12_300, 12_310, 13_000]
    enc = encode_word_times(starts, 12_000)
    assert enc == "0,300,10,690" and decode_word_times(enc, 12_000) == starts

def test_chunks_about_30s_with_one_sentence_overlap():
    sents = sentences_every(5_000, n=20)                 # 20 sentences, 5 s each
    chunks = build_chunks(sents, [False] * 20)
    assert all(30_000 <= c.end_ms - c.start_ms <= 45_000 for c in chunks[:-1])
    for a, b in zip(chunks, chunks[1:]):
        assert b.text.startswith(last_sentence_text(a))
    assert all(len(c.text.split()) == len(c.word_times.split(",")) for c in chunks)

def test_unpunctuated_monologue_is_split_under_max():
    sents = [one_sentence(duration_ms=200_000, words=500)]
    chunks = build_chunks(sents, [False])
    assert len(chunks) >= 5 and all(c.end_ms - c.start_ms <= 45_000 for c in chunks)

def test_boilerplate_threshold_60_percent():
    sents = [sent(words=6), sent(words=4)]
    assert build_chunks(sents, [True, False])[0].is_boilerplate is True     # 6/10
    assert build_chunks([sent(words=5), sent(words=5)], [True, False])[0].is_boilerplate is False
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_chunker.py -q`. Expected: FAIL.

- [ ] **Step 3: Implement `chunker.py`**

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "pipeline: sentence-aligned ~30s chunker with word-times codec"`

---

### Task 11: Boilerplate index

**Files:**
- Create: `pipeline/src/wts/boilerplate.py`, `pipeline/tests/test_boilerplate.py`

**Interfaces:**
- Consumes: the `bp_sentences` and `bp_bands` tables, and `Sentence.norm`.
- Produces:
  - `shingles(norm: str, k: int = 5) -> set[str]`.
  - `band_keys(norm: str) -> list[int]`:
    - MinHash with 128 permutations and `seed=1` over the shingles.
    - Split the hash values into 16 bands of 8.
    - Each key is `int.from_bytes(blake2b(band_index.to_bytes(1) + band_bytes, digest_size=8).digest(), "big", signed=True)`.
  - `class BoilerplateIndex(conn)`:
    - `replace_episode(episode_id: int, sentences: Sequence[Sentence]) -> None`: deletes and re-inserts that episode's rows. Only sentences with 6 or more normalized words are stored.
    - `is_boilerplate(episode_id: int, norm: str) -> bool`:
      - Candidates are other episodes' sentences that share at least one band key.
      - Keep candidates with exact Jaccard over 5-word shingles of at least 0.8.
      - True when the number of distinct candidate episodes plus 1 is at least 5.
      - Always false for sentences under 6 words.
    - `mask(episode_id: int, sentences: Sequence[Sentence]) -> list[bool]`.

- [ ] **Step 1: Write failing tests**

```python
AD = "this episode is brought to you by rockler woodworking and hardware go to rockler dot com"

def test_sentence_in_five_episodes_is_boilerplate(conn, make_episodes):
    ids = make_episodes(5)
    idx = BoilerplateIndex(conn)
    for e in ids: idx.replace_episode(e, [sentence_from(AD)])
    assert idx.is_boilerplate(ids[0], AD)

def test_four_episodes_is_not_enough(conn, make_episodes):
    ids = make_episodes(4); idx = BoilerplateIndex(conn)
    for e in ids: idx.replace_episode(e, [sentence_from(AD)])
    assert not idx.is_boilerplate(ids[0], AD)

def test_near_duplicates_with_whisper_noise_match(conn, make_episodes):
    ids = make_episodes(5); idx = BoilerplateIndex(conn)
    variants = [AD, AD.replace("rockler dot com", "rockler.com"), AD + " today",
                AD.replace("hardware", "hardwares"), AD]
    for e, v in zip(ids, variants): idx.replace_episode(e, [sentence_from(v)])
    assert idx.is_boilerplate(ids[0], normalize_text(AD))

def test_repeats_within_one_episode_do_not_count(conn, make_episodes):
    ids = make_episodes(2); idx = BoilerplateIndex(conn)
    idx.replace_episode(ids[0], [sentence_from(AD)] * 6)
    assert not idx.is_boilerplate(ids[0], AD)

def test_short_sentences_never_boilerplate(conn, make_episodes):
    ids = make_episodes(6); idx = BoilerplateIndex(conn)
    for e in ids: idx.replace_episode(e, [sentence_from("yeah totally")])
    assert not idx.is_boilerplate(ids[0], "yeah totally")
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_boilerplate.py -q`. Expected: FAIL.

- [ ] **Step 3: Implement `boilerplate.py`** using `datasketch.MinHash(num_perm=128, seed=1)`

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "pipeline: MinHash/LSH boilerplate index in state db"`

---

### Task 12: `wts chunk` orchestration and refresh

**Files:**
- Create: `pipeline/src/wts/chunking.py`, `pipeline/tests/test_chunking.py`
- Modify: `pipeline/src/wts/steps.py` (`run_chunk`), `pipeline/src/wts/cli.py` (`chunk [--force]`)

**Interfaces:**
- Consumes: `clean_transcript`, `load_corrections`, `apply_corrections`, `split_sentences`, `BoilerplateIndex`, `build_chunks`, `advance`, `fail`, `reset`.
- Produces:
  - `prepare_episode(row, corrections) -> tuple[list[Sentence], list[str]]`: load the transcript JSON → `clean_transcript` → `apply_corrections` → `split_sentences`. Returns the sentences and the flags.
  - `chunk_episode(conn, row, corrections, index: BoilerplateIndex) -> bool`:
    - Prepares the episode, calls `index.replace_episode`, `index.mask`, then `build_chunks`.
    - Compares the result with the stored chunks (`seq, start_ms, end_ms, text, word_times, is_boilerplate`).
    - Replaces the stored chunks only if they differ. Returns `True` if anything changed.
    - Saves `flags` as JSON on the episode.
  - `refresh_chunks(conn, corrections, index) -> int`:
    - Re-runs `chunk_episode` for every episode in `chunked`, `embedded` or `published`.
    - Any that changed are `reset` to `TRANSCRIBED` and then `advance`d through `"chunk"`, so they end up `chunked` and will be re-embedded.
    - Returns how many changed.
  - `run_chunk(conn, paths, cfg, ids, *, force: bool = False, corrections_file=CORRECTIONS_FILE) -> Counter`:
    1. With `force`, first `reset` the selected episodes whose status is `chunked` or later to `TRANSCRIBED`.
    2. Chunk every eligible episode from `episodes_for_step(conn, "chunk", ids)`. Failures call `fail`.
    3. If any episode was newly chunked, or `corrections_sha(corrections_file)` differs from `kv_get(conn, "corrections_sha")`, call `refresh_chunks` and then `kv_set(conn, "corrections_sha", …)`.

- [ ] **Step 1: Write failing tests** (using transcript fixtures built with the Task 8 helpers and written into `paths.transcripts_dir`)

```python
def test_chunk_step_stores_chunks_and_flags(conn, transcribed_episode, paths, cfg):
    run_chunk(conn, paths, cfg, [transcribed_episode])
    rows = conn.execute("select * from chunks where episode_id=?", (transcribed_episode,)).fetchall()
    assert rows and status_of(conn, transcribed_episode) == "chunked"
    assert all(len(r["text"].split()) == len(r["word_times"].split(",")) for r in rows)

def test_fifth_episode_with_ad_flips_earlier_episodes_back_to_chunked(conn, paths, cfg, episodes_with_ad):
    first4, fifth = episodes_with_ad[:4], episodes_with_ad[4]
    run_chunk(conn, paths, cfg, first4)
    for e in first4: force_status(conn, e, "embedded")
    run_chunk(conn, paths, cfg, [fifth])
    assert all(status_of(conn, e) == "chunked" for e in first4)
    assert boilerplate_chunk_count(conn, first4[0]) >= 1

def test_unchanged_refresh_keeps_ids_and_status(conn, paths, cfg, transcribed_episode):
    run_chunk(conn, paths, cfg, [transcribed_episode]); force_status(conn, transcribed_episode, "embedded")
    ids_before = chunk_ids(conn, transcribed_episode)
    run_chunk(conn, paths, cfg, [])                        # nothing new; refresh is a no-op
    assert chunk_ids(conn, transcribed_episode) == ids_before
    assert status_of(conn, transcribed_episode) == "embedded"

def test_force_rechunk_applies_new_correction(conn, paths, cfg, transcribed_episode, tmp_path):
    run_chunk(conn, paths, cfg, [transcribed_episode])
    cf = tmp_path / "corrections.yaml"; cf.write_text('global: {"kremona": "Cremona"}\n')
    run_chunk(conn, paths, cfg, [transcribed_episode], force=True, corrections_file=cf)
    assert "Cremona" in all_text(conn, transcribed_episode)
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_chunking.py -q`. Expected: FAIL.

- [ ] **Step 3: Implement `chunking.py`, `steps.run_chunk` and the `wts chunk` command**

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "pipeline: wts chunk with boilerplate refresh and forced re-chunk"`

---

### Task 13: Embeddings and `wts embed`

**Files:**
- Create: `pipeline/src/wts/embed.py`, `pipeline/tests/test_embed.py`
- Modify: `pipeline/src/wts/steps.py` (`run_embed`), `pipeline/src/wts/cli.py` (`embed`), `pipeline/tests/conftest.py` (`FakeEmbedder`)

**Interfaces:**
- Consumes: the `chunks` table, `advance`, `fail`, `Paths.embeddings_dir`.
- Produces:
  - `class Embedder(Protocol)`: `model: str`, `dim: int`, and `def embed(self, texts: Sequence[str]) -> np.ndarray` returning `(n, dim)` `float32` vectors of unit length.
  - `SentenceTransformerEmbedder(model="BAAI/bge-base-en-v1.5", device="mps", batch_size=64)`: imports lazily and uses `normalize_embeddings=True`. `dim = 768`.
  - `get_embedder() -> Embedder`, the factory that tests monkeypatch.
  - `embed_episode(conn, row, embedder, out_dir: Path) -> int`:
    - Covers the episode's **non-boilerplate** chunks.
    - Loads the existing `out_dir/<stem>.npz` (keys `chunk_ids` int64, `text_sha` U16, `vectors` float32), if any, and reuses a vector when its `text_sha` (first 16 hex characters of sha256 of the text) matches.
    - Embeds only the missing texts.
    - Writes `<stem>.npz.tmp` and renames it into place.
    - Returns how many were newly embedded.
  - `load_embeddings(path: Path) -> tuple[np.ndarray, np.ndarray]` returns `(chunk_ids, vectors)`; plan 2's publish uses it.
  - `run_embed(conn, paths, cfg, ids, *, embedder=None) -> Counter`: success calls `advance(…, "embed")`; failure calls `fail`.

- [ ] **Step 1: Write failing tests**

```python
def test_embeds_only_non_boilerplate(conn, chunked_episode_with_boilerplate, paths, cfg):
    run_embed(conn, paths, cfg, [chunked_episode_with_boilerplate], embedder=FakeEmbedder())
    ids, vecs = load_embeddings(paths.embeddings_dir / f"{stem_of(conn, chunked_episode_with_boilerplate)}.npz")
    assert set(ids) == non_boilerplate_chunk_ids(conn, chunked_episode_with_boilerplate)
    assert vecs.shape == (len(ids), 768) and vecs.dtype == np.float32
    assert np.allclose(np.linalg.norm(vecs, axis=1), 1.0, atol=1e-5)
    assert status_of(conn, chunked_episode_with_boilerplate) == "embedded"

def test_reembed_reuses_vectors_for_unchanged_text(conn, chunked_episode, paths, cfg):
    fake = FakeEmbedder(); run_embed(conn, paths, cfg, [chunked_episode], embedder=fake)
    n_first = fake.calls
    rechunk_with_new_ids_same_text(conn, chunked_episode)          # status back to chunked
    run_embed(conn, paths, cfg, [chunked_episode], embedder=fake)
    assert fake.calls == n_first                                    # nothing re-embedded

@pytest.mark.mac
def test_bge_dimension_and_norm():
    v = SentenceTransformerEmbedder().embed(["dovetail saw"])
    assert v.shape == (1, 768)
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_embed.py -q`. Expected: FAIL.

- [ ] **Step 3: Implement `embed.py`, `steps.run_embed` and the `wts embed` command**

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd pipeline && uv run pytest -q`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "pipeline: bge-base embeddings with per-chunk cache"`

---

### Task 14: `wts run` end to end, and the first real seed run

**Files:**
- Create: `pipeline/tests/test_run.py`, `pipeline/README.md`
- Modify: `pipeline/src/wts/steps.py` (`run_all`), `pipeline/src/wts/cli.py` (`run`), `CLAUDE.md` (add a Commands section)

**Interfaces:**
- Consumes: every `run_*` step.
- Produces:
  - `run_all(conn, paths, cfg, selector: str, *, client=None, transcriber=None, embedder=None, probe=probe_duration_s) -> dict[str, Counter]`:
    - Order: feed → resolve selector → download → transcribe → chunk → embed.
    - Each step is wrapped in `run_record`.
    - `StorageUnavailable` propagates; the CLI maps it to exit code 3. Publish is added in plan 2.
  - CLI `wts run [--select S]`.

- [ ] **Step 1: Write the failing end-to-end test**

It uses `respx` for the feed (`fixtures/feed.xml`) and for every enclosure URL, plus `FakeTranscriber` and `FakeEmbedder`. The `mocked_feed_and_audio` fixture also provides `.probe`, a fake that returns each file's feed `duration_s`.

```python
def test_run_all_takes_scoped_episodes_to_embedded(conn, paths, cfg, mocked_feed_and_audio):
    upsert_from_fixture_and_scope(conn, "recent:3")
    results = run_all(conn, paths, cfg, "scope", transcriber=FakeTranscriber(), embedder=FakeEmbedder(),
                      probe=mocked_feed_and_audio.probe)
    assert [status_of(conn, e) for e in scoped(conn)] == ["embedded"] * 3
    assert results["download"]["ok"] == 3 and conn.execute("select count(*) from runs").fetchone()[0] >= 5

def test_run_stops_cleanly_when_nas_missing(conn, paths, cfg, mocked_feed_and_audio):
    upsert_from_fixture_and_scope(conn, "recent:3")
    (paths.app_dir / "config.toml").write_text(
        'feed_url = "https://feed.example/rss"\naudio_dir = "/nonexistent/Volumes/media/wts/audio"\n')
    r = CliRunner(env={"WTS_HOME": str(paths.app_dir)}).invoke(main, ["run"])
    assert r.exit_code == 3 and "audio" in r.output.lower()
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd pipeline && uv run pytest tests/test_run.py -q`. Expected: FAIL.

- [ ] **Step 3: Implement `run_all` and `wts run`.** In `pipeline/README.md`, document setup:
  - `brew install ffmpeg`.
  - `uv sync --extra mac`.
  - Create `config.toml` with `feed_url` and `audio_dir`.
  - Add the Commands section to `CLAUDE.md`: `cd pipeline && uv run pytest -q`, `uv run ruff check .`, `uv run pytest -m mac` (Mac only).

- [ ] **Step 4: Run the full suite and lint.** Run: `cd pipeline && uv run pytest -q && uv run ruff check .`. Expected: all pass.

- [ ] **Step 5: Commit** — `git commit -m "pipeline: wts run end-to-end (feed→embed)"`

- [ ] **Step 6: Manual seed run on the M1 Max (maintainer).** This checks the real environment and is not automated.
  1. `uv sync --extra mac`, then `uv run pytest -m mac`. Expected: the 2 Mac tests pass.
  2. Write `config.toml` with the real `feed_url` (spec §10 item 5) and the NAS `audio_dir`. Then run `wts paths`. Expected: Application Support, NAS and Logs paths.
  3. Run `wts feed`, then `wts scope add seed`, then `wts scope list`. Expected: about 620 episodes found, 70 in scope.
  4. Run `wts run`, then `wts status`. Expected: 70 episodes `embedded`, or listed with errors.
  5. Spot-check 3 transcripts by eye, and note how long each episode took to transcribe in the `runs` table, to estimate the full-archive time on the Mini.
