"""`wts search`: a terminal client of the Worker's `GET /api/search` (spec §3.2, §4.4; plan 2,
Task 13a).

It shows exactly what the web app will, because the query syntax, ranking, collapsing, cue times
and links all stay in the Worker. `search()` is also what `wts eval` and the smoke search after
`wts run` call. The API is public, so there are no secrets here; the query is, though, kept out
of every error message (as in `wts.net.describe_http_error`: status or class, method, host and
path, never the query string).
"""

import time
from collections.abc import Callable

import click
import httpx

from wts.net import describe_http_error

RETRY_S = (1, 2)  # one retry per entry, on network errors, 429 and 5xx
TIMEOUT_S = 30
LINK_ORDER = ("youtube", "apple", "spotify", "page")  # card order (spec §4.6)
MAX_ERROR_CHARS = 100


class SearchError(Exception):
    """A failed search. `status` is the HTTP status, or None for a network error."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def search(
    client: httpx.Client,
    api_url: str,
    q: str,
    *,
    mode: str = "smart",
    sort: str = "relevance",
    page: int = 1,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """GET `<api_url>/api/search` and return the parsed response.

    Network errors, 429 and 5xx (a 503 is D1 being briefly unavailable) are retried once per
    `RETRY_S` entry; other 4xx fail at once. `sleep` is injectable for tests.
    """
    url = f"{api_url.rstrip('/')}/api/search"
    params = {"q": q, "mode": mode, "sort": sort, "page": page}
    for attempt in range(len(RETRY_S) + 1):
        try:
            resp = client.get(url, params=params, timeout=TIMEOUT_S)
        except httpx.TransportError as exc:
            error = SearchError(f"search failed: {describe_http_error(exc)}")
        else:
            if resp.status_code == 429 or resp.status_code >= 500:
                error = _status_error(resp)
            elif resp.status_code >= 400:
                raise _status_error(resp)
            else:
                return _parse(resp)
        if attempt == len(RETRY_S):
            raise error from None
        sleep(RETRY_S[attempt])
    raise AssertionError("unreachable")  # the loop returns or raises


def _where(resp: httpx.Response) -> str:
    request = resp.request
    return f"{request.method} {request.url.host}{request.url.path}"


def _status_error(resp: httpx.Response) -> SearchError:
    """`search failed: HTTP 503 (unavailable) on GET host/api/search`; the parenthesis is the
    API's own `error` field when its body has one."""
    try:
        body = resp.json()
    except ValueError:  # not JSON (an HTML error page from a proxy, say)
        body = None
    detail = body.get("error") if isinstance(body, dict) else None
    suffix = f" ({detail[:MAX_ERROR_CHARS]})" if isinstance(detail, str) and detail else ""
    return SearchError(
        f"search failed: HTTP {resp.status_code}{suffix} on {_where(resp)}", resp.status_code)


def _parse(resp: httpx.Response) -> dict:
    try:
        body = resp.json()
    except ValueError:
        raise SearchError(
            f"search failed: response from {_where(resp)} is not valid JSON", resp.status_code
        ) from None
    if not isinstance(body, dict):
        raise SearchError(
            f"search failed: response from {_where(resp)} is not a JSON object", resp.status_code)
    return body


# --- formatting --------------------------------------------------------------------------------


def format_results(response: dict, *, color: bool) -> str:
    """The response as plain text: a header, then one block per result, then footers.

    Hits are bold when `color`, else wrapped in `[` `]`.
    """
    lines = [_header(response)]
    results = response.get("results") or []
    if not results:
        lines.append("No results.")
        return "\n".join(lines)
    for r in results:
        lines += ["", *_result_lines(r, color)]
    total = _total(response)
    footers = []
    if response.get("truncated"):
        footers.append(f'Showing the best 200 of {total} matches; '
                       'add words, a "phrase" or year: to narrow.')
    if response.get("has_more"):
        footers.append(f"More: --page {int(response.get('page', 1)) + 1}")
    if footers:
        lines += ["", *footers]
    return "\n".join(lines)


def _total(response: dict) -> str:
    total = response.get("total", 0)
    return f"{total}+" if response.get("total_capped") else str(total)


def _header(response: dict) -> str:
    if response.get("mode") == "exact":
        one = response.get("total") == 1 and not response.get("total_capped")
        head = f"{_total(response)} {'match' if one else 'matches'}"
    elif response.get("smart_degraded"):
        head = "smart search degraded: keyword results only"
    else:
        head = "smart search"
    page = response.get("page", 1)
    if page > 1:
        head += f", page {page}"
    # Matches count chunks; nearby hits in one episode share a result (`more_in_episode`). Say
    # so, or "5 matches" over 4 results looks like a lost hit.
    results = response.get("results") or []
    folded = sum(r.get("more_in_episode", 0) for r in results)
    if folded:
        what = "a nearby hit" if folded == 1 else "nearby hits"
        head += f"; {len(results)} results ({folded} folded into {what})"
    return head


def _result_lines(r: dict, color: bool) -> list[str]:
    episode = r["episode"]
    number = episode.get("number")
    title = f"#{number} " if number is not None else ""
    title += f"{episode['title']} ({episode['date']})  {_clock(r.get('hit_ms', 0))}"
    lines = [title, "  " + _highlight(r["text"], r.get("ranges") or [], color)]
    more = r.get("more_in_episode", 0)
    if more > 0:
        lines.append(f"  +{more} more in episode")
    links = episode.get("links") or {}
    lines += [f"  {name:<7}  {links[name]}" for name in LINK_ORDER if links.get(name)]
    return lines


def _clock(ms: int) -> str:
    """`m:ss`, or `h:mm:ss` from one hour."""
    hours, rest = divmod(max(int(ms), 0) // 1000, 3600)
    minutes, seconds = divmod(rest, 60)
    return f"{hours}:{minutes:02}:{seconds:02}" if hours else f"{minutes}:{seconds:02}"


def _highlight(text: str, ranges: list, color: bool) -> str:
    """`text` with each range marked. The API's ranges are UTF-16 code-unit offsets (spec
    §4.4, what JavaScript's `slice` takes), so they are converted to `str` indices first: an
    emoji is two units there and one character here. A range that is empty, out of bounds,
    overlapping the one before, or starting or ending inside a surrogate pair is ignored."""
    index_of = {}  # UTF-16 offset -> str index, for offsets that fall between characters
    units = 0
    for i, ch in enumerate(text):
        index_of[units] = i
        units += 2 if ord(ch) > 0xFFFF else 1
    index_of[units] = len(text)

    out = []
    pos = 0  # str index up to which text has been copied
    for r in sorted(ranges, key=_range_start):
        if not (isinstance(r, list | tuple) and len(r) == 2
                and all(isinstance(n, int) for n in r)):
            continue
        start, end = index_of.get(r[0]), index_of.get(r[1])
        if start is None or end is None or start >= end or start < pos:
            continue
        hit = text[start:end]
        out += [text[pos:start], click.style(hit, bold=True) if color else f"[{hit}]"]
        pos = end
    out.append(text[pos:])
    return "".join(out)


def _range_start(r: object) -> float:
    """Sort key that never raises on a malformed range (those are skipped later)."""
    if isinstance(r, list | tuple) and r and isinstance(r[0], int):
        return r[0]
    return float("inf")
