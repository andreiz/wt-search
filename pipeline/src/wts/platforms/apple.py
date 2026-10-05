"""Apple Podcasts IDs from the iTunes lookup API (spec §3.2 `wts feed`, §4.6).

No key is needed. The lookup returns only the newest ~200 episodes, so older episodes get no
Apple ID (plan 2, decision 4). Episodes are keyed on `episodeGuid`, which is the RSS guid.
"""

import httpx

LOOKUP_URL = "https://itunes.apple.com/lookup"


def match_apple(client: httpx.Client, podcast_id: int) -> dict[str, str]:
    """RSS guid → Apple episode id (`trackId`), for every episode the lookup returns."""
    resp = client.get(
        LOOKUP_URL,
        params={"id": podcast_id, "media": "podcast", "entity": "podcastEpisode", "limit": 200},
        timeout=30,
        follow_redirects=True,
    )
    resp.raise_for_status()
    found: dict[str, str] = {}
    for result in resp.json().get("results", []):
        # The first result is the podcast itself (kind "podcast"); episodes carry a guid.
        guid, track_id = result.get("episodeGuid"), result.get("trackId")
        if result.get("kind") == "podcast-episode" and guid and track_id is not None:
            found[guid] = str(track_id)
    return found
