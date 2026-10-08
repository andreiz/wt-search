from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
import respx
from click.testing import CliRunner

from wts.cli import main
from wts.feed import MassReset, normalize_audio_url, parse_feed, upsert_episodes
from wts.net import USER_AGENT
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
    assert "2017-03-28_ep313_walnut-finishing" in stems  # number not repeated in the slug
    assert "2020-06-01_ep400_sawmills-with-matt" in stems
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


@respx.mock
def test_feed_request_sends_the_bot_user_agent(wts_home):
    (wts_home / "config.toml").write_text('feed_url = "https://feed.example/rss"\n')
    route = respx.get("https://feed.example/rss").mock(
        return_value=httpx.Response(200, content=FEED)
    )
    r = CliRunner().invoke(main, ["feed"])
    assert r.exit_code == 0, r.output
    assert route.calls.last.request.headers["User-Agent"] == USER_AGENT


BROKEN_FEED = b"""<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title>No date</title><guid>g-nodate</guid>
  <enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg"/></item>
<item><title>Bad date</title><guid>g-baddate</guid><pubDate>sometime soon</pubDate>
  <enclosure url="https://cdn.example.com/b.mp3" type="audio/mpeg"/></item>
<item><title>No guid</title><pubDate>Tue, 14 Mar 2017 12:00:00 +0000</pubDate>
  <enclosure url="https://cdn.example.com/c.mp3?tracking=%s" type="audio/mpeg"/></item>
</channel></rss>"""


def _feed(items: list[tuple[str, str, int | None]]) -> bytes:
    """A feed from (title, RFC 822 date, itunes:episode) tuples."""
    out = []
    for i, (title, when, itunes) in enumerate(items):
        ep = f"<itunes:episode>{itunes}</itunes:episode>" if itunes else ""
        out.append(
            f"<item><title>{title}</title><guid>g{i}</guid><pubDate>{when}</pubDate>{ep}"
            f'<enclosure url="https://cdn.example.com/{i}.mp3" type="audio/mpeg"/></item>'
        )
    return (
        '<?xml version="1.0"?><rss version="2.0" '
        'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>'
        + "".join(out)
        + "</channel></rss>"
    ).encode()


SIDE_SERIES = _feed([
    ("Hand Tools vs Power Tools #85", "Thu, 26 May 2011 12:00:00 +0000", None),
    ("Board Meetings #1", "Tue, 29 Mar 2011 16:36:37 +0000", None),
    ("Board Meetings #2", "Thu, 14 Apr 2011 02:46:53 +0000", 2),  # even with itunes:episode
    ("Something Else | 83", "Mon, 28 Mar 2011 12:00:00 +0000", None),
    ("Shop Stuff #84", "Fri, 22 Apr 2011 12:00:00 +0000", 84),
    ("The Awkward Beginning | 1", "Sun, 01 Apr 2007 23:01:50 +0000", 1),
    ("Can Grandpa's Old Tools Be Saved? | 2", "Mon, 09 Apr 2007 01:49:44 +0000", 2),
])


def test_side_series_numbers_out_of_sequence_are_dropped():
    by_title = {i.title: i.number for i in parse_feed(SIDE_SERIES)}
    assert by_title["Board Meetings #1"] is None
    assert by_title["Board Meetings #2"] is None
    assert by_title["Hand Tools vs Power Tools #85"] == 85
    assert by_title["Something Else | 83"] == 83
    assert by_title["The Awkward Beginning | 1"] == 1  # early episodes fit their own era


def test_unnumbered_side_series_keeps_its_number_in_the_stem(conn):
    upsert_episodes(conn, parse_feed(SIDE_SERIES))
    stems = {r[0] for r in conn.execute("select stem from episodes")}
    assert "2011-03-29_board-meetings-1" in stems
    assert "2007-04-01_ep001_the-awkward-beginning" in stems


def test_items_without_usable_date_are_skipped():
    items = parse_feed(BROKEN_FEED.replace(b"%s", b"1"))
    assert [i.title for i in items] == ["No guid"]


