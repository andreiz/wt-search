"""`wts eval run` (spec §7.2, plan 5 Task 3): asks the API for every case, paced, and writes a
report; compares with the baseline."""

import json
from datetime import UTC, datetime

import httpx
import pytest
from click.testing import CliRunner

from wts.cli import main
from wts.evalset.cases import Case, Item
from wts.evalset.run import EvalError, ask, build_report, run_cases, write_report
from wts.net import new_client

API = "https://wts-api-staging.example.workers.dev"


def body(*numbers_and_times, mode="exact", degraded=None, debug=False):
    results = []
    for rank, (number, at_s) in enumerate(numbers_and_times, 1):
        r = {"episode": {"number": number, "title": "T", "date": "2020-01-01"},
             "hit_ms": at_s * 1000, "match": "keyword" if mode == "exact" else "related",
             "more_in_episode": 0, "text": "x", "ranges": []}
        if debug:
            r["debug"] = {"vector_rank": rank, "vector_score": 0.7}
        results.append(r)
    out = {"mode": mode, "page": 1, "results": results}
    if degraded:
        out["smart_degraded"] = degraded
    return out


@pytest.fixture
def api(respx_mock):
    return respx_mock.get(f"{API}/api/search")


def test_ask_both_modes_paced_with_debug_for_related(api):
    api.side_effect = lambda request: httpx.Response(200, json=body(
        (71, 41), mode=request.url.params["mode"]))
    sleeps = []
    with new_client() as client:
        answers = ask(client, API, Case("a", "glue", "paraphrase", expect=(Item(71),)),
                      sleep=sleeps.append)
    assert set(answers) == {"exact", "related"}
    params = [dict(c.request.url.params) for c in api.calls]
    assert [p["mode"] for p in params] == ["exact", "related"]
    assert "debug" not in params[0] and params[1]["debug"] == "1"
    assert all(p["sort"] == "relevance" and p["page"] == "1" for p in params)
    assert sleeps == [1.0, 1.0]


def test_a_degraded_related_answer_stops_with_the_case_id(api):
    api.mock(return_value=httpx.Response(200, json=body(mode="related", degraded="budget")))
    with new_client() as client, pytest.raises(EvalError) as err:
        ask(client, API, Case("secret-id", "zymurgy", "paraphrase", mode="related",
                              expect=(Item(1),)), sleep=lambda s: None)
    assert "secret-id" in str(err.value) and "budget" in str(err.value)
    assert "zymurgy" not in str(err.value)


def test_a_failed_search_names_the_case_not_the_query(api, monkeypatch):
    monkeypatch.setattr("wts.search.RETRY_S", ())
    api.mock(return_value=httpx.Response(500))
    with new_client() as client, pytest.raises(EvalError) as err:
        ask(client, API, Case("c1", "zymurgy", "exact", mode="exact", expect=(Item(1),)),
            sleep=lambda s: None)
    assert "c1" in str(err.value) and "HTTP 500" in str(err.value)
    assert "zymurgy" not in str(err.value)


def test_build_and_write_a_report(api, tmp_path):
    api.mock(return_value=httpx.Response(200, json=body((71, 61), mode="related", debug=True)))
    case = Case("a", "chair", "paraphrase", mode="related", expect=(Item(71, 60),))
    with new_client() as client:
        scored = run_cases(client, API, [case], sleep=lambda s: None)
    report = build_report("staging", API, scored, now=datetime(2026, 10, 13, 20, 1, 2, tzinfo=UTC))
    assert report["at"] == "2026-10-13T20:01:02Z"
    assert report["summary"]["overall"]["recall@10"] == 1.0
    [entry] = report["cases"]
    assert entry["query"] == "chair" and entry["mode"] == "related"
    assert entry["top"]["related"] == [{"episode": 71, "at": "1:01", "match": "related",
                                        "meaning_rank": 1, "similarity": 0.7}]
    path = write_report(report, tmp_path, update=False)
    assert path == tmp_path / "reports" / "20261013T200102Z.json"
    assert json.loads(path.read_text()) == report
    assert not (tmp_path / "baseline.json").exists()
    write_report(report, tmp_path, update=True)
    assert json.loads((tmp_path / "baseline.json").read_text()) == report


def test_a_reranked_hit_keeps_its_rerank_rank_and_score(api):
    answer = body((71, 61), (44, 5), mode="related", debug=True)
    answer["results"][0]["debug"] |= {"rerank_rank": 1, "rerank_score": 0.91}
    answer["results"][1]["debug"] |= {"rerank_rank": None, "rerank_score": None}
    api.mock(return_value=httpx.Response(200, json=answer))
    case = Case("a", "chair", "paraphrase", mode="related", expect=(Item(71),))
    with new_client() as client:
        scored = run_cases(client, API, [case], sleep=lambda s: None)
    report = build_report("staging", API, scored, now=datetime(2026, 10, 25, tzinfo=UTC))
    reranked, unscored = report["cases"][0]["top"]["related"]
    assert reranked["rerank_rank"] == 1 and reranked["rerank_score"] == 0.91
    assert "rerank_rank" not in unscored and "rerank_score" not in unscored


