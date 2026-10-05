"""YouTube video IDs and lengths from the Data API (spec §3.2 `wts feed`, §4.6).

Lists the channel's uploads playlist (about 1 quota unit per 50 videos; plan 2, decision 5)
instead of searching (100 units per call). Every match is stored with the video's length; the
3 s length rule against the feed is applied when publishing, not here.

Numbered episodes match on the number in the video title, in any style `split_title` knows;
unnumbered ones on equal normalized titles. Either way the dates must be within ±14 days, and
an episode with more than one candidate stays unmatched.
"""

import logging
import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date

import httpx

from wts.platforms.text import PlatformError, day_of, normalize_title
from wts.stems import split_title

API = "https://www.googleapis.com/youtube/v3"
DATE_WINDOW_DAYS = 14
VIDEOS_PER_CALL = 50
log = logging.getLogger("wts")

_DURATION = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")


@dataclass(frozen=True)
class Video:
    id: str
    title: str
    published: date
    duration_s: int


def parse_duration(value: str | None) -> int | None:
    """Seconds in an ISO 8601 duration such as `PT1H4M15S`, `PT50M39S` or `PT45S`."""
    match = _DURATION.match(value or "")
    if not match or not any(match.groups()):  # "", "P" and "PT" carry no duration
        return None
    days, hours, minutes, seconds = (int(g or 0) for g in match.groups())
    return ((days * 24 + hours) * 60 + minutes) * 60 + seconds


def _get(client: httpx.Client, resource: str, api_key: str, **params) -> dict:
    resp = client.get(f"{API}/{resource}", params={**params, "key": api_key}, timeout=30)
    resp.raise_for_status()
    return resp.json()


def _uploads_playlist(client: httpx.Client, api_key: str, handle: str) -> str:
    body = _get(client, "channels", api_key, part="contentDetails", forHandle=handle)
    items = body.get("items") or []
    if not items:
        raise PlatformError(f"no YouTube channel found for {handle}")
    return items[0]["contentDetails"]["relatedPlaylists"]["uploads"]


def _playlist_items(client: httpx.Client, api_key: str, playlist_id: str) -> list[dict]:
    items: list[dict] = []
    page_token = None
    while True:
        params = {"part": "snippet", "maxResults": 50, "playlistId": playlist_id}
        if page_token:
            params["pageToken"] = page_token
        body = _get(client, "playlistItems", api_key, **params)
        items.extend(body.get("items", []))
        page_token = body.get("nextPageToken")
        if not page_token:
            return items


def _durations(client: httpx.Client, api_key: str, video_ids: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for i in range(0, len(video_ids), VIDEOS_PER_CALL):
        batch = video_ids[i : i + VIDEOS_PER_CALL]
        body = _get(client, "videos", api_key, part="contentDetails", id=",".join(batch))
        for item in body.get("items", []):
            seconds = parse_duration(item.get("contentDetails", {}).get("duration"))
            if seconds is not None:
                out[item["id"]] = seconds
    return out


def _channel_videos(client: httpx.Client, api_key: str, handle: str) -> list[Video]:
    items = _playlist_items(client, api_key, _uploads_playlist(client, api_key, handle))
    # Deleted and private videos stay in the playlist but have no length: they're dropped.
    snippets = {
        item["snippet"]["resourceId"]["videoId"]: item["snippet"]
        for item in items
        if item.get("snippet", {}).get("resourceId", {}).get("videoId")
    }
    durations = _durations(client, api_key, list(snippets))
    return [
        Video(video_id, s["title"], day_of(s["publishedAt"]), durations[video_id])
        for video_id, s in snippets.items()
        if video_id in durations and s.get("publishedAt")
    ]


def match_youtube(
    client: httpx.Client, api_key: str, handle: str, episodes: Sequence[Mapping]
) -> dict[int, tuple[str, int]]:
    """Episode id → (video id, video length in seconds), for `episodes` (rows with id, number,
    title, published_at)."""
    by_number: dict[int, list[Video]] = defaultdict(list)
    by_title: dict[str, list[Video]] = defaultdict(list)
    for video in _channel_videos(client, api_key, handle):
        number = split_title(video.title, None)[0]
        if number is not None:
            by_number[number].append(video)
        by_title[normalize_title(video.title)].append(video)
    found: dict[int, tuple[str, int]] = {}
    for ep in episodes:
        released = day_of(ep["published_at"])
        candidates = (
            by_number.get(ep["number"], []) if ep["number"] is not None
            else by_title.get(normalize_title(ep["title"]), [])
        )
        near = {
            v.id: v for v in candidates if abs((v.published - released).days) <= DATE_WINDOW_DAYS
        }
        if len(near) == 1:
            video = next(iter(near.values()))
            found[ep["id"]] = (video.id, video.duration_s)
        elif near:
            log.warning(
                f"youtube: {len(near)} videos match {ep['title']!r}; leaving it unmatched",
                extra={"step": "feed"},
            )
    return found
