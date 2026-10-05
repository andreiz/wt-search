"""Batch steps: each selects eligible episodes, does the work, and moves their status."""

import logging
import sqlite3
import time
from collections import Counter
from collections.abc import Callable, Collection
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from wts import storage
from wts.config import Config
from wts.download import ProbeError, download_episode, probe_duration_s
from wts.paths import Paths
from wts.state import advance, episodes_for_step, fail
from wts.transcribe import VOCAB_FILE, Transcriber, get_transcriber, transcribe_episode

log = logging.getLogger("wts")


def run_download(
    conn: sqlite3.Connection,
    paths: Paths,
    cfg: Config,
    ids: Collection[int],
    *,
    client: httpx.Client | None = None,
    probe: Callable[[Path], float] = probe_duration_s,
    workers: int = 4,
) -> Counter:
    storage.check_audio_dir(paths.audio_dir, cfg.min_free_gb)
    rows = episodes_for_step(conn, "download", ids)
    counts: Counter = Counter()
    client = client or httpx.Client()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            (row, pool.submit(download_episode, client, dict(row), paths.audio_dir, probe))
            for row in rows
        ]
        for row, future in futures:
            extra = {"step": "download", "episode": row["stem"]}
            try:
                path = future.result()
            except (ProbeError, httpx.HTTPError) as exc:
                fail(conn, row["id"], "download", str(exc)[:500])
                counts["error"] += 1
                log.error(f"download failed: {exc}", extra=extra)
                continue
            except OSError as exc:
                storage.check_audio_dir(paths.audio_dir, cfg.min_free_gb)  # raises if it's gone
                fail(conn, row["id"], "download", repr(exc)[:500])
                counts["error"] += 1
                log.error(f"download failed: {exc!r}", extra=extra)
                continue
            with conn:
                conn.execute(
                    "update episodes set audio_path = ? where id = ?", (str(path), row["id"])
                )
            advance(conn, row["id"], "download")
            counts["ok"] += 1
            log.info("downloaded", extra=extra)
    return counts


def run_transcribe(
    conn: sqlite3.Connection,
    paths: Paths,
    cfg: Config,
    ids: Collection[int],
    *,
    transcriber: Transcriber | None = None,
    vocab_file: Path = VOCAB_FILE,
) -> Counter:
    storage.check_audio_dir(paths.audio_dir, cfg.min_free_gb)
    rows = episodes_for_step(conn, "transcribe", ids)
    counts: Counter = Counter()
    if not rows:
        return counts
    transcriber = transcriber or get_transcriber()
    for row in rows:
        extra = {"step": "transcribe", "episode": row["stem"]}
        started = time.monotonic()
        try:
            out = transcribe_episode(row, transcriber, paths.transcripts_dir, vocab_file)
        except KeyboardInterrupt:
            log.warning("interrupted; episode left as downloaded", extra=extra)
            raise
        except Exception as exc:
            fail(conn, row["id"], "transcribe", repr(exc)[:500])
            counts["error"] += 1
            log.exception("transcription failed", extra=extra)
            continue
        with conn:
            conn.execute(
                "update episodes set transcript_path = ? where id = ?", (str(out), row["id"])
            )
        advance(conn, row["id"], "transcribe")
        counts["ok"] += 1
        elapsed_ms = int((time.monotonic() - started) * 1000)
        log.info("transcribed", extra={**extra, "duration_ms": elapsed_ms})
    return counts
