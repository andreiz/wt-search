"""Batch steps: each selects eligible episodes, does the work, and moves their status."""

import json
import logging
import shutil
import sqlite3
import threading
import time
from collections import Counter
from collections.abc import Callable, Collection
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from datetime import UTC, datetime
from pathlib import Path

import httpx

from wts import storage
from wts.boilerplate import BoilerplateIndex
from wts.chunking import chunk_episode, refresh_chunks
from wts.config import Config
from wts.corrections import CORRECTIONS_FILE, corrections_sha, load_corrections
from wts.db import kv_get, kv_set
from wts.download import (
    RETRY_PAUSE_S,
    download_ad_free,
    has_inserted_ads,
    probe_duration_s,
)
from wts.embed import Embedder, embed_episode, get_embedder
from wts.feed import parse_feed, upsert_episodes
from wts.log import clock, plural, run_record
from wts.net import describe_http_error, new_client
from wts.notify import Notifier, get_notifier, notify_run
from wts.paths import Paths
from wts.platforms import match_platform_ids
from wts.publish import run_publish as publish_to
from wts.secrets import SecretStore, get_store
from wts.selection import resolve_selector
from wts.state import Status, advance, episodes_for_step, fail, reset
from wts.storage import MachineProblem, ToolMissing
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
    pause_s: float = RETRY_PAUSE_S,
    refetch_ads: bool = False,
) -> Counter:
    if probe is probe_duration_s and shutil.which("ffprobe") is None:
        raise ToolMissing("ffprobe not found; install ffmpeg (brew install ffmpeg)")
    storage.check_audio_dir(paths.audio_dir, cfg.min_free_gb)
    counts: Counter = Counter()
    if refetch_ads:
        # Copies stored with inserted ads go back to `new` (any transcript is redone).
        for episode_id in ids:
            row = conn.execute(
                "select status, audio_duration_s, duration_s from episodes where id = ?",
                (episode_id,),
            ).fetchone()
            if (
                row
                and row["status"] != Status.NEW
                and row["audio_duration_s"] is not None
                and has_inserted_ads(row["audio_duration_s"], row["duration_s"])
            ):
                reset(conn, episode_id, Status.NEW)
                counts["refetched"] += 1
    rows = iter(episodes_for_step(conn, "download", ids))
    client = client or new_client()
    stop = threading.Event()
    pool = ThreadPoolExecutor(max_workers=workers)
    in_flight: dict[Future, sqlite3.Row] = {}

    def refill() -> None:
        # Submit lazily so that stopping the run leaves nothing queued behind it.
        while len(in_flight) < workers and (row := next(rows, None)) is not None:
            job = pool.submit(
                download_ad_free, client, dict(row), paths.audio_dir, probe, stop,
                pause_s=pause_s,
            )
            in_flight[job] = row

    def record(row: sqlite3.Row, job: Future) -> None:
        extra = {"step": "download", "episode": row["stem"]}
        try:
            got = job.result()
        except OSError as exc:
            storage.check_audio_dir(paths.audio_dir, cfg.min_free_gb)  # raises if it's gone
            reason = repr(exc)
        except Exception as exc:  # noqa: BLE001 — one bad episode must not stop the batch
            reason = str(exc) or repr(exc)
        else:
            with conn:
                conn.execute(
                    "update episodes set audio_path = ?, audio_duration_s = ?, "
                    "ads_inserted = ? where id = ?",
                    (str(got.path), got.duration_s, int(got.ads_inserted), row["id"]),
                )
            advance(conn, row["id"], "download")
            counts["ok"] += 1
            if got.ads_inserted:
                counts["ads_inserted"] += 1
                log.warning(
                    f"downloaded, but every attempt had ads inserted "
                    f"(+{got.duration_s - row['duration_s']:.0f}s)",
                    extra=extra,
                )
            else:
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
    # Newest first: recent episodes are the ones people search for, and a long backlog run
    # makes them searchable before the archive.
    rows = episodes_for_step(conn, "transcribe", ids, newest_first=True)
    counts: Counter = Counter()
    if not rows:
        return counts
    transcriber = transcriber or get_transcriber()
    audio_s = [row["audio_duration_s"] or row["duration_s"] or 0 for row in rows]
    done_s = done_audio_s = 0.0
    for i, row in enumerate(rows, 1):
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
        elapsed = time.monotonic() - started
        done_s += elapsed
        done_audio_s += audio_s[i - 1]
        msg = f"transcribed in {clock(elapsed)}{_speed(audio_s[i - 1], elapsed)}; {i} of {len(rows)}"
        left_audio_s = sum(audio_s[i:])
        if left_audio_s and done_audio_s:
            msg += f", about {clock(left_audio_s * done_s / done_audio_s)} left"
        log.info(msg, extra={**extra, "duration_ms": int(elapsed * 1000)})
    if counts["ok"]:
        log.info(
            f"transcribed {plural(counts['ok'], 'episode')} in {clock(done_s)}"
            f"{_speed(done_audio_s, done_s)}",
            extra={"step": "transcribe"},
        )
    return counts


