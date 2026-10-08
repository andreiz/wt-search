"""`wts links`: an episode's links from state.db, built as the Worker builds them for a result
card (worker/src/links.ts, spec §4.6), plus the feed's audio URL.

The rules match the site's: a platform is left out when its ID is missing, YouTube only when
the matched video's length is within 3 s of the feed's, and a time (`--at`) is shifted by each
platform's offset, never below 0. Unlike a search hit's cue there is no 7 s lead-in: the time
asked for is the time linked.
"""

import re
import sqlite3
from urllib.parse import quote

from wts.publish import youtube_id_for_publish

APPLE_SHOW_URL = "https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480"
_TIME = re.compile(r"(?:(\d+):)?(?:(\d+):)?(\d+)")


def parse_time(text: str) -> int:
    """Seconds from `754`, `12:34` or `1:02:03`; ValueError otherwise."""
    match = _TIME.fullmatch(text.strip())
    if not match:
        raise ValueError(f"{text!r} is not a time like 12:34, 1:02:03 or 754")
    parts = [int(p) for p in match.groups() if p is not None]
    if any(p >= 60 for p in parts[1:]):
        raise ValueError(f"{text!r} is not a time like 12:34, 1:02:03 or 754")
    seconds = 0
    for p in parts:
        seconds = seconds * 60 + p
    return seconds


def _t(at_s: int, offset_s: int) -> int:
    return max(0, at_s + offset_s)


def episode_links(row: sqlite3.Row, at_s: int | None = None) -> dict[str, str]:
    """youtube, apple, spotify, page, audio: in the result card's order, missing ones left out."""
    links: dict[str, str] = {}
    youtube = youtube_id_for_publish(row)
    if youtube:
        links["youtube"] = f"https://www.youtube.com/watch?v={quote(youtube, safe='')}" + (
            "" if at_s is None else f"&t={_t(at_s, row['offset_youtube_s'])}s")
    if row["apple_episode_id"]:
        links["apple"] = f"{APPLE_SHOW_URL}?i={quote(row['apple_episode_id'], safe='')}" + (
            "" if at_s is None else f"&t={_t(at_s, row['offset_apple_s'])}")
    if row["spotify_episode_id"]:
        links["spotify"] = (
            f"https://open.spotify.com/episode/{quote(row['spotify_episode_id'], safe='')}"
            + ("" if at_s is None else f"?t={_t(at_s, row['offset_spotify_s'])}"))
    if row["page_url"]:
        links["page"] = row["page_url"]
    if row["audio_url"]:
        links["audio"] = row["audio_url"]
    return links


def youtube_note(row: sqlite3.Row) -> str | None:
    """Why a matched YouTube video isn't linked (the 3 s length rule), or None."""
    video, video_s, feed_s = row["youtube_video_id"], row["youtube_duration_s"], row["duration_s"]
    if video is None or youtube_id_for_publish(row) is not None:
        return None
    if video_s is None or feed_s is None:
        return f"(matched {video}, but a length is unknown: not linked)"
    drift = video_s - feed_s  # past YOUTUBE_MAX_DRIFT_S, or youtube_id_for_publish took it
    return (f"(matched {video}, but {abs(drift)} s {'longer' if drift > 0 else 'shorter'} "
            "than the feed: not linked)")
