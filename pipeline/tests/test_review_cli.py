import json
import re

import pytest
from click.testing import CliRunner
from conftest import seg, tx

from wts import cli
from wts.db import connect
from wts.review import server as server_mod


class FakeServer:
    """Stands in for the HTTP server: `serve_forever` returns at once."""

    def __init__(self, raise_interrupt=False):
        self.server_address = ("127.0.0.1", 5555)
        self.raise_interrupt = raise_interrupt
        self.closed = False
        self.served = False

    def serve_forever(self):
        self.served = True
        if self.raise_interrupt:
            raise KeyboardInterrupt

    def server_close(self):
        self.closed = True


@pytest.fixture
def conn(paths):
    """The database the command opens (`paths.state_db`)."""
    c = connect(paths.state_db)
    yield c
    c.close()


@pytest.fixture
def fake(monkeypatch):
    """Replaces `serve` and `webbrowser.open`; returns what they saw."""
    seen = {"serve": [], "opened": [], "server": FakeServer()}

    def serve(app, port=0):
        seen["serve"].append((app, port))
        return seen["server"]

    monkeypatch.setattr(server_mod, "serve", serve)
    monkeypatch.setattr("webbrowser.open", lambda url: seen["opened"].append(url) or True)
    monkeypatch.delenv("WTS_REVIEW_TOKEN", raising=False)
    monkeypatch.delenv("WTS_CORRECTIONS_FILE", raising=False)
    return seen


def run(*args):
    return CliRunner().invoke(cli.main, ["review", *args])


def transcribed(conn, paths, make_episode, **kw):
    e = make_episode(**kw)
    stem = conn.execute("select stem from episodes where id = ?", (e,)).fetchone()[0]
    paths.transcripts_dir.mkdir(parents=True, exist_ok=True)
    out = paths.transcripts_dir / f"{stem}.json"
    out.write_text(json.dumps(tx(seg("Cut the tenon."))))
    conn.execute("update episodes set transcript_path = ? where id = ?", (str(out), e))
    conn.commit()
    return e


def test_review_an_episode_prints_the_url_and_opens_it(fake, conn, paths, make_episode):
    e = transcribed(conn, paths, make_episode, number=71)
    result = run("71")
    assert result.exit_code == 0, result.output
    (app, port), = fake["serve"]
    assert port == 0
    url = f"http://127.0.0.1:5555/?t={app.token}&episode={e}"
    assert result.output.strip() == url
    assert fake["opened"] == [url]
    assert fake["server"].served and fake["server"].closed


def test_at_is_in_milliseconds(fake, conn, paths, make_episode):
    e = transcribed(conn, paths, make_episode, number=71)
    result = run("71", "--at", "12:34")
    assert result.exit_code == 0, result.output
    assert f"&episode={e}&at=754000" in result.output


def test_selector_and_port_and_no_open(fake, conn, paths, make_episode):
    e = transcribed(conn, paths, make_episode, number=71)
    stem = conn.execute("select stem from episodes where id = ?", (e,)).fetchone()[0]
    result = run(f"stem:{stem}", "--port", "8123", "--no-open")
    assert result.exit_code == 0, result.output
    assert fake["serve"][0][1] == 8123
    assert fake["opened"] == []
    assert f"episode={e}" in result.output


def test_ctrl_c_exits_quietly_and_closes(fake, conn, paths, make_episode):
    transcribed(conn, paths, make_episode, number=71)
    fake["server"].raise_interrupt = True
    result = run("71", "--no-open")
    assert result.exit_code == 0
    assert result.output.count("\n") == 1  # just the URL
    assert fake["server"].closed


def test_next_flagged_skips_reviewed_and_unflagged(fake, conn, paths, make_episode):
    flagged = json.dumps(["retimed"])
    transcribed(conn, paths, make_episode, published_at="2020-01-01T00:00:00+00:00")
    reviewed = transcribed(
        conn, paths, make_episode, flags=flagged, published_at="2020-01-02T00:00:00+00:00"
    )
    conn.execute("update episodes set reviewed_at = '2026-01-01T00:00:00+00:00' where id = ?",
                 (reviewed,))
    conn.commit()
    want = transcribed(
        conn, paths, make_episode, flags=flagged, published_at="2020-01-03T00:00:00+00:00"
    )
    later = transcribed(
        conn, paths, make_episode, flags=flagged, published_at="2020-01-04T00:00:00+00:00"
    )
    result = run("--next-flagged")
    assert result.exit_code == 0, result.output
    assert f"episode={want}" in result.output
    assert f"episode={later}" not in result.output


def test_next_flagged_none_left(fake, conn, paths, make_episode):
    transcribed(conn, paths, make_episode)
    result = run("--next-flagged")
    assert result.exit_code == 1
    assert "no flagged episodes left to review" in result.output
    assert fake["serve"] == []


def test_exactly_one_of_episode_and_next_flagged(fake, conn, paths, make_episode):
    transcribed(conn, paths, make_episode, number=71)
    for args in ([], ["71", "--next-flagged"]):
        result = run(*args)
        assert result.exit_code == 2
        assert "EPISODE or --next-flagged" in result.output
    assert fake["serve"] == []


def test_at_only_with_an_episode(fake, conn, paths, make_episode):
    result = run("--next-flagged", "--at", "1:00")
    assert result.exit_code == 2
    assert "--at" in result.output


def test_bad_at_is_a_usage_error(fake, conn, paths, make_episode):
    transcribed(conn, paths, make_episode, number=71)
    result = run("71", "--at", "soon")
    assert result.exit_code == 2
    assert "not a time" in result.output


def test_no_match_and_several_matches(fake, conn, paths, make_episode):
    a = transcribed(conn, paths, make_episode, number=71)
    b = transcribed(conn, paths, make_episode, number=72)
    result = run("500")
    assert result.exit_code == 1
    assert "no episode matches" in result.output
    stems = [conn.execute("select stem from episodes where id = ?", (i,)).fetchone()[0]
             for i in (a, b)]
    result = run(f"stem:{stems[0]},stem:{stems[1]}")
    assert result.exit_code == 1
    assert "more than one" in result.output
    assert all(s in result.output for s in stems)
    assert fake["serve"] == []


def test_episode_without_a_transcript_names_its_status(fake, conn, make_episode):
    make_episode(number=71, status="discovered")
    result = run("71")
    assert result.exit_code == 1
    assert "no transcript" in result.output
    assert "discovered" in result.output
    assert fake["serve"] == []


def test_test_environment_variables(fake, conn, paths, make_episode, monkeypatch, tmp_path):
    transcribed(conn, paths, make_episode, number=71)
    monkeypatch.setenv("WTS_REVIEW_TOKEN", "fixed-token")
    monkeypatch.setenv("WTS_CORRECTIONS_FILE", str(tmp_path / "c.yaml"))
    result = run("71")
    assert result.exit_code == 0, result.output
    app = fake["serve"][0][0]
    assert app.token == "fixed-token"
    assert app.corrections_file == tmp_path / "c.yaml"
    assert re.search(r"\?t=fixed-token&episode=", result.output)


def test_defaults_without_the_environment_variables(fake, conn, paths, make_episode):
    from wts.corrections import CORRECTIONS_FILE

    transcribed(conn, paths, make_episode, number=71)
    run("71")
    app = fake["serve"][0][0]
    assert app.corrections_file == CORRECTIONS_FILE
    assert len(app.token) >= 24
