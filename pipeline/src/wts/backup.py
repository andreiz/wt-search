"""Backups of the app folder to `backup_dir` on the NAS (spec §3.0.1; plan 2, Task 16).

In order:
  1. A consistent snapshot of `state.db` with SQLite's backup API, into a local temp folder.
     It is safe while another connection writes; copying the live file (and its -wal) isn't.
  2. `rsync -a --delete` of the app folder to `<backup_dir>/wts/`, leaving out audio, the live
     database files, `*.tmp` and `.partial/`. Excluded files are also safe from `--delete`, so
     the previous snapshot stays in place until step 3.
  3. The snapshot goes in as `state.db` (copied beside it, then renamed), only after rsync has
     succeeded: a new state.db never sits beside transcripts that weren't all copied.

A failure is a `BackupFailed`; `wts run` turns it into a warning and a notification.
"""

import logging
import os
import shutil
import sqlite3
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

from wts.config import Config
from wts.paths import Paths

log = logging.getLogger("wts")

RSYNC_TIMEOUT_S = 1800  # the folder is under 1 GB; a hung share must not hold the run forever
RSYNC_VANISHED = 24  # "some files vanished before they could be transferred": still a backup
EXCLUDES = ("/audio/", "/state.db", "/state.db-wal", "/state.db-shm", "*.tmp", ".partial/")

Runner = Callable[[list[str]], subprocess.CompletedProcess]


class BackupFailed(Exception):
    """The backup didn't happen. Its message names folders and rsync's error, never secrets."""


def run_rsync(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=RSYNC_TIMEOUT_S,
                          check=False)


def rsync_command(app_dir: Path, dest: Path) -> list[str]:
    # Trailing slashes: copy the folder's contents into dest, not the folder into it.
    return ["rsync", "-a", "--delete", *(f"--exclude={p}" for p in EXCLUDES),
            f"{app_dir}/", f"{dest}/"]


def _last_line(text: str) -> str:
    lines = [line for line in (text or "").splitlines() if line.strip()]
    return lines[-1].strip() if lines else ""


def _reachable(root: Path) -> None:
    """`root` exists or can be made in a folder that exists, as for the audio folder."""
    if root.is_dir():
        return
    if not root.parent.is_dir():
        raise BackupFailed(f"backup folder {root} is not reachable (is the share mounted?)")
    try:
        root.mkdir()
    except OSError as exc:
        raise BackupFailed(f"backup folder {root} could not be created: {exc}") from exc


def _snapshot(state_db: Path, to: Path) -> None:
    if not state_db.exists():  # sqlite3.connect would create an empty one
        raise BackupFailed(f"{state_db} does not exist")
    src = sqlite3.connect(state_db)
    try:
        dst = sqlite3.connect(to)
        try:
            src.backup(dst)
            # One self-contained file: in WAL mode (copied from the source), opening the backup
            # would leave -wal and -shm files beside it, which a later snapshot mustn't meet.
            dst.execute("PRAGMA journal_mode = DELETE")
        finally:
            dst.close()
    except sqlite3.Error as exc:
        raise BackupFailed(f"snapshot of {state_db} failed: {exc}") from exc
    finally:
        src.close()


def backup(paths: Paths, cfg: Config, *, runner: Runner | None = None) -> Path | None:
    """Back up the app folder to `<backup_dir>/wts/` and return that folder; None (logged) when
    `backup_dir` isn't set. Raises BackupFailed."""
    if cfg.backup_dir is None:
        log.info("backup_dir is not set in config.toml; no backup", extra={"step": "backup"})
        return None
    runner = runner or run_rsync
    _reachable(cfg.backup_dir)
    dest = cfg.backup_dir / "wts"
    with tempfile.TemporaryDirectory(prefix="wts-backup-") as tmp:
        snapshot = Path(tmp) / "state.db"
        _snapshot(paths.state_db, snapshot)
        try:
            dest.mkdir(exist_ok=True)
        except OSError as exc:
            raise BackupFailed(f"backup folder {dest} could not be created: {exc}") from exc
        try:
            done = runner(rsync_command(paths.app_dir, dest))
        except FileNotFoundError as exc:
            raise BackupFailed("rsync not found") from exc
        except subprocess.TimeoutExpired as exc:
            raise BackupFailed(f"rsync timed out after {exc.timeout:.0f} s") from exc
        except OSError as exc:
            raise BackupFailed(f"rsync could not run: {exc}") from exc
        if done.returncode == RSYNC_VANISHED:
            log.warning(f"backup: some files vanished during the copy ({_last_line(done.stderr)})",
                        extra={"step": "backup"})
        elif done.returncode != 0:
            raise BackupFailed(f"rsync exited {done.returncode}: {_last_line(done.stderr)}")
        try:
            shutil.copyfile(snapshot, dest / "state.db.tmp")  # *.tmp: rsync leaves it alone
            os.replace(dest / "state.db.tmp", dest / "state.db")
        except OSError as exc:
            raise BackupFailed(f"copying state.db to {dest} failed: {exc}") from exc
    log.info(f"backed up to {dest}", extra={"step": "backup"})
    return dest
