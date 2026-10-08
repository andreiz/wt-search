"""Backups (plan 2, Task 16; spec §3.0.1). rsync is faked: the tests check its command line, and
`backup()`'s own work (snapshot, folders, errors) runs for real. A Mac-only test runs the real
rsync (macOS ships openrsync since 15.4), to check the excludes do what the command line says."""

import shutil
import sqlite3
import subprocess
from dataclasses import replace

import pytest

from wts import backup as backup_mod
from wts.backup import BackupFailed, backup
from wts.db import connect, kv_set


class FakeRsync:
    """Records each command line; answers with `returncode` and `stderr`, or raises `exc`."""

    def __init__(self, returncode=0, stderr="", exc=None):
        self.returncode, self.stderr, self.exc = returncode, stderr, exc
        self.calls: list[list[str]] = []

    def __call__(self, args):
        self.calls.append(args)
        if self.exc:
            raise self.exc
        return subprocess.CompletedProcess(args, self.returncode, "", self.stderr)


@pytest.fixture
def nas(tmp_path):
    """A mounted share: the folder exists, `backup_dir` inside it doesn't yet."""
    share = tmp_path / "Volumes" / "media"
    share.mkdir(parents=True)
    return share


@pytest.fixture
def state(paths):
    c = connect(paths.state_db)
    kv_set(c, "committed", "yes")
    yield c
    c.close()


def snapshot_value(path, key):
    with sqlite3.connect(path) as db:
        assert db.execute("pragma integrity_check").fetchone()[0] == "ok"
        row = db.execute("select value from kv where key = ?", (key,)).fetchone()
    return row[0] if row else None


def test_no_backup_dir_is_none_and_logged(paths, cfg, state, wts_messages):
    rsync = FakeRsync()
    assert backup(paths, cfg, runner=rsync) is None
    assert rsync.calls == []
    assert any("backup_dir is not set" in m for m in wts_messages)


def test_rsync_command_line(paths, cfg, state, nas):
    rsync = FakeRsync()
    dest = backup(paths, replace(cfg, backup_dir=nas / "backup"), runner=rsync)
    assert dest == nas / "backup" / "wts"
    assert rsync.calls == [[
        "rsync", "-a", "--delete",
        "--exclude=/audio/",
        "--exclude=/state.db", "--exclude=/state.db-wal", "--exclude=/state.db-shm",
        "--exclude=*.tmp", "--exclude=.partial/",
        f"{paths.app_dir}/", f"{dest}/",
    ]]


def test_snapshot_is_copied_in_as_state_db(paths, cfg, state, nas):
    dest = backup(paths, replace(cfg, backup_dir=nas / "backup"), runner=FakeRsync())
    assert snapshot_value(dest / "state.db", "committed") == "yes"
    with sqlite3.connect(dest / "state.db") as db:
        assert db.execute("pragma journal_mode").fetchone()[0] == "delete"
    # No temp file left, and opening the snapshot left no -wal or -shm beside it.
    assert sorted(p.name for p in dest.iterdir()) == ["state.db"]


def test_snapshot_is_valid_while_another_connection_holds_a_write_transaction(
    paths, cfg, state, nas
):
    state.execute("begin immediate")
    state.execute("insert into kv (key, value) values ('uncommitted', 'no')")
    try:
        dest = backup(paths, replace(cfg, backup_dir=nas / "backup"), runner=FakeRsync())
    finally:
        state.rollback()
    assert snapshot_value(dest / "state.db", "committed") == "yes"
    assert snapshot_value(dest / "state.db", "uncommitted") is None


def test_unreachable_backup_dir_fails_without_calling_rsync(paths, cfg, state, tmp_path):
    rsync = FakeRsync()
    with pytest.raises(BackupFailed, match="not reachable"):
        backup(paths, replace(cfg, backup_dir=tmp_path / "unmounted" / "wts" / "backup"),
               runner=rsync)
    assert rsync.calls == []


def test_rsync_failure_keeps_the_previous_snapshot(paths, cfg, state, nas):
    dest = nas / "backup" / "wts"
    dest.mkdir(parents=True)
    (dest / "state.db").write_text("previous snapshot")
    rsync = FakeRsync(23, "rsync: failed to set times on x\n"
                          "rsync error: some files could not be transferred (code 23)\n")
    with pytest.raises(BackupFailed, match=r"rsync exited 23: rsync error: some files"):
        backup(paths, replace(cfg, backup_dir=nas / "backup"), runner=rsync)
    # A new state.db must not sit beside files that weren't all copied.
    assert (dest / "state.db").read_text() == "previous snapshot"


@pytest.mark.parametrize(
    ("exc", "message"),
    [(FileNotFoundError("rsync"), "rsync not found"),
     (subprocess.TimeoutExpired(["rsync"], 1800), "rsync timed out")],
    ids=["missing", "timeout"],
)
def test_rsync_that_cannot_run_is_a_backup_failure(paths, cfg, state, nas, exc, message):
    with pytest.raises(BackupFailed, match=message):
        backup(paths, replace(cfg, backup_dir=nas / "backup"), runner=FakeRsync(exc=exc))


def test_files_that_vanished_during_the_copy_are_a_warning(paths, cfg, state, nas, wts_messages):
    rsync = FakeRsync(24, "file has vanished: x.json\n")
    dest = backup(paths, replace(cfg, backup_dir=nas / "backup"), runner=rsync)
    assert (dest / "state.db").exists()
    assert any("vanished" in m for m in wts_messages)


def test_missing_state_db_is_a_backup_failure(paths, cfg, nas):
    with pytest.raises(BackupFailed, match="state.db"):
        backup(paths, replace(cfg, backup_dir=nas / "backup"), runner=FakeRsync())
    assert not paths.state_db.exists()  # not created empty by the attempt


def test_default_runner_is_looked_up_when_called(paths, cfg, state, nas, monkeypatch):
    rsync = FakeRsync()
    monkeypatch.setattr(backup_mod, "run_rsync", rsync)
    backup(paths, replace(cfg, backup_dir=nas / "backup"))
    assert len(rsync.calls) == 1


@pytest.mark.mac
@pytest.mark.skipif(shutil.which("rsync") is None, reason="needs rsync")
def test_real_rsync_copies_the_app_folder_but_not_audio(paths, cfg, state, nas):
    # Run on the Mac: uv run pytest -m mac -k real_rsync
    app = paths.app_dir
    (app / "data" / "transcripts").mkdir(parents=True)
    (app / "data" / "transcripts" / "ep1.json").write_text("{}")
    (app / "config.toml").write_text('feed_url = "x"\n')
    (app / "audio" / ".partial").mkdir(parents=True)
    (app / "audio" / "ep1.mp3").write_bytes(b"mp3")
    (app / "data" / "half.tmp").write_text("x")
    old = nas / "backup" / "wts" / "data" / "transcripts"
    old.mkdir(parents=True)
    (old / "gone.json").write_text("{}")  # deleted locally since the last backup

    dest = backup(paths, replace(cfg, backup_dir=nas / "backup"))

    assert (dest / "data" / "transcripts" / "ep1.json").exists()
    assert (dest / "config.toml").exists()
    assert not (dest / "audio").exists()
    assert not (dest / "data" / "half.tmp").exists()
    assert not (dest / "data" / "transcripts" / "gone.json").exists()
    assert not (dest / "state.db-wal").exists() and not (dest / "state.db-shm").exists()
    assert snapshot_value(dest / "state.db", "committed") == "yes"
