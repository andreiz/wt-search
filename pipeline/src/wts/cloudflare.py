"""Cloudflare REST client for `wts publish`: D1 queries and Vectorize v2 (spec §3.2, §3.6;
plan 2, Task 6).

Every request goes through a client from `wts.net.new_client()`. The API token is sent only in
the `Authorization` header: it never reaches exception messages, which carry the API's own error
codes and messages (with the token scrubbed, in case an API message echoes it) but never request
bodies, headers or raw response bodies.

Calls are retried on 429, 5xx and network errors (1, 2, 4, 8 s, or the numeric `Retry-After`),
and fail at once on other 4xx. D1's REST API is not atomic across the statements of a `batch`
(plan 2, Global Constraints), so callers write statements that are safe to repeat.
"""

import json
import logging
import re
import time
from collections.abc import Callable, Iterable, Sequence

import httpx

BASE = "https://api.cloudflare.com/client/v4"
TIMEOUT_S = 60
BACKOFF_S = (1, 2, 4, 8)  # one retry per entry
MAX_RETRY_AFTER_S = 60
VECTORS_PER_REQUEST = 1000
# D1 REST limits: 100 bound parameters per statement, 100 KB per statement. The size cap
# counts the SQL and the JSON params, and stays well under the limit.
MAX_PARAMS = 100
MAX_STATEMENT_BYTES = 50_000
log = logging.getLogger("wts")
EXTRA = {"step": "publish"}

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class CloudflareError(Exception):
    """A failed API call. `status` is the HTTP status (0 for a network error that outlasted the
    retries); `errors` is a list of `{"code", "message"}` dicts."""

    def __init__(self, status: int, errors: Sequence[dict]):
        self.status = status
        self.errors = list(errors)
        details = "; ".join(
            (f"[{e['code']}] " if e.get("code") is not None else "") + e.get("message", "")
            for e in self.errors
        )
        super().__init__(f"Cloudflare API error (HTTP {status}): {details or 'no details'}")


