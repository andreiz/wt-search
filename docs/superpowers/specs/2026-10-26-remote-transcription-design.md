# Remote transcription on walnut — design

**Status:** draft for the maintainer's review, 2026-10-26.
**Replaces:** HANDOFF item 15's open questions; the draft "M2 Plan A"
(`docs/superpowers/plans/2026-10-08-m2-mac-mini-migration.md`), which moved the whole pipeline
to the Mini and is superseded.
**Main spec:** `2026-10-04-wood-talk-search-design.md` §1 (Heavy compute, M2), §3.2
(`wts transcribe`), §10 item 8. Those sections get a pointer here once this is approved.

## 1. Goal and scope

Grow staging from 36 episodes to a quarter of the archive (~156 in all) before the hosts are
contacted, transcribing on **walnut** (Mac mini M5 Pro, 64 GB) instead of on **wick** (the
M1 Max that runs the pipeline). The run also proves the walnut path before launch.

What the maintainer decided (2026-10-25/26):
- walnut serves models; it is not a general pipeline host. The pipeline (`state.db`,
  transcripts, audio, chunk, embed, publish, review, eval) stays on wick.
- Transcription goes through walnut's existing **transcribe-web** service (media-tools
  `transcription/`), extended with a second engine, not a new service.
- Wick **uploads** the MP3 it already has (HTTP POST), so walnut transcribes the exact file wick
  keeps for playback and review. No scp, no file paths, no second download.
- One job at a time from wick: upload, poll, next episode.
- After the public launch, weekly new episodes run as a **Forgejo Actions** job. Those runners
  are Docker on Linux. Backlog runs before then are started by hand on wick.
- The scope grows to **a quarter of all episodes, counting the 36 already in scope**: ~120 more,
  evenly spaced across the archive (2026-10-26).
- Later, and not needed for the quarter: the pipeline moves to a **Docker-based deployment run
  from Forgejo** if possible (§1 "Not in scope").

**In scope:** the media-tools changes, `RemoteTranscriber` in `wts`, the `spread:N` selector, the
walnut deployment (homelab-ci), the equivalence check and the backlog run.

**Not in scope (noted for later):**
- The Docker-based deployment run from Forgejo (maintainer, 2026-10-26: "if possible", after
  the quarter checkpoint; its own brainstorm → spec → plan). It would cover: a `wts` image
  (Linux, no MLX), `state.db`, transcripts and audio off the job's filesystem (NAS or volume,
  with one writer: the M2 Plan A reasoning), secrets from runner secrets instead of the
  Keychain (`secrets.py` needs an environment fallback), the runner's route to walnut (§6),
  and possibly the Worker deploys (`wrangler`) too. Transcription stays native on walnut
  either way: Docker on macOS has no Metal, so MLX can't run in a container. The design here
  keeps the client Linux-safe (§4.1) so it carries over unchanged.
- Embedding off wick. `SentenceTransformerEmbedder` hard-codes `device="mps"`; a Linux runner
  would embed on CPU. Embedding on walnut or with Workers AI's `bge-base-en-v1.5` is decided with
  the Forgejo design.
- A remote mode for the `transcribe` CLI (`transcribe -r walnut file.mp3`: upload and poll in
  ~30 lines of bash). A small follow-up in media-tools; `wts` doesn't need it.

## 2. What exists

- **transcribe-web** (`media-tools/transcription/web/server.py`): stdlib Python, one worker
  thread (jobs strictly one at a time), jobs in memory, `POST /jobs` takes http(s) URLs and a
  model from an allow-list, progress over SSE (`/jobs/<id>/stream`). It shells out to the
  `transcribe` bash script (captions first, else whisper.cpp `large-v3-turbo`), which writes
  txt and srt only. On walnut it runs as LaunchDaemon `org.zmievski.transcribe`, account
  `_transcribe`, `:8765`, under `/Library/Transcribe` (`app/`, `whisper/`, `out/`), behind
  Traefik at `https://transcribe.home.zmievski.org` (Trusted LAN and tailnet only). It shares
  the GPU with Ollama.
- **wts** transcribes through a `Transcriber` protocol (`transcribe(audio, prompt) ->
  RawTranscript`); `MlxWhisperTranscriber` calls `mlx_whisper.transcribe` with
  `mlx-community/whisper-large-v3-turbo`, `word_timestamps=True` and the vocab prompt.
  `mlx-whisper` is 0.4.3 in `pipeline/uv.lock`. `transcribe_episode` copies the MP3 to a temp
  folder, transcribes the copy and writes the JSON atomically, with `meta.machine` from
  `platform.node()`. A failed episode costs a retry (`fail()`; `MAX_RETRIES` = 3). A
  `MachineProblem` (e.g. `StorageUnavailable`) stops the run and is reported instead.

