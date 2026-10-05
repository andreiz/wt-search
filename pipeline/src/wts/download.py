"""Resumable, verified episode downloads (spec §3.2 `wts download`, §3.0.1)."""

import json
import subprocess
import threading
from collections.abc import Callable, Mapping
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from wts.feed import normalize_audio_url

DURATION_TOLERANCE = 0.02
CHUNK = 1 << 16


class ProbeError(Exception):
    pass


class DownloadAborted(Exception):
    """The run is stopping; the partial file is kept for the next run."""


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
) -> Path:
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
        if expected and abs(seconds - expected) > DURATION_TOLERANCE * expected:
            raise ProbeError(f"duration {seconds:.0f}s differs from feed's {expected}s by over 2%")
    except ProbeError:
        partial.unlink(missing_ok=True)
        meta_file.unlink(missing_ok=True)
        raise
    final = audio_dir / name
    partial.replace(final)
    meta_file.unlink(missing_ok=True)
    return final
