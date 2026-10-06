import base64
import json
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import respx

from wts.net import USER_AGENT, new_client
from wts.platforms import match_platform_ids
from wts.platforms.apple import match_apple
from wts.platforms.spotify import match_spotify
from wts.platforms.text import PlatformError, normalize_title
from wts.platforms.youtube import match_youtube, parse_duration
from wts.secrets import EnvStore
from wts.steps import run_feed

FIXTURES = Path(__file__).parent / "fixtures" / "platforms"

SHOW_ID = "6hSv7mQd1x3kGZ0wVtQkYp"
SPOTIFY_ID, SPOTIFY_SECRET = "sp-client-id-1234", "sp-client-secret-5678"
YOUTUBE_KEY = "AIzaSyFAKE-youtube-key-0123456789abcdef"
FULL_STORE = EnvStore({
    "WTS_SECRET_SPOTIFY_CLIENT_ID": SPOTIFY_ID,
    "WTS_SECRET_SPOTIFY_CLIENT_SECRET": SPOTIFY_SECRET,
    "WTS_SECRET_YOUTUBE_API_KEY": YOUTUBE_KEY,
})
SECRETS = (SPOTIFY_ID, SPOTIFY_SECRET, YOUTUBE_KEY)

APPLE_LOOKUP = "https://itunes.apple.com/lookup"
SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token"
SPOTIFY_EPISODES = f"https://api.spotify.com/v1/shows/{SHOW_ID}/episodes"
YT = "https://www.googleapis.com/youtube/v3"

# Real guids, titles and dates of episodes 610-615; the unnumbered "Shop Tour Q&A" and the
# livestream-era WT379 (feed 50:39, YouTube 1:04:15) are made up.
def _row(guid, number, duration_s, title, published_at) -> dict:
    return {"guid": guid, "number": number, "duration_s": duration_s, "title": title,
            "published_at": published_at}


EPISODES = {
    "610": _row("6a578e13c152a357dbbe63e5", 610, 3600, "Jazz Hands Joinery | 610",
                "2026-07-15T13:41:39+00:00"),
    "611": _row("6a615b495092e5d571e10552", 611, 3501, "When She Gives Away Your Tools | 611",
                "2026-07-23T00:07:37+00:00"),
    "612": _row("6a73408fca067b295bbf8fbe", 612, 3320, "Reservations about Shannon | 612",
                "2026-08-05T13:54:23+00:00"),
    "613": _row("6a85040fa835875d37750395", 613, 3039, "Shove a Kregger in the Hole | 613",
                "2026-08-19T01:17:03+00:00"),
    "614": _row("6a9753f01d1d1a8a9d5ac5a7", 614, 3468, "It’s Too Long and Bendy | 614",
                "2026-09-01T22:38:40+00:00"),
    "615": _row("6aac45dcbf7eb386d30aa403", 615, 3612, "Why We Don't Use Metric | WT615",
                "2026-09-17T19:56:12+00:00"),
    "tour": _row("6a7c1f2e9d3b4a5c6e7f8091", None, 1743, "Shop Tour Q&A",
                 "2026-08-10T15:00:00+00:00"),
    "379": _row("5df9f2a4c31e8b0007a1b2c3", 379, 3039, "Router Table Showdown | WT379",
                "2019-12-18T12:00:00+00:00"),
}
APPLE_IDS = {"615": "1000741230615", "614": "1000739118614", "613": "1000736652613",
             "612": "1000734210612", "611": "1000732998611", "tour": "1000735100001"}
SPOTIFY_IDS = {"615": "4kQ0aWt615MetricShop01", "614": "2mXp9LgBendy614Boards02",
               "613": "7nRt3KregBloke613Hole03", "612": "1cYw8HShannon612Resv04",
               "tour": "5dVb2NShopTourQA0005"}