def test_missing_guid_falls_back_to_normalized_url(conn):
    upsert_episodes(conn, parse_feed(BROKEN_FEED.replace(b"%s", b"1")))
    r = upsert_episodes(conn, parse_feed(BROKEN_FEED.replace(b"%s", b"2")))
    assert (r.added, conn.execute("select count(*) from episodes").fetchone()[0]) == (0, 1)
    assert conn.execute("select guid from episodes").fetchone()[0] == "https://cdn.example.com/c.mp3"


def test_mass_reset_is_refused_without_force(conn):
    items = parse_feed(FEED)
    upsert_episodes(conn, items)
    advance_all_to(conn, "transcribed")
    moved = [replace(i, audio_url=i.audio_url.replace("cdn.example.com", "pdst.fm/e/cdn")) for i in items]
    with pytest.raises(MassReset, match="8 episodes"):
        upsert_episodes(conn, moved)
    assert all(row[0] == "transcribed" for row in conn.execute("select status from episodes"))
    assert upsert_episodes(conn, moved, force=True).reset == 8


def test_feed_command_force_flag(wts_home):
    (wts_home / "config.toml").write_text('feed_url = "https://feed.example/rss"\n')
    with respx.mock:
        respx.get("https://feed.example/rss").mock(return_value=httpx.Response(200, content=FEED))
        assert CliRunner().invoke(main, ["feed", "--force"]).exit_code == 0


def scoped_guids(conn) -> set[str]:
    return {r[0] for r in conn.execute("select guid from episodes where in_scope = 1")}


def new_item(base, days: int, guid: str):
    return replace(base, guid=guid, published_at=base.published_at + timedelta(days=days),
                   audio_url=f"https://cdn.example.com/{guid}.mp3")


def test_the_first_import_scopes_nothing(conn):
    # A new install imports the whole archive: putting it all in scope would queue ~600
    # episodes of transcription. Scope is chosen by hand then (`wts scope add seed`).
    r = upsert_episodes(conn, parse_feed(FEED))
    assert r.added == 8 and r.scoped == 0
    assert scoped_guids(conn) == set()


def test_a_new_episode_goes_into_scope(conn):
    # Open decision 3 (maintainer, 2026-10-08: option a): a scheduled `wts run` processes the
    # scope, so a new release must join it or it is never transcribed.
    items = parse_feed(FEED)
    upsert_episodes(conn, items)
    newest = max(items, key=lambda i: i.published_at)
    r = upsert_episodes(conn, [*items, new_item(newest, 13, "wt-guid-new")])
    assert (r.added, r.scoped) == (1, 1)
    assert scoped_guids(conn) == {"wt-guid-new"}  # the others are untouched


def test_a_new_episode_on_the_newest_date_goes_into_scope(conn):
    items = parse_feed(FEED)
    upsert_episodes(conn, items)
    newest = max(items, key=lambda i: i.published_at)
    r = upsert_episodes(conn, [*items, new_item(newest, 0, "wt-guid-same-day")])
    assert r.scoped == 1


def test_an_old_episode_found_later_stays_out_of_scope(conn):
    # A back-catalog item turning up in the feed is not a new release.
    items = parse_feed(FEED)
    upsert_episodes(conn, items)
    oldest = min(items, key=lambda i: i.published_at)
    r = upsert_episodes(conn, [*items, new_item(oldest, 1, "wt-guid-old")])
    assert (r.added, r.scoped) == (1, 0)
    assert scoped_guids(conn) == set()


def test_feed_command_says_how_many_were_scoped(wts_home):
    (wts_home / "config.toml").write_text('feed_url = "https://feed.example/rss"\n')
    with respx.mock:
        respx.get("https://feed.example/rss").mock(return_value=httpx.Response(200, content=FEED))
        r = CliRunner().invoke(main, ["feed"])
    assert r.exit_code == 0, r.output
    assert "added=8 updated=0 reset=0 scoped=0" in r.output


def test_stems_are_never_regenerated(conn):
    items = parse_feed(FEED)
    upsert_episodes(conn, items)
    before = dict(conn.execute("select guid, stem from episodes").fetchall())
    upsert_episodes(conn, [replace(i, title=i.title + " (remastered)") for i in items])
    assert dict(conn.execute("select guid, stem from episodes").fetchall()) == before
