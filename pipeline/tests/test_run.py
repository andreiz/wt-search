import sqlite3
from collections import Counter
from dataclasses import replace
from functools import partial
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import respx
from click.testing import CliRunner
from conftest import FakeEmbedder, FakeTranscriber, status_of
from test_backup import FakeRsync
from test_notify import FakeNotifier
from test_publish import Target

from wts import backup as backup_mod
from wts import publish, steps
from wts.backup import BackupFailed
from wts.cli import main
from wts.db import connect
from wts.feed import parse_feed, upsert_episodes
from wts.selection import add_to_scope, resolve_selector
from wts.steps import run_all

FEED_URL = "https://feed.example/rss"
FEED = (Path(__file__).parent / "fixtures" / "feed.xml").read_bytes()


@pytest.fixture
def mocked_feed_and_audio(tmp_path):
    with respx.mock(assert_all_called=False) as mock:
        mock.get(FEED_URL).mock(return_value=httpx.Response(200, content=FEED))
        mock.get(url__regex=r"https://cdn\.example\.com/.*").mock(
            return_value=httpx.Response(200, content=b"audio")
        )

        def probe(path):  # the feed's own duration, so the 2% check passes
            # Runs in a download worker thread: needs its own connection.
            with sqlite3.connect(tmp_path / "state.db") as db:
                row = db.execute("select duration_s from episodes where stem = ?", (path.stem,))
                return float(row.fetchone()[0])

        yield SimpleNamespace(probe=probe)


def upsert_from_fixture_and_scope(conn, selector):
    upsert_episodes(conn, parse_feed(FEED))
    add_to_scope(conn, resolve_selector(conn, selector))


def scoped(conn):
    return resolve_selector(conn, "scope")


def test_run_all_takes_scoped_episodes_to_embedded(conn, paths, cfg, mocked_feed_and_audio):
    upsert_from_fixture_and_scope(conn, "recent:3")
    results = run_all(
        conn,
        paths,
        replace(cfg, feed_url=FEED_URL),
        "scope",
        transcriber=FakeTranscriber(),
        embedder=FakeEmbedder(),
        probe=mocked_feed_and_audio.probe,
    )
    assert [status_of(conn, e) for e in scoped(conn)] == ["embedded"] * 3
    assert results["download"]["ok"] == 3 and results["embed"]["ok"] == 3
    assert conn.execute("select count(*) from runs").fetchone()[0] >= 5
    others = set(resolve_selector(conn, "all")) - set(scoped(conn))
    assert all(status_of(conn, e) == "new" for e in others)  # out of scope: untouched


def test_run_all_processes_a_new_release_in_the_same_run(conn, paths, cfg, mocked_feed_and_audio):
    # Open decision 3 (a): the feed puts a new release in scope, and the steps after it pick
    # it up, so a scheduled run needs no `wts scope add`.
    items = parse_feed(FEED)
    newest = max(items, key=lambda i: i.published_at)
    upsert_episodes(conn, [i for i in items if i.guid != newest.guid])
    results = run_all(conn, paths, replace(cfg, feed_url=FEED_URL), "scope",
                      transcriber=FakeTranscriber(), embedder=FakeEmbedder(),
                      probe=mocked_feed_and_audio.probe, notifier=FakeNotifier())
    assert results["feed"]["scoped"] == 1
    (row,) = conn.execute("select guid, status from episodes where in_scope = 1").fetchall()
    assert tuple(row) == (newest.guid, "embedded")


def test_run_all_without_feed_url_skips_feed(conn, paths, cfg):
    results = run_all(conn, paths, cfg, "scope", transcriber=FakeTranscriber(),
                      embedder=FakeEmbedder(), probe=lambda p: 0.0)
    assert "feed" not in results


def test_run_stops_cleanly_when_audio_dir_missing(paths, mocked_feed_and_audio):
    (paths.app_dir / "config.toml").write_text(
        f'feed_url = "{FEED_URL}"\naudio_dir = "/nonexistent/Volumes/media/wts/audio"\n'
    )
    r = CliRunner(env={"WTS_HOME": str(paths.app_dir)}).invoke(main, ["run"])
    assert r.exit_code == 3 and "audio" in r.output.lower()


# --- publish, backup and notify (plan 2, Task 16) -------------------------------------------


