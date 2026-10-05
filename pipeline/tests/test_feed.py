from dataclasses import replace
from pathlib import Path

import httpx
import respx
from click.testing import CliRunner

from wts.cli import main
from wts.feed import normalize_audio_url, parse_feed, upsert_episodes
from wts.state import Status

FIXTURES = Path(__file__).parent / "fixtures"
FEED = (FIXTURES / "feed.xml").read_bytes()


def advance_all_to(conn, status: str) -> None:
    conn.execute("update episodes set status = ?", (status,))
    conn.commit()


def test_parse_feed_fixture():
    items = parse_feed(FEED)
    assert len(items) == 8
    by_guid = {i.guid: i for i in items}
    assert by_guid["wt-guid-0312"].number == 312
    assert by_guid["wt-guid-0313"].number == 313  # from "Ep. 313 –" title
    assert by_guid["wt-guid-0007"].number == 7  # from "#7"
    assert by_guid["wt-guid-bonus-1"].number is None
    assert by_guid["wt-guid-0312"].duration_s == 3723
    assert by_guid["wt-guid-0313"].duration_s == 3510
    assert by_guid["wt-guid-bonus-1"].duration_s == 1800
    assert by_guid["wt-guid-0312"].page_url == "https://www.woodtalkshow.com/312"
    assert by_guid["wt-guid-0312"].published_at.isoformat() == "2017-03-14T12:00:00+00:00"
    assert all(i.audio_url and i.guid for i in items)


def test_normalize_audio_url():
    assert normalize_audio_url("https://a.b/x.mp3?t=1#f") == "https://a.b/x.mp3"


def test_insert_gives_unique_ascii_stems(conn):
    r = upsert_episodes(conn, parse_feed(FEED))
    assert (r.added, r.updated, r.reset) == (8, 0, 0)
    stems = [row[0] for row in conn.execute("select stem from episodes")]
    assert len(set(stems)) == 8 and all(s.isascii() for s in stems)
    assert "2017-03-14_ep312_dado-stacks-shop-safety" in stems
    assert {"2021-05-05_cafe-talk-dovetails", "2021-05-05_cafe-talk-dovetails-2"} <= set(stems)


def test_tracking_query_change_does_not_reset(conn):
    items = parse_feed(FEED)
    upsert_episodes(conn, items)
    advance_all_to(conn, "transcribed")
    changed = [
        replace(i, audio_url=i.audio_url.split("?")[0] + "?tracking=zzz") for i in items
    ]
    r = upsert_episodes(conn, changed)
    assert r.reset == 0 and r.updated == 8
    assert all(row[0] == "transcribed" for row in conn.execute("select status from episodes"))


def test_real_audio_url_change_resets_to_new(conn):
    items = parse_feed(FEED)
    upsert_episodes(conn, items)
    advance_all_to(conn, "transcribed")
    r = upsert_episodes(
        conn, [replace(items[0], audio_url="https://cdn.example/new.mp3")] + items[1:]
    )
    assert r.reset == 1
    row = conn.execute("select status, audio_url from episodes where guid = ?", (items[0].guid,))
    assert tuple(row.fetchone()) == (Status.NEW, "https://cdn.example/new.mp3")


def test_feed_command_requires_feed_url(wts_home):
    r = CliRunner().invoke(main, ["feed"])
    assert r.exit_code == 2 and "feed_url" in r.output


@respx.mock
def test_feed_command_fetches_and_upserts(wts_home):
    (wts_home / "config.toml").write_text('feed_url = "https://feed.example/rss"\n')
    respx.get("https://feed.example/rss").mock(return_value=httpx.Response(200, content=FEED))
    r = CliRunner().invoke(main, ["feed"])
    assert r.exit_code == 0, r.output
    assert "added=8" in r.output


def test_stems_are_never_regenerated(conn):
    items = parse_feed(FEED)
    upsert_episodes(conn, items)
    before = dict(conn.execute("select guid, stem from episodes").fetchall())
    upsert_episodes(conn, [replace(i, title=i.title + " (remastered)") for i in items])
    assert dict(conn.execute("select guid, stem from episodes").fetchall()) == before
