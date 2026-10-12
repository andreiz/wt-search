import json
import re
import threading

import httpx
import pytest
from conftest import seg, tx

from wts.db import connect
from wts.review.server import ReviewApp, serve

TOKEN = "test-token"
CSP = "default-src 'self'; media-src 'self'; frame-ancestors 'none'"


@pytest.fixture
def app(tmp_path, paths):
    return ReviewApp(lambda: connect(tmp_path / "state.db"), paths, token=TOKEN)


@pytest.fixture
def server(app):
    srv = serve(app, 0)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    srv.server_close()
    thread.join(timeout=5)


@pytest.fixture
def base(server):
    return f"http://127.0.0.1:{server.server_address[1]}"


@pytest.fixture
def client(base):
    with httpx.Client(base_url=base) as c:
        yield c


AUTH = {"X-Review-Token": TOKEN}


def _transcribed(conn, paths, make_episode, **kw):
    e = make_episode(**kw)
    stem = conn.execute("select stem from episodes where id = ?", (e,)).fetchone()[0]
    paths.transcripts_dir.mkdir(parents=True, exist_ok=True)
    out = paths.transcripts_dir / f"{stem}.json"
    out.write_text(json.dumps(tx(seg("Cut the tenon."))))
    conn.execute("update episodes set transcript_path = ? where id = ?", (str(out), e))
    conn.commit()
    return e


def test_server_binds_loopback_only(server):
    assert server.server_address[0] == "127.0.0.1"
    assert server.daemon_threads is True


def test_url(app):
    assert app.url(8000, 5) == f"http://127.0.0.1:8000/?t={TOKEN}&episode=5"
    assert app.url(8000, 5, at_ms=1500, report_id=3) == (
        f"http://127.0.0.1:8000/?t={TOKEN}&episode=5&at=1500&report=3"
    )


def test_random_token_when_none_given(tmp_path, paths):
    a = ReviewApp(lambda: connect(tmp_path / "state.db"), paths)
    b = ReviewApp(lambda: connect(tmp_path / "state.db"), paths)
    assert a.token and a.token != b.token