YOUTUBE_IDS = {"615": ("aB3dE5fG7h1", 3612), "614": ("kL9mN2pQ4r6", 3468),
               "613": ("tU8vW1xY3z5", 3039), "612": ("Cd4Ef6Gh8Ij", 3320),
               "tour": ("Mn0Op2Qr4St", 1743), "379": ("Uv6Wx8Yz0Ab", 3855)}


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def episode(key: str, id: int = 1, **overrides) -> dict:
    """An episode row as the matchers take it."""
    return {"id": id, **EPISODES[key], **overrides}


@pytest.fixture
def api():
    with respx.mock(assert_all_called=False) as mock:
        yield mock


def mock_apple(api):
    return api.get(APPLE_LOOKUP).mock(
        return_value=httpx.Response(200, json=fixture("apple_lookup.json"))
    )


def mock_spotify(api):
    token = api.post(SPOTIFY_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("spotify_token.json"))
    )

    def page(request):
        name = "page2" if request.url.params.get("offset") == "3" else "page1"
        return httpx.Response(200, json=fixture(f"spotify_episodes_{name}.json"))

    return SimpleNamespace(token=token, episodes=api.get(SPOTIFY_EPISODES).mock(side_effect=page))


def mock_youtube(api):
    def playlist(request):
        name = "page2" if request.url.params.get("pageToken") == "EAAaBlBUOkNESQ" else "page1"
        return httpx.Response(200, json=fixture(f"youtube_playlist_{name}.json"))

    return SimpleNamespace(
        channels=api.get(f"{YT}/channels").mock(
            return_value=httpx.Response(200, json=fixture("youtube_channels.json"))
        ),
        playlist=api.get(f"{YT}/playlistItems").mock(side_effect=playlist),
        videos=api.get(f"{YT}/videos").mock(
            return_value=httpx.Response(200, json=fixture("youtube_videos.json"))
        ),
    )


def mock_all(api):
    return SimpleNamespace(apple=mock_apple(api), spotify=mock_spotify(api),
                           youtube=mock_youtube(api))


def settings(cfg):
    return replace(cfg, spotify_show_id=SHOW_ID)


def add_all(make_episode, keys=None) -> dict[str, int]:
    return {k: make_episode(**EPISODES[k]) for k in (keys or EPISODES)}


def column(conn, id: int, name: str):
    return conn.execute(f"select {name} from episodes where id = ?", (id,)).fetchone()[0]


# --- normalize_title --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("Why We Don’t Use Metric | WT615", "why we dont use metric"),
        ("Why We Don't Use Metric | WT615", "why we dont use metric"),
        ("WT615 – Why We Don’t Use Metric", "why we dont use metric"),
        ("Wood Talk 614: It's Too Long and Bendy", "its too long and bendy"),
        ("It’s Too Long and Bendy | 614", "its too long and bendy"),
        ("#613 Shove a Kregger in the Hole", "shove a kregger in the hole"),
        ("Ep. 313 – Walnut Finishing", "walnut finishing"),
        ("Episode 400: Sawmills with Matt", "sawmills with matt"),
        ("552 - Planes & Saws", "planes saws"),
        ("Café Talk: \"Dovetails?\"", "cafe talk dovetails"),
        ("Cafe Talk -- Dovetails!", "cafe talk dovetails"),
        ("  Shop   Tour\tQ&A ", "shop tour q a"),
        ("Board Meetings #1", "board meetings"),
        ("5 Tips for Sharper Chisels", "5 tips for sharper chisels"),
    ],
)
def test_normalize_title(title, expected):
    assert normalize_title(title) == expected


def test_smart_and_straight_quotes_normalize_alike():
    assert normalize_title("Don’t ‘Panic’") == normalize_title("Don't 'Panic'") == "dont panic"


# --- Apple ------------------------------------------------------------------------------


def test_apple_matches_by_episode_guid(api):
    route = mock_apple(api)
    found = match_apple(new_client(), 251471480)
    assert found["6aac45dcbf7eb386d30aa403"] == APPLE_IDS["615"]  # str(trackId)
    assert len(found) == 6  # the podcast record itself is not an episode
    assert "251471480" not in found.values()
    params = route.calls.last.request.url.params
    assert dict(params) == {"id": "251471480", "media": "podcast", "entity": "podcastEpisode",
                            "limit": "200"}


