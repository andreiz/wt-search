"""Spotify episode IDs from the Web API with a client-credentials app (spec §3.2 `wts feed`).

Matched on equal normalized titles with release dates within ±2 days. An episode with more
than one candidate in that window stays unmatched.
"""

import logging
from collections import defaultdict
from collections.abc import Mapping, Sequence

import httpx

from wts.platforms.text import PlatformError, day_of, normalize_title

TOKEN_URL = "https://accounts.spotify.com/api/token"
API = "https://api.spotify.com/v1"
DATE_WINDOW_DAYS = 2
log = logging.getLogger("wts")


def _token(client: httpx.Client, client_id: str, client_secret: str) -> str:
    resp = client.post(
        TOKEN_URL, data={"grant_type": "client_credentials"}, auth=(client_id, client_secret),
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def _show_episodes(client: httpx.Client, token: str, show_id: str) -> list[dict]:
    headers = {"Authorization": f"Bearer {token}"}
    url: str | None = f"{API}/shows/{show_id}/episodes"
    params: dict | None = {"market": "US", "limit": 50}
    items: list[dict] = []
    while url:
        resp = client.get(url, params=params, headers=headers, timeout=30)
        resp.raise_for_status()
        body = resp.json()
        items.extend(item for item in body.get("items", []) if item)  # unavailable ones are null
        url, params = body.get("next"), None  # `next` carries its own query string
        if url and not url.startswith(f"{API}/"):
            raise PlatformError("Spotify paging pointed outside api.spotify.com")  # token stays
    return items


def match_spotify(
    client: httpx.Client,
    client_id: str,
    client_secret: str,
    show_id: str,
    episodes: Sequence[Mapping],
) -> dict[int, str]:
    """Episode id → Spotify episode id, for `episodes` (rows with id, title, published_at)."""
    by_title: dict[str, list[tuple]] = defaultdict(list)
    for item in _show_episodes(client, _token(client, client_id, client_secret), show_id):
        if item.get("release_date_precision") == "day":  # "month"/"year" dates can't be compared
            by_title[normalize_title(item["name"])].append(
                (day_of(item["release_date"]), item["id"])
            )
    found: dict[int, str] = {}
    for ep in episodes:
        released = day_of(ep["published_at"])
        near = {
            spotify_id
            for when, spotify_id in by_title.get(normalize_title(ep["title"]), [])
            if abs((when - released).days) <= DATE_WINDOW_DAYS
        }
        if len(near) == 1:
            found[ep["id"]] = near.pop()
        elif near:
            log.warning(
                f"spotify: {len(near)} episodes match {ep['title']!r}; leaving it unmatched",
                extra={"step": "feed"},
            )
    return found
