"""The review tool's local HTTP server: the page, the episode JSON, the audio, and the checks.

Standard library only. It binds 127.0.0.1, so the only way to reach it from another site is the
browser, which is why every request is checked in one place (`_Handler._dispatch`), in this
order: `Host` (403), route known (404), token where needed (401), then for a write the method,
`Content-Type` and `Origin` (405, 415, 403), then the body (413, 400).

Write endpoints are added by putting a function in `ReviewApp.post_routes`:
`handler(body: dict, conn: sqlite3.Connection) -> (status, json_body)`.
"""

import hmac
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import sys
import tempfile
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from hashlib import sha256
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

from wts.chunking import chunk_episode
from wts.corrections import (
    CORRECTIONS_FILE,
    CorrectionRule,
    _match_words,
    load_corrections,
)
from wts.corrections_check import Change, changes_digest, rule_changes
from wts.corrections_edit import EditFailed, RuleExists, add_rule
from wts.paths import Paths
from wts.review.data import episode_payload

log = logging.getLogger("wts")

MAX_BODY = 64 * 1024
CHUNK = 64 * 1024
CSP = "default-src 'self'; media-src 'self'; frame-ancestors 'none'"
JSON_TYPE = "application/json; charset=utf-8"
# The only files /static/ serves; a request never names a file system path.
STATIC_FILES = {
    "review.css": "text/css; charset=utf-8",
    "review.js": "text/javascript; charset=utf-8",
}
AUDIO_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4"}
_RANGE = re.compile(r"bytes=(\d*)-(\d*)")

PostHandler = Callable[[dict, sqlite3.Connection], tuple[int, dict]]


class ReviewApp:
    def __init__(
        self,
        conn_factory: Callable[[], sqlite3.Connection],
        paths: Paths,
        corrections_file: Path = CORRECTIONS_FILE,
        token: str | None = None,
    ) -> None:
        self.conn_factory = conn_factory
        self.paths = paths
        self.corrections_file = corrections_file
        self.token = token or secrets.token_urlsafe(24)
        self.post_routes: dict[str, PostHandler] = {}
        # The server is threaded: reading, checking and replacing corrections.yaml is one step.
        self.corrections_lock = threading.Lock()
        register_corrections(self)

    def url(
        self, port: int, episode_id: int, at_ms: int | None = None, report_id: int | None = None
    ) -> str:
        query = {"t": self.token, "episode": episode_id}
        if at_ms is not None:
            query["at"] = at_ms
        if report_id is not None:
            query["report"] = report_id
        return f"http://127.0.0.1:{port}/?{urlencode(query)}"


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        # A browser that seeks or closes a tab drops its connection mid-answer; that is normal.
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


def serve(app: ReviewApp, port: int = 0) -> ThreadingHTTPServer:
    """A server bound to 127.0.0.1; the caller runs `serve_forever()`."""
    return _Server(("127.0.0.1", port), _make_handler(app))


class _Reply(Exception):
    """Ends a request with a JSON error."""

    def __init__(self, status: int, error: str, headers: list[tuple[str, str]] = ()) -> None:
        super().__init__(error)
        self.status = status
        self.error = error
        self.headers = headers