# --- Spotify ----------------------------------------------------------------------------


def test_spotify_matches_by_title_and_date_across_pages(api):
    mocks = mock_spotify(api)
    eps = [episode(k, i) for i, k in enumerate(["615", "614", "613", "612", "611", "tour"], 1)]
    found = match_spotify(new_client(), SPOTIFY_ID, SPOTIFY_SECRET, SHOW_ID, eps)
    # 611 is not on Spotify; smart and straight quotes meet; the null item is skipped.
    assert found == {1: SPOTIFY_IDS["615"], 2: SPOTIFY_IDS["614"], 3: SPOTIFY_IDS["613"],
                     4: SPOTIFY_IDS["612"], 6: SPOTIFY_IDS["tour"]}
    assert mocks.episodes.call_count == 2


def test_spotify_token_request_and_bearer_header(api):
    mocks = mock_spotify(api)
    match_spotify(new_client(), SPOTIFY_ID, SPOTIFY_SECRET, SHOW_ID, [episode("615")])
    token_request = mocks.token.calls.last.request
    basic = token_request.headers["Authorization"].removeprefix("Basic ")
    assert base64.b64decode(basic).decode() == f"{SPOTIFY_ID}:{SPOTIFY_SECRET}"
    assert token_request.content == b"grant_type=client_credentials"
    assert token_request.headers["User-Agent"] == USER_AGENT
    first = mocks.episodes.calls[0].request
    assert first.headers["Authorization"] == f"Bearer {fixture('spotify_token.json')['access_token']}"
    assert dict(first.url.params) == {"market": "US", "limit": "50"}
    assert first.headers["User-Agent"] == USER_AGENT


@pytest.mark.parametrize(("days", "matches"), [(-3, False), (-2, True), (0, True), (2, True),
                                               (3, False)])
def test_spotify_date_window_is_two_days(api, days, matches):
    mock_spotify(api)
    published = date(2026, 9, 17) + timedelta(days=days)
    ep = episode("615", published_at=f"{published.isoformat()}T19:56:12+00:00")
    found = match_spotify(new_client(), SPOTIFY_ID, SPOTIFY_SECRET, SHOW_ID, [ep])
    assert found == ({1: SPOTIFY_IDS["615"]} if matches else {})


def test_spotify_ambiguous_title_in_window_is_not_matched(api):
    mock_spotify(api)
    page1 = fixture("spotify_episodes_page1.json")
    twin = {**page1["items"][0], "id": "TWIN0000000000000000", "release_date": "2026-09-16"}
    page1["items"].append(twin)
    api.get(SPOTIFY_EPISODES).mock(side_effect=[
        httpx.Response(200, json={**page1, "next": None}),
    ])
    found = match_spotify(new_client(), SPOTIFY_ID, SPOTIFY_SECRET, SHOW_ID, [episode("615")])
    assert found == {}


# --- YouTube ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "seconds"),
    [("PT1H4M15S", 3855), ("PT50M39S", 3039), ("PT45S", 45), ("PT2H", 7200), ("PT3M", 180),
     ("P0D", 0), ("P1DT1H", 90000), ("PT0S", 0), ("", None), ("1:04:15", None), (None, None)],
)
def test_parse_duration(value, seconds):
    assert parse_duration(value) == seconds


def test_youtube_matches_by_number_and_stores_duration(api):
    mocks = mock_youtube(api)
    eps = [episode(k, i) for i, k in enumerate(["615", "614", "613", "612", "611", "379"], 1)]
    found = match_youtube(new_client(), YOUTUBE_KEY, "@WoodTalk", eps)
    # Every title style: "WT615 –", "Wood Talk 614:", "#613", "| 612". 611 has no video.
    # WT379 matches even though the stream is far longer than the feed: the length rule is
    # applied at publish.
    assert found == {1: YOUTUBE_IDS["615"], 2: YOUTUBE_IDS["614"], 3: YOUTUBE_IDS["613"],
                     4: YOUTUBE_IDS["612"], 6: YOUTUBE_IDS["379"]}
    assert mocks.playlist.call_count == 2  # followed nextPageToken


