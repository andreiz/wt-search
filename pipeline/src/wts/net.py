"""HTTP client for the feed and downloads (spec §3.2)."""

import httpx

from wts import __version__

# Acast serves ad-free audio to bots it recognises: the check is case-sensitive ("…Bot" passes,
# "wts-bot" got ads) and httpx's default User-Agent gets ads. Keep the capital B.
USER_AGENT = f"WoodTalkSearchBot/{__version__} (+https://github.com/andreiz/wt-search)"


def new_client() -> httpx.Client:
    return httpx.Client(headers={"User-Agent": USER_AGENT})


def describe_http_error(exc: httpx.HTTPError) -> str:
    """`HTTP 500 on GET host/path` or `ConnectError on GET host/path`, for logs and messages.

    httpx puts the full request URL in its own messages, and URLs can carry secrets in the
    query string (or, for ntfy, the topic). This keeps the status or class name, the method,
    the host and the path, nothing else.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        what = f"HTTP {exc.response.status_code}"
    else:
        what = type(exc).__name__
    try:
        request = exc.request
    except RuntimeError:  # an httpx error raised without a request attached
        return what
    return f"{what} on {request.method} {request.url.host}{request.url.path}"
