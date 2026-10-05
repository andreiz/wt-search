"""HTTP client for the feed and downloads (spec §3.2)."""

import httpx

from wts import __version__

# Acast serves ad-free audio to bots it recognises: the check is case-sensitive ("…Bot" passes,
# "wts-bot" got ads) and httpx's default User-Agent gets ads. Keep the capital B.
USER_AGENT = f"WoodTalkSearchBot/{__version__} (+https://github.com/andreiz/wt-search)"


def new_client() -> httpx.Client:
    return httpx.Client(headers={"User-Agent": USER_AGENT})
