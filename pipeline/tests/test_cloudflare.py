import json
import sqlite3
import traceback

import httpx
import pytest
import respx
from test_schema_contract import add_episode, apply_schema, fts

from wts.cloudflare import (
    D1,
    CloudflareApi,
    CloudflareError,
    Vectorize,
    chunked_inserts,
)
from wts.net import USER_AGENT, new_client

ACCOUNT = "acct0123"
TOKEN = "cf-token-SECRET-abcdef0123456789"
DB = "5f3c1a2e-0000-4000-8000-d1d1d1d1d1d1"
INDEX = "wts-chunks-staging"

BASE = "https://api.cloudflare.com/client/v4"
D1_URL = f"{BASE}/accounts/{ACCOUNT}/d1/database/{DB}/query"
VEC_URL = f"{BASE}/accounts/{ACCOUNT}/vectorize/v2/indexes/{INDEX}"

CHUNK_COLUMNS = ["id", "episode_id", "seq", "start_ms", "end_ms", "text", "word_times",
                 "is_boilerplate"]


@pytest.fixture
def sleeps() -> list[float]:
    return []


@pytest.fixture
def api(sleeps):
    with new_client() as client:
        yield CloudflareApi(client, ACCOUNT, TOKEN, sleep=sleeps.append)


@pytest.fixture
def d1(api):
    return D1(api, DB)


@pytest.fixture
def vec(api):
    return Vectorize(api, INDEX)


def d1_ok(*statements: list[dict]) -> dict:
    """A D1 query response with one result entry per statement."""
    return {
        "success": True, "errors": [], "messages": [],
        "result": [{"success": True, "results": rows, "meta": {"changes": 0}}
                   for rows in statements],
    }


def failure(code: int = 7500, message: str = "no such table: nope") -> dict:
    return {"success": False, "errors": [{"code": code, "message": message}], "messages": [],
            "result": None}


def mutation(n: int = 1) -> dict:
    return {"success": True, "errors": [], "messages": [], "result": {"mutationId": f"mut-{n}"}}


def body_of(call) -> dict:
    return json.loads(call.request.content)


def ndjson_of(call) -> list[dict]:
    return [json.loads(line) for line in call.request.content.decode().splitlines()]


def vectors(n: int, start: int = 0) -> list[tuple[str, list[float], dict]]:
    return [(str(i), [i / 1000, 0.5, -0.25], {"episode_id": i % 7, "year": 2017 + i % 9})
            for i in range(start, start + n)]


def chunk_row(i: int, text: str = "gluing dovetails", episode_id: int = 1) -> list:
    return [i, episode_id, i, i * 1000, i * 1000 + 900, text, "0,400", 0]


# --- D1 ---


@respx.mock
def test_query_posts_one_statement_and_returns_its_rows(d1):
    route = respx.post(D1_URL).respond(json=d1_ok([{"id": 10, "text": "gluing"}]))
    rows = d1.query("select id, text from chunks where id = ?", [10])
    assert rows == [{"id": 10, "text": "gluing"}]
    assert body_of(route.calls.last) == {
        "sql": "select id, text from chunks where id = ?", "params": [10]}


@respx.mock
def test_query_without_params_sends_an_empty_list(d1):
    route = respx.post(D1_URL).respond(json=d1_ok([]))
    assert d1.query("select 1") == []
    assert body_of(route.calls.last) == {"sql": "select 1", "params": []}


@respx.mock
def test_batch_body_shape_and_per_statement_results(d1):
    route = respx.post(D1_URL).respond(json=d1_ok([], [{"n": 3}]))
    results = d1.batch([("insert into meta values (?, ?)", ["k", "v"]),
                        ("select count(*) as n from chunks", [])])
    assert results == [[], [{"n": 3}]]
    assert body_of(route.calls.last) == {"batch": [
        {"sql": "insert into meta values (?, ?)", "params": ["k", "v"]},
        {"sql": "select count(*) as n from chunks", "params": []},
    ]}


@respx.mock
def test_empty_batch_makes_no_request(d1):
    route = respx.post(D1_URL).respond(json=d1_ok())
    assert d1.batch([]) == []
    assert route.call_count == 0


@respx.mock
def test_params_are_sent_as_json_values(d1):
    route = respx.post(D1_URL).respond(json=d1_ok([]))
    d1.query("select ?, ?, ?, ?, ?", [7, 2.5, "7", None, 0])
    raw = route.calls.last.request.content.decode()
    assert '"params": [7, 2.5, "7", null, 0]' in raw or '"params":[7,2.5,"7",null,0]' in raw
    params = body_of(route.calls.last)["params"]
    assert [type(p) for p in params] == [int, float, str, type(None), int]