@pytest.fixture
def calls(monkeypatch):
    """Records publish, backup and the summary notification in the order run_all makes them."""
    made: list[tuple] = []

    def fake_publish(conn, paths, cfg, ids, *, env, **kwargs):
        made.append(("publish", env, sorted(ids)))
        return Counter(ok=len(ids))

    def fake_backup(paths, cfg):
        made.append(("backup",))
        return paths.app_dir / "backup"

    def fake_notify_run(notifier, conn, results, started):
        made.append(("notify", sorted(results)))
        return True

    monkeypatch.setattr(steps, "run_publish", fake_publish)
    monkeypatch.setattr(steps, "backup", fake_backup)
    monkeypatch.setattr(steps, "notify_run", fake_notify_run)
    return made


def quick_run(conn, paths, cfg, **kwargs):
    return run_all(conn, paths, cfg, "scope", transcriber=FakeTranscriber(),
                   embedder=FakeEmbedder(), probe=lambda p: 0.0,
                   notifier=kwargs.pop("notifier", FakeNotifier()), **kwargs)


def test_run_all_with_env_publishes_then_backs_up_then_notifies(conn, paths, cfg, calls):
    upsert_from_fixture_and_scope(conn, "recent:2")
    results = quick_run(conn, paths, cfg, env="staging")
    assert [c[0] for c in calls] == ["publish", "backup", "notify"]
    assert calls[0] == ("publish", "staging", sorted(scoped(conn)))
    # The summary sees both steps' counts.
    assert calls[2] == ("notify", ["backup", "chunk", "download", "embed", "publish",
                                   "transcribe"])
    assert results["publish"]["ok"] == 2 and results["backup"]["ok"] == 1


def test_run_all_without_env_skips_publish_with_a_warning(conn, paths, cfg, calls, wts_messages):
    results = quick_run(conn, paths, cfg)
    assert [c[0] for c in calls] == ["backup", "notify"]
    assert "publish" not in results
    assert any("not publishing" in m and "run_env" in m for m in wts_messages)


def test_run_all_without_backup_dir_counts_nothing(conn, paths, cfg, calls, monkeypatch):
    monkeypatch.setattr(steps, "backup", lambda paths, cfg: None)
    results = quick_run(conn, paths, cfg)
    assert results["backup"]["ok"] == 0 and results["backup"]["error"] == 0


def test_a_backup_failure_is_a_warning_and_a_notification(conn, paths, cfg, calls, monkeypatch,
                                                          wts_messages):
    def broken(paths, cfg):
        raise BackupFailed("backup folder /Volumes/media/wts/backup is not reachable")

    monkeypatch.setattr(steps, "backup", broken)
    notifier = FakeNotifier()
    results = quick_run(conn, paths, cfg, env="staging", notifier=notifier)  # doesn't raise
    assert results["backup"]["error"] == 1
    (msg,) = notifier.sent
    assert msg["title"] == "wts: backup failed" and msg["priority"] == "high"
    assert "/Volumes/media/wts/backup" in msg["body"]
    assert any("backup failed" in m for m in wts_messages)
    assert calls[-1][0] == "notify"  # the run summary still goes out, last


def test_run_all_end_to_end_publishes_and_backs_up(paths, cfg, mocked_feed_and_audio, tmp_path,
                                                   monkeypatch):
    conn = connect(paths.state_db)  # the database backup() snapshots

    def probe(path):
        with sqlite3.connect(paths.state_db) as db:
            row = db.execute("select duration_s from episodes where stem = ?", (path.stem,))
            return float(row.fetchone()[0])

    upsert_from_fixture_and_scope(conn, "recent:2")
    target = Target()
    monkeypatch.setattr(steps, "publish_to",
                        partial(publish.run_publish, d1=target.d1, vectorize=target.vec))
    rsync = FakeRsync()
    monkeypatch.setattr(backup_mod, "run_rsync", rsync)
    (tmp_path / "nas").mkdir()
    notifier = FakeNotifier()
    results = run_all(
        conn, paths, replace(cfg, feed_url=FEED_URL, backup_dir=tmp_path / "nas" / "backup"),
        "scope", env="staging", transcriber=FakeTranscriber(), embedder=FakeEmbedder(),
        probe=probe, notifier=notifier,
    )
    ids = scoped(conn)
    assert [status_of(conn, e) for e in ids] == ["published"] * 2
    assert results["publish"]["ok"] == 2 and results["backup"]["ok"] == 1
    assert sorted(r[0] for r in target.d1.rows("select id from episodes")) == sorted(ids)
    assert len(rsync.calls) == 1
    with sqlite3.connect(tmp_path / "nas" / "backup" / "wts" / "state.db") as snapshot:
        statuses = [r[0] for r in snapshot.execute(
            "select status from episodes where in_scope = 1")]
    assert statuses == ["published"] * 2  # the backup is taken after publishing
    (msg,) = notifier.sent
    assert msg["title"] == "wts: published 2 episodes"


