"""`wts links`: an episode's links, built as the Worker builds them (worker/src/links.ts)."""

from urllib.parse import quote

import pytest
from click.testing import CliRunner
from conftest import insert_episode

from wts.cli import main
from wts.db import connect
from wts.links import episode_links, parse_time

APPLE = "https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480"
ACAST_EPISODES = "https://shows.acast.com/woodtalk/episodes/"
IDS = {"apple_episode_id": "1000654321", "spotify_episode_id": "25v5lMYTgOxsTSJ2jaZ6Rt",
       "youtube_video_id": "dQw4w9WgXcQ", "youtube_duration_s": 3602}


def row(conn, **overrides):
    e = insert_episode(conn, **overrides)
    return conn.execute("select * from episodes where id = ?", (e,)).fetchone()


def test_every_link_without_a_time(conn):
    episode = row(conn, page_url="https://woodtalkshow.com/ep171",
                  audio_url="https://cdn.example/ep171.mp3", **IDS)
    guid = episode["guid"]
    links = episode_links(episode)
    assert links == {
        "youtube": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "apple": f"{APPLE}?i=1000654321",
        "spotify": "https://open.spotify.com/episode/25v5lMYTgOxsTSJ2jaZ6Rt",
        "page": f"{ACAST_EPISODES}{quote(guid, safe='')}",
        "notes": "https://woodtalkshow.com/ep171",
        "audio": "https://cdn.example/ep171.mp3",
    }
    assert list(links) == ["youtube", "apple", "spotify", "page", "notes", "audio"]  # card order


def test_a_time_uses_each_platform_format_and_offset(conn):
    links = episode_links(row(conn, offset_spotify_s=-30, offset_apple_s=5, **IDS), at_s=754)
    assert links["youtube"].endswith("?v=dQw4w9WgXcQ&t=754s")
    assert links["apple"].endswith("?i=1000654321&t=759")
    assert links["spotify"].endswith("/25v5lMYTgOxsTSJ2jaZ6Rt?t=724")


def test_a_time_never_goes_below_zero(conn):
    links = episode_links(row(conn, offset_spotify_s=-30, **IDS), at_s=10)
    assert links["spotify"].endswith("?t=0")


ACAST = "https://shows.acast.com/woodtalk/episodes/should-i-buy-a-jointer-wt616"


def test_the_show_page_is_the_acast_page_under_the_guid_and_seeks_to_the_time(conn):
    # No lead-in and no offset, like the other links; the page is on the show's own timeline.
    # Both forms tried on a phone and a desktop, 2026-10-11 (the same links as the Worker's test).
    new = row(conn, guid="6968079fe9172b83203dbacf", offset_apple_s=30)
    assert episode_links(new, at_s=600)["page"] == f"{ACAST_EPISODES}6968079fe9172b83203dbacf?seek=600"
    assert episode_links(new, at_s=0)["page"] == f"{ACAST_EPISODES}6968079fe9172b83203dbacf?seek=0"
    old = row(conn, guid="http://archive.org/download/wt089/WT_071.mp3")
    assert episode_links(old, at_s=4184)["page"] == (
        f"{ACAST_EPISODES}http%3A%2F%2Farchive.org%2Fdownload%2Fwt089%2FWT_071.mp3?seek=4184")


def test_the_show_page_is_bare_without_a_time(conn):
    assert episode_links(row(conn, guid="abc"))["page"] == f"{ACAST_EPISODES}abc"


def test_a_guid_is_encoded_as_the_worker_encodes_it(conn):
    # JavaScript's encodeURIComponent leaves ! * ' ( ) alone and escapes the rest.
    page = episode_links(row(conn, guid="a b/c?d#e!*'()"))["page"]
    assert page == f"{ACAST_EPISODES}a%20b%2Fc%3Fd%23e!*'()"


def test_the_feeds_own_link_is_the_notes_unless_it_is_the_acast_page(conn):
    assert episode_links(row(conn, page_url="https://woodtalkshow.com/episodes/x/"), at_s=90)[
        "notes"] == "https://woodtalkshow.com/episodes/x/"
    assert "notes" not in episode_links(row(conn, page_url=ACAST), at_s=90)
    # A look-alike host is not Acast, so it is kept as it is.
    assert episode_links(row(conn, page_url="https://shows.acast.com.evil.example/x"))[
        "notes"] == "https://shows.acast.com.evil.example/x"


@pytest.mark.parametrize("page", [None, "", "not a url", "javascript:alert(1)"])
def test_no_notes_without_a_web_link(conn, page):
    assert "notes" not in episode_links(row(conn, page_url=page))


def test_missing_ids_are_left_out(conn):
    links = episode_links(row(conn, page_url=None))
    assert links == {"page": links["page"], "audio": links["audio"]}


def test_youtube_follows_the_length_rule(conn):
    # Within 3 s of the feed's length: linked. Further: not linked (spec §4.6), but reported.
    assert "youtube" in episode_links(row(conn, **{**IDS, "youtube_duration_s": 3603}))
    links = episode_links(row(conn, **{**IDS, "youtube_duration_s": 3604}))
    assert "youtube" not in links


@pytest.mark.parametrize(("text", "expected"), [
    ("754", 754), ("12:34", 754), ("1:02:03", 3723), ("0:05", 5), (" 12:34 ", 754),
])
def test_parse_time(text, expected):
    assert parse_time(text) == expected


@pytest.mark.parametrize("text", ["", "abc", "1:2:3:4", "12:60", "-5", "1.5"])
def test_parse_time_rejects(text):
    with pytest.raises(ValueError, match="12:34"):
        parse_time(text)


# --- CLI ------------------------------------------------------------------------------------


@pytest.fixture
def state(paths):
    c = connect(paths.state_db)
    yield c
    c.close()


def test_cli_by_number(state):
    insert_episode(state, number=71, title="WT71 – Calls", published_at="2009-05-01T00:00:00+00:00",
                   **IDS)
    result = CliRunner().invoke(main, ["links", "71", "--at", "12:34"])
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert lines[0] == "#71 WT71 – Calls (2009-05-01), at 12:34"
    assert lines[1] == "  youtube  https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s"
    assert lines[-1].startswith("  audio    https://cdn.example/")


def test_cli_by_selector_lists_each_episode(state):
    insert_episode(state, number=500, title="Older", published_at="2025-01-01T00:00:00+00:00")
    insert_episode(state, number=501, title="Newer", published_at="2025-02-01T00:00:00+00:00")
    result = CliRunner().invoke(main, ["links", "recent:2"])
    assert result.exit_code == 0, result.output
    assert [x for x in result.output.splitlines() if x.startswith("#")] == [
        "#500 Older (2025-01-01)", "#501 Newer (2025-02-01)"
    ]


def test_cli_says_why_youtube_is_not_linked(state):
    insert_episode(state, number=72, **{**IDS, "youtube_duration_s": 3641})
    result = CliRunner().invoke(main, ["links", "72"])
    assert result.exit_code == 0, result.output
    assert ("  youtube  (matched dQw4w9WgXcQ, but 41 s longer than the feed: not linked)"
            in result.output.splitlines())


def test_cli_unknown_episode(state):
    result = CliRunner().invoke(main, ["links", "9999"])
    assert result.exit_code == 1
    assert "no episode matches" in result.output


def test_cli_bad_time(state):
    insert_episode(state, number=73)
    result = CliRunner().invoke(main, ["links", "73", "--at", "soon"])
    assert result.exit_code == 2
    assert "12:34" in result.output
