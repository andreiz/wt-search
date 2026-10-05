"""Resumable, verified episode downloads (spec §3.2 `wts download`, §3.0.1)."""

import subprocess
from collections.abc import Callable, Mapping
from pathlib import Path
from urllib.parse import urlsplit

import httpx

DURATION_TOLERANCE = 0.02
CHUNK = 1 << 16


class ProbeError(Exception):
    pass


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


def download_episode(
    client: httpx.Client,
    row: Mapping,
    audio_dir: Path,
    probe: Callable[[Path], float] = probe_duration_s,
) -> Path:
    name = f"{row['stem']}{_extension(row['audio_url'])}"
    partial = audio_dir / ".partial" / name
    partial.parent.mkdir(parents=True, exist_ok=True)
    have = partial.stat().st_size if partial.exists() else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with client.stream(
        "GET", row["audio_url"], headers=headers, follow_redirects=True, timeout=60
    ) as resp:
        resp.raise_for_status()
        mode = "ab" if have and resp.status_code == 206 else "wb"
        with partial.open(mode) as out:
            for block in resp.iter_bytes(CHUNK):
                out.write(block)
    try:
        seconds = probe(partial)
        expected = row["duration_s"]
        if expected and abs(seconds - expected) > DURATION_TOLERANCE * expected:
            raise ProbeError(f"duration {seconds:.0f}s differs from feed's {expected}s by over 2%")
    except ProbeError:
        partial.unlink(missing_ok=True)
        raise
    final = audio_dir / name
    partial.replace(final)
    return final
