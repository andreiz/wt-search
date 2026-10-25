"""The review page's test-search endpoints: check where a passage lands, and add a case to
eval/queries.yaml (spec §7.2)."""

import threading

import httpx
import pytest

from wts.db import connect
from wts.review.server import ReviewApp, serve
from wts.search import SearchError

TOKEN = "test-token"
AUTH = {"X-Review-Token": TOKEN}
FILE = "# hand-written\n- id: conoid\n  query: Conoid\n  tag: jargon\n  expect: [{episode: 71}]\n"


def _r(number, hit_s):
    return {"episode": {"number": number}, "hit_ms": hit_s * 1000}


class FakeSearch:
    def __init__(self):
        self.calls = []
        self.answers = {"exact": {"results": [_r(5, 0), _r(71, 2460)]},
                        "related": {"results": [_r(71, 100)]}}
        self.error = None

    def __call__(self, query, mode):
        self.calls.append((query, mode))
        if self.error:
            raise self.error
        return self.answers[mode]


@pytest.fixture
def fake():
    return FakeSearch()


@pytest.fixture
def eval_file(tmp_path):
    f = tmp_path / "queries.yaml"
    f.write_text(FILE)
    return f


@pytest.fixture
def base(tmp_path, paths, fake, eval_file):
    app = ReviewApp(lambda: connect(tmp_path / "state.db"), paths, token=TOKEN,
                    eval_file=eval_file, searcher=fake)
    srv = serve(app, 0)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()
    thread.join(timeout=5)


@pytest.fixture
def ep(make_episode):
    return make_episode(number=71)


def _post(base, path, body, headers=AUTH):
    return httpx.post(base + path, json=body, headers=headers)


def test_check_asks_both_modes_and_ranks_the_passage(base, fake, ep):
    r = _post(base, "/api/eval/check", {"query": "conoid chair", "episode_id": ep,
                                        "at_ms": 2454_000})
    assert r.status_code == 200
    assert r.json() == {
        "top": 10,
        "exact": {"rank": 2, "episode_rank": 2},
        "related": {"rank": None, "episode_rank": 1},
    }
    assert fake.calls == [("conoid chair", "exact"), ("conoid chair", "related")]


def test_check_without_a_time_counts_any_card_of_the_episode(base, ep):
    r = _post(base, "/api/eval/check", {"query": "x", "episode_id": ep, "at_ms": None})
    assert r.json()["related"] == {"rank": 1, "episode_rank": 1}


def test_check_a_failed_search_is_502(base, fake, ep):
    fake.error = SearchError("search failed: 429")
    r = _post(base, "/api/eval/check", {"query": "x", "episode_id": ep, "at_ms": None})
    assert (r.status_code, r.json()) == (502, {"error": "search_failed"})


def test_check_a_degraded_related_search_is_502(base, fake, ep):
    fake.answers["related"] = {"results": [], "smart_degraded": "budget"}
    r = _post(base, "/api/eval/check", {"query": "x", "episode_id": ep, "at_ms": None})
    assert (r.status_code, r.json()) == (502, {"error": "degraded"})


def test_check_without_an_environment_is_503(tmp_path, paths, ep):
    app = ReviewApp(lambda: connect(tmp_path / "state.db"), paths, token=TOKEN)
    srv = serve(app, 0)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{srv.server_address[1]}"
        r = _post(url, "/api/eval/check", {"query": "x", "episode_id": ep, "at_ms": None})
        assert (r.status_code, r.json()) == (503, {"error": "no_environment"})
    finally:
        srv.shutdown()
        srv.server_close()


@pytest.mark.parametrize("body", [
    {"query": "", "episode_id": 1, "at_ms": None},
    {"query": "x" * 201, "episode_id": 1, "at_ms": None},
    {"query": "x", "episode_id": "1", "at_ms": None},
    {"query": "x", "episode_id": 1, "at_ms": -5},
    {"query": "x", "episode_id": 1},
])
def test_check_bad_bodies_are_400(base, ep, body):
    assert _post(base, "/api/eval/check", body).status_code == 400