def test_youtube_requests(api):
    mocks = mock_youtube(api)
    match_youtube(new_client(), YOUTUBE_KEY, "@WoodTalk", [episode("615")])
    channels = mocks.channels.calls.last.request
    assert dict(channels.url.params) == {"part": "contentDetails", "forHandle": "@WoodTalk",
                                         "key": YOUTUBE_KEY}
    first, second = (c.request for c in mocks.playlist.calls)
    assert dict(first.url.params) == {"part": "snippet", "maxResults": "50", "key": YOUTUBE_KEY,
                                      "playlistId": "UUwT9kLm3QxZ7vNpR2sYd8Aw"}
    assert second.url.params["pageToken"] == "EAAaBlBUOkNESQ"
    videos = mocks.videos.calls.last.request
    assert videos.url.params["part"] == "contentDetails"
    assert len(videos.url.params["id"].split(",")) == 7
    assert all(c.request.headers["User-Agent"] == USER_AGENT for c in api.calls)


def test_youtube_unnumbered_episode_matches_on_normalized_title(api):
    mock_youtube(api)
    found = match_youtube(new_client(), YOUTUBE_KEY, "@WoodTalk", [episode("tour")])
    assert found == {1: YOUTUBE_IDS["tour"]}


def test_youtube_numbered_episode_does_not_match_on_title(api):
    mock_youtube(api)
    found = match_youtube(new_client(), YOUTUBE_KEY, "@WoodTalk",
                          [episode("tour", number=700)])
    assert found == {}


@pytest.mark.parametrize("key", ["613", "tour"])
@pytest.mark.parametrize(("days", "matches"), [(-15, False), (-14, True), (14, True),
                                               (15, False)])
def test_youtube_date_window_is_fourteen_days(api, key, days, matches):
    mock_youtube(api)
    video_date = {"613": date(2026, 8, 20), "tour": date(2026, 8, 12)}[key]
    published = video_date + timedelta(days=days)
    ep = episode(key, published_at=f"{published.isoformat()}T12:00:00+00:00")
    found = match_youtube(new_client(), YOUTUBE_KEY, "@WoodTalk", [ep])
    assert found == ({1: YOUTUBE_IDS[key]} if matches else {})


def test_youtube_batches_video_lookups_in_fifties(api):
    items = [
        {"snippet": {"publishedAt": "2026-09-17T20:00:00Z", "title": f"Filler {i}",
                     "resourceId": {"videoId": f"v{i:03d}"}}}
        for i in range(120)
    ]
    items[77]["snippet"]["title"] = "WT615 | Why We Don't Use Metric"
    api.get(f"{YT}/channels").mock(
        return_value=httpx.Response(200, json=fixture("youtube_channels.json"))
    )
    api.get(f"{YT}/playlistItems").mock(return_value=httpx.Response(200, json={"items": items}))

    def videos(request):
        ids = request.url.params["id"].split(",")
        found = [{"id": i, "contentDetails": {"duration": "PT10M"}} for i in ids]
        return httpx.Response(200, json={"items": found})

    route = api.get(f"{YT}/videos").mock(side_effect=videos)
    found = match_youtube(new_client(), YOUTUBE_KEY, "@WoodTalk", [episode("615")])
    assert found == {1: ("v077", 600)}
    sizes = [len(c.request.url.params["id"].split(",")) for c in route.calls]
    assert sizes == [50, 50, 20]


def test_youtube_unknown_handle_raises(api):
    api.get(f"{YT}/channels").mock(
        return_value=httpx.Response(200, json={"pageInfo": {"totalResults": 0}})
    )
    with pytest.raises(PlatformError, match="@Nobody"):
        match_youtube(new_client(), YOUTUBE_KEY, "@Nobody", [episode("615")])


# --- match_platform_ids -----------------------------------------------------------------


