"""Batch steps: each selects eligible episodes, does the work, and moves their status."""

import logging
import shutil
import sqlite3
import threading
import time
from collections import Counter
from collections.abc import Callable, Collection
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from pathlib import Path

import httpx

from wts import storage
from wts.boilerplate import BoilerplateIndex
from wts.chunking import chunk_episode, refresh_chunks
from wts.config import Config
from wts.corrections import CORRECTIONS_FILE, corrections_sha, load_corrections
from wts.db import kv_get, kv_set
from wts.download import download_episode, probe_duration_s
from wts.embed import Embedder, embed_episode, get_embedder
from wts.feed import parse_feed, upsert_episodes
from wts.log import run_record
from wts.paths import Paths
from wts.selection import resolve_selector
from wts.state import Status, advance, episodes_for_step, fail, reset
from wts.storage import ToolMissing
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
    if probe is probe_duration_s and shutil.which("ffprobe") is None:
        raise ToolMissing("ffprobe not found; install ffmpeg (brew install ffmpeg)")
    storage.check_audio_dir(paths.audio_dir, cfg.min_free_gb)
    rows = iter(episodes_for_step(conn, "download", ids))
    counts: Counter = Counter()
    client = client or httpx.Client()
    stop = threading.Event()
    pool = ThreadPoolExecutor(max_workers=workers)
    in_flight: dict[Future, sqlite3.Row] = {}

    def refill() -> None:
        # Submit lazily so that stopping the run leaves nothing queued behind it.
        while len(in_flight) < workers and (row := next(rows, None)) is not None:
            job = pool.submit(download_episode, client, dict(row), paths.audio_dir, probe, stop)
            in_flight[job] = row

    def record(row: sqlite3.Row, job: Future) -> None:
        extra = {"step": "download", "episode": row["stem"]}
        try:
            path = job.result()
        except OSError as exc:
            storage.check_audio_dir(paths.audio_dir, cfg.min_free_gb)  # raises if it's gone
            reason = repr(exc)
        except Exception as exc:  # noqa: BLE001 — one bad episode must not stop the batch
            reason = str(exc) or repr(exc)
        else:
            with conn:
                conn.execute(
                    "update episodes set audio_path = ? where id = ?", (str(path), row["id"])
                )
            advance(conn, row["id"], "download")
            counts["ok"] += 1
            log.info("downloaded", extra=extra)
            return
        fail(conn, row["id"], "download", reason[:500])
        counts["error"] += 1
        log.error(f"download failed: {reason}", extra=extra)

    try:
        refill()
        while in_flight:
            done, _ = wait(in_flight, return_when=FIRST_COMPLETED)
            for job in done:
                record(in_flight.pop(job), job)
            refill()
    except BaseException:
        stop.set()  # running downloads stop at their next block; partials are kept
        raise
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
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
        except OSError as exc:
            storage.check_audio_dir(paths.audio_dir, cfg.min_free_gb)  # raises if it's gone
            fail(conn, row["id"], "transcribe", repr(exc)[:500])
            counts["error"] += 1
            log.exception("transcription failed", extra=extra)
            continue
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


def run_chunk(
    conn: sqlite3.Connection,
    paths: Paths,
    cfg: Config,
    ids: Collection[int],
    *,
    force: bool = False,
    corrections_file: Path = CORRECTIONS_FILE,
) -> Counter:
    corrections = load_corrections(corrections_file)
    index = BoilerplateIndex(conn)
    counts: Counter = Counter()
    if force:
        done = (Status.CHUNKED, Status.EMBEDDED, Status.PUBLISHED)
        for episode_id in ids:
            row = conn.execute("select status from episodes where id = ?", (episode_id,)).fetchone()
            if row and row["status"] in done:
                reset(conn, episode_id, Status.TRANSCRIBED)
    for row in episodes_for_step(conn, "chunk", ids):
        extra = {"step": "chunk", "episode": row["stem"]}
        try:
            chunk_episode(conn, row, corrections, index)
        except Exception as exc:  # noqa: BLE001 — one bad episode must not stop the batch
            fail(conn, row["id"], "chunk", repr(exc)[:500])
            counts["error"] += 1
            log.error(f"chunking failed: {exc!r}", extra=extra)
            continue
        advance(conn, row["id"], "chunk")
        counts["ok"] += 1
        log.info("chunked", extra=extra)

    # New episodes can turn earlier sentences into boilerplate (the 5-episode rule), and a
    # corrections.yaml edit changes text: re-check everything already chunked.
    sha = corrections_sha(corrections_file)
    if counts["ok"] or sha != kv_get(conn, "corrections_sha"):
        counts["refreshed"] = refresh_chunks(conn, corrections, index)
        kv_set(conn, "corrections_sha", sha)
    return counts


def run_embed(
    conn: sqlite3.Connection,
    paths: Paths,
    cfg: Config,
    ids: Collection[int],
    *,
    embedder: Embedder | None = None,
) -> Counter:
    rows = episodes_for_step(conn, "embed", ids)
    counts: Counter = Counter()
    if not rows:
        return counts
    embedder = embedder or get_embedder()  # loading the model is slow; only when needed
    for row in rows:
        extra = {"step": "embed", "episode": row["stem"]}
        try:
            fresh = embed_episode(conn, row, embedder, paths.embeddings_dir)
        except Exception as exc:  # noqa: BLE001 — one bad episode must not stop the batch
            fail(conn, row["id"], "embed", repr(exc)[:500])
            counts["error"] += 1
            log.error(f"embedding failed: {exc!r}", extra=extra)
            continue
        advance(conn, row["id"], "embed")
        counts["ok"] += 1
        counts["vectors"] += fresh
        log.info(f"embedded ({fresh} new vectors)", extra=extra)
    return counts


def run_feed(
    conn: sqlite3.Connection, cfg: Config, *, client: httpx.Client | None = None,
    force: bool = False,
) -> Counter:
    client = client or httpx.Client()
    resp = client.get(cfg.feed_url, timeout=30, follow_redirects=True)
    resp.raise_for_status()
    result = upsert_episodes(conn, parse_feed(resp.content), force=force)
    log.info(f"feed: {result}", extra={"step": "feed"})
    return Counter(added=result.added, updated=result.updated, reset=result.reset)


def run_all(
    conn: sqlite3.Connection,
    paths: Paths,
    cfg: Config,
    selector: str,
    *,
    client: httpx.Client | None = None,
    transcriber: Transcriber | None = None,
    embedder: Embedder | None = None,
    probe: Callable[[Path], float] = probe_duration_s,
) -> dict[str, Counter]:
    """feed → download → transcribe → chunk → embed. Publish is added in plan 2."""
    results: dict[str, Counter] = {}
    if cfg.feed_url:
        with run_record(conn, "feed") as run:
            run.counts.update(run_feed(conn, cfg, client=client))
        results["feed"] = run.counts
    else:
        log.warning("feed_url is not set; skipping the feed step", extra={"step": "feed"})
    ids = resolve_selector(conn, selector)
    steps = [
        ("download", lambda: run_download(conn, paths, cfg, ids, client=client, probe=probe)),
        ("transcribe", lambda: run_transcribe(conn, paths, cfg, ids, transcriber=transcriber)),
        ("chunk", lambda: run_chunk(conn, paths, cfg, ids)),
        ("embed", lambda: run_embed(conn, paths, cfg, ids, embedder=embedder)),
    ]
    for name, step in steps:
        with run_record(conn, name) as run:
            run.counts.update(step())
        results[name] = run.counts
    return results