def _make_handler(app: ReviewApp) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args) -> None:  # the token is in URLs
            pass

        # -- plumbing --

        def _send(self, status: int, body: bytes, content_type: str, extra=()) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self._security_headers()
            for name, value in extra:
                self.send_header(name, value)
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _security_headers(self) -> None:
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            # The page's own URL holds the token; it must not travel in a Referer.
            self.send_header("Referrer-Policy", "no-referrer")

        def _json(self, status: int, payload: dict) -> None:
            self._send(status, json.dumps(payload).encode(), JSON_TYPE)

        def _handle(self, method: str) -> None:
            try:
                self._dispatch(method)
            except _Reply as r:
                if method == "POST":
                    self.close_connection = True  # the body may be unread
                body = json.dumps({"error": r.error}).encode()
                self._send(r.status, body, JSON_TYPE, r.headers)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                self.close_connection = True
            except Exception:
                log.exception("review server error")
                self.close_connection = True
                try:
                    self._json(500, {"error": "internal"})
                except OSError:
                    pass

        def do_GET(self) -> None:
            self._handle("GET")

        def do_POST(self) -> None:
            self._handle("POST")

        def do_PUT(self) -> None:
            self._handle("PUT")

        def do_DELETE(self) -> None:
            self._handle("DELETE")

        def do_PATCH(self) -> None:
            self._handle("PATCH")

        # -- the checks, in one place --

        def _allowed_hosts(self) -> set[str]:
            port = self.server.server_address[1]
            return {f"127.0.0.1:{port}", f"localhost:{port}"}

        def _dispatch(self, method: str) -> None:
            if self.headers.get("Host", "") not in self._allowed_hosts():
                raise _Reply(403, "forbidden_host")
            parts = urlsplit(self.path)
            path = unquote(parts.path)
            query = parse_qs(parts.query)
            if ".." in path or "\\" in path:
                raise _Reply(404, "not_found")

            get_handler = self._get_route(path)
            post_handler = app.post_routes.get(path)
            if get_handler is None and post_handler is None:
                raise _Reply(404, "not_found")
            if path.startswith(("/api/", "/audio/")) and not self._token_ok(query):
                raise _Reply(401, "unauthorized")

            if post_handler is not None and get_handler is None:
                if method != "POST":
                    raise _Reply(405, "method_not_allowed")
                self._post(post_handler)
            else:
                if method != "GET":
                    raise _Reply(405, "method_not_allowed")
                assert get_handler is not None
                get_handler(path, query)

        def _token_ok(self, query: dict[str, list[str]]) -> bool:
            given = self.headers.get("X-Review-Token") or (query.get("t") or [""])[0]
            return hmac.compare_digest(given.encode(), app.token.encode())

        def _post(self, handler: PostHandler) -> None:
            ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if ctype != "application/json":
                raise _Reply(415, "unsupported_media_type")
            origin = self.headers.get("Origin")
            if origin is not None and origin not in {
                f"http://{h}" for h in self._allowed_hosts()
            }:
                raise _Reply(403, "forbidden_origin")
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                raise _Reply(400, "bad_json") from None
            if length < 0:
                raise _Reply(400, "bad_json")
            if length > MAX_BODY:
                raise _Reply(413, "too_large")
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except ValueError:  # includes UnicodeDecodeError and JSONDecodeError
                raise _Reply(400, "bad_json") from None
            if not isinstance(body, dict):
                raise _Reply(400, "bad_json")
            conn = app.conn_factory()
            try:
                status, payload = handler(body, conn)
            finally:
                conn.close()
            self._json(status, payload)

        # -- GET routes --

        def _get_route(self, path: str):
            if path == "/":
                return self._index
            if path.startswith("/static/") and path[len("/static/") :] in STATIC_FILES:
                return self._static
            if path == "/api/episode":
                return self._episode
            if path.startswith("/audio/"):
                return self._audio
            return None

        def _index(self, path, query) -> None:
            self._send(200, _static_bytes("index.html"), "text/html; charset=utf-8")

        def _static(self, path, query) -> None:
            name = path[len("/static/") :]
            self._send(200, _static_bytes(name), STATIC_FILES[name])

        def _episode(self, path, query) -> None:
            episode_id = _int((query.get("id") or [""])[0])
            conn = app.conn_factory()
            try:
                row = (
                    conn.execute("select * from episodes where id = ?", (episode_id,)).fetchone()
                    if episode_id is not None
                    else None
                )
                if row is None:
                    raise _Reply(404, "not_found")
                if not row["transcript_path"]:
                    raise _Reply(409, "not_transcribed")
                payload = episode_payload(conn, row, load_corrections(app.corrections_file))
            finally:
                conn.close()
            self._json(200, payload)

        def _audio(self, path, query) -> None:
            episode_id = _int(path[len("/audio/") :])
            audio = None
            if episode_id is not None:
                conn = app.conn_factory()
                try:
                    row = conn.execute(
                        "select audio_path from episodes where id = ?", (episode_id,)
                    ).fetchone()
                finally:
                    conn.close()
                if row and row["audio_path"]:
                    audio = Path(row["audio_path"])
            if audio is None or not audio.is_file():
                raise _Reply(404, "not_found")
            ctype = AUDIO_TYPES.get(audio.suffix.lower(), "application/octet-stream")
            try:
                f = audio.open("rb")
            except OSError:
                raise _Reply(404, "not_found") from None
            with f:
                size = audio.stat().st_size
                span = _parse_range(self.headers.get("Range"), size)
                if span == "unsatisfiable":
                    raise _Reply(
                        416, "range_not_satisfiable", [("Content-Range", f"bytes */{size}")]
                    )
                if span is None:
                    status, start, end = 200, 0, size - 1
                    extra = [("Accept-Ranges", "bytes")]
                else:
                    status = 206
                    start, end = span
                    extra = [
                        ("Accept-Ranges", "bytes"),
                        ("Content-Range", f"bytes {start}-{end}/{size}"),
                    ]
                length = end - start + 1
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(length))
                self._security_headers()
                for name, value in extra:
                    self.send_header(name, value)
                self.end_headers()
                f.seek(start)
                left = length
                while left > 0:
                    piece = f.read(min(CHUNK, left))
                    if not piece:
                        self.close_connection = True  # the file shrank under us
                        break
                    self.wfile.write(piece)
                    left -= len(piece)

        def send_error(self, code, message=None, explain=None) -> None:
            # Malformed requests that the base class rejects itself (bad request line, ...).
            body = json.dumps({"error": HTTPStatus(code).name.lower()}).encode()
            self.close_connection = True
            self._send(code, body, JSON_TYPE)

    return Handler


