# M2 Plan A — Move the pipeline to the Mac Mini (draft for review)

> **Status:** draft, 2026-10-08, written after Checkpoint G. Nothing here is built yet. The
> decisions marked **Decide** need the maintainer before the code tasks start.

**Goal:** the Mac Mini (M5 Pro) becomes the one machine that runs the pipeline: it owns
`state.db`, transcribes, publishes, backs up and runs `wts run` every day under launchd, with
audio on the NAS and a watchdog. The M1 Max stays the **development** machine: code, tests,
Worker deploys, corrections, `wts search`, and read-only looks at the data. Spec §1 (M2), §3,
§3.0.1, §8.2, §10 item 8.

**Not in this plan** (later M2 plans): the full-archive backlog (~590 episodes), `production`
(D1/Vectorize resources, the atomic publish route of §10 item 9, Workers Paid), the domain and
the site launch.

## Roles after the move

| | Mac Mini (pipeline) | M1 Max (development) |
|---|---|---|
| Code | a clone of `main`, updated on purpose (decision 1) | where code is written, tested, committed |
| `state.db`, transcripts, chunks, embeddings | **the only writable copy** | a read-only mirror, refreshed from the NAS backup |
| Audio | on the NAS (`audio_dir`) | reads the NAS when it needs to |
| `wts run`, `publish`, `feed`, `download`, `transcribe`, `chunk`, `embed` | yes, daily under launchd | refused (Task A3) |
| `wts search`, `links`, `logs`, `status`, `transcript_peek`, `check_corrections` | yes | yes, on the mirror |
| Worker deploys (`wrangler`), `npm test` | no (no Node needed) | yes |
| Keychain secrets | pipeline secrets | the same, for `wts search`, `check-embeddings` and tests |

**Why one writer:** each environment's publish state (`publications`, `published_vectors`) lives in
`state.db`. Two machines publishing from two copies would each think the other's vectors don't
exist: removed chunks would leave ghost vectors in Vectorize, and each machine would republish
what the other changed.

## Code tasks (before the move; test-first, on the M1 as usual)

### Task A1: File paths come from the stem, not from `state.db`
Today `episodes.audio_path` and `transcript_path` hold absolute paths (`steps.py`), which
`wts chunk` and `wts transcribe` read. After the move the audio is on the NAS, and a mirror on
the M1 has another root. Resolve both from the stem and the current `Paths`
(`<audio_dir>/<stem>.mp3`, `<transcripts_dir>/<stem>.json`, as spec §3.4 already names them);
keep the columns only as "this step produced a file". Tests: a `state.db` whose stored paths
point elsewhere still chunks and transcribes from the configured folders.

### Task A2: One run at a time
A lock file (`flock` on `<app_dir>/.wts.lock`) around every command that writes `state.db`, so a
manual `wts run` can't overlap the scheduled one. A second run exits at once with "another wts
run is in progress (pid N, started …)" and exit code 4; launchd logs it, nothing is notified.