@respx.mock
def test_requests_carry_bearer_token_and_bot_user_agent(d1):
    route = respx.post(D1_URL).respond(json=d1_ok([]))
    d1.query("select 1")
    headers = route.calls.last.request.headers
    assert headers["authorization"] == f"Bearer {TOKEN}"
    assert headers["user-agent"] == USER_AGENT
    assert headers["content-type"].startswith("application/json")


@respx.mock
def test_requests_have_an_explicit_timeout(d1):
    route = respx.post(D1_URL).respond(json=d1_ok([]))
    d1.query("select 1")
    timeout = route.calls.last.request.extensions["timeout"]
    assert timeout["read"] and timeout["connect"]  # set, not None (no waiting forever)


@respx.mock
def test_d1_failure_with_http_400_raises_with_codes(d1):
    respx.post(D1_URL).respond(400, json=failure(7500, "no such table: nope"))
    with pytest.raises(CloudflareError) as exc:
        d1.query("select * from nope")
    assert exc.value.status == 400
    assert "7500" in str(exc.value) and "no such table: nope" in str(exc.value)
    assert exc.value.errors[0]["code"] == 7500


@respx.mock
def test_d1_failure_in_a_200_envelope_raises(d1):
    respx.post(D1_URL).respond(200, json=failure(7001, "bad request"))
    with pytest.raises(CloudflareError) as exc:
        d1.query("select 1")
    assert exc.value.status == 200
    assert "7001" in str(exc.value)


@respx.mock
def test_statement_level_failure_raises(d1):
    ok = {"success": True, "results": [], "meta": {}}
    bad = {"success": False, "error": "UNIQUE constraint failed: episodes.guid"}
    respx.post(D1_URL).respond(
        200, json={"success": True, "errors": [], "messages": [], "result": [ok, bad]})
    with pytest.raises(CloudflareError) as exc:
        d1.batch([("select 1", []), ("insert into episodes values (1)", [])])
    assert "UNIQUE constraint failed" in str(exc.value)
    assert "statement 2" in str(exc.value)  # 1-based, so a person can count the statements


@respx.mock
def test_a_result_count_that_differs_from_the_statements_raises(d1):
    respx.post(D1_URL).respond(json=d1_ok([]))
    with pytest.raises(CloudflareError, match="1 results for 2 statements"):
        d1.batch([("select 1", []), ("select 2", [])])


@respx.mock
def test_non_json_error_body_raises_cloudflare_error(d1):
    respx.post(D1_URL).respond(403, text="<html>Forbidden</html>")
    with pytest.raises(CloudflareError) as exc:
        d1.query("select 1")
    assert exc.value.status == 403
    assert "Forbidden" not in str(exc.value)  # raw bodies stay out of messages


# --- retries ---


@respx.mock
def test_429_then_200_succeeds_after_sleeping_for_retry_after(d1, sleeps):
    route = respx.post(D1_URL).mock(side_effect=[
        httpx.Response(429, headers={"Retry-After": "3"}, json=failure(971, "rate limited")),
        httpx.Response(200, json=d1_ok([{"a": 1}])),
    ])
    assert d1.query("select 1") == [{"a": 1}]
    assert route.call_count == 2
    assert sleeps == [3]


@respx.mock
def test_backoff_doubles_without_retry_after_and_ignores_a_date(d1, sleeps):
    route = respx.post(D1_URL).mock(side_effect=[
        httpx.Response(503),
        httpx.Response(502, headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}),
        httpx.Response(500),
        httpx.Response(429),
        httpx.Response(200, json=d1_ok([])),
    ])
    assert d1.query("select 1") == []
    assert route.call_count == 5
    assert sleeps == [1, 2, 4, 8]


@respx.mock
def test_503_five_times_raises_after_four_retries(d1, sleeps):
    route = respx.post(D1_URL).respond(503, json=failure(1015, "unavailable"))
    with pytest.raises(CloudflareError) as exc:
        d1.query("select 1")
    assert route.call_count == 5
    assert sleeps == [1, 2, 4, 8]
    assert exc.value.status == 503
    assert "1015" in str(exc.value)