class CloudflareApi:
    """Authenticated POSTs to the API, with retries. `sleep` is injectable for tests."""

    def __init__(
        self,
        client: httpx.Client,
        account_id: str,
        token: str,
        base: str = BASE,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._client = client
        self.account_id = account_id
        self._token = token
        self._base = base.rstrip("/")
        self._sleep = sleep

    def post(self, path: str, *, body: object = None, content: bytes | None = None,
             content_type: str | None = None) -> dict:
        """POST `path` (under `/accounts/{account_id}`) and return the response envelope: a JSON
        `body`, or raw `content` with its `content_type`. Raises CloudflareError on a failed
        call, including `success: false` in a 200."""
        url = f"{self._base}/accounts/{self.account_id}{path}"
        headers = {"Authorization": f"Bearer {self._token}"}
        if content_type:
            headers["Content-Type"] = content_type
        kwargs = {"content": content} if content is not None else {"json": body}
        for attempt in range(len(BACKOFF_S) + 1):
            delay = None
            try:
                resp = self._client.post(url, headers=headers, timeout=TIMEOUT_S, **kwargs)
            except httpx.TransportError as exc:
                # The class name only: httpx puts the request URL in its messages.
                error = CloudflareError(0, [{"message": f"network error: {type(exc).__name__}"}])
            else:
                if resp.status_code != 429 and resp.status_code < 500:
                    return self._envelope(resp)
                error = self._error(resp)
                delay = _retry_after(resp)
            if attempt == len(BACKOFF_S):
                raise error from None
            delay = BACKOFF_S[attempt] if delay is None else delay
            log.warning(
                f"cloudflare: {error.status or 'network error'} on POST {path}; retry "
                f"{attempt + 1} of {len(BACKOFF_S)} in {delay:g}s",
                extra=EXTRA,
            )
            self._sleep(delay)
        raise AssertionError("unreachable")  # the loop returns or raises

    def _scrub(self, text: object) -> str:
        text = str(text)
        return text.replace(self._token, "[redacted]") if self._token else text

    def _error(self, resp: httpx.Response, fallback: str | None = None) -> CloudflareError:
        try:
            body = resp.json()
            raw = body.get("errors") if isinstance(body, dict) else None
        except ValueError:  # not JSON (an HTML error page from a proxy, say)
            raw = None
        errors = [
            {"code": e.get("code"), "message": self._scrub(e.get("message", ""))}
            for e in raw or [] if isinstance(e, dict)
        ]
        return CloudflareError(
            resp.status_code, errors or [{"message": fallback or f"HTTP {resp.status_code}"}])

    def _envelope(self, resp: httpx.Response) -> dict:
        if resp.status_code >= 400:
            raise self._error(resp)
        try:
            body = resp.json()
        except ValueError:
            body = None
        if not isinstance(body, dict) or not body.get("success"):
            raise self._error(resp, "response was not a success envelope")
        return body

    def fail(self, status: int, message: str) -> CloudflareError:
        """An error for a response that is well-formed but wrong (a missing result, say)."""
        return CloudflareError(status, [{"message": self._scrub(message)}])


def _retry_after(resp: httpx.Response) -> float | None:
    """Seconds from a numeric `Retry-After` header; a date or junk means "use the backoff"."""
    try:
        seconds = float(resp.headers.get("Retry-After", ""))
    except ValueError:
        return None
    return min(max(seconds, 0.0), MAX_RETRY_AFTER_S)


class D1:
    """Queries against one D1 database. Params are sent as JSON values, so numbers stay numbers."""

    def __init__(self, api: CloudflareApi, database_id: str):
        self._api = api
        self._path = f"/d1/database/{database_id}/query"

    def query(self, sql: str, params: Sequence = ()) -> list[dict]:
        """Run one statement; return its rows."""
        return self._run({"sql": sql, "params": list(params)}, 1)[0]

    def batch(self, statements: Sequence[tuple[str, Sequence]]) -> list[list[dict]]:
        """Run statements in one request; return each statement's rows. Not atomic."""
        if not statements:
            return []
        body = {"batch": [{"sql": sql, "params": list(params)} for sql, params in statements]}
        return self._run(body, len(statements))

    def _run(self, body: dict, expected: int) -> list[list[dict]]:
        result = self._api.post(self._path, body=body).get("result")
        if not isinstance(result, list) or len(result) != expected:
            got = len(result) if isinstance(result, list) else "no"
            raise self._api.fail(200, f"D1 returned {got} results for {expected} statements")
        out = []
        for number, entry in enumerate(result, 1):
            # `success` is optional per statement in the API reference; only `false` fails.
            if not isinstance(entry, dict) or entry.get("success") is False:
                reason = entry.get("error", "failed") if isinstance(entry, dict) else "failed"
                raise self._api.fail(200, f"D1 statement {number} failed: {reason}")
            out.append(entry.get("results") or [])
        return out


class Vectorize:
    """Vectorize v2 mutations on one index. Both calls split into requests of at most 1000 and
    return the mutation IDs, one per request. Vectorize applies mutations asynchronously."""

    def __init__(self, api: CloudflareApi, index: str):
        self._api = api
        self._path = f"/vectorize/v2/indexes/{index}"

    def upsert(self, vectors: Sequence[tuple[str, Sequence[float], dict]]) -> list[str]:
        """Insert or replace vectors, given as `(id, values, metadata)`."""
        mutations = []
        for i in range(0, len(vectors), VECTORS_PER_REQUEST):
            lines = [
                json.dumps({"id": vid, "values": [float(x) for x in values], "metadata": meta})
                for vid, values, meta in vectors[i : i + VECTORS_PER_REQUEST]
            ]
            body = "\n".join(lines).encode() + b"\n"
            resp = self._api.post(f"{self._path}/upsert", content=body,
                                  content_type="application/x-ndjson")
            mutations.append(self._mutation_id(resp))
        return mutations

    def delete_by_ids(self, ids: Sequence[str]) -> list[str]:
        mutations = []
        for i in range(0, len(ids), VECTORS_PER_REQUEST):
            resp = self._api.post(f"{self._path}/delete_by_ids",
                                  body={"ids": list(ids[i : i + VECTORS_PER_REQUEST])})
            mutations.append(self._mutation_id(resp))
        return mutations

    def _mutation_id(self, resp: dict) -> str:
        result = resp.get("result")
        mutation_id = result.get("mutationId") if isinstance(result, dict) else None
        if not mutation_id:
            raise self._api.fail(200, "Vectorize response has no mutationId")
        return str(mutation_id)


def _identifier(name: str) -> str:
    if not _IDENTIFIER.match(name):
        raise ValueError(f"not a plain SQL identifier: {name!r}")
    return name


def chunked_inserts(
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence],
    *,
    upsert_on: str | Sequence[str] | None = None,
    max_params: int = MAX_PARAMS,
    max_bytes: int = MAX_STATEMENT_BYTES,
) -> list[tuple[str, list]]:
    """Multi-row `insert` statements for `D1.batch`, each within `max_params` bound parameters
    and about `max_bytes` of SQL plus JSON params (8 columns → at most 12 rows per statement).

    With `upsert_on` (a column or columns), each statement ends with `on conflict(<key>) do
    update set <other column> = excluded.<column>, …`. Use this, not `insert or replace`:
    REPLACE doesn't fire the FTS5 delete trigger (schema/0001_init.sql). `upsert_on` columns
    are never updated; with nothing else to update the conflict does nothing.
    """
    columns = [_identifier(c) for c in columns]
    table = _identifier(table)
    if len(columns) > max_params:
        raise ValueError(f"{len(columns)} columns exceed the {max_params} parameters allowed")
    keys = [upsert_on] if isinstance(upsert_on, str) else list(upsert_on or [])
    if not set(keys) <= set(columns):
        raise ValueError(f"upsert_on {keys} must be among the columns {columns}")
    suffix = ""
    if keys:
        updates = [f"{c} = excluded.{c}" for c in columns if c not in keys]
        suffix = f" on conflict({', '.join(keys)}) " + (
            f"do update set {', '.join(updates)}" if updates else "do nothing")
    prefix = f"insert into {table} ({', '.join(columns)}) values "
    placeholders = "(" + ", ".join("?" * len(columns)) + ")"
    max_rows = max_params // len(columns)
    base = len((prefix + suffix).encode())
    # Each row costs its placeholders plus ", " in the SQL and its JSON in the params.
    row_sql = len(placeholders) + 2

    statements: list[tuple[str, list]] = []
    batch: list[Sequence] = []
    size = base
    for number, row in enumerate(rows):
        if len(row) != len(columns):
            raise ValueError(f"row {number} has {len(row)} values for {len(columns)} columns")
        cost = row_sql + len(json.dumps(list(row), ensure_ascii=False).encode())
        if base + cost > max_bytes:
            raise ValueError(f"row {number} is too large for one statement ({base + cost} bytes)")
        if batch and (len(batch) == max_rows or size + cost > max_bytes):
            statements.append(_statement(prefix, placeholders, suffix, batch))
            batch, size = [], base
        batch.append(row)
        size += cost
    if batch:
        statements.append(_statement(prefix, placeholders, suffix, batch))
    return statements


def _statement(
    prefix: str, placeholders: str, suffix: str, rows: list[Sequence]
) -> tuple[str, list]:
    sql = prefix + ", ".join([placeholders] * len(rows)) + suffix
    return sql, [value for row in rows for value in row]