# --- wts run --env --------------------------------------------------------------------------

CLOUDFLARE = (
    'cloudflare_account_id = "acc"\n'
    '[env.staging]\nd1_database_id = "d"\nvectorize_index = "wts-chunks-staging"\n'
)


@pytest.fixture
def cli_run(paths, monkeypatch):
    """`wts run` through the CLI, with run_all replaced: records the env it was given."""
    got = {}

    def fake_run_all(conn, paths, cfg, selector, *, env=None):
        got["env"] = env
        return {}

    monkeypatch.setattr(steps, "run_all", fake_run_all)
    monkeypatch.setenv("WTS_SECRET_CLOUDFLARE_API_TOKEN", "t0ken")

    def invoke(*args, config=""):
        (paths.app_dir / "config.toml").write_text(config)
        return CliRunner().invoke(main, ["run", *args]), got

    return invoke


@pytest.mark.parametrize(
    ("args", "config", "expected"),
    [((), "", None),
     (("--env", "staging"), CLOUDFLARE, "staging"),
     ((), 'run_env = "staging"\n' + CLOUDFLARE, "staging")],
    ids=["neither", "flag", "run_env"],
)
def test_cli_run_env_comes_from_the_flag_or_run_env(cli_run, args, config, expected):
    result, got = cli_run(*args, config=config)
    assert result.exit_code == 0, result.output
    assert got == {"env": expected}


def test_cli_run_checks_the_env_config_before_starting(cli_run):
    result, got = cli_run("--env", "staging")
    assert result.exit_code == 2
    assert "[env.staging]" in result.output and got == {}


def test_cli_run_checks_run_env_too(cli_run):
    result, got = cli_run(config='run_env = "prod"\n' + CLOUDFLARE)
    assert result.exit_code == 2
    assert "prod" in result.output and got == {}


def test_cli_run_checks_the_token_before_starting(cli_run, monkeypatch):
    monkeypatch.delenv("WTS_SECRET_CLOUDFLARE_API_TOKEN")
    result, got = cli_run("--env", "staging", config=CLOUDFLARE)
    assert result.exit_code == 1
    assert "wts secrets set cloudflare_api_token" in result.output and got == {}


# --- wts backup -----------------------------------------------------------------------------


def test_cli_backup(paths, tmp_path, monkeypatch):
    rsync = FakeRsync()
    monkeypatch.setattr(backup_mod, "run_rsync", rsync)
    (tmp_path / "nas").mkdir()
    (paths.app_dir / "config.toml").write_text(f'backup_dir = "{tmp_path / "nas" / "backup"}"\n')
    result = CliRunner().invoke(main, ["backup"])
    assert result.exit_code == 0, result.output
    assert f"backed up to {tmp_path / 'nas' / 'backup' / 'wts'}" in result.output
    assert len(rsync.calls) == 1


def test_cli_backup_without_backup_dir(paths):
    result = CliRunner().invoke(main, ["backup"])
    assert result.exit_code == 2
    assert "backup_dir" in result.output


def test_cli_backup_failure(paths, tmp_path, monkeypatch):
    monkeypatch.setattr(backup_mod, "run_rsync", FakeRsync(exc=FileNotFoundError("rsync")))
    (tmp_path / "nas").mkdir()
    (paths.app_dir / "config.toml").write_text(f'backup_dir = "{tmp_path / "nas" / "backup"}"\n')
    result = CliRunner().invoke(main, ["backup"])
    assert result.exit_code == 1
    assert "rsync not found" in result.output
