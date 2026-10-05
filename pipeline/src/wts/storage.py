"""Audio folder checks (spec §3.0.1). A missing mount is a machine problem, not an episode one."""

import shutil
from pathlib import Path


class MachineProblem(Exception):
    """Something wrong with this machine: stop the run, but don't charge any episode a retry."""


class StorageUnavailable(MachineProblem):
    pass


class ToolMissing(MachineProblem):
    pass


def check_audio_dir(path: Path, min_free_gb: float) -> None:
    if not path.exists():
        if not path.parent.exists():
            raise StorageUnavailable(f"audio folder {path} is not reachable (is the share mounted?)")
        path.mkdir()
    probe = path / ".wts-write-test"
    try:
        probe.write_bytes(b"")
        probe.unlink()
    except OSError as exc:
        raise StorageUnavailable(f"audio folder {path} is not writable: {exc}") from exc
    free_gb = shutil.disk_usage(path).free / 2**30
    if free_gb < min_free_gb:
        raise StorageUnavailable(
            f"audio folder {path} has {free_gb:.1f} GB free, need {min_free_gb:.1f} GB"
        )
