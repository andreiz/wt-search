"""Resumable, verified episode downloads (spec §3.2 `wts download`, §3.0.1)."""

import json
import subprocess
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit

import httpx

from wts.feed import normalize_audio_url

SHORTER_TOLERANCE = 0.02
MAX_INSERTED_ADS_S = 600
AD_FREE_SLACK_S = 5  # a copy this close to the feed's duration has no inserted ads
AD_FREE_ATTEMPTS = 5
RETRY_PAUSE_S = 2.0
CHUNK = 1 << 16


class ProbeError(Exception):
    pass


class DownloadAborted(Exception):
    """The run is stopping; the partial file is kept for the next run."""


class Downloaded(NamedTuple):
    path: Path
    duration_s: float  # as probed from the file we actually got
    ads_inserted: bool = False


def probe_duration_s(path: Path) -> float:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        if proc.returncode != 0:
            raise ValueError(proc.stderr.strip())
        return float(proc.stdout.strip())
    except ValueError as exc:
        raise ProbeError(f"ffprobe could not read {path.name}: {exc}") from exc


def _extension(url: str) -> str:
    return Path(urlsplit(url).path).suffix or ".mp3"


def _read_meta(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def download_episode(
    client: httpx.Client,
    row: Mapping,
    audio_dir: Path,
    probe: Callable[[Path], float] = probe_duration_s,
    stop: threading.Event | None = None,
) -> Downloaded:
    name = f"{row['stem']}{_extension(row['audio_url'])}"
    partial = audio_dir / ".partial" / name
    meta_file = partial.with_name(partial.name + ".json")
    partial.parent.mkdir(parents=True, exist_ok=True)

    # Resume only when we can prove the server still has the same file: same URL and a
    # validator for If-Range. Otherwise ads inserted per request could splice two versions.
    url_key = normalize_audio_url(row["audio_url"])
    meta = _read_meta(meta_file)
    have = partial.stat().st_size if partial.exists() else 0
    resumable = bool(have and meta.get("url") == url_key and meta.get("validator"))
    headers = {"Range": f"bytes={have}-", "If-Range": meta["validator"]} if resumable else {}

    with client.stream(
        "GET", row["audio_url"], headers=headers, follow_redirects=True, timeout=60
    ) as resp:
        if not (resumable and resp.status_code == 416):  # 416: we already have every byte
            resp.raise_for_status()
            appending = resumable and resp.status_code == 206
            if not appending:
                validator = resp.headers.get("etag") or resp.headers.get("last-modified")
                meta_file.write_text(json.dumps({"url": url_key, "validator": validator}))
            with partial.open("ab" if appending else "wb") as out:
                for block in resp.iter_bytes(CHUNK):
                    if stop is not None and stop.is_set():
                        raise DownloadAborted(name)
                    out.write(block)
    try:
        seconds = probe(partial)
        expected = row["duration_s"]
        # Truncated downloads are short. Files are often *longer* than the feed says,
        # because ads are inserted per download, so allow up to MAX_INSERTED_ADS_S extra.
        if expected and seconds < expected * (1 - SHORTER_TOLERANCE):
            raise ProbeError(
                f"duration {seconds:.0f}s is over 2% shorter than the feed's {expected}s"
            )
        if expected and seconds > expected + MAX_INSERTED_ADS_S:
            raise ProbeError(
                f"duration {seconds:.0f}s is over {MAX_INSERTED_ADS_S // 60} min longer "
                f"than the feed's {expected}s"
            )
    except ProbeError:
        partial.unlink(missing_ok=True)
        meta_file.unlink(missing_ok=True)
        raise
    final = audio_dir / name
    partial.replace(final)
    meta_file.unlink(missing_ok=True)
    return Downloaded(final, seconds)


def has_inserted_ads(seconds: float, feed_duration_s: int | None) -> bool:
    return bool(feed_duration_s) and seconds > feed_duration_s + AD_FREE_SLACK_S


def download_ad_free(
    client: httpx.Client,
    row: Mapping,
    audio_dir: Path,
    probe: Callable[[Path], float] = probe_duration_s,
    stop: threading.Event | None = None,
    attempts: int = AD_FREE_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
    pause_s: float = RETRY_PAUSE_S,
) -> Downloaded:
    """Download until we get a copy without inserted ads (length matches the feed).

    Acast stitches ads into each download differently; an ad-free copy carries the show's own
    timeline. If every attempt has ads, keep the shortest copy and report ads_inserted.
    """
    best: Downloaded | None = None
    best_file = audio_dir / ".partial" / f"{row['stem']}.best"
    for attempt in range(attempts):
        if attempt:
            if stop is not None and stop.is_set():
                raise DownloadAborted(row["stem"])
            sleep(pause_s)
        got = download_episode(client, row, audio_dir, probe, stop)
        if not has_inserted_ads(got.duration_s, row["duration_s"]):
            best_file.unlink(missing_ok=True)
            return got
        if best is None or got.duration_s < best.duration_s:
            got.path.replace(best_file)
            best = got
        else:
            got.path.unlink()
    assert best is not None
    best_file.replace(best.path)
    return Downloaded(best.path, best.duration_s, ads_inserted=True)