@respx.mock
def test_429_forever_raises_too(d1, sleeps):
    route = respx.post(D1_URL).respond(429, headers={"Retry-After": "2"})
    with pytest.raises(CloudflareError) as exc:
        d1.query("select 1")
    assert route.call_count == 5 and sleeps == [2, 2, 2, 2]
    assert exc.value.status == 429


@respx.mock
def test_an_absurd_retry_after_is_capped(d1, sleeps):
    respx.post(D1_URL).mock(side_effect=[
        httpx.Response(429, headers={"Retry-After": "86400"}),
        httpx.Response(200, json=d1_ok([])),
    ])
    d1.query("select 1")
    assert sleeps == [60]


@respx.mock
def test_400_fails_at_once_without_retry(d1, sleeps):
    route = respx.post(D1_URL).respond(400, json=failure())
    with pytest.raises(CloudflareError):
        d1.query("select 1")
    assert route.call_count == 1 and sleeps == []


@respx.mock
@pytest.mark.parametrize("status", [401, 403, 404])
def test_other_4xx_fail_at_once(d1, sleeps, status):
    route = respx.post(D1_URL).respond(status, json=failure(10000, "Authentication error"))
    with pytest.raises(CloudflareError) as exc:
        d1.query("select 1")
    assert exc.value.status == status
    assert route.call_count == 1 and sleeps == []


@respx.mock
def test_network_errors_are_retried(d1, sleeps):
    route = respx.post(D1_URL).mock(side_effect=[
        httpx.ConnectError("connection refused"),
        httpx.ReadTimeout("slow"),
        httpx.Response(200, json=d1_ok([{"a": 1}])),
    ])
    assert d1.query("select 1") == [{"a": 1}]
    assert route.call_count == 3 and sleeps == [1, 2]


@respx.mock
def test_network_errors_forever_raise_cloudflare_error(d1, sleeps):
    route = respx.post(D1_URL).mock(side_effect=httpx.ConnectError("connection refused"))
    with pytest.raises(CloudflareError) as exc:
        d1.query("select 1")
    assert route.call_count == 5 and sleeps == [1, 2, 4, 8]
    assert exc.value.status == 0
    assert "ConnectError" in str(exc.value)


# --- Vectorize ---


@respx.mock
def test_upsert_posts_ndjson_that_parses_back(vec):
    route = respx.post(f"{VEC_URL}/upsert").respond(json=mutation(1))
    given = vectors(3)
    assert vec.upsert(given) == ["mut-1"]
    request = route.calls.last.request
    assert request.headers["content-type"] == "application/x-ndjson"
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    lines = ndjson_of(route.calls.last)
    assert lines == [{"id": i, "values": v, "metadata": m} for i, v, m in given]
    assert all(isinstance(line["id"], str) for line in lines)
    assert request.content.endswith(b"\n")
    assert b"\n\n" not in request.content  # one object per line, no blank lines


@respx.mock
def test_upsert_keeps_metadata_types(vec):
    route = respx.post(f"{VEC_URL}/upsert").respond(json=mutation())
    vec.upsert([("42", [0.1, 0.2], {"episode_id": 7, "year": 2019})])
    metadata = ndjson_of(route.calls.last)[0]["metadata"]
    assert metadata == {"episode_id": 7, "year": 2019}
    assert all(type(v) is int for v in metadata.values())  # year is a number index


@respx.mock
def test_upsert_of_2500_vectors_makes_three_requests(vec):
    route = respx.post(f"{VEC_URL}/upsert").mock(
        side_effect=[httpx.Response(200, json=mutation(n)) for n in (1, 2, 3)])
    given = vectors(2500)
    assert vec.upsert(given) == ["mut-1", "mut-2", "mut-3"]
    sizes = [len(ndjson_of(call)) for call in route.calls]
    assert sizes == [1000, 1000, 500]
    sent = [line["id"] for call in route.calls for line in ndjson_of(call)]
    assert sent == [i for i, _, _ in given]  # in order, nothing lost or repeated


@respx.mock
def test_upsert_of_exactly_1000_is_one_request(vec):
    route = respx.post(f"{VEC_URL}/upsert").respond(json=mutation())
    vec.upsert(vectors(1000))
    assert route.call_count == 1


@respx.mock
def test_upsert_of_nothing_makes_no_request(vec):
    route = respx.post(f"{VEC_URL}/upsert").respond(json=mutation())
    assert vec.upsert([]) == []
    assert route.call_count == 0


