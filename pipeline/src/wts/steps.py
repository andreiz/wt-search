"""Batch steps: each selects eligible episodes, does the work, and moves their status."""

import logging
import sqlite3
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