def test_match_platform_ids_writes_ids_and_durations(conn, cfg, make_episode, api):
    mock_all(api)
    ids = add_all(make_episode)
    counts = match_platform_ids(conn, settings(cfg), new_client(), FULL_STORE)
    assert counts["apple"] == 6 and counts["spotify"] == 5 and counts["youtube"] == 6
    for key, eid in ids.items():
        assert column(conn, eid, "apple_episode_id") == APPLE_IDS.get(key)
        assert column(conn, eid, "spotify_episode_id") == SPOTIFY_IDS.get(key)
        video = YOUTUBE_IDS.get(key)
        assert column(conn, eid, "youtube_video_id") == (video[0] if video else None)
        assert column(conn, eid, "youtube_duration_s") == (video[1] if video else None)
        assert column(conn, eid, "platforms_checked_at") is not None
    assert not any(k.endswith(("_skipped", "_error", "_duplicate")) for k in counts)


def test_nothing_pending_makes_no_requests(conn, cfg, make_episode, api):
    mocks = mock_all(api)
    make_episode(**EPISODES["615"], apple_episode_id="A", spotify_episode_id="S",
                 youtube_video_id="Y")
    counts = match_platform_ids(conn, settings(cfg), new_client(), FULL_STORE)
    assert sum(counts.values()) == 0
    assert len(api.calls) == 0, mocks


def test_existing_ids_are_never_overwritten(conn, cfg, make_episode, api):
    mock_all(api)
    keep = make_episode(**EPISODES["615"], apple_episode_id="OLD-A", spotify_episode_id="OLD-S",
                        youtube_video_id="OLD-Y", youtube_duration_s=1)
    other = make_episode(**EPISODES["614"], spotify_episode_id="OLD-S2")
    counts = match_platform_ids(conn, settings(cfg), new_client(), FULL_STORE)
    assert [column(conn, keep, c) for c in ("apple_episode_id", "spotify_episode_id",
                                            "youtube_video_id", "youtube_duration_s")] == [
        "OLD-A", "OLD-S", "OLD-Y", 1]
    assert column(conn, other, "spotify_episode_id") == "OLD-S2"
    assert column(conn, other, "apple_episode_id") == APPLE_IDS["614"]  # null ones are filled
    assert column(conn, other, "youtube_video_id") == YOUTUBE_IDS["614"][0]
    assert counts["apple"] == 1 and counts["spotify"] == 0 and counts["youtube"] == 1


def test_missing_spotify_secret_skips_only_spotify(conn, cfg, make_episode, api, wts_messages):
    mocks = mock_all(api)
    ids = add_all(make_episode, ["615", "614"])
    store = EnvStore({"WTS_SECRET_YOUTUBE_API_KEY": YOUTUBE_KEY})
    counts = match_platform_ids(conn, settings(cfg), new_client(), store)
    assert counts["spotify_skipped"] == 1 and "spotify" not in counts
    assert counts["apple"] == 2 and counts["youtube"] == 2
    assert column(conn, ids["615"], "spotify_episode_id") is None
    assert mocks.spotify.token.call_count == 0 and mocks.spotify.episodes.call_count == 0
    warnings = [m for m in wts_messages if "spotify" in m.lower()]
    assert len(warnings) == 1 and "spotify_client_id" in warnings[0]


def test_missing_show_id_skips_spotify(conn, cfg, make_episode, api, wts_messages):
    mocks = mock_all(api)
    add_all(make_episode, ["615"])
    counts = match_platform_ids(conn, cfg, new_client(), FULL_STORE)  # cfg has no show id
    assert counts["spotify_skipped"] == 1 and mocks.spotify.token.call_count == 0
    warnings = [m for m in wts_messages if "spotify" in m.lower()]
    assert len(warnings) == 1 and "spotify_show_id" in warnings[0]


def test_missing_youtube_key_skips_only_youtube(conn, cfg, make_episode, api, wts_messages):
    mocks = mock_all(api)
    add_all(make_episode, ["615"])
    store = EnvStore({"WTS_SECRET_SPOTIFY_CLIENT_ID": SPOTIFY_ID,
                      "WTS_SECRET_SPOTIFY_CLIENT_SECRET": SPOTIFY_SECRET})
    counts = match_platform_ids(conn, settings(cfg), new_client(), store)
    assert counts["youtube_skipped"] == 1 and mocks.youtube.channels.call_count == 0
    assert counts["apple"] == 1 and counts["spotify"] == 1
    assert len([m for m in wts_messages if "youtube" in m.lower()]) == 1