@respx.mock
def test_delete_by_ids_posts_json_ids(vec):
    route = respx.post(f"{VEC_URL}/delete_by_ids").respond(json=mutation(9))
    assert vec.delete_by_ids(["1", "2"]) == ["mut-9"]
    assert body_of(route.calls.last) == {"ids": ["1", "2"]}
    assert route.calls.last.request.headers["authorization"] == f"Bearer {TOKEN}"


@respx.mock
def test_delete_of_2500_ids_makes_three_requests(vec):
    route = respx.post(f"{VEC_URL}/delete_by_ids").mock(
        side_effect=[httpx.Response(200, json=mutation(n)) for n in (1, 2, 3)])
    ids = [str(i) for i in range(2500)]
    assert vec.delete_by_ids(ids) == ["mut-1", "mut-2", "mut-3"]
    assert [len(body_of(call)["ids"]) for call in route.calls] == [1000, 1000, 500]


@respx.mock
def test_delete_of_nothing_makes_no_request(vec):
    route = respx.post(f"{VEC_URL}/delete_by_ids").respond(json=mutation())
    assert vec.delete_by_ids([]) == []
    assert route.call_count == 0


@respx.mock
def test_vectorize_failure_raises_with_codes(vec):
    respx.post(f"{VEC_URL}/upsert").respond(
        400, json=failure(40006, "metadata index not found"))
    with pytest.raises(CloudflareError) as exc:
        vec.upsert(vectors(1))
    assert "40006" in str(exc.value) and "metadata index not found" in str(exc.value)


@respx.mock
def test_vectorize_failure_in_a_200_envelope_raises(vec):
    respx.post(f"{VEC_URL}/delete_by_ids").respond(200, json=failure(40000, "nope"))
    with pytest.raises(CloudflareError, match="40000"):
        vec.delete_by_ids(["1"])


@respx.mock
def test_a_failed_second_request_raises_after_the_first_went_through(vec):
    route = respx.post(f"{VEC_URL}/upsert").mock(side_effect=[
        httpx.Response(200, json=mutation(1)),
        httpx.Response(400, json=failure(40006, "bad")),
    ])
    with pytest.raises(CloudflareError):
        vec.upsert(vectors(1500))
    assert route.call_count == 2  # upserts are idempotent, so the caller just repeats them


@respx.mock
def test_a_response_without_a_mutation_id_raises(vec):
    respx.post(f"{VEC_URL}/upsert").respond(json={"success": True, "result": {}})
    with pytest.raises(CloudflareError, match="mutationId"):
        vec.upsert(vectors(1))


# --- secrets stay out of errors ---


STATEMENT_FAILURE = {"success": True, "errors": [], "messages": [], "result": [
    {"success": False, "error": "boom"}]}
UPSERT_URL = f"{VEC_URL}/upsert"
DELETE_URL = f"{VEC_URL}/delete_by_ids"

# Every way a call can fail: (route, response or side effect, call under test).
ERROR_PATHS = {
    "400": (D1_URL, httpx.Response(400, json=failure()), lambda d1, vec: d1.query("select 1")),
    "401": (D1_URL, httpx.Response(401, json=failure(10000, "Auth error")),
            lambda d1, vec: d1.query("select 1")),
    "200-failure": (D1_URL, httpx.Response(200, json=failure()),
                    lambda d1, vec: d1.query("select 1")),
    "statement": (D1_URL, httpx.Response(200, json=STATEMENT_FAILURE),
                  lambda d1, vec: d1.batch([("select 1", [])])),
    "count-mismatch": (D1_URL, httpx.Response(200, json=d1_ok([])),
                       lambda d1, vec: d1.batch([("select 1", []), ("select 2", [])])),
    "503-forever": (D1_URL, httpx.Response(503), lambda d1, vec: d1.query("select 1")),
    "429-forever": (D1_URL, httpx.Response(429), lambda d1, vec: d1.query("select 1")),
    "network": (D1_URL, httpx.ConnectError("refused"), lambda d1, vec: d1.query("select 1")),
    "non-json": (D1_URL, httpx.Response(502, text="<html>bad gateway</html>"),
                 lambda d1, vec: d1.query("select 1")),
    "echoed-token": (D1_URL, httpx.Response(400, json=failure(10000, f"Bearer {TOKEN} is bad")),
                     lambda d1, vec: d1.query("select 1")),
    "upsert": (UPSERT_URL, httpx.Response(400, json=failure()),
               lambda d1, vec: vec.upsert(vectors(1))),
    "delete": (DELETE_URL, httpx.Response(200, json=failure(40000, "nope")),
               lambda d1, vec: vec.delete_by_ids(["1"])),
    "no-mutation-id": (UPSERT_URL, httpx.Response(200, json={"success": True, "result": {}}),
                       lambda d1, vec: vec.upsert(vectors(1))),
}