def test_index_needs_no_token_and_has_security_headers(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert '<script type="module" src="/static/review.js">' in r.text
    assert r.headers["content-security-policy"] == CSP
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "no-store"


def test_static_files(client):
    js = client.get("/static/review.js")
    assert js.status_code == 200
    assert "javascript" in js.headers["content-type"]
    css = client.get("/static/review.css")
    assert css.status_code == 200
    assert css.headers["content-type"].startswith("text/css")


@pytest.mark.parametrize(
    "path",
    [
        "/static/../config.toml",
        "/static/%2e%2e/config.toml",
        "/static/%2E%2E%2Fconfig.toml",
        "/static/..%5Cconfig.toml",
        "/static/index.html",
        "/static/server.py",
        "/static/",
        "/static",
        "/nope",
    ],
)
def test_unlisted_static_and_traversal_are_404(base, path):
    # httpx would normalise "/static/../x"; send the path as it is.
    r = httpx.get(base + path, headers=AUTH)
    assert r.status_code == 404
    assert r.json() == {"error": "not_found"}


def test_traversal_in_raw_request_is_404(server):
    import socket

    port = server.server_address[1]
    with socket.create_connection(("127.0.0.1", port)) as s:
        s.sendall(
            f"GET /static/../config.toml HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
            "Connection: close\r\n\r\n".encode()
        )
        data = b""
        while chunk := s.recv(4096):
            data += chunk
    assert data.startswith(b"HTTP/1.1 404")


def test_api_needs_the_token(client, conn, paths, make_episode):
    e = _transcribed(conn, paths, make_episode)
    assert client.get(f"/api/episode?id={e}").status_code == 401
    assert client.get(f"/api/episode?id={e}", headers={"X-Review-Token": "wrong"}).status_code == 401
    assert client.get(f"/api/episode?id={e}&t=wrong").status_code == 401
    assert client.get(f"/api/episode?id={e}", headers={"X-Review-Token": ""}).status_code == 401
    assert client.get(f"/api/episode?id={e}").json() == {"error": "unauthorized"}


def test_token_by_header_or_query(client, conn, paths, make_episode):
    e = _transcribed(conn, paths, make_episode)
    by_header = client.get(f"/api/episode?id={e}", headers=AUTH)
    assert by_header.status_code == 200
    by_query = client.get(f"/api/episode?id={e}&t={TOKEN}")
    assert by_query.status_code == 200
    assert by_header.headers["content-type"] == "application/json; charset=utf-8"


def test_token_compared_in_constant_time(monkeypatch, client, conn, paths, make_episode):
    import hmac

    from wts.review import server as mod

    e = _transcribed(conn, paths, make_episode)
    calls = []
    real = hmac.compare_digest

    def spy(a, b):
        calls.append(1)
        return real(a, b)

    monkeypatch.setattr(mod.hmac, "compare_digest", spy)
    client.get(f"/api/episode?id={e}", headers=AUTH)
    assert calls


def test_episode_payload_over_http(client, conn, paths, make_episode, audio_file):
    e = _transcribed(conn, paths, make_episode, audio_path=str(audio_file))
    body = client.get(f"/api/episode?id={e}", headers=AUTH).json()
    assert [w[0] for w in body["words"]] == ["Cut", "the", "tenon."]
    assert body["episode"]["id"] == e
    assert body["episode"]["has_audio"] is True


def test_episode_unknown_bad_and_not_transcribed(client, conn, make_episode):
    assert client.get("/api/episode?id=9999", headers=AUTH).status_code == 404
    assert client.get("/api/episode?id=abc", headers=AUTH).status_code == 404
    assert client.get("/api/episode", headers=AUTH).status_code == 404
    e = make_episode()
    r = client.get(f"/api/episode?id={e}", headers=AUTH)
    assert r.status_code == 409
    assert r.json() == {"error": "not_transcribed"}


def test_wrong_host_is_403_even_with_token(base, server, conn, paths, make_episode):
    e = _transcribed(conn, paths, make_episode)
    r = httpx.get(f"{base}/api/episode?id={e}", headers={**AUTH, "Host": "evil.example"})
    assert r.status_code == 403
    r = httpx.get(base + "/", headers={"Host": "evil.example"})
    assert r.status_code == 403
    port = server.server_address[1]
    r = httpx.get(base + "/", headers={"Host": f"127.0.0.1:{port + 1}"})
    assert r.status_code == 403
    r = httpx.get(base + "/", headers={"Host": "127.0.0.1"})
    assert r.status_code == 403


def test_localhost_host_is_accepted(base, server):
    port = server.server_address[1]
    assert httpx.get(base + "/", headers={"Host": f"localhost:{port}"}).status_code == 200


def test_no_cors_header_and_csp_on_every_answer(client, base, conn, paths, make_episode):
    e = _transcribed(conn, paths, make_episode)
    answers = [
        client.get("/"),
        client.get("/static/review.js"),
        client.get("/nope"),
        client.get(f"/api/episode?id={e}"),
        client.get(f"/api/episode?id={e}", headers=AUTH),
        client.get("/audio/1"),
        client.get("/audio/1", headers=AUTH),
        client.post("/api/reviewed", json={}),
        httpx.get(base + "/", headers={"Host": "evil.example"}),
    ]
    for r in answers:
        assert "access-control-allow-origin" not in r.headers
        assert r.headers["content-security-policy"] == CSP
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["referrer-policy"] == "no-referrer"
        assert r.headers["cache-control"] == "no-store"


def test_check_order_host_then_route_then_token(base):
    wrong_host = {"Host": "evil.example"}
    # Host first: unknown route and missing token both give 403 under a wrong Host.
    assert httpx.get(base + "/nope", headers=wrong_host).status_code == 403
    # Then route: unknown is 404 even without a token.
    assert httpx.get(base + "/nope").status_code == 404
    assert httpx.get(base + "/api/nope").status_code == 404
    # Then token.
    assert httpx.get(base + "/api/episode?id=1").status_code == 401


# --- audio ---


@pytest.fixture
def audio_id(conn, make_episode, audio_file):
    return make_episode(audio_path=str(audio_file))  # the file holds b"fake audio"


def _audio(client, audio_id, range_=None, **kw):
    headers = dict(AUTH)
    if range_ is not None:
        headers["Range"] = range_
    return client.get(f"/audio/{audio_id}", headers=headers, **kw)


def test_audio_whole_file(client, audio_id):
    r = _audio(client, audio_id)
    assert r.status_code == 200
    assert r.content == b"fake audio"
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-length"] == "10"
    assert r.headers["content-type"] == "audio/mpeg"


def test_audio_token_in_query(client, audio_id):
    assert client.get(f"/audio/{audio_id}?t={TOKEN}").status_code == 200
    assert client.get(f"/audio/{audio_id}").status_code == 401
    assert client.get(f"/audio/{audio_id}?t=nope").status_code == 401


@pytest.mark.parametrize(
    ("range_", "body", "content_range"),
    [
        ("bytes=0-3", b"fake", "bytes 0-3/10"),
        ("bytes=4-", b" audio", "bytes 4-9/10"),
        ("bytes=-3", b"dio", "bytes 7-9/10"),
        ("bytes=8-99", b"io", "bytes 8-9/10"),
        ("bytes=-99", b"fake audio", "bytes 0-9/10"),
        ("bytes=0-0", b"f", "bytes 0-0/10"),
    ],
)
def test_audio_ranges(client, audio_id, range_, body, content_range):
    r = _audio(client, audio_id, range_)
    assert r.status_code == 206
    assert r.content == body
    assert r.headers["content-range"] == content_range
    assert r.headers["content-length"] == str(len(body))
    assert r.headers["accept-ranges"] == "bytes"


@pytest.mark.parametrize("range_", ["bytes=10-", "bytes=10-20", "bytes=99-", "bytes=-0"])
def test_audio_range_past_the_end_is_416(client, audio_id, range_):
    r = _audio(client, audio_id, range_)
    assert r.status_code == 416
    assert r.headers["content-range"] == "bytes */10"


@pytest.mark.parametrize(
    "range_", ["bytes=0-1,4-5", "bytes=abc", "bytes=5-2", "items=0-3", "bytes=", "garbage", "bytes=-"]
)
def test_audio_malformed_or_multiple_range_gives_whole_file(client, audio_id, range_):
    r = _audio(client, audio_id, range_)
    assert r.status_code == 200
    assert r.content == b"fake audio"


def test_audio_streams_large_files_in_pieces(client, conn, make_episode, tmp_path):
    big = tmp_path / "big.m4a"
    data = bytes(range(256)) * 1024  # 256 KB
    big.write_bytes(data)
    e = make_episode(audio_path=str(big))
    full = _audio(client, e)
    assert full.content == data
    assert full.headers["content-type"] == "audio/mp4"
    part = _audio(client, e, "bytes=70000-200000")
    assert part.status_code == 206
    assert part.content == data[70000:200001]


def test_audio_missing_is_404(client, conn, make_episode, tmp_path):
    gone = make_episode(audio_path=str(tmp_path / "unmounted" / "ep.mp3"))
    none = make_episode()
    for e in (gone, none, 99999):
        assert _audio(client, e).status_code == 404
    assert client.get("/audio/abc", headers=AUTH).status_code == 404


# --- write checks, through a route registered here ---


@pytest.fixture
def echo(app):
    seen = []

    def handler(body, conn):
        seen.append(body)
        return 200, {"got": body, "has_conn": conn is not None}

    app.post_routes["/api/echo"] = handler
    return seen


def _post(base, **kw):
    headers = {"X-Review-Token": TOKEN, "Content-Type": "application/json", **kw.pop("headers", {})}
    return httpx.post(base + "/api/echo", headers=headers, **kw)


def test_post_ok(base, echo):
    r = _post(base, content=json.dumps({"a": 1}))
    assert r.status_code == 200
    assert r.json() == {"got": {"a": 1}, "has_conn": True}
    assert echo == [{"a": 1}]
    assert r.headers["content-type"] == "application/json; charset=utf-8"


def test_post_content_type_with_charset_is_fine(base, echo):
    r = _post(base, content="{}", headers={"Content-Type": "application/json; charset=utf-8"})
    assert r.status_code == 200


def test_post_needs_token(base, echo):
    r = httpx.post(base + "/api/echo", json={})
    assert r.status_code == 401
    assert echo == []


def test_post_with_token_in_query(base, echo):
    r = httpx.post(base + f"/api/echo?t={TOKEN}", json={})
    assert r.status_code == 200


def test_get_on_a_post_route_is_405(client, echo):
    assert client.get("/api/echo", headers=AUTH).status_code == 405


def test_post_on_a_get_route_is_405(base, echo):
    r = httpx.post(base + "/api/episode", headers=AUTH, json={})
    assert r.status_code == 405
    r = httpx.post(base + "/", headers=AUTH, json={})
    assert r.status_code == 405
    assert httpx.put(base + "/api/echo", headers=AUTH, json={}).status_code == 405
    assert httpx.delete(base + "/api/echo", headers=AUTH).status_code == 405


def test_post_to_unknown_route_is_404(base, echo):
    assert httpx.post(base + "/api/other", headers=AUTH, json={}).status_code == 404


@pytest.mark.parametrize("ctype", ["text/plain", "application/x-www-form-urlencoded", ""])
def test_post_wrong_content_type_is_415(base, echo, ctype):
    headers = {"Content-Type": ctype} if ctype else {}
    r = httpx.post(
        base + "/api/echo", headers={**AUTH, **headers}, content=b"{}"
    )
    # httpx adds no Content-Type for raw content, so "" tests the missing header.
    assert r.status_code == 415
    assert echo == []


def test_post_origin_must_be_our_own(base, server, echo):
    port = server.server_address[1]
    for origin in ("http://evil.example", f"http://127.0.0.1:{port + 1}", "null", "https://x.test"):
        r = _post(base, content="{}", headers={"Origin": origin})
        assert r.status_code == 403, origin
    assert echo == []
    for origin in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
        assert _post(base, content="{}", headers={"Origin": origin}).status_code == 200


def test_post_without_origin_is_allowed(base, echo):
    assert _post(base, content="{}").status_code == 200


def test_post_wrong_host_is_403_before_anything(base, echo):
    r = _post(base, content="{}", headers={"Host": "evil.example"})
    assert r.status_code == 403
    assert echo == []


def test_post_body_cap(base, echo):
    ok = json.dumps({"x": "a" * (64 * 1024 - 20)})
    assert len(ok) <= 64 * 1024
    assert _post(base, content=ok).status_code == 200
    too_big = json.dumps({"x": "a" * (64 * 1024)})
    r = _post(base, content=too_big)
    assert r.status_code == 413
    assert r.json() == {"error": "too_large"}


@pytest.mark.parametrize("raw", ["", "not json", "[1, 2]", '"s"', "3", "null", b"\xff\xfe"])
def test_post_body_must_be_a_json_object(base, echo, raw):
    r = _post(base, content=raw)
    assert r.status_code == 400
    assert r.json() == {"error": "bad_json"}
    assert echo == []


def test_server_survives_a_client_that_goes_away(server, base, audio_id, capfd):
    import socket

    port = server.server_address[1]
    for _ in range(3):
        s = socket.create_connection(("127.0.0.1", port))
        s.sendall(
            f"GET /audio/{audio_id}?t={TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode()
        )
        s.close()
    assert httpx.get(base + "/").status_code == 200
    assert "Traceback" not in capfd.readouterr().err


# --- previewing and saving a correction ---

GLOBAL_FILE = "# fixes\nglobal:\n  # a comment\n  tennon: tenon\n\nepisodes:\n  other_stem:\n    a: b\n"


@pytest.fixture
def corr_file(app, tmp_path):
    f = tmp_path / "corrections.yaml"
    f.write_text(GLOBAL_FILE)
    app.corrections_file = f
    return f


def _glue(conn, paths, make_episode, text="Cut the glue joint."):
    e = make_episode()
    stem = conn.execute("select stem from episodes where id = ?", (e,)).fetchone()[0]
    paths.transcripts_dir.mkdir(parents=True, exist_ok=True)
    out = paths.transcripts_dir / f"{stem}.json"
    out.write_text(json.dumps(tx(seg(text))))
    conn.execute("update episodes set transcript_path = ? where id = ?", (str(out), e))
    conn.commit()
    return e, stem


def _api(base, path, body, **headers):
    return httpx.post(
        base + path,
        json=body,
        headers={"X-Review-Token": TOKEN, **headers},
    )


def _rule(episode_id=None, key="glue", value="Glew"):
    return {"key": key, "value": value, "episode_id": episode_id}


def test_preview_lists_changes_and_a_digest(base, corr_file, conn, paths, make_episode):
    _, stem = _glue(conn, paths, make_episode)
    r = _api(base, "/api/corrections/preview", _rule())
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 1
    (change,) = body["changes"]
    assert change["stem"] == stem
    assert "glue" in change["before"] and "Glew" in change["after"]
    assert set(change) == {"stem", "start_ms", "before", "after"}
    assert len(body["digest"]) == 64
    assert corr_file.read_text() == GLOBAL_FILE  # a preview writes nothing


def test_preview_for_an_episode_rule_and_no_match(base, corr_file, conn, paths, make_episode):
    e, _ = _glue(conn, paths, make_episode)
    _glue(conn, paths, make_episode)
    r = _api(base, "/api/corrections/preview", _rule(e))
    assert r.json()["count"] == 1
    r = _api(base, "/api/corrections/preview", _rule(key="nothing here"))
    assert r.json() == {"changes": [], "count": 0, "digest": r.json()["digest"]}


def test_digest_binds_the_rule(base, corr_file, conn, paths, make_episode):
    e, _ = _glue(conn, paths, make_episode)
    a = _api(base, "/api/corrections/preview", _rule(value="Glew")).json()["digest"]
    b = _api(base, "/api/corrections/preview", _rule(value="Glue")).json()["digest"]
    c = _api(base, "/api/corrections/preview", _rule(e)).json()["digest"]
    assert len({a, b, c}) == 3


@pytest.mark.parametrize(
    "body",
    [
        {"key": 1, "value": "x", "episode_id": None},
        {"key": "a", "value": 1, "episode_id": None},
        {"key": "a", "episode_id": None},
        {"key": "a", "value": "x"},
        {"key": "", "value": "x", "episode_id": None},
        {"key": "?!", "value": "x", "episode_id": None},
        {"key": "a" * 201, "value": "x", "episode_id": None},
        {"key": "a", "value": "x" * 201, "episode_id": None},
        {"key": "a", "value": "x", "episode_id": "1"},
        {"key": "a", "value": "x", "episode_id": True},
        {"key": "a", "value": "x", "episode_id": 1.5},
    ],
)
def test_preview_bad_requests(base, corr_file, body):
    r = _api(base, "/api/corrections/preview", body)
    assert r.status_code == 400
    assert r.json() == {"error": "bad_request"}


def test_preview_unknown_episode_is_404(base, corr_file):
    assert _api(base, "/api/corrections/preview", _rule(99999)).status_code == 404


def test_preview_existing_rule_is_409(base, corr_file):
    r = _api(base, "/api/corrections/preview", _rule(key="Tennon,", value="tenon"))
    assert r.status_code == 409
    assert r.json() == {"error": "exists"}


def test_preview_checks(base, corr_file):
    path = "/api/corrections/preview"
    assert httpx.post(base + path, json=_rule()).status_code == 401
    r = httpx.post(base + path, json=_rule(), headers={**AUTH, "Origin": "http://evil.example"})
    assert r.status_code == 403
    assert httpx.get(base + path, headers=AUTH).status_code == 405


def _preview_then_save(base, e, rule=None, open_id=None):
    rule = rule or _rule()
    digest = _api(base, "/api/corrections/preview", rule).json()["digest"]
    return _api(
        base,
        "/api/corrections",
        {**rule, "digest": digest, "open_episode_id": e if open_id is None else open_id},
    )


def test_save_writes_the_file_and_rechunks(base, corr_file, conn, paths, make_episode):
    e, _ = _glue(conn, paths, make_episode)
    r = _preview_then_save(base, e)
    assert r.status_code == 200
    payload = r.json()
    assert [w[0] for w in payload["words"]][:3] == ["Cut", "the", "Glew"]
    assert corr_file.read_text() == GLOBAL_FILE.replace(
        "  tennon: tenon\n", "  tennon: tenon\n  glue: Glew\n"
    )
    assert payload["chunks"]  # re-chunked
    text = conn.execute("select text from chunks where episode_id = ?", (e,)).fetchone()[0]
    assert "Glew" in text
    assert not [p for p in corr_file.parent.iterdir() if p.name != corr_file.name
                and p.name.startswith(corr_file.name)]


def test_save_an_episode_rule(base, corr_file, conn, paths, make_episode):
    e, stem = _glue(conn, paths, make_episode)
    r = _preview_then_save(base, e, _rule(e))
    assert r.status_code == 200
    assert f"  {stem}:\n    glue: Glew\n" in corr_file.read_text()


def test_save_keeps_the_files_mode(base, corr_file, conn, paths, make_episode):
    import os

    e, _ = _glue(conn, paths, make_episode)
    os.chmod(corr_file, 0o640)
    assert _preview_then_save(base, e).status_code == 200
    assert corr_file.stat().st_mode & 0o777 == 0o640


def test_save_creates_a_missing_file(base, app, tmp_path, conn, paths, make_episode):
    app.corrections_file = tmp_path / "new.yaml"
    e, _ = _glue(conn, paths, make_episode)
    assert _preview_then_save(base, e).status_code == 200
    assert app.corrections_file.read_text() == "global:\n  glue: Glew\n"


def test_save_with_a_stale_digest_is_409_and_leaves_the_file(
    base, corr_file, conn, paths, make_episode
):
    e, _ = _glue(conn, paths, make_episode)
    digest = _api(base, "/api/corrections/preview", _rule()).json()["digest"]
    _glue(conn, paths, make_episode)  # a transcript appears between preview and save
    r = _api(base, "/api/corrections", {**_rule(), "digest": digest, "open_episode_id": e})
    assert r.status_code == 409
    assert r.json() == {"error": "changed"}
    assert corr_file.read_text() == GLOBAL_FILE


def test_a_preview_of_one_rule_cannot_save_another(base, corr_file, conn, paths, make_episode):
    e, _ = _glue(conn, paths, make_episode)
    digest = _api(base, "/api/corrections/preview", _rule(value="Glew")).json()["digest"]
    r = _api(
        base,
        "/api/corrections",
        {**_rule(value="Evil"), "digest": digest, "open_episode_id": e},
    )
    assert r.status_code == 409
    assert corr_file.read_text() == GLOBAL_FILE


def test_save_existing_rule_is_409_exists(base, corr_file, conn, paths, make_episode):
    e, _ = _glue(conn, paths, make_episode)
    rule = _rule(key="tennon", value="tenon")
    # A preview of this rule is refused, so compute the digest the way the server does.
    from wts.review import server as mod

    digest = mod._rule_digest([], "tennon", "tenon", None)
    r = _api(base, "/api/corrections", {**rule, "digest": digest, "open_episode_id": e})
    assert r.status_code == 409
    assert r.json() == {"error": "exists"}
    assert corr_file.read_text() == GLOBAL_FILE


def test_save_edit_failure_is_500_and_leaves_the_file(
    monkeypatch, base, corr_file, conn, paths, make_episode
):
    from wts.corrections_edit import EditFailed
    from wts.review import server as mod

    def boom(*a, **k):
        raise EditFailed("no")

    e, _ = _glue(conn, paths, make_episode)
    digest = _api(base, "/api/corrections/preview", _rule()).json()["digest"]
    monkeypatch.setattr(mod, "add_rule", boom)
    r = _api(base, "/api/corrections", {**_rule(), "digest": digest, "open_episode_id": e})
    assert r.status_code == 500
    assert r.json() == {"error": "edit_failed"}
    assert corr_file.read_text() == GLOBAL_FILE


def test_save_validation(base, corr_file, conn, paths, make_episode):
    e, _ = _glue(conn, paths, make_episode)
    ok = {**_rule(), "digest": "d", "open_episode_id": e}
    for bad in (
        {**ok, "digest": 5},
        {**ok, "open_episode_id": None},
        {**ok, "open_episode_id": "1"},
        {**ok, "key": ""},
    ):
        r = _api(base, "/api/corrections", bad)
        assert (r.status_code, r.json()) == (400, {"error": "bad_request"})
    assert _api(base, "/api/corrections", {**ok, "open_episode_id": 99999}).status_code == 404
    assert _api(base, "/api/corrections", {**ok, "episode_id": 99999}).status_code == 404
    assert corr_file.read_text() == GLOBAL_FILE


def test_save_rejects_a_foreign_origin(base, corr_file, conn, paths, make_episode):
    e, _ = _glue(conn, paths, make_episode)
    digest = _api(base, "/api/corrections/preview", _rule()).json()["digest"]
    r = _api(
        base,
        "/api/corrections",
        {**_rule(), "digest": digest, "open_episode_id": e},
        Origin="http://evil.example",
    )
    assert r.status_code == 403
    assert corr_file.read_text() == GLOBAL_FILE


def test_save_open_episode_not_transcribed_is_409(base, corr_file, conn, paths, make_episode):
    _glue(conn, paths, make_episode)
    bare = make_episode()
    r = _preview_then_save(base, bare)
    assert r.status_code == 409
    assert r.json() == {"error": "not_transcribed"}
    assert corr_file.read_text() == GLOBAL_FILE


# --- reviewed ---


def test_reviewed_sets_and_clears(base, conn, make_episode):
    e = make_episode()

    def stored():
        return conn.execute("select reviewed_at from episodes where id = ?", (e,)).fetchone()[0]

    r = _api(base, "/api/reviewed", {"episode_id": e, "reviewed": True})
    assert r.status_code == 200
    at = r.json()["reviewed_at"]
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00", at)
    assert stored() == at
    r = _api(base, "/api/reviewed", {"episode_id": e, "reviewed": False})
    assert r.json() == {"reviewed_at": None}
    assert stored() is None


def test_reviewed_errors(base, make_episode):
    e = make_episode()
    assert _api(base, "/api/reviewed", {"episode_id": 99999, "reviewed": True}).status_code == 404
    for bad in (
        {},
        {"episode_id": e},
        {"episode_id": e, "reviewed": "yes"},
        {"episode_id": "1", "reviewed": True},
        {"episode_id": True, "reviewed": True},
    ):
        r = _api(base, "/api/reviewed", bad)
        assert (r.status_code, r.json()) == (400, {"error": "bad_request"})


# --- /api/report ----------------------------------------------------------------------------------

REPORT_ROW = {
    "id": 7, "created_at": "2026-10-05 09:30:00", "status": "open", "chunk_id": 10,
    "quoted_text": "mark said", "suggested_text": "Marc said", "note": "hm",
    "episode_number": 71, "episode_title": "Hide Glue", "start_ms": 754_000,
}


class FakeD1:
    """One report (id 7); records each query; `down` makes every query fail."""

    def __init__(self, down=False):
        self.down = down
        self.calls = []

    def query(self, sql, params=()):
        from wts.cloudflare import CloudflareError

        self.calls.append((sql, list(params)))
        if self.down:
            raise CloudflareError(0, [{"code": 0, "message": "network error"}])
        if sql.lstrip().startswith("update"):
            return [{"id": 7}] if params[1] == 7 else []
        return [REPORT_ROW] if params == [7] else []


def _get_report(base, query="id=7", token=True):
    return httpx.get(f"{base}/api/report?{query}", headers={"X-Review-Token": TOKEN} if token else {})


def test_get_report_found(app, base):
    app.d1 = FakeD1()
    r = _get_report(base)
    assert r.status_code == 200
    assert r.json() == {k: v for k, v in REPORT_ROW.items()}


def test_get_report_needs_the_token(app, base):
    app.d1 = FakeD1()
    assert _get_report(base, token=False).status_code == 401
    assert app.d1.calls == []


def test_get_report_unknown_and_bad_ids(app, base):
    app.d1 = FakeD1()
    r = _get_report(base, "id=99")
    assert (r.status_code, r.json()) == (404, {"error": "not_found"})
    for query in ("id=abc", "id=", "", "id=-1", "id=1.5"):
        r = _get_report(base, query)
        assert (r.status_code, r.json()) == (400, {"error": "bad_request"})


def test_report_endpoints_without_d1_are_503(app, base):
    assert app.d1 is None
    r = _get_report(base)
    assert (r.status_code, r.json()) == (503, {"error": "no_environment"})
    r = _api(base, "/api/report", {"id": 7, "status": "resolved"})
    assert (r.status_code, r.json()) == (503, {"error": "no_environment"})


def test_post_report_sets_the_status(app, base):
    app.d1 = FakeD1()
    for status in ("resolved", "rejected", "open"):
        r = _api(base, "/api/report", {"id": 7, "status": status})
        assert (r.status_code, r.json()) == (200, {"ok": True, "status": status})
    assert app.d1.calls[0][1] == ["resolved", 7]


def test_post_report_unknown_id_is_404(app, base):
    app.d1 = FakeD1()
    r = _api(base, "/api/report", {"id": 99, "status": "resolved"})
    assert (r.status_code, r.json()) == (404, {"error": "not_found"})


def test_post_report_bad_bodies_are_400(app, base):
    app.d1 = FakeD1()
    for bad in (
        {},
        {"id": 7},
        {"id": 7, "status": "closed"},
        {"id": 7, "status": None},
        {"id": "7", "status": "resolved"},
        {"id": True, "status": "resolved"},
        {"status": "resolved"},
    ):
        r = _api(base, "/api/report", bad)
        assert (r.status_code, r.json()) == (400, {"error": "bad_request"}), bad
    assert app.d1.calls == []


def test_report_endpoints_when_d1_is_down_are_502(app, base, caplog):
    app.d1 = FakeD1(down=True)
    with caplog.at_level("WARNING", logger="wts"):
        r = _get_report(base)
        assert (r.status_code, r.json()) == (502, {"error": "d1_unavailable"})
        r = _api(base, "/api/report", {"id": 7, "status": "resolved"})
        assert (r.status_code, r.json()) == (502, {"error": "d1_unavailable"})
    assert TOKEN not in caplog.text