def test_youtube_403_is_logged_and_keeps_other_matches(conn, cfg, make_episode, api,
                                                       wts_messages):
    mock_apple(api)
    mock_spotify(api)
    api.get(f"{YT}/channels").mock(
        return_value=httpx.Response(403, json=fixture("youtube_error_403.json"))
    )
    ids = add_all(make_episode, ["615", "614"])
    counts = match_platform_ids(conn, settings(cfg), new_client(), FULL_STORE)
    assert counts["youtube_error"] == 1 and counts["apple"] == 2 and counts["spotify"] == 2
    assert column(conn, ids["615"], "apple_episode_id") == APPLE_IDS["615"]
    assert column(conn, ids["615"], "spotify_episode_id") == SPOTIFY_IDS["615"]
    assert column(conn, ids["615"], "youtube_video_id") is None
    failures = [m for m in wts_messages if "youtube" in m.lower()]
    assert len(failures) == 1 and "403" in failures[0] and "quotaExceeded" in failures[0]


def test_errors_name_the_request_without_its_query(conn, cfg, make_episode, api, wts_messages):
    mock_apple(api)
    mock_spotify(api).episodes.mock(side_effect=httpx.ReadTimeout("timed out"))
    mock_youtube(api).channels.mock(side_effect=httpx.ReadTimeout("timed out"))
    add_all(make_episode, ["615"])
    match_platform_ids(conn, settings(cfg), new_client(), FULL_STORE)
    spotify = next(m for m in wts_messages if m.startswith("spotify: lookup failed"))
    youtube = next(m for m in wts_messages if m.startswith("youtube: lookup failed"))
    assert f"ReadTimeout on GET api.spotify.com/v1/shows/{SHOW_ID}/episodes" in spotify
    assert "ReadTimeout on GET www.googleapis.com/youtube/v3/channels" in youtube
    assert "?" not in spotify and "?" not in youtube  # the YouTube key is a query parameter


@pytest.mark.parametrize(
    "failure",
    [
        httpx.Response(403, json=fixture("youtube_error_403.json")),
        httpx.Response(500, text="oops"),
        httpx.ConnectError(f"boom reaching {YT}/channels?key={YOUTUBE_KEY}"),
    ],
    ids=["403", "500", "connect-error"],
)
def test_secrets_never_appear_in_logs(conn, cfg, make_episode, api, wts_messages, failure):
    mock_apple(api)
    mock_spotify(api)
    mock_youtube(api).channels.mock(
        **({"side_effect": failure} if isinstance(failure, Exception)
           else {"return_value": failure})
    )
    add_all(make_episode, ["615"])
    match_platform_ids(conn, settings(cfg), new_client(), FULL_STORE)
    assert wts_messages
    for message in wts_messages:
        assert not any(secret in message for secret in SECRETS), message


def test_secrets_never_appear_in_logs_on_success(conn, cfg, make_episode, api, wts_messages):
    mock_all(api)
    add_all(make_episode)
    match_platform_ids(conn, settings(cfg), new_client(), FULL_STORE)
    assert wts_messages
    assert not any(secret in m for m in wts_messages for secret in SECRETS)


def test_spotify_failure_does_not_stop_the_others(conn, cfg, make_episode, api, wts_messages):
    mock_apple(api)
    api.post(SPOTIFY_TOKEN).mock(return_value=httpx.Response(401, json={"error": "invalid_client"}))
    mock_youtube(api)
    ids = add_all(make_episode, ["615"])
    counts = match_platform_ids(conn, settings(cfg), new_client(), FULL_STORE)
    assert counts["spotify_error"] == 1 and counts["apple"] == 1 and counts["youtube"] == 1
    assert column(conn, ids["615"], "spotify_episode_id") is None
    assert any("spotify" in m.lower() and "401" in m for m in wts_messages)