@respx.mock
@pytest.mark.parametrize("name", ERROR_PATHS)
def test_the_token_appears_in_no_exception_text(d1, vec, name):
    url, outcome, call = ERROR_PATHS[name]
    if isinstance(outcome, Exception):
        respx.post(url).mock(side_effect=outcome)
    else:
        respx.post(url).mock(return_value=outcome)
    with pytest.raises(CloudflareError) as exc:
        call(d1, vec)
    # The message, the repr and the whole traceback chain.
    everything = "".join(traceback.format_exception(exc.value)) + repr(exc.value)
    assert TOKEN not in everything
    assert "SECRET" not in everything


# --- chunked_inserts ---


def test_chunked_inserts_makes_12_rows_per_statement_for_8_columns():
    rows = [chunk_row(i) for i in range(50)]
    statements = chunked_inserts("chunks", CHUNK_COLUMNS, rows)
    assert [len(params) // 8 for _, params in statements] == [12, 12, 12, 12, 2]
    for sql, params in statements:
        assert len(params) <= 100
        assert sql.count("?") == len(params)


def test_chunked_inserts_flattens_rows_in_order():
    rows = [chunk_row(i) for i in range(30)]
    statements = chunked_inserts("chunks", CHUNK_COLUMNS, rows)
    flat = [value for _, params in statements for value in params]
    assert flat == [value for row in rows for value in row]


def test_chunked_inserts_sql_shape_without_upsert():
    (sql, params), = chunked_inserts("episodes", ["id", "title"], [[1, "a"], [2, "b"]])
    assert sql == "insert into episodes (id, title) values (?, ?), (?, ?)"
    assert params == [1, "a", 2, "b"]


def test_chunked_inserts_upsert_updates_every_other_column():
    (sql, _), = chunked_inserts("chunks", CHUNK_COLUMNS, [chunk_row(1)], upsert_on="id")
    assert sql.startswith("insert into chunks (id, episode_id, seq, ")
    assert " on conflict(id) do update set " in sql
    update = sql.split(" do update set ")[1]
    assert update == ", ".join(f"{c} = excluded.{c}" for c in CHUNK_COLUMNS[1:])
    assert "insert or replace" not in sql and "replace" not in sql  # REPLACE skips the FTS trigger


def test_chunked_inserts_upsert_with_nothing_to_update_does_nothing():
    (sql, _), = chunked_inserts("published", ["a", "b"], [[1, 2]], upsert_on=["a", "b"])
    assert sql.endswith(" on conflict(a, b) do nothing")


def test_chunked_inserts_upsert_on_several_columns():
    (sql, _), = chunked_inserts("t", ["env", "id", "v"], [["s", 1, 2]], upsert_on=("env", "id"))
    assert sql.endswith(" on conflict(env, id) do update set v = excluded.v")


def test_chunked_inserts_with_no_rows_makes_no_statements():
    assert chunked_inserts("chunks", CHUNK_COLUMNS, []) == []


def test_chunked_inserts_params_stay_numbers_and_none_stays_none():
    rows = [[1, 2.5, "3", None, 0]]
    (_, params), = chunked_inserts("t", list("abcde"), rows)
    assert [type(p) for p in params] == [int, float, str, type(None), int]


def test_chunked_inserts_splits_on_size_too():
    text = "x" * 400
    rows = [chunk_row(i, text) for i in range(12)]
    big = chunked_inserts("chunks", CHUNK_COLUMNS, rows, max_bytes=2000)
    assert len(big) > 1
    for sql, params in big:
        assert len(sql.encode()) + len(json.dumps(params).encode()) <= 2000
    assert sum(len(params) for _, params in big) == 12 * 8  # every row still sent once


def test_chunked_inserts_default_size_cap_is_well_under_100_kb():
    # ~12 KB per row: the 100-param rule alone would allow 12 rows = 144 KB.
    rows = [chunk_row(i, "y" * 12_000) for i in range(12)]
    statements = chunked_inserts("chunks", CHUNK_COLUMNS, rows)
    assert len(statements) > 1
    for sql, params in statements:
        assert len(sql.encode()) + len(json.dumps(params).encode()) < 100_000


def test_chunked_inserts_counts_utf8_bytes_not_characters():
    # 800 bytes of text per row: three rows overflow 2500 bytes, though 1200 characters wouldn't.
    rows = [chunk_row(i, "é" * 400) for i in range(3)]
    assert len(chunked_inserts("chunks", CHUNK_COLUMNS, rows, max_bytes=2500)) == 2


def test_chunked_inserts_rejects_a_row_too_big_for_any_statement():
    with pytest.raises(ValueError, match="too large"):
        chunked_inserts("chunks", CHUNK_COLUMNS, [chunk_row(1, "z" * 5000)], max_bytes=2000)


def test_chunked_inserts_rejects_rows_of_the_wrong_width():
    with pytest.raises(ValueError, match="row 1"):
        chunked_inserts("chunks", CHUNK_COLUMNS, [chunk_row(1), [1, 2, 3]])


def test_chunked_inserts_rejects_more_columns_than_params_allowed():
    with pytest.raises(ValueError, match="parameters"):
        chunked_inserts("t", [f"c{i}" for i in range(101)], [[0] * 101])


@pytest.mark.parametrize("table, columns", [
    ("chunks; drop table chunks", ["id"]),
    ("chunks", ["id", "text) values (1); --"]),
    ("", ["id"]),
])
def test_chunked_inserts_rejects_unsafe_identifiers(table, columns):
    with pytest.raises(ValueError, match="identifier"):
        chunked_inserts(table, columns, [[1] * len(columns)])


def test_chunked_inserts_rejects_an_upsert_key_that_is_not_a_column():
    with pytest.raises(ValueError, match="upsert_on"):
        chunked_inserts("chunks", CHUNK_COLUMNS, [chunk_row(1)], upsert_on="nope")


def apply(conn: sqlite3.Connection, statements: list[tuple[str, list]]) -> None:
    for sql, params in statements:
        conn.execute(sql, params)


def test_chunked_upserts_run_on_the_real_schema_and_fts_follows():
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    apply_schema(conn)
    add_episode(conn)

    rows = [chunk_row(i, f"gluing dovetails number {i}") for i in range(30)]
    apply(conn, chunked_inserts("chunks", CHUNK_COLUMNS, rows, upsert_on="id"))
    assert conn.execute("select count(*) from chunks").fetchone() == (30,)
    assert fts(conn, "dovetail") == list(range(30))  # porter stems dovetails → dovetail

    # Publish again with chunks 3 and 4 changed, and a new chunk 30.
    rows[3][5] = "planing tenons"
    rows[4][5] = "sharpening chisels"
    rows.append(chunk_row(30, "dovetail jig"))
    apply(conn, chunked_inserts("chunks", CHUNK_COLUMNS, rows, upsert_on="id"))

    assert conn.execute("select count(*) from chunks").fetchone() == (31,)
    assert fts(conn, "tenon") == [3] and fts(conn, "chisel") == [4]
    assert fts(conn, "dovetail") == [i for i in range(31) if i not in (3, 4)]
    # The upsert is an UPDATE, so the FTS delete+insert triggers ran: no stale terms remain.
    conn.execute("insert into chunks_fts(chunks_fts, rank) values ('integrity-check', 1)")
    conn.close()


def test_chunked_upserts_leave_unlisted_columns_and_rows_alone():
    conn = sqlite3.connect(":memory:")
    apply_schema(conn)
    add_episode(conn)
    apply(conn, chunked_inserts("chunks", CHUNK_COLUMNS, [chunk_row(1), chunk_row(2)],
                                upsert_on="id"))
    row = chunk_row(1, "new text")
    row[7] = 1  # is_boilerplate
    apply(conn, chunked_inserts("chunks", CHUNK_COLUMNS, [row], upsert_on="id"))
    assert conn.execute("select text, is_boilerplate from chunks where id = 1").fetchone() == (
        "new text", 1)
    assert conn.execute("select text from chunks where id = 2").fetchone() == (
        "gluing dovetails",)
    conn.close()


@respx.mock
def test_chunked_inserts_go_through_d1_batch_as_json_numbers(d1):
    statements = chunked_inserts("chunks", CHUNK_COLUMNS, [chunk_row(i) for i in range(13)],
                                 upsert_on="id")
    route = respx.post(D1_URL).respond(json=d1_ok(*[[] for _ in statements]))
    assert d1.batch(statements) == [[] for _ in statements]
    sent = body_of(route.calls.last)["batch"]
    assert len(sent) == 2
    assert [type(p) for p in sent[0]["params"][:8]] == [int] * 5 + [str, str, int]
