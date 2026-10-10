"""`wts links`: an episode's links, built as the Worker builds them (worker/src/links.ts)."""

import pytest
from click.testing import CliRunner
from conftest import insert_episode

from wts.cli import main
from wts.db import connect
from wts.links import episode_links, parse_time

APPLE = "https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480"
IDS = {"apple_episode_id": "1000654321", "spotify_episode_id": "25v5lMYTgOxsTSJ2jaZ6Rt",
       "youtube_video_id": "dQw4w9WgXcQ", "youtube_duration_s": 3602}


def row(conn, **overrides):
    e = insert_episode(conn, **overrides)
    return conn.execute("select * from episodes where id = ?", (e,)).fetchone()


def test_every_link_without_a_time(conn):
    links = episode_links(row(conn, page_url="https://woodtalkshow.com/ep171",
                              audio_url="https://cdn.example/ep171.mp3", **IDS))
    assert links == {
        "youtube": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "apple": f"{APPLE}?i=1000654321",
        "spotify": "https://open.spotify.com/episode/25v5lMYTgOxsTSJ2jaZ6Rt",
        "page": "https://woodtalkshow.com/ep171",
        "audio": "https://cdn.example/ep171.mp3",
    }
    assert list(links) == ["youtube", "apple", "spotify", "page", "audio"]  # card order


def test_a_time_uses_each_platform_format_and_offset(conn):
    links = episode_links(row(conn, offset_spotify_s=-30, offset_apple_s=5, **IDS), at_s=754)
    assert links["youtube"].endswith("?v=dQw4w9WgXcQ&t=754s")
    assert links["apple"].endswith("?i=1000654321&t=759")
    assert links["spotify"].endswith("/25v5lMYTgOxsTSJ2jaZ6Rt?t=724")


def test_a_time_never_goes_below_zero(conn):
    links = episode_links(row(conn, offset_spotify_s=-30, **IDS), at_s=10)
    assert links["spotify"].endswith("?t=0")


ACAST = "https://shows.acast.com/woodtalk/episodes/should-i-buy-a-jointer-wt616"


def test_an_acast_page_seeks_to_the_time(conn):
    # No lead-in and no offset, like the other links; the page is on the show's own timeline.
    links = episode_links(row(conn, page_url=ACAST, offset_apple_s=30), at_s=1741)
    assert links["page"] == f"{ACAST}?seek=1741"
    assert episode_links(row(conn, page_url=ACAST), at_s=0)["page"] == f"{ACAST}?seek=0"


def test_an_acast_page_keeps_other_parameters_and_the_fragment(conn):
    page = "https://shows.acast.com/woodtalk/episodes/x?a=1&seek=5#notes"
    assert episode_links(row(conn, page_url=page), at_s=90)["page"] == (
        "https://shows.acast.com/woodtalk/episodes/x?a=1&seek=90#notes")


def test_an_acast_page_is_bare_without_a_time(conn):
    assert episode_links(row(conn, page_url=ACAST))["page"] == ACAST


@pytest.mark.parametrize("page", [
    "https://example.com/ep/612", "https://shows.acast.com.evil.example/x", "not a url"])
def test_any_other_page_is_unchanged(conn, page):
    assert episode_links(row(conn, page_url=page), at_s=90)["page"] == page
    assert episode_links(row(conn, page_url=page))["page"] == page


def test_missing_ids_are_left_out(conn):
    links = episode_links(row(conn, page_url=None))
    assert links == {"audio": links["audio"]}


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