def test_params_go_with_related_requests_only_and_into_the_report(api):
    api.side_effect = lambda request: httpx.Response(200, json=body(
        (71, 41), mode=request.url.params["mode"], debug=True))
    case = Case("a", "glue", "paraphrase", expect=(Item(71),))  # mode both
    with new_client() as client:
        scored = run_cases(client, API, [case], sleep=lambda s: None, params={"floor": "0.66"})
    exact_request, related_request = (c.request for c in api.calls)
    assert exact_request.url.params.get("floor") is None
    assert related_request.url.params["floor"] == "0.66"
    now = datetime(2026, 10, 13, 20, 1, 2, tzinfo=UTC)
    report = build_report("staging", API, scored, now=now, params={"floor": "0.66"})
    assert report["params"] == {"floor": "0.66"}
    assert build_report("staging", API, scored, now=now)["params"] == {}


# --- CLI ---------------------------------------------------------------------------------------


@pytest.fixture
def cli_env(wts_home, tmp_path, monkeypatch):
    (wts_home / "config.toml").write_text(f'run_env = "staging"\n[env.staging]\napi_url = "{API}"\n')
    cases = tmp_path / "eval"
    cases.mkdir()
    (cases / "queries.yaml").write_text("""
- {id: conoid, query: Conoid, tag: jargon, mode: exact, expect: [{episode: 71, at: 41}]}
- {id: chair, query: chair, tag: paraphrase, mode: exact, expect: [{episode: 71}]}
""")
    monkeypatch.setenv("WTS_EVAL_DIR", str(cases))
    monkeypatch.setattr("wts.evalset.run.PACE_S", 0)
    return cases


def invoke(*args):
    return CliRunner().invoke(main, ["eval", "run", *args])


def test_cli_first_run_writes_a_report_and_says_there_is_no_baseline(cli_env, api):
    api.mock(return_value=httpx.Response(200, json=body((71, 41))))
    r = invoke()
    assert r.exit_code == 0, r.output
    assert "2 cases" in r.output and "no baseline yet" in r.output
    assert len(list((cli_env / "reports").glob("*.json"))) == 1


def test_cli_update_then_a_drop_exits_1_and_names_the_case(cli_env, api):
    api.mock(return_value=httpx.Response(200, json=body((71, 41))))
    assert invoke("--update").exit_code == 0
    api.mock(return_value=httpx.Response(200, json=body((5, 0))))
    r = invoke()
    assert r.exit_code == 1
    assert "overall recall@10 0.000 < baseline 1.000" in r.output
    assert "conoid" in r.output and "chair" in r.output


def test_cli_only_filters_by_tag_or_id_and_skips_the_baseline(cli_env, api):
    api.mock(return_value=httpx.Response(200, json=body((5, 0))))
    r = invoke("--only", "chair")
    assert r.exit_code == 0 and "1 case" in r.output and len(api.calls) == 1
    assert invoke("--only", "paraphrase").exit_code == 0


def test_cli_only_matching_nothing_and_only_with_update_are_refused(cli_env, api):
    assert "no case has the tag or id" in invoke("--only", "nope").output
    assert invoke("--only", "chair", "--update").exit_code == 2


def test_cli_a_bad_case_file_fails_before_any_request(cli_env, api):
    (cli_env / "queries.yaml").write_text("- {id: a, query: q, tag: vibes, expect: [{episode: 1}]}")
    r = invoke()
    assert r.exit_code == 1 and "tag must be one of" in r.output and not api.calls


def test_cli_param_must_be_key_equals_value(cli_env, api):
    r = invoke("--param", "floor")
    assert r.exit_code == 2 and "KEY=VALUE" in r.output and not api.calls


def test_cli_update_refuses_params(cli_env, api):
    # A baseline is the deployed settings, not an experiment.
    r = invoke("--update", "--param", "floor=0.7")
    assert r.exit_code == 2 and "--param" in r.output and not api.calls


def test_cli_params_are_sent_reported_and_printed(cli_env, api):
    (cli_env / "queries.yaml").write_text(
        "- {id: chair, query: chair, tag: paraphrase, mode: related, expect: [{episode: 71}]}")
    api.mock(return_value=httpx.Response(200, json=body((71, 41), mode="related", debug=True)))
    r = invoke("--param", "floor=0.66", "--param", "rerank=1")
    assert r.exit_code == 0, r.output
    assert "params: floor=0.66 rerank=1" in r.output
    sent = api.calls[0].request.url.params
    assert sent["floor"] == "0.66" and sent["rerank"] == "1"
    [path] = (cli_env / "reports").glob("*.json")
    assert json.loads(path.read_text())["params"] == {"floor": "0.66", "rerank": "1"}