def _speed(audio_s: float, elapsed_s: float) -> str:
    if not audio_s:
        return ""
    return f" ({clock(audio_s)} of audio, {audio_s / max(elapsed_s, 0.001):.1f}× realtime)"


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
    chunked: list[int] = []
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
        chunked.append(row["id"])
        n, bp, flags = _chunk_stats(conn, [row["id"]])
        msg = f"chunked: {plural(n, 'chunk')}, {bp} boilerplate"
        log.info(msg + (f"; flags: {', '.join(flags[row['stem']])}" if flags else ""), extra=extra)

    # New episodes can turn earlier sentences into boilerplate (the 5-episode rule), and a
    # corrections.yaml edit changes text: re-check everything already chunked.
    sha = corrections_sha(corrections_file)
    if counts["ok"] or sha != kv_get(conn, "corrections_sha"):
        counts["refreshed"] = refresh_chunks(conn, corrections, index)
        kv_set(conn, "corrections_sha", sha)
    if chunked:
        # After the refresh, so boilerplate reflects every episode chunked so far.
        n, bp, flags = _chunk_stats(conn, chunked)
        counts.update(chunks=n, boilerplate=bp, flagged=len(flags))
        msg = (f"chunked {plural(len(chunked), 'episode')}: {plural(n, 'chunk')}, "
               f"{bp} boilerplate ({100 * bp / max(n, 1):.0f}%)")
        if flags:
            msg += "; flagged: " + ", ".join(f"{s} ({', '.join(f)})" for s, f in flags.items())
        log.info(msg, extra={"step": "chunk"})
    return counts


def _chunk_stats(
    conn: sqlite3.Connection, ids: list[int]
) -> tuple[int, int, dict[str, list[str]]]:
    """Chunks, boilerplate chunks, and the quality flags of flagged episodes, for `ids`."""
    marks = ", ".join("?" for _ in ids)
    n, bp = conn.execute(
        f"select count(*), coalesce(sum(is_boilerplate), 0) from chunks "
        f"where episode_id in ({marks})",
        ids,
    ).fetchone()
    flags = {
        r["stem"]: json.loads(r["flags"])
        for r in conn.execute(
            f"select stem, flags from episodes where id in ({marks}) order by published_at", ids
        )
        if json.loads(r["flags"] or "[]")
    }
    return n, bp, flags


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
    total_s = 0.0
    for row in rows:
        extra = {"step": "embed", "episode": row["stem"]}
        started = time.monotonic()
        try:
            fresh = embed_episode(conn, row, embedder, paths.embeddings_dir)
        except Exception as exc:  # noqa: BLE001 — one bad episode must not stop the batch
            fail(conn, row["id"], "embed", repr(exc)[:500])
            counts["error"] += 1
            log.error(f"embedding failed: {exc!r}", extra=extra)
            continue
        advance(conn, row["id"], "embed")
        elapsed = time.monotonic() - started
        total_s += elapsed
        n = conn.execute(
            "select count(*) from chunks where episode_id = ? and is_boilerplate = 0", (row["id"],)
        ).fetchone()[0]
        counts["ok"] += 1
        counts["chunks"] += n
        counts["vectors"] += fresh
        log.info(
            f"embedded {plural(n, 'chunk')} ({plural(fresh, 'new vector')}) in {clock(elapsed)}",
            extra={**extra, "duration_ms": int(elapsed * 1000)},
        )
    if counts["ok"]:
        log.info(
            f"embedded {plural(counts['ok'], 'episode')}: {plural(counts['chunks'], 'chunk')}, "
            f"{plural(counts['vectors'], 'new vector')}, "
            f"{counts['chunks'] - counts['vectors']} cached in {clock(total_s)}",
            extra={"step": "embed"},
        )
    return counts


def run_publish(
    conn: sqlite3.Connection, paths: Paths, cfg: Config, ids: Collection[int], *, env: str,
    **kwargs,
) -> Counter:
    """`wts publish --env`; see publish.py."""
    return publish_to(conn, paths, cfg, env, ids, **kwargs)


def run_feed(
    conn: sqlite3.Connection, cfg: Config, *, client: httpx.Client | None = None,
    force: bool = False, store: SecretStore | None = None,
) -> Counter:
    client = client or new_client()
    resp = client.get(cfg.feed_url, timeout=30, follow_redirects=True)
    resp.raise_for_status()
    result = upsert_episodes(conn, parse_feed(resp.content), force=force)
    log.info(f"feed: {result}", extra={"step": "feed"})
    counts = Counter(added=result.added, updated=result.updated, reset=result.reset)
    # Platform failures are logged and counted, never raised: the feed itself has landed.
    counts.update(match_platform_ids(conn, cfg, client, store or get_store()))
    return counts


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
    notifier: Notifier | None = None,
) -> dict[str, Counter]:
    """feed → download → transcribe → chunk → embed, then one notification (spec §6, §8.2).

    A feed fetch failure is logged, counted and notified, and the run goes on with the
    episodes already downloaded. A machine problem is notified and re-raised.
    """
    started = datetime.now(UTC).isoformat(timespec="seconds")
    notifier = notifier or get_notifier(client or new_client(), get_store(), cfg.ntfy_url)
    results: dict[str, Counter] = {}
    try:
        if cfg.feed_url:
            with run_record(conn, "feed") as run:
                try:
                    run.counts.update(run_feed(conn, cfg, client=client))
                except httpx.HTTPError as exc:  # not MassReset: that still stops the run
                    run.counts["error"] += 1
                    what = describe_http_error(exc)
                    log.error(f"feed fetch failed: {what}", extra={"step": "feed"})
                    notifier.send("wts: feed fetch failed", what, priority="high",
                                  tags=("warning",))
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
    except MachineProblem as exc:  # its message names folders or tools, never secrets
        notifier.send("wts: run stopped", str(exc), priority="high", tags=("rotating_light",))
        raise
    notify_run(notifier, conn, results, started)
    return results