def _static_bytes(name: str) -> bytes:
    return resources.files("wts.review").joinpath("static", name).read_bytes()


def _int(text: str) -> int | None:
    return int(text) if text.isascii() and text.isdigit() else None


def _parse_range(header: str | None, size: int) -> tuple[int, int] | str | None:
    """`(start, end)` inclusive for one valid range, "unsatisfiable", or None for the whole file.

    A malformed header, another unit and several ranges are answered with the whole file, which
    RFC 9110 allows.
    """
    if not header:
        return None
    m = _RANGE.fullmatch(header.strip())
    if not m or (not m.group(1) and not m.group(2)):
        return None
    first, last = m.groups()
    if not first:  # bytes=-n: the last n bytes
        n = int(last)
        if n == 0 or size == 0:
            return "unsatisfiable"
        return max(size - n, 0), size - 1
    start = int(first)
    end = int(last) if last else size - 1
    if last and end < start:
        return None
    if start >= size:
        return "unsatisfiable"
    return start, min(end, size - 1)


# -- write endpoints --

MAX_RULE_TEXT = 200


class _Bad(Exception):
    """A write handler's early exit: `(status, {"error": slug})`."""

    def __init__(self, status: int, error: str) -> None:
        super().__init__(error)
        self.status = status
        self.error = error


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _episode_row(conn: sqlite3.Connection, episode_id: object) -> sqlite3.Row:
    """The episode with this id: 400 for a non-integer, 404 for an unknown one."""
    if not _is_int(episode_id):
        raise _Bad(400, "bad_request")
    row = conn.execute("select * from episodes where id = ?", (episode_id,)).fetchone()
    if row is None:
        raise _Bad(404, "not_found")
    return row


def _parse_rule(body: dict, conn: sqlite3.Connection) -> tuple[str, str, str | None]:
    """`(key, value, stem or None)` from a request body, or a `_Bad`."""
    key, value, scope = body.get("key"), body.get("value"), body.get("episode_id")
    if not isinstance(key, str) or not isinstance(value, str) or "episode_id" not in body:
        raise _Bad(400, "bad_request")
    if len(key) > MAX_RULE_TEXT or len(value) > MAX_RULE_TEXT or not _match_words(key):
        raise _Bad(400, "bad_request")
    if scope is None:
        return key, value, None
    return key, value, _episode_row(conn, scope)["stem"]


