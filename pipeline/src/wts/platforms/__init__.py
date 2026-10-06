"""Platform ID matching for `wts feed` (spec §3.2, §4.6, §6).

Apple, Spotify and YouTube IDs are looked up only for episodes that don't have one yet, and an
existing ID is never overwritten. A platform whose secrets or config are missing is skipped
with one warning; a platform that fails is logged and the others still run. Either way the ID
stays null and the next `wts feed` tries again.
"""

import logging
import sqlite3
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx

from wts.config import Config
from wts.platforms.apple import match_apple
from wts.platforms.spotify import match_spotify
from wts.platforms.text import PlatformError
from wts.platforms.youtube import match_youtube
from wts.secrets import MissingSecret, SecretStore, get_secret

log = logging.getLogger("wts")
EXTRA = {"step": "feed"}

# episode id → (platform id, extra value stored beside it: YouTube's length in seconds)
Matches = dict[int, tuple[str, int | None]]


class MissingConfig(Exception):
    pass


def _find_apple(cfg: Config, client: httpx.Client, store: SecretStore, rows: list) -> Matches:
    by_guid = match_apple(client, cfg.apple_podcast_id)
    return {row["id"]: (by_guid[row["guid"]], None) for row in rows if row["guid"] in by_guid}


def _find_spotify(cfg: Config, client: httpx.Client, store: SecretStore, rows: list) -> Matches:
    if not cfg.spotify_show_id:
        raise MissingConfig("spotify_show_id is not set in config.toml")
    client_id = get_secret(store, "spotify_client_id")
    client_secret = get_secret(store, "spotify_client_secret")
    found = match_spotify(client, client_id, client_secret, cfg.spotify_show_id, rows)
    return {eid: (spotify_id, None) for eid, spotify_id in found.items()}


def _find_youtube(cfg: Config, client: httpx.Client, store: SecretStore, rows: list) -> Matches:
    return match_youtube(client, get_secret(store, "youtube_api_key"), cfg.youtube_handle, rows)


@dataclass(frozen=True)
class Platform:
    name: str
    column: str
    extra_column: str | None
    find: Callable[[Config, httpx.Client, SecretStore, list], Matches]


PLATFORMS = (
    Platform("apple", "apple_episode_id", None, _find_apple),
    Platform("spotify", "spotify_episode_id", None, _find_spotify),
    Platform("youtube", "youtube_video_id", "youtube_duration_s", _find_youtube),
)


def _request(exc: httpx.HTTPError) -> str:
    """` on GET host/path` for the failed request, without the query string."""
    try:
        request = exc.request
    except RuntimeError:  # an httpx error raised without a request attached
        return ""
    return f" on {request.method} {request.url.host}{request.url.path}"


def _describe(exc: Exception) -> str:
    """What went wrong, without the exception's own text: httpx puts the request URL in its
    messages, and the YouTube key is a query parameter of that URL."""
    if isinstance(exc, httpx.HTTPStatusError):
        text = f"HTTP {exc.response.status_code}"
        try:
            reason = exc.response.json()["error"]["errors"][0]["reason"]  # Google's error body
        except Exception:  # noqa: BLE001 — any other body shape just has no reason
            reason = None
        if isinstance(reason, str) and reason.isalpha():
            text += f" {reason}"
        return text + _request(exc)
    if isinstance(exc, httpx.HTTPError):
        return type(exc).__name__ + _request(exc)
    if isinstance(exc, PlatformError):
        return str(exc)
    return type(exc).__name__


def _claimable(
    conn: sqlite3.Connection, platform: Platform, found: Matches, stems: dict[int, str],
    counts: Counter,
) -> Matches:
    """Drop matches whose platform ID two episodes claim, or another episode already holds."""
    claimed_by = defaultdict(list)
    for episode_id, (platform_id, _) in found.items():
        claimed_by[platform_id].append(episode_id)
    keep: Matches = {}
    for platform_id, episode_ids in claimed_by.items():
        names = ", ".join(stems[i] for i in episode_ids)
        if len(episode_ids) > 1:
            counts[f"{platform.name}_duplicate"] += len(episode_ids)
            log.warning(
                f"{platform.name}: duplicate match, {platform_id} was claimed by {names}; "
                "dropped for all of them",
                extra=EXTRA,
            )
            continue
        holder = conn.execute(
            f"select stem from episodes where {platform.column} = ?", (platform_id,)
        ).fetchone()
        if holder:
            counts[f"{platform.name}_duplicate"] += 1
            log.warning(
                f"{platform.name}: {platform_id} is already stored on {holder['stem']}; "
                f"not given to {names}",
                extra=EXTRA,
            )
            continue
        keep[episode_ids[0]] = found[episode_ids[0]]
    return keep


def match_platform_ids(
    conn: sqlite3.Connection, cfg: Config, client: httpx.Client, store: SecretStore
) -> Counter:
    """Fill null Apple, Spotify and YouTube IDs. Counts matches per platform, plus
    `<platform>_skipped`, `_error` and `_duplicate` when those happen."""
    counts: Counter = Counter()
    for platform in PLATFORMS:
        rows = conn.execute(
            "select id, guid, number, title, published_at, stem from episodes "
            f"where {platform.column} is null order by published_at"
        ).fetchall()
        if not rows:
            continue  # nothing to look up: no request, no warning about missing secrets
        try:
            found = platform.find(cfg, client, store, rows)
        except (MissingSecret, MissingConfig) as exc:
            counts[f"{platform.name}_skipped"] += 1
            log.warning(f"{platform.name}: skipped; {exc}", extra=EXTRA)
            continue
        except Exception as exc:  # noqa: BLE001 — one platform failing must not stop the others
            counts[f"{platform.name}_error"] += 1
            log.error(
                f"{platform.name}: lookup failed ({_describe(exc)}); the IDs stay null and "
                "are retried on the next `wts feed`",
                extra=EXTRA,
            )
            continue
        found = _claimable(conn, platform, found, {r["id"]: r["stem"] for r in rows}, counts)
        sets = f"{platform.column} = ?"
        if platform.extra_column:
            sets += f", {platform.extra_column} = ?"
        checked_at = datetime.now(UTC).isoformat(timespec="seconds")
        with conn:
            conn.executemany(
                "update episodes set platforms_checked_at = ? where id = ?",
                [(checked_at, r["id"]) for r in rows],
            )
            for episode_id, (platform_id, extra) in found.items():
                values = (platform_id, extra) if platform.extra_column else (platform_id,)
                conn.execute(
                    f"update episodes set {sets} where id = ? and {platform.column} is null",
                    (*values, episode_id),
                )
        counts[platform.name] += len(found)
        log.info(
            f"{platform.name}: matched {len(found)} of {len(rows)} episodes without an ID",
            extra=EXTRA,
        )
    return counts