whisper.cpp is not used for the pipeline: it has no per-segment `no_speech_prob` or
`avg_logprob` in the form the guards read, and mixing two engines' segmentation and word timing
in one archive would undo settled tuning.

## 3. media-tools changes

### 3.1 `transcribe-mlx`

A new script beside `transcribe`, a uv inline-metadata Python script pinned to
`mlx-whisper==0.4.3` (the version in wt-search's lockfile; both move together, on purpose).

```
transcribe-mlx -o DIR -n NAME [-p PROMPT] FILE
```

- Calls `mlx_whisper.transcribe(FILE, path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
  word_timestamps=True, initial_prompt=PROMPT)`, exactly as `wts` does.
- Writes `NAME.json`, `NAME.txt` and `NAME.srt` to DIR. The JSON:
  ```json
  {"model": "mlx-community/whisper-large-v3-turbo", "model_version": "0.4.3",
   "segments": [{"start": 0.0, "end": 4.2, "text": "...", "no_speech_prob": 0.01,
                 "avg_logprob": -0.21,
                 "words": [{"start": 0.0, "end": 0.4, "word": " Welcome", "probability": 0.98}]}]}
  ```
  Field names and types match `wts.transcribe.RawSegment`/`RawWord`; `model_version` is
  `importlib.metadata.version("mlx-whisper")`.
- Same `>>` progress lines and stdout contract as `transcribe` (the output path on stdout).
- The model cache is wherever `HF_HOME` points (`/Library/Transcribe/hf` on walnut).
- `transcribe-mlx --prefetch` installs its dependencies and downloads the model without
  transcribing, so a deploy can warm it (§6) and the first real job isn't the slow one.

### 3.2 `transcribe -E ENGINE`

`-E whisper.cpp` (default, today's behaviour) or `-E mlx`. With `mlx`, the script skips the
captions shortcut and the 16 kHz WAV conversion and hands the input to `transcribe-mlx`. It
still takes URLs and local files, so the web page can offer the engine too. `-p PROMPT` passes
an initial prompt (mlx only; with whisper.cpp it is an error, so nothing is silently ignored).

### 3.3 Server routes

Existing routes are unchanged except that `POST /jobs` accepts `"engine"`, validated against
the fixed list `["whisper.cpp", "mlx"]` like `model` is now.

**`POST /jobs/upload?engine=mlx`**
- Body: the raw audio (`Content-Type: audio/mpeg`), `Content-Length` required, at most 100 MB
  (Wood Talk MP3s are ~25–60 MB; see §6 for why the cap stays small).
- `X-Transcribe-Prompt`: the initial prompt, percent-encoded UTF-8, at most 4 KB. Optional.
- The server streams the body in chunks to a per-job directory under `TMPDIR` (on walnut
  `/Library/Transcribe/tmp/`, already the service's own), as `<dir>/audio.mp3`, then queues the
  job on the same worker as URL jobs.
- `202 {"id": "<id>"}`. `400` unknown engine, empty body or a bad prompt header; `411` no
  length; `413` over the cap. Only `engine=mlx` is accepted here for now (only it returns JSON).
- The job runs `transcribe -E mlx [-p PROMPT] <dir>/audio.mp3 -o <dir> -n out`. The local path
  check stays: only files the server saved itself are ever passed to `transcribe`.
- Upload jobs write to their own directory, not `out/`. The directory, upload included, is
  deleted when the job ends, done or failed; the result JSON is held in memory (below).

**`GET /jobs/<id>`** (all jobs, not just uploads)
- `{"status": "queued" | "running", "steps": [...]}`
- `{"status": "done", "result": {...}, "machine": "walnut"}`: `result` is the §3.1 JSON for an
  upload job; URL jobs keep `text`/`srt` as now. `machine` is the server's host name.
- `{"status": "error", "error": "..."}`
- `404` for an unknown id, including every id from before a restart (jobs live in memory).
- A finished job's result is kept for one hour after it ends, then dropped.

### 3.4 Tests

media-tools has none yet; this adds `transcription/tests/` (pytest, run with
`uv run --with pytest`). The server runs in a thread on a free port with `TRANSCRIBE_BIN`
pointing at a fake script that writes canned JSON/txt/srt (or fails on cue).
- upload: `202` and a queued job; `400` engine/body/prompt; `411`; `413` without reading the
  body; the prompt reaches the fake script intact (non-ASCII included).
- `GET /jobs/<id>`: queued, running, done with `result` and `machine`, error, `404`.
- the upload file and job directory are gone after success and after failure.
- result expiry after the hour (clock injected).
- an upload job and a URL job share the one worker: the second waits for the first.
- `POST /jobs` with `engine`: accepted from the list, `400` otherwise.

`transcribe-mlx` is checked by hand on walnut (§7 step 2).

## 4. wts changes

### 4.1 `RemoteTranscriber`

`src/wts/transcribe_remote.py`, httpx only (no MLX import anywhere on this path, so the
transcribe step imports and runs on Linux without `mlx-whisper`).

```python
class TranscriberUnavailable(MachineProblem): ...

class RemoteTranscriber:
    def __init__(self, base_url: str, *, poll_s: float = 5.0, client: httpx.Client | None = None): ...
    machine: str | None  # set from the last result's "machine"
    def transcribe(self, audio: Path, initial_prompt: str) -> RawTranscript: ...
```

- Uploads the file (streamed), then polls `GET /jobs/<id>` every `poll_s`, logging new step
  lines at debug level.
- Maps `result` to `RawTranscript` field for field.
- **Unavailable** → raises `TranscriberUnavailable` (the run stops; the episode is not failed and
  keeps its retries): connect error or timeout, any 5xx, a `404` for its own job, or a stall —
  not done 2 h after the upload. (The longest episode takes ~10 min on walnut; the margin is
  for web jobs queued ahead. `transcribe()` doesn't get the episode row, so the limit is fixed
  rather than scaled to the audio.)
- **The job failed** (`status: error`) → raises an ordinary exception: the step calls `fail()`
  as for a local failure.
- `model_version` different from the locally installed or locked `mlx-whisper` → a warning,
  not a refusal (it is recorded per transcript).
- Ctrl-C stops polling and propagates; walnut finishes the orphaned job and drops it after an
  hour.

### 4.2 Wiring

- `config.toml`: `transcribe_url = "https://transcribe.home.zmievski.org"` (optional; `Config`
  gains `transcribe_url: str | None = None`).
- `get_transcriber(cfg, local=False)`: `RemoteTranscriber(cfg.transcribe_url)` when set and not
  `local`, else `MlxWhisperTranscriber()`.
- `wts transcribe --local` and `wts run --local-transcribe` force the local engine for one run.
- `transcribe_episode` writes `meta.machine` from the transcriber's `machine` when it has one,
  else `platform.node()`.
- `wts paths` prints `transcriber: remote https://… | local mlx`.
- The run's notification already reports a `MachineProblem`; for this one it reads
  "walnut unreachable; N episodes left to transcribe".

### 4.3 `spread:N` selector

`spread:N` in `selection._term`: N episodes evenly spaced by publication date across the
episodes **not yet in scope** (so adding it never re-picks one and the total is exact): of the
M candidates in date order, take indexes `round((i + 0.5) * M / N)` for `i` in `0..N-1`.
`N >= 1`; N ≥ M takes them all. Used as `wts scope add spread:120`. Added to the selector help
text and the README's selector list. The 36 already in scope lean recent (20 newest), so the
quarter as a whole is slightly denser in the last year; that is fine.

### 4.4 Tests

httpx `MockTransport` for the server.
- a done job maps to the expected `RawTranscript`; `machine` lands in the transcript meta.
- connect error, 5xx, own-job `404` and a stall each raise `TranscriberUnavailable`; through
  `run_transcribe`, the episode stays `downloaded` with its retries unchanged and the run reports
  the problem.
- `status: error` → the episode is failed with the server's message.
- version mismatch → a warning in the log.
- `transcribe_url` unset or `--local` → the local transcriber.
- importing `wts.steps` and running `run_transcribe` with a `RemoteTranscriber` works with
  `mlx_whisper` made unimportable.
- `spread:N` on a small fixture: evenly spaced, never an in-scope episode, exactly N (or all
  candidates when N ≥ M); `spread:0` and `spread:x` are rejected.

## 5. Equivalence

walnut's output must match wick's closely enough that the archive does not care which machine
made a transcript. Not bit-identical (different GPU). On 3 seed episodes already transcribed on
wick (one 2007-era, one mid, one recent), a Mac-only check compares walnut's transcript with
wick's: identical word sequence for at least 99% of words (by alignment), same segment count
±2%, and word start times within 0.05 s at the median and 0.5 s at the 99th percentile. If it
falls short, stop and look before the backlog run. The check is a script in `pipeline/spikes/`
(it needs the real transcripts), not part of the test suite.

## 6. Deployment and network

- media-tools changes ship to walnut as transcribe-web's do now (homelab-ci
  `provisioning/walnut/README.md` "Run"): from wick, `rsync` media-tools `transcription/` to
  `walnut:walnut-provisioning/transcription/`, `rsync` `provisioning/walnut/` beside it, then
  `ssh walnut walnut-provisioning/setup.sh`, which copies the code to the root-owned
  `/Library/Transcribe/app` and restarts `org.zmievski.transcribe` only when it changed. Needs
  sudo: the maintainer with `ssh -t`, or Claude with `claude-walnut-key on`. The README's rsync
  excludes `*.txt`/`*.srt` (sample transcripts); test fixtures with those suffixes are not
  needed on walnut, so that stays.
- homelab-ci changes, all in `provisioning/walnut/`:
  - `setup.sh`'s transcribe-web step also creates `/Library/Transcribe/hf` (owned by
    `_transcribe`) and, after the code copy, warms MLX as `_transcribe`:
    `sudo -u _transcribe env HOME=… HF_HOME=… uv run --script $T/app/transcribe-mlx --prefetch`
    (idempotent; it only downloads what is missing, like the whisper.cpp model fetch above it).
  - `org.zmievski.transcribe.plist` gains `HF_HOME=/Library/Transcribe/hf`. Uploads and job
    directories use the existing `TMPDIR` (`/Library/Transcribe/tmp/`); no new directory.
  - The README's transcribe-web section documents the `mlx` engine, the upload route and the
    pinned `mlx-whisper`.
  - No Brewfile change: `uv` and `ffmpeg` are there; `mlx-whisper` comes from the script's
    inline metadata into `_transcribe`'s uv cache.
- This is a script run from wick, not CI:
  the Forgejo runners are Docker on Linux hosts and don't reach walnut. Automating it (a
  host-mode `act_runner` on walnut running `setup.sh` on push; a new root-equivalent daemon, cf.
  the security review's §D1) belongs to the Docker/Forgejo design, not this one.
- **GPU memory budget.** The llm-node design (homelab-docs
  `specs/2026-10-03-llm-node-design.md`, decision 6) gives every server on walnut a row in its
  allotment table, under the 56 GB wired cap. `transcribe-mlx` adds one: `large-v3-turbo`
  (~1.6 GB of weights, ~3 GB resident while a job runs, freed when the process exits; one job
  at a time). whisper.cpp's row is checked or added at the same time.
- **Why not a container.** Docker Desktop and Apple's `container` (Containerization, macOS 26+)
  both run Linux guests in VMs; MLX needs Metal, which exists only in macOS, and Apple's
  `container` passes no GPU through (Podman/libkrun offers Vulkan, which MLX doesn't use). So
  transcription stays a native LaunchDaemon. Re-check if a later macOS adds GPU access for
  containers.
- wick reaches `https://transcribe.home.zmievski.org` already (Trusted LAN). Traefik sets no
  timeouts of its own, so v3's default applies: a request not fully read within **60 s** is cut
  off. An upload must therefore arrive at about 14 Mbit/s for the 100 MB cap (~5 Mbit/s for a
  typical 35 MB episode): seconds on the LAN, and fine over Tailscale from most connections.
  Polling is short GETs, so the transcription itself never holds a request open. No Traefik
  change is needed; raising the cap would mean raising `websecure`'s `readTimeout` in
  infra-stack (which applies to every site and restarts Traefik).
- Later, for Forgejo: the runners are on the Servers network, which Traefik does not admit. The
  by-hop rule says machine-to-machine traffic uses the host name, so the runner would use
  `http://walnut.lan:8765` with a firewall rule Servers → walnut:8765. Decided in homelab-ci
  with the Forgejo design; `transcribe_url` is plain configuration either way.

## 7. The run to a quarter (~156 episodes)

1. Build and test both halves; deploy to walnut (§6).
2. Hand-check `transcribe -E mlx` on walnut with one episode; run the §5 equivalence check.
3. `wts scope add spread:N` with N = ⌈episodes in the feed ÷ 4⌉ − episodes in scope, both from
   `wts status` at the time (today 157 − 36 = 121).
4. `wts run --env staging`, in several sittings if needed; walnut's speed is measured on the
   first episodes (estimate 4–6 h of transcription for ~120 h of audio). Audio stays on wick's
   disk: ~120 × 31 MB ≈ 3.7 GB, with 40 GB free.
5. Before contacting the hosts: `check_corrections.py` over all transcripts, `wts status
   --flagged`, an eval rerun and a new baseline (the Related floor may need retuning with ~4×
   the passages), platform link coverage.

## 8. Risks

- **GPU contention with Ollama.** Each slows the other; HA voice requests may lag during the
  backlog run. Accepted for a few evenings; runs can be paused with Ctrl-C.
- **Version drift.** Upgrading `mlx-whisper` on one side only changes new transcripts; the
  warning in §4.1 surfaces it. Both pins move together.
- **Memory-only jobs.** A daemon restart loses running jobs; the client treats it as
  unavailable and the next run re-uploads. Acceptable for one-at-a-time use.