def _rule_digest(changes: list[Change], key: str, value: str, stem: str | None) -> str:
    """The changes' digest bound to the rule, so a preview of one rule cannot save another."""
    text = f"{changes_digest(changes)}|{key}|{value}|{stem or ''}"
    return sha256(text.encode("utf-8")).hexdigest()


def _corrections_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _changes_for(app: ReviewApp, key: str, value: str, stem: str | None) -> list[Change]:
    before = load_corrections(app.corrections_file)
    after = [*before, CorrectionRule(_match_words(key), value, stem)]
    return rule_changes(app.paths.transcripts_dir, before, after)


def _checked_edit(text: str, key: str, value: str, stem: str | None) -> str:
    """`add_rule`, with its failures as `_Bad`."""
    try:
        return add_rule(text, key, value, stem)
    except ValueError:
        raise _Bad(400, "bad_request") from None
    except RuleExists:
        raise _Bad(409, "exists") from None
    except EditFailed:
        log.exception("corrections.yaml edit failed")
        raise _Bad(500, "edit_failed") from None


def _write_replacing(path: Path, text: str) -> None:
    """Write `text` to a temporary file beside `path`, then replace `path` with it."""
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with open(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        if path.exists():
            shutil.copymode(path, tmp)
        else:
            tmp.chmod(0o644)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def register_corrections(app: ReviewApp) -> None:
    """Add the correction and "reviewed" endpoints to `app.post_routes`."""

    def preview(body: dict, conn: sqlite3.Connection) -> tuple[int, dict]:
        try:
            key, value, stem = _parse_rule(body, conn)
            _checked_edit(_corrections_text(app.corrections_file), key, value, stem)
            changes = _changes_for(app, key, value, stem)
        except _Bad as bad:
            return bad.status, {"error": bad.error}
        return 200, {
            "changes": [
                {"stem": c.stem, "start_ms": c.start_ms, "before": c.before, "after": c.after}
                for c in changes
            ],
            "count": len(changes),
            "digest": _rule_digest(changes, key, value, stem),
        }

    def save(body: dict, conn: sqlite3.Connection) -> tuple[int, dict]:
        try:
            key, value, stem = _parse_rule(body, conn)
            digest = body.get("digest")
            if not isinstance(digest, str):
                raise _Bad(400, "bad_request")
            open_row = _episode_row(conn, body.get("open_episode_id"))
            if not open_row["transcript_path"]:
                raise _Bad(409, "not_transcribed")
            with app.corrections_lock:
                changes = _changes_for(app, key, value, stem)
                if not hmac.compare_digest(
                    digest.encode(), _rule_digest(changes, key, value, stem).encode()
                ):
                    raise _Bad(409, "changed")
                new_text = _checked_edit(_corrections_text(app.corrections_file), key, value, stem)
                _write_replacing(app.corrections_file, new_text)
                rules = load_corrections(app.corrections_file)
                chunk_episode(conn, open_row, rules)
                conn.commit()
                return 200, episode_payload(conn, open_row, rules)
        except _Bad as bad:
            return bad.status, {"error": bad.error}

    def reviewed(body: dict, conn: sqlite3.Connection) -> tuple[int, dict]:
        flag = body.get("reviewed")
        if not isinstance(flag, bool):
            return 400, {"error": "bad_request"}
        try:
            row = _episode_row(conn, body.get("episode_id"))
        except _Bad as bad:
            return bad.status, {"error": bad.error}
        at = datetime.now(UTC).isoformat(timespec="seconds") if flag else None
        with conn:
            conn.execute("update episodes set reviewed_at = ? where id = ?", (at, row["id"]))
        return 200, {"reviewed_at": at}

    app.post_routes["/api/corrections/preview"] = preview
    app.post_routes["/api/corrections"] = save
    app.post_routes["/api/reviewed"] = reviewed
