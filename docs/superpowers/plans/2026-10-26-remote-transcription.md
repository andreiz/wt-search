# Remote Transcription on walnut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wts transcribe` sends each episode's MP3 to walnut's transcribe-web, which transcribes it with MLX Whisper and returns the same JSON `wts` makes locally; then staging grows to a quarter of the archive.

**Architecture:** media-tools `transcription/` gains a second engine (`transcribe-mlx`, selected with `transcribe -E mlx`) and two routes on its stdlib server (`POST /jobs/upload`, `GET /jobs/<id>`). `wts` gains `RemoteTranscriber` (httpx, Linux-safe) behind the existing `Transcriber` protocol, selected by `transcribe_url` in `config.toml`, plus a `spread:N` selector. homelab-ci's walnut provisioning warms the MLX model.

**Tech Stack:** Python 3.13 stdlib server + bash (media-tools), `mlx-whisper==0.4.3`, httpx 0.28, click, pytest; uv; macOS LaunchDaemon on walnut.

**Spec:** `docs/superpowers/specs/2026-10-26-remote-transcription-design.md`

## Repositories

| Repo | Path | Tasks | Test command |
|---|---|---|---|
| media-tools | `~/projects/media-tools` | 1, 2 | `cd ~/projects/media-tools/transcription && uv run --no-project --with pytest pytest -q tests` |
| wt-search | `~/projects/wt-search` | 3, 4, 5, 6, 9 | `cd pipeline && uv run pytest -q && uv run ruff check .` |
| homelab-ci | `~/projects/homelab-ci` | 7 | `bash -n` / `plutil -lint` (no test suite) |

Commit on `main` in each repo; **never push** (the maintainer pushes). media-tools and homelab-ci
are outside this session's sandbox: run their commands with the sandbox disabled.

## Global Constraints

- Model `mlx-community/whisper-large-v3-turbo`, `word_timestamps=True`, initial prompt from `wts`; `mlx-whisper` pinned to **0.4.3** on both sides.
- Result JSON fields exactly: `model`, `model_version`, `segments[]` of `start`, `end`, `text`, `no_speech_prob`, `avg_logprob`, `words[]` of `start`, `end`, `word`, `probability` (floats except text/word).
- Upload cap **100 MB** (100 × 1024 × 1024 bytes); prompt header `X-Transcribe-Prompt`, percent-encoded UTF-8, at most **4 KB** encoded.
- Engines: the fixed list `["whisper.cpp", "mlx"]`; uploads accept only `mlx`.
- Finished jobs are kept **3600 s**, then dropped. Jobs run one at a time on the existing worker.
- Client: poll every **5 s**; give up after **7200 s** from upload (unavailable, not failed).
- Unavailable (connect error, timeout, transport error, any 5xx, `404` for its own job, stall) → `TranscriberUnavailable` (a `MachineProblem`): the run stops, the episode keeps its retries. A job `status: error` → ordinary failure (`fail()`).
- The `wts` transcribe path must import and run without `mlx_whisper` installed.
- wt-search: Edit tool for changes, ruff clean, commit message trailer as in `CLAUDE.md`.

## Review Focus