### Task A3: The pipeline machine owns `state.db`
`wts claim` records this machine (`platform.node()`) as the owner in `state.db`'s `kv`. The
commands that write to Cloudflare or change episode state (`run`, `publish`, `feed`, `download`,
`transcribe`, `chunk`, `embed`, `scope add`, `backup`) refuse on any other machine: "this
state.db belongs to <mini>; on this machine it is a read-only mirror (`wts claim` moves it)".
Read-only commands work everywhere. With no owner recorded, nothing changes (today's behaviour).
The owner travels in backups, so the M1's mirror is protected automatically.

### Task A4: `wts mirror` (M1)
Refreshes the M1's app folder from the NAS backup (`<backup_dir>/wts/`): `rsync -a --delete`,
keeping the M1's own `config.toml` and logs. Refuses on the owner machine. The mirror is a day
old at most (one backup per scheduled run).

### Task A5: The scheduled job
- `ops/launchd/org.zmievski.wts.run.plist` (a template) and `ops/wts-scheduled.sh`: a login-shell
  wrapper that sets `PATH` (Homebrew's `ffmpeg`, `uv`), runs `uv run wts run --env <run_env>`
  from the clone, and on exit 0 pings the watchdog (decision 2). Output to
  `~/Library/Logs/wts/launchd.log`.
- Quiet model loading: Hugging Face progress bars and the `HF_TOKEN` warning off
  (`HF_HUB_DISABLE_PROGRESS_BARS=1`, `TRANSFORMERS_VERBOSITY=error`) in the wrapper.
- Daily at 05:47 local (spec: early morning; off the hour).

## Setup on the Mini (maintainer)

1. **macOS:** your user, logged in. Energy: never sleep, start after a power failure
   (`sudo pmset -a sleep 0 autorestart 1`). FileVault vs. automatic login: decision 3.
2. **Tools:** Xcode command-line tools, Homebrew, `brew install ffmpeg uv git`.
3. **Code:** `git clone` the repo, `cd pipeline && uv sync --extra mac`, `uv run pytest -q`.
4. **Models:** one interactive `uv run pytest -m mac` downloads MLX Whisper and bge into the
   Hugging Face cache, and checks MLX, bge and the Mac's rsync on the new machine.
5. **NAS:** mount the share at login (Login Items, or autofs in `/etc/auto_master` so it
   remounts by itself); check that `/Volumes/media/wts` appears after a reboot.
6. **Secrets:** `wts secrets set` for each name (`cloudflare_api_token`, `spotify_client_id`,
   `spotify_client_secret`, `youtube_api_key`, `ntfy_topic`, `ntfy_token`), from 1Password;
   then `wts secrets check`. Run one `wts` command that reads them interactively and choose
   **Always Allow** for `security`, so launchd runs aren't blocked by a Keychain prompt.
7. `uv run wts notify test`.

## The move

1. **On the M1:** the last `uv run wts run --env staging`, then `uv run wts backup`. No more
   pipeline runs on the M1 from here.
2. **Audio to the NAS:** `rsync -a "$HOME/Library/Application Support/wts/audio/"
   /Volumes/media/wts/audio/` (~2 GB for the 37 episodes); compare file counts.
3. **App folder to the Mini:** from the NAS backup (`rsync -a /Volumes/media/wts/backup/wts/
   "$HOME/Library/Application Support/wts/"`), or straight from the M1 over SSH.
4. **Config on the Mini:** `audio_dir = "/Volumes/media/wts/audio"`, `backup_dir`, `run_env =
   "staging"`; everything else as on the M1.
5. **Claim and check:** `uv run wts claim`; `wts status` counts match the M1's; `wts run --env
   staging` with nothing new (publish: nothing to do; backup ok); `wts check-embeddings`.
6. **The M1 becomes the mirror:** move its app folder aside (`wts.m1-archive`, kept until the
   Mini has run cleanly for two weeks), then `uv run wts mirror`; `wts publish --env staging`
   must now refuse.
7. **Schedule:** install the plist (`launchctl bootstrap gui/$(id -u) …`), set up the watchdog,
   then `launchctl kickstart` once and read `launchd.log` and `wts logs --since 1h`.
8. **Watch a week:** daily runs, the watchdog quiet, and the next release (Wednesdays, ~every 13
   days) published by the Mini with `scoped=1` and a notification. Then Checkpoint J below.

**Rollback:** `wts claim` on the M1 against its archived folder (or a fresh mirror) and unload
the Mini's job. Nothing on Cloudflare depends on which machine published.

## Development on the M1 afterwards

- Code: as now. To ship pipeline changes, push to `main`, then update the Mini (decision 1).
- Corrections: edit on the M1, check with `check_corrections.py` against the mirror's
  transcripts, push; the Mini applies them on its next `wts chunk` (the corrections hash
  triggers the refresh) after its code is updated.
- `wts search`, `wts links`, `wts logs` (the Mini's logs aren't mirrored; read them there or via
  SSH), `transcript_peek.py`: unchanged, on the mirror.
- Worker: `npm test`, `wrangler deploy` from the M1 only.

## Checkpoint J (maintainer, on the Mini)

*(Renamed from H on 2026-10-09: plan 3 uses H and I.)*

- A scheduled run published a new release by itself; the notification arrived; the watchdog
  stayed quiet, and alerted when the job was unloaded for a day.
- A reboot with the NAS: the share came back and the next run worked; with the share
  unmounted, the run stopped with the "audio folder is not reachable" notification.
- The M1 refused `wts publish` and `wts run`; `wts mirror` brought the latest transcripts.
- Transcription speed on the M5 Pro (× realtime), for the backlog estimate.

## Decide (maintainer)

1. **Updating the Mini's code:** (a) by hand — `ssh mini 'cd wt-search && git pull --ff-only &&
   cd pipeline && uv sync --extra mac'` when you choose (recommended: what runs unattended is
   what you chose to ship); or (b) the scheduled wrapper pulls `main` before each run.
2. **Watchdog:** healthchecks.io (spec §8.2, 8-day timeout), or a push monitor in your homelab
   (Uptime Kuma "Push" type), next to the `/api/health` monitor, both alerting through your ntfy.
3. **FileVault on the Mini:** with FileVault on, macOS won't log in automatically after a
   restart, so after a power cut runs wait until someone logs in (the watchdog would say so).
   Off gives unattended restarts; on keeps the disk encrypted at rest.
4. **Where the M1's mirror lives:** in place of its app folder (recommended: every tool works
   unchanged) or in a separate folder used with `WTS_HOME`.