def test_duplicate_claims_are_dropped_for_both(conn, cfg, make_episode, api, wts_messages):
    mock_all(api)
    first = make_episode(**EPISODES["tour"])
    twin = make_episode(**{**EPISODES["tour"], "guid": "twin-guid"})  # same title, same day
    counts = match_platform_ids(conn, settings(cfg), new_client(), FULL_STORE)
    for eid in (first, twin):
        assert column(conn, eid, "spotify_episode_id") is None
        assert column(conn, eid, "youtube_video_id") is None
    assert counts["spotify"] == 0 and counts["spotify_duplicate"] == 2
    assert counts["youtube"] == 0 and counts["youtube_duplicate"] == 2
    assert counts["apple"] == 1  # only one of them has the guid Apple knows
    assert column(conn, first, "apple_episode_id") == APPLE_IDS["tour"]
    assert any(SPOTIFY_IDS["tour"] in m and "duplicate" in m.lower() for m in wts_messages)


def test_id_already_stored_on_another_episode_is_not_claimed(conn, cfg, make_episode, api,
                                                             wts_messages):
    mock_all(api)
    owner = make_episode(**EPISODES["610"], spotify_episode_id=SPOTIFY_IDS["615"],
                         youtube_video_id=YOUTUBE_IDS["615"][0])
    claimant = make_episode(**EPISODES["615"])
    counts = match_platform_ids(conn, settings(cfg), new_client(), FULL_STORE)
    assert column(conn, owner, "spotify_episode_id") == SPOTIFY_IDS["615"]  # untouched
    assert column(conn, claimant, "spotify_episode_id") is None
    assert column(conn, claimant, "youtube_video_id") is None
    assert column(conn, claimant, "apple_episode_id") == APPLE_IDS["615"]
    assert counts["spotify_duplicate"] == 1 and counts["youtube_duplicate"] == 1
    assert any("already" in m and SPOTIFY_IDS["615"] in m for m in wts_messages)


# --- run_feed ---------------------------------------------------------------------------

FEED_URL = "https://feed.example/rss"


def feed_xml(*keys: str) -> bytes:
    items = "".join(
        f"<item><title>{EPISODES[k]['title']}</title><guid>{EPISODES[k]['guid']}</guid>"
        f"<pubDate>{_rfc822(EPISODES[k]['published_at'])}</pubDate>"
        f'<enclosure url="https://cdn.example.com/{k}.mp3" type="audio/mpeg"/></item>'
        for k in keys
    )
    return f'<?xml version="1.0"?><rss version="2.0"><channel>{items}</channel></rss>'.encode()


def _rfc822(iso: str) -> str:
    from datetime import datetime
    from email.utils import format_datetime

    return format_datetime(datetime.fromisoformat(iso))


def test_run_feed_matches_platforms_and_reports_counts(conn, cfg):
    with respx.mock(assert_all_called=False) as api:
        api.get(FEED_URL).mock(return_value=httpx.Response(200, content=feed_xml("615", "614")))
        mock_apple(api)
        counts = run_feed(conn, replace(cfg, feed_url=FEED_URL), client=new_client(),
                          store=EnvStore({}))
    assert counts["added"] == 2 and counts["apple"] == 2
    assert counts["spotify_skipped"] == 1 and counts["youtube_skipped"] == 1
    rows = conn.execute("select number, apple_episode_id from episodes order by number")
    assert [tuple(r) for r in rows] == [(614, APPLE_IDS["614"]), (615, APPLE_IDS["615"])]


def test_run_feed_survives_a_platform_that_cannot_be_reached(conn, cfg):
    # An unmocked itunes.apple.com request raises inside respx; any platform failure is
    # logged and the feed still lands (spec §6).
    with respx.mock() as api:
        api.get(FEED_URL).mock(return_value=httpx.Response(200, content=feed_xml("615")))
        counts = run_feed(conn, replace(cfg, feed_url=FEED_URL), client=new_client(),
                          store=EnvStore({}))
    assert counts["added"] == 1 and counts["apple_error"] == 1
    assert conn.execute("select count(*) from episodes").fetchone()[0] == 1
