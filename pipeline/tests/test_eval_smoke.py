"""The smoke search after `wts run` (spec §8.1, plan 5 Task 4)."""

import httpx
import pytest
from test_notify import FakeNotifier

from wts.config import Config
from wts.evalset.run import smoke
from wts.net import new_client

API = "https://wts-api-staging.example.workers.dev"
CFG = Config(env_tables={"staging": {"api_url": API}})


def answer(number):
    return {"mode": "exact", "page": 1, "results": [
        {"episode": {"number": number}, "hit_ms": 0, "more_in_episode": 0}]}


@pytest.fixture
def cases(tmp_path):
    (tmp_path / "queries.yaml").write_text("""
- {id: conoid, query: Conoid, tag: jargon, mode: exact, expect: [{episode: 71}], smoke: true}
- {id: other, query: glue, tag: exact, mode: exact, expect: [{episode: 9}]}
""")
    return tmp_path


def run(cases, notifier, cfg=CFG):
    with new_client() as client:
        return smoke(cfg, "staging", client, notifier, directory=cases, sleep=lambda s: None)


def test_only_smoke_cases_run_and_a_pass_says_nothing(cases, respx_mock):
    route = respx_mock.get(f"{API}/api/search").mock(return_value=httpx.Response(200, json=answer(71)))
    notifier = FakeNotifier()
    assert run(cases, notifier)["ok"] == 1
    assert len(route.calls) == 1 and notifier.sent == []


def test_a_miss_is_notified_by_case_id(cases, respx_mock, wts_messages):
    respx_mock.get(f"{API}/api/search").mock(return_value=httpx.Response(200, json=answer(5)))
    notifier = FakeNotifier()
    counts = run(cases, notifier)
    assert counts["failed"] == 1
    [sent] = notifier.sent
    assert sent["title"] == "wts: smoke search failed" and sent["priority"] == "high"
    assert "conoid: ep 71 not in the top 10" in sent["body"]
    assert "Conoid" not in sent["body"]  # the id is sent, not the query
    assert any("smoke search failed" in m for m in wts_messages)


def test_a_search_error_is_a_failure_too(cases, respx_mock, monkeypatch):
    monkeypatch.setattr("wts.search.RETRY_S", ())
    respx_mock.get(f"{API}/api/search").mock(return_value=httpx.Response(503))
    notifier = FakeNotifier()
    assert run(cases, notifier)["failed"] == 1
    assert "HTTP 503" in notifier.sent[0]["body"]


def test_no_api_url_or_no_smoke_cases_is_skipped_with_a_warning(cases, tmp_path, wts_messages):
    notifier = FakeNotifier()
    assert run(cases, notifier, cfg=Config())["skipped"] == 1
    assert any("api_url" in m for m in wts_messages)
    empty = tmp_path / "empty"
    empty.mkdir()
    assert run(empty, notifier)["skipped"] == 1
    assert notifier.sent == []


def test_a_broken_case_file_is_an_error_not_a_crash(cases, wts_messages):
    (cases / "queries.yaml").write_text("- [unclosed")
    assert run(cases, FakeNotifier())["error"] == 1
    assert any("not valid YAML" in m for m in wts_messages)