1. An upload whose body ends before `Content-Length` (wick killed mid-upload) must not queue a truncated file: `400`, its directory removed. → Task 2 `test_truncated_upload_is_rejected_and_removed`.
2. The connection dropping mid-upload or mid-poll (`httpx.RemoteProtocolError`/`ReadError`, walnut restarting) is "unavailable", not an episode failure. → Task 4 `test_transport_error_is_unavailable`.
3. A `done` job whose `result` is malformed (missing `segments`, a word without `probability`) fails that episode with a clear message instead of crashing the run or writing a broken transcript. → Task 4 `test_malformed_result_is_a_job_failure`.
4. A server that omits `machine` (an older deploy) still yields a transcript whose `meta.machine` names the remote host, not wick. → Task 4 `test_machine_falls_back_to_url_host`.
5. Ctrl-C while uploading or polling leaves the episode `downloaded` with retries unchanged (the `KeyboardInterrupt` is not swallowed by the client's error handling). → Task 5 `test_ctrl_c_during_remote_transcription_keeps_episode`.

---

### Task 1: `transcribe-mlx` and `transcribe -E/-p` (media-tools)

**Files:**
- Create: `transcription/transcribe-mlx` (executable, uv inline-script Python, no extension)
- Modify: `transcription/transcribe` (options, engine dispatch), `transcription/README.md`
- Test: `transcription/tests/conftest.py`, `transcription/tests/test_transcribe_mlx.py`, `transcription/tests/test_transcribe_cli.py`

**Interfaces:**
- Produces: `transcribe-mlx -o DIR -n NAME [-p PROMPT] FILE` and `transcribe-mlx --prefetch`; writes `DIR/NAME.json|.txt|.srt`, prints `DIR/NAME.txt` on stdout, `>>` progress on stderr, exit ≠ 0 with `transcribe-mlx: error: …` on failure.
- Produces: `transcribe -E mlx [-p PROMPT] FILE-or-URL -o DIR -n NAME` → delegates to `$TRANSCRIBE_MLX_BIN` (default: sibling `transcribe-mlx`); stdout contract unchanged.
- Produces (for tests): in `transcribe-mlx`, `to_result(raw: dict, model: str, version: str) -> dict` and `srt(segments: list[dict]) -> str`, pure functions; `mlx_whisper` imported only inside `main`.

- [ ] **Step 1: Write the failing tests.** `conftest.py` loads the extension-less script as a module (`importlib.machinery.SourceFileLoader("transcribe_mlx", str(path)).load_module()` via `importlib.util`) as fixture `mlx_mod`. In `test_transcribe_mlx.py`:
  - `test_to_result_maps_fields`: a raw mlx dict `{"segments": [{"start": 0, "end": 1.5, "text": " Hi.", "no_speech_prob": 0.1, "avg_logprob": -0.2, "words": [{"start": 0, "end": 0.5, "word": " Hi.", "probability": 0.9}]}]}` → `{"model": M, "model_version": "0.4.3", "segments": [{"start": 0.0, "end": 1.5, "text": " Hi.", "no_speech_prob": 0.1, "avg_logprob": -0.2, "words": [{"start": 0.0, "end": 0.5, "word": " Hi.", "probability": 0.9}]}]}`, all numbers `float`.
  - `test_to_result_defaults_missing_probs`: a segment without `no_speech_prob`/`avg_logprob`/`words` → `0.0`, `0.0`, `[]` (as `wts`'s `MlxWhisperTranscriber` does).
  - `test_srt_numbers_and_formats_cues`: two segments → `"1\n00:00:00,000 --> 00:00:01,500\nHi.\n\n2\n…"` (text stripped).

  In `test_transcribe_cli.py` (runs the bash script with `TRANSCRIBE_MLX_BIN` = a fake that writes its argv to `$ARGS_FILE` and creates `DIR/NAME.txt`):
  - `test_mlx_engine_hands_file_and_prompt_to_transcribe_mlx`: `transcribe -E mlx -p "Wood Talk, Festool." clip.mp3 -o OUT -n out` → exit 0, argv file shows `-o OUT -n out -p Wood Talk, Festool. <abs clip.mp3>`, stdout is `OUT/out.txt`; no whisper model download attempted (`WHISPER_MODEL_DIR` points at an empty temp dir and stays empty).
  - `test_prompt_with_whisper_cpp_is_refused`: `transcribe -p x clip.mp3` → exit ≠ 0, stderr contains `-p needs -E mlx`.
  - `test_unknown_engine_is_refused`: `-E foo` → exit ≠ 0, stderr contains `unknown engine: foo`.

- [ ] **Step 2: Run them; expect failures.**
Run: `cd ~/projects/media-tools/transcription && uv run --no-project --with pytest pytest -q tests`
Expected: FAIL (`transcribe-mlx` not found; `-E`/`-p` unknown options).

- [ ] **Step 3: Write `transcribe-mlx`.** Header `#!/usr/bin/env -S uv run --script` with `# /// script` metadata `requires-python = ">=3.12"`, `dependencies = ["mlx-whisper==0.4.3"]`. `main()` parses `-o -n -p --prefetch FILE` (argparse); `--prefetch` imports `mlx_whisper` and calls `huggingface_hub.snapshot_download("mlx-community/whisper-large-v3-turbo")`, prints `>> model ready`, exits 0. Otherwise `mlx_whisper.transcribe(FILE, path_or_hf_repo=REPO, word_timestamps=True, initial_prompt=PROMPT or None)`, then writes the three files (txt = segment texts joined and stripped) via a temp name + `os.replace`, prints the txt path. `model_version` = `importlib.metadata.version("mlx-whisper")`.

- [ ] **Step 4: Change `transcribe`.** Add `-E ENGINE` (default `whisper.cpp`; anything else but `mlx` → `die "unknown engine: …"`) and `-p PROMPT` (`die "-p needs -E mlx"` unless the engine is `mlx`) to `getopts` and `usage`. Move the `whisper-cli` dependency check and the "resolve model" block inside the whisper.cpp path. With `mlx`: skip the captions fast path and the WAV conversion; after "obtain audio" (URL or local file, unchanged), run `"${TRANSCRIBE_MLX_BIN:-$HERE/transcribe-mlx}" -o "$OUTDIR" -n "$BASENAME" ${PROMPT:+-p "$PROMPT"} "$AUDIO"` and exit with its status. Not `exec`: a downloaded URL's audio lives in the work dir, which the EXIT trap removes afterwards. Resolve `HERE` as `transcribe-web` does; pass `$AUDIO` as an absolute path. README: the `-E`/`-p` rows in the options table and a short "Engines" paragraph (mlx = MLX Whisper, JSON output, pinned 0.4.3; `--prefetch`).

- [ ] **Step 5: Run the tests; expect PASS.** Same command. Also `bash -n transcribe` and, on wick, one real run: `./transcribe -E mlx -o /tmp/tm -n t <a 1-minute mp3>` produces `t.json` with words.

- [ ] **Step 6: Commit (media-tools).**
```bash
git add transcription/transcribe transcription/transcribe-mlx transcription/README.md transcription/tests
git commit -m "transcription: an mlx engine (transcribe -E mlx, transcribe-mlx) with full JSON output"
```

### Task 2: upload and status routes (media-tools server)

**Files:**
- Modify: `transcription/web/server.py`, `transcription/README.md` (transcribe-web section)
- Test: `transcription/tests/test_server.py`

**Interfaces:**
- Consumes: Task 1's `transcribe -E mlx [-p PROMPT] FILE -o DIR -n out` writing `DIR/out.json`.
- Produces: `POST /jobs/upload?engine=mlx` → `202 {"id"}` / `400` / `411` / `413`; `GET /jobs/<id>` → `{"status": "queued"|"running", "steps"}` | `{"status": "done", "result", "machine"}` (URL jobs: `text`, `srt` instead of `result`) | `{"status": "error", "error"}` | `404`; `POST /jobs` accepts `"engine"`.
- Module seams for tests: `MAX_UPLOAD = 100 * 1024 * 1024`, `KEEP_S = 3600`, `ENGINES = ("whisper.cpp", "mlx")`, `clock = time.monotonic` (patched in tests), `MACHINE = socket.gethostname().split(".")[0]`.

- [ ] **Step 1: Write the failing tests.** Fixture: `TRANSCRIBE_BIN` = a fake bash script that records argv, sleeps if `$FAKE_SLEEP`, fails with `transcribe: error: boom` if the input file's first bytes are `FAIL`, else writes `-o DIR`'s `out.json` (`{"model":"m","model_version":"0.4.3","segments":[]}`) and `out.txt` and prints the txt path. Import `server` with `TMPDIR` set to a temp dir, start `ThreadingHTTPServer` + `worker_loop` threads on port 0. Tests:
  - `test_upload_queues_and_finishes`: POST 1 KB body, `Content-Type: audio/mpeg` → `202`; poll `GET /jobs/<id>` until `done`; `result == {"model": "m", …}`, `machine == server.MACHINE`; the fake's argv contains `-E mlx`.
  - `test_prompt_reaches_transcribe`: header `X-Transcribe-Prompt: ` + `quote("Wood Talk, Spagnuolo — Festool")` → argv has `-p Wood Talk, Spagnuolo — Festool`.
  - `test_upload_rejections`: `engine=whisper.cpp` → 400; `engine=foo` → 400; empty body → 400; no `Content-Length` (raw socket) → 411; `Content-Length: 104857601` → 413 answered without sending the body; prompt header over 4096 bytes or not valid percent-encoded UTF-8 → 400.
  - `test_truncated_upload_is_rejected_and_removed` (Review Focus 1): raw socket sends `Content-Length: 1000` then 10 bytes and closes → no job is queued and `TMPDIR` holds no job directory.
  - `test_job_dir_removed_after_success_and_failure`: after a `done` and an `error` job (body starting `FAIL`, error text contains `boom`), no `job-*` directories remain under `TMPDIR`.
  - `test_status_404_and_expiry`: unknown id → 404; finished job, `server.clock` advanced 3601 s → 404.
  - `test_upload_waits_behind_url_job`: a URL job with `FAKE_SLEEP=1` then an upload → the upload is `queued` while the URL job runs.
  - `test_post_jobs_engine`: `{"urls": ["https://x/a.mp3"], "engine": "mlx"}` → 200 and argv contains `-E mlx`; `"engine": "foo"` → 400.

- [ ] **Step 2: Run them; expect failures** (404s on the new routes).

- [ ] **Step 3: Implement.** In `do_POST`: route `/jobs/upload` (parse `urlsplit(self.path)` query) to `_upload()`; check engine, length (`411`/`413` before reading), prompt (`unquote(..., errors="strict")` in a try → `400`; length ≤ 4096); create `tempfile.mkdtemp(prefix="job-")`; read `Content-Length` bytes in 1 MiB chunks into `audio.mp3`; short read → `shutil.rmtree`, `400 {"error": "upload incomplete"}`. `new_job(url=None, opts)` with `opts = {"engine": "mlx", "prompt": …, "upload_dir": dir}`. `run_job`: for an upload, `cmd = [TRANSCRIBE_BIN, dir/audio.mp3, "-o", dir, "-n", "out", "-E", "mlx"] + (["-p", prompt] if prompt else [])`; on success read `dir/out.json` into `job["result"]`; always `rmtree(dir)` in a `finally`; set `job["finished"] = clock()`. URL jobs append `-E engine` when it isn't the default. In `do_GET`, match `/jobs/<id>/stream` first, then `/jobs/<id>`; before answering, drop jobs with `finished` older than `KEEP_S` (under `JOBS_LOCK`). README: document both routes, the cap and the 60 s Traefik read timeout it stays inside (spec §6).

- [ ] **Step 4: Run the tests; expect PASS.** Also start it locally (`./transcribe-web --port 8799`, no `open`) and confirm the page still loads and `/models` answers.

- [ ] **Step 5: Commit (media-tools).**
```bash
git add transcription/web/server.py transcription/README.md transcription/tests/test_server.py
git commit -m "transcribe-web: upload jobs (POST /jobs/upload), job status (GET /jobs/<id>), engine choice"
```

### Task 3: `spread:N` selector (wt-search)

**Files:**
- Modify: `pipeline/src/wts/selection.py` (`_term`, error text), `pipeline/src/wts/cli.py:66` (`--select` help), `pipeline/README.md` (selector list)
- Test: `pipeline/tests/test_selection.py`

**Interfaces:**
- Produces: selector term `spread:N` — N episodes evenly spaced by `published_at` among episodes with `in_scope = 0`; indexes `round((i + 0.5) * M / N)` for `i` in `range(N)` over the M candidates; N ≥ M → all; N < 1 or non-integer → the existing `BadParameter`.

- [ ] **Step 1: Write the failing tests.**
  - `test_spread_is_even_and_skips_scope`: `make_episodes(100)`, `add_to_scope(conn, ids[-20:])`, `got = resolve_selector(conn, "spread:10")` → `len(got) == 10`, `not set(got) & set(ids[-20:])`, `got[0] == ids[4]` and `got[-1] == ids[76]` (M = 80: indexes 4, 12, …, 76), consecutive gaps all 8.
  - `test_spread_more_than_candidates_takes_all`: 5 episodes, 2 in scope, `spread:9` → the 3 others.
  - `test_spread_rejects_bad_n`: `spread:0` and `spread:x` raise `click.BadParameter`.

- [ ] **Step 2: Run; expect FAIL** (`unknown selector 'spread:10'`).
Run: `cd pipeline && uv run pytest -q tests/test_selection.py`

- [ ] **Step 3: Implement** the `spread` branch in `_term` (`n = int(arg)`, `n < 1` → fall through to the error), add `spread:N` to both help strings and the README list.

- [ ] **Step 4: Run; expect PASS.**

- [ ] **Step 5: Commit.** `git commit -m "pipeline: spread:N selects N episodes evenly across the archive, outside the scope"`

### Task 4: `RemoteTranscriber` (wt-search)

**Files:**
- Create: `pipeline/src/wts/transcribe_remote.py`
- Test: `pipeline/tests/test_transcribe_remote.py`

**Interfaces:**
- Consumes: `wts.transcribe.RawTranscript/RawSegment/RawWord`; `wts.storage.MachineProblem`.
- Produces:
  ```python
  class TranscriberUnavailable(MachineProblem): ...
  class RemoteJobFailed(Exception): ...
  class RemoteTranscriber:
      def __init__(self, base_url: str, *, client: httpx.Client | None = None,
                   poll_s: float = 5.0, max_wait_s: float = 7200.0,
                   clock: Callable[[], float] = time.monotonic,
                   sleep: Callable[[float], None] = time.sleep): ...
      machine: str | None   # from the last result, else the URL's host's first label
      def transcribe(self, audio: Path, initial_prompt: str) -> RawTranscript: ...
  ```
  Unavailable messages read `"<host> unreachable (<reason>)"`, e.g. `"transcribe.home.zmievski.org unreachable (ConnectError)"`. No `mlx_whisper` import in this module.

- [ ] **Step 1: Write the failing tests** with `httpx.MockTransport` handlers and a fake clock/sleep:
  - `test_done_job_maps_to_raw_transcript`: upload → `202 {"id": "j1"}` (assert method POST, path `/jobs/upload`, query `engine=mlx`, body equals the file, `content-type: audio/mpeg`, `x-transcribe-prompt` unquotes to the prompt); then `GET /jobs/j1` → `running`, then `done` with a two-segment result → `RawTranscript` equal to the expected dataclasses; `t.machine == "walnut"`.
  - `test_machine_falls_back_to_url_host` (Review Focus 4): `done` without `machine`, base URL `https://transcribe.home.zmievski.org` → `t.machine == "transcribe"`.
  - `test_connect_error_is_unavailable`, `test_5xx_is_unavailable` (upload 503; poll 502), `test_own_job_404_is_unavailable`: each raises `TranscriberUnavailable` whose message starts with the host and `unreachable`.
  - `test_transport_error_is_unavailable` (Review Focus 2): the handler raises `httpx.RemoteProtocolError` on upload, and separately `httpx.ReadError` on a poll → `TranscriberUnavailable`.
  - `test_stall_is_unavailable`: always `queued`; the fake clock passes 7200 s → `TranscriberUnavailable` mentioning `no result after 2 h`; it slept in 5 s steps.
  - `test_job_error_is_a_failure`: `{"status": "error", "error": "transcribe: error: boom"}` → `RemoteJobFailed("transcribe: error: boom")`, not a `MachineProblem`.
  - `test_malformed_result_is_a_job_failure` (Review Focus 3): `done` with `{"result": {"segments": [{"start": 0}]}}` → `RemoteJobFailed` whose message names the missing field.
  - `test_version_mismatch_warns`: result `model_version: "9.9"` with the installed version monkeypatched to `"0.4.3"` → a warning record naming both; the transcript is still returned. When `mlx-whisper` is not installed (`PackageNotFoundError`), no warning.

- [ ] **Step 2: Run; expect FAIL** (module missing).
Run: `cd pipeline && uv run pytest -q tests/test_transcribe_remote.py`

- [ ] **Step 3: Implement.** Upload with `content=audio.read_bytes()` (≤ 100 MB; httpx sets `Content-Length`), header `X-Transcribe-Prompt: quote(prompt, safe="")`, client timeout `httpx.Timeout(60, connect=10)`. Map `httpx.TransportError` (covers connect, timeout, protocol, read) and 5xx/own-404 to `TranscriberUnavailable(...) from exc`; let every other exception, `KeyboardInterrupt` included, pass. Parse the result with explicit key access, converting `KeyError`/`TypeError`/`ValueError` to `RemoteJobFailed(f"bad result from {host}: missing {key}")`. Version: `importlib.metadata.version("mlx-whisper")` in a try; log with `logging.getLogger("wts")` at warning.

- [ ] **Step 4: Run; expect PASS.** Then `uv run ruff check .`.

- [ ] **Step 5: Commit.** `git commit -m "pipeline: RemoteTranscriber uploads to transcribe-web and polls for the result (spec 2026-10-26 §4.1)"`

### Task 5: wiring, failure handling and the Linux-safe path (wt-search)

**Files:**
- Modify: `pipeline/src/wts/config.py` (`transcribe_url`), `pipeline/src/wts/transcribe.py` (`get_transcriber`, `transcribe_episode` machine), `pipeline/src/wts/steps.py` (`run_transcribe`, `run`), `pipeline/src/wts/cli.py` (`transcribe --local`, `run --local-transcribe`, `paths`), `pipeline/README.md`
- Test: `pipeline/tests/test_transcribe.py`, `pipeline/tests/test_run.py`, `pipeline/tests/test_config.py`, `pipeline/tests/test_paths.py`

**Interfaces:**
- Consumes: Task 4's `RemoteTranscriber`, `TranscriberUnavailable`, `RemoteJobFailed`.
- Produces: `Config.transcribe_url: str | None = None`; `get_transcriber(cfg: Config | None = None, *, local: bool = False) -> Transcriber`; `run_transcribe(..., local: bool = False)`; `run(..., local_transcribe: bool = False)`; `meta.machine` = `transcriber.machine` when set, else `platform.node()`.

- [ ] **Step 1: Write the failing tests.**
  - `test_config.py::test_transcribe_url`: `transcribe_url = "https://t.example"` → `cfg.transcribe_url == "https://t.example"`; absent → `None`.
  - `test_transcribe.py::test_get_transcriber_picks_remote_or_local`: URL set → `RemoteTranscriber`; `local=True` or unset → `MlxWhisperTranscriber` (constructing it imports nothing).
  - `test_transcribe.py::test_machine_comes_from_remote_transcriber`: a fake transcriber with `machine = "walnut"` → the written JSON's `meta.machine == "walnut"`; without the attribute → `platform.node()`.
  - `test_run.py::test_unavailable_stops_step_and_keeps_retries`: `FakeTranscriber(raise_exc=TranscriberUnavailable("walnut unreachable (ConnectError)"))` over 3 downloaded episodes → `run_transcribe` raises `TranscriberUnavailable` whose message ends `; 3 episodes left to transcribe`; all 3 still `downloaded`, `retries == 0`; through `wts transcribe` the CLI exits 3 with `Stopped: …`; through `run()` the notifier gets `"wts: run stopped"` with that text.
  - `test_run.py::test_remote_job_failure_fails_the_episode`: `RemoteJobFailed("boom")` → that episode `error`, `retries == 1`, the next episode still transcribed.
  - `test_run.py::test_ctrl_c_during_remote_transcription_keeps_episode` (Review Focus 5): `RemoteTranscriber` over a `MockTransport` whose poll handler raises `KeyboardInterrupt` → it propagates out of `run_transcribe`; the episode stays `downloaded`, `retries == 0`.
  - `test_transcribe.py::test_remote_path_needs_no_mlx`: with `sys.modules["mlx_whisper"] = None` (monkeypatch) and `transcribe_url` set, `run_transcribe` over a `MockTransport`-backed `RemoteTranscriber` transcribes an episode.
  - `test_paths.py::test_paths_names_the_transcriber`: `wts paths` prints `transcriber: remote https://t.example` with the URL set, `transcriber: local mlx` without.

- [ ] **Step 2: Run; expect FAIL.**
Run: `cd pipeline && uv run pytest -q tests/test_transcribe.py tests/test_run.py tests/test_config.py tests/test_paths.py`

- [ ] **Step 3: Implement.** `load_config` reads `transcribe_url`. In `run_transcribe`, add `except MachineProblem as exc:` **before** the generic `except Exception` (today a non-`OSError` exception is charged to the episode): re-raise `type(exc)(f"{exc}; {plural(len(rows) - i + 1, 'episode')} left to transcribe") from exc` for `TranscriberUnavailable`, plain `raise` for other machine problems. Thread `local` from the CLI flags through `run()` to `run_transcribe`. README: `transcribe_url` in the config section, `--local`/`--local-transcribe` in Everyday use.

- [ ] **Step 4: Run the whole suite; expect PASS.**
Run: `cd pipeline && uv run pytest -q && uv run ruff check .`
Expected: all pass (1092 + the new ones), ruff clean.

- [ ] **Step 5: Commit.** `git commit -m "pipeline: transcribe_url sends transcription to walnut; an unreachable server stops the run without failing episodes"`

### Task 6: equivalence check script (wt-search)

**Files:**
- Create: `pipeline/spikes/compare_transcripts.py`

**Interfaces:**
- Consumes: `RemoteTranscriber`, `build_initial_prompt(VOCAB_FILE)`, `wts paths` locations, `state.db` read-only.
- Produces: `uv run python spikes/compare_transcripts.py --remote URL EP [EP...]` — for each episode number, uploads its stored MP3, compares the result with the existing transcript JSON, prints one line per episode (`ep071: words 99.6% same, segments 412 vs 409 (-0.7%), start Δ median 0.02 s p99 0.31 s: OK`), writes walnut's JSON to the scratch dir it names, and exits 1 if any episode misses a threshold. It changes no state and no transcript.

- [ ] **Step 1: Implement** `compare(a: list[dict], b: list[dict]) -> Comparison` (dataclass: `word_match`, `seg_a`, `seg_b`, `median_dt`, `p99_dt`): words normalised (strip, lower-case, punctuation removed), aligned with `difflib.SequenceMatcher(autojunk=False)`; Δ over the start times of words in matching blocks. Thresholds from spec §5: `word_match >= 0.99`, `abs(seg_b - seg_a) / seg_a <= 0.02`, `median_dt <= 0.05`, `p99_dt <= 0.5`. Also `--files A.json B.json` to compare two existing files without uploading.

- [ ] **Step 2: Sanity check.** `uv run python spikes/compare_transcripts.py --files X.json X.json` on any transcript → `100.0% same … Δ median 0.00 s p99 0.00 s: OK`, exit 0. `uv run ruff check spikes/compare_transcripts.py` clean.

- [ ] **Step 3: Commit.** `git commit -m "pipeline: spikes/compare_transcripts.py checks walnut's transcripts against wick's (spec §5)"`

### Task 7: walnut provisioning (homelab-ci) and homelab notes

**Files:**
- Modify: `provisioning/walnut/setup.sh` (transcribe-web step), `provisioning/walnut/files/launchd/org.zmievski.transcribe.plist`, `provisioning/walnut/README.md`
- Modify (homelab-docs, if writable this session; else hand the text to the maintainer): `hosts/walnut.md` (transcribe-web section), `specs/2026-10-03-llm-node-design.md` (allotment table)

**Interfaces:**
- Consumes: Task 1's `transcribe-mlx --prefetch`.

- [ ] **Step 1: Edit `setup.sh`.** Add `$T/hf` to the `_transcribe`-owned `install -d` line. After the code copy, when `$T/app/transcribe-mlx` exists: `sudo -u _transcribe env HOME=$T/home HF_HOME=$T/hf PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/uv run --script $T/app/transcribe-mlx --prefetch` (idempotent). Plist: `HF_HOME` = `/Library/Transcribe/hf` in `EnvironmentVariables`. README transcribe-web section: the `mlx` engine, upload/status routes, `hf/`, `mlx-whisper` pinned in `transcribe-mlx` and wt-search together.

- [ ] **Step 2: Verify.** `bash -n provisioning/walnut/setup.sh` and `plutil -lint provisioning/walnut/files/launchd/org.zmievski.transcribe.plist` → OK.

- [ ] **Step 3: Homelab notes.** walnut.md: transcribe-web also serves `wts` (mlx engine, upload route). llm-node table row: `transcribe-web (mlx) | 8765 | ~3 GB while a job runs, freed after; one job at a time | wt-search transcription`; check whisper.cpp's row exists (add `~2 GB while running` if not).

- [ ] **Step 4: Commit (homelab-ci; homelab-docs separately if edited).** `git commit -m "walnut: transcribe-web warms MLX Whisper for the mlx engine (HF_HOME, --prefetch)"`

### Task 8: deploy and equivalence (needs walnut sudo)

Ask the maintainer to run `ssh -t walnut /usr/local/bin/claude-walnut-key on` (or to run step 1 themselves). Confirm before deploying: it restarts transcribe-web (a running web job is lost).

- [ ] **Step 1: Deploy** with README "Run", from `~/projects/homelab-ci`:
```bash
rsync -a --delete --exclude .ruff_cache --exclude web/out --exclude '*.txt' --exclude '*.srt' --exclude tests \
  ~/projects/media-tools/transcription/ walnut:walnut-provisioning/transcription/
rsync -a provisioning/walnut/ walnut:walnut-provisioning/ && ssh walnut walnut-provisioning/setup.sh
```
Expected: `app changed: restarted org.zmievski.transcribe`, the prefetch prints `>> model ready`, `setup.sh: done`. (Add `--exclude tests` to the README's command in Task 7 if it isn't there.)

- [ ] **Step 2: Smoke.** From wick: `curl -sS -X POST --data-binary @clip.mp3 -H 'Content-Type: audio/mpeg' 'https://transcribe.home.zmievski.org/jobs/upload?engine=mlx'` → `202 {"id": …}`; poll `GET /jobs/<id>` → `done` with segments and `"machine": "walnut"`. The web page still transcribes a URL with the default engine.

- [ ] **Step 3: Equivalence.** `cd pipeline && uv run python spikes/compare_transcripts.py --remote https://transcribe.home.zmievski.org 1 71 616` (one 2007-era, one mid, one recent; substitute in-scope numbers). Expected: three `OK` lines. Anything else: stop and report to the maintainer before Task 9. Record walnut's speed (× realtime) from the log.

- [ ] **Step 4: Ask the maintainer to switch the key off** (`claude-walnut-key off`).

### Task 9: the run to a quarter, and docs (maintainer runs `wts`)

- [ ] **Step 1: Docs (Claude).** Main spec: §1 "Heavy compute"/M2 and §3.2 `wts transcribe` point to the 2026-10-26 spec (transcription on walnut via `transcribe_url`); HANDOFF: item 15 "built", the run steps below, walnut's measured speed. Commit.

- [ ] **Step 2: Maintainer, on wick.** Add `transcribe_url = "https://transcribe.home.zmievski.org"` to `config.toml` (top level, before any `[env.*]`); `uv run wts paths` shows `transcriber: remote …`. Read N from `uv run wts status` (⌈feed episodes ÷ 4⌉ − in scope; 157 − 36 = 121 today), then `uv run wts scope add spread:N` and `uv run wts run --env staging` (several sittings are fine; Ctrl-C safe).

- [ ] **Step 3: Before contacting the hosts.** `uv run python spikes/check_corrections.py` over all transcripts (fix false matches with the corrections skill); `uv run wts status --flagged`; `uv run wts eval run` and, once reviewed, `--update` for the new baseline (retune the Related floor if paraphrase recall drops); platform link coverage. Record results in the HANDOFF.