def test_check_an_unknown_episode_is_404(base):
    r = _post(base, "/api/eval/check", {"query": "x", "episode_id": 999, "at_ms": None})
    assert r.status_code == 404


def test_the_endpoints_need_the_token(base, ep):
    body = {"query": "x", "episode_id": ep, "at_ms": None}
    assert _post(base, "/api/eval/check", body, headers={}).status_code == 401
    assert _post(base, "/api/eval", body, headers={}).status_code == 401


def test_said_compares_stems(base):
    text = "the board foot calculator is awesome"
    r = _post(base, "/api/eval/said", {"query": "board foot calculation", "text": text})
    assert (r.status_code, r.json()) == (200, {"said": True})
    r = _post(base, "/api/eval/said", {"query": "board foot math", "text": text})
    assert r.json() == {"said": False}


@pytest.mark.parametrize("body", [
    {"query": "x"}, {"text": "x"}, {"query": 1, "text": "x"}, {"query": "x", "text": None},
    {"query": "x" * 201, "text": "x"}, {"query": "x", "text": "x" * 20_001},
])
def test_said_bad_bodies_are_400(base, body):
    assert _post(base, "/api/eval/said", body).status_code == 400


def test_said_needs_the_token(base):
    r = _post(base, "/api/eval/said", {"query": "x", "text": "x"}, headers={})
    assert r.status_code == 401


def _case(ep, **kw):
    return {"query": "aspirational builds", "tag": "paraphrase", "mode": "both",
            "episode_id": ep, "at_ms": 2454_321, "absent": False} | kw


def test_save_appends_a_case(base, eval_file, ep):
    r = _post(base, "/api/eval", _case(ep))
    assert (r.status_code, r.json()) == (200, {"id": "aspirational-builds"})
    assert eval_file.read_text() == FILE + (
        "\n- id: aspirational-builds\n  query: aspirational builds\n  tag: paraphrase\n"
        '  expect: [{episode: 71, at: "40:54"}]\n')


def test_save_a_negative_for_one_mode(base, eval_file, ep):
    r = _post(base, "/api/eval", _case(ep, tag="negative", mode="related", absent=True,
                                       at_ms=None))
    assert r.status_code == 200
    assert eval_file.read_text().endswith(
        "  tag: negative\n  mode: related\n  expect_absent: [{episode: 71}]\n")


def test_save_the_same_case_twice_is_409(base, eval_file, ep):
    assert _post(base, "/api/eval", _case(ep)).status_code == 200
    before = eval_file.read_text()
    r = _post(base, "/api/eval", _case(ep))
    assert (r.status_code, r.json()) == (409, {"error": "exists"})
    assert eval_file.read_text() == before


def test_save_creates_a_missing_file(base, eval_file, ep):
    eval_file.unlink()
    assert _post(base, "/api/eval", _case(ep)).status_code == 200
    assert eval_file.read_text().startswith("- id: aspirational-builds\n")


def test_save_into_a_broken_file_is_500_and_leaves_it(base, eval_file, ep):
    eval_file.write_text("- id: [unclosed\n")
    r = _post(base, "/api/eval", _case(ep))
    assert (r.status_code, r.json()) == (500, {"error": "edit_failed"})
    assert eval_file.read_text() == "- id: [unclosed\n"


@pytest.mark.parametrize("change", [
    {"tag": "fuzzy"}, {"mode": "smart"}, {"absent": "no"}, {"query": " "},
    {"at_ms": 1.5}, {"episode_id": None},
])
def test_save_bad_bodies_are_400(base, eval_file, ep, change):
    assert _post(base, "/api/eval", _case(ep, **change)).status_code == 400
    assert eval_file.read_text() == FILE


def test_save_an_unknown_episode_is_404(base, eval_file):
    assert _post(base, "/api/eval", _case(999)).status_code == 404
