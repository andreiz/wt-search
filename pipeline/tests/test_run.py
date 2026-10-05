import sqlite3
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import respx
from click.testing import CliRunner
from conftest import FakeEmbedder, FakeTranscriber, status_of

from wts.cli import main
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
