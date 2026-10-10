"""`wts search` (plan 2, Task 13a): the client of the Worker's GET /api/search, the plain-text
formatting of its response, and the CLI. The fixtures in tests/fixtures/search are hand-built in
the Worker's shape; worker/test/search-contract.test.ts keeps them honest."""

import copy
import json
from pathlib import Path
from types import SimpleNamespace

import click
import httpx
import pytest
from click.testing import CliRunner

from wts.cli import main
from wts.net import USER_AGENT, new_client
from wts.search import RETRY_S, SearchError, format_results, search

API = "https://wts-api-staging.example.workers.dev"
FIXTURES = Path(__file__).parent / "fixtures" / "search"
SECRET_WORD = "zymurgy"  # a query word that must never appear in an error


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def result(**overrides) -> dict:
    """One result with the Worker's keys; `overrides` replace top-level keys."""
    base = {
        "episode": {"id": 1, "number": 7, "title": "Hide Glue", "date": "2020-01-02", "links": {}},
        "chunk_id": 1,
        "text": "we like hide glue a lot",
        "ranges": [],
        "hit_ms": 0,
        "cue_s": {"youtube": 0, "apple": 0, "spotify": 0, "page": 0},
        "match": "keyword",
        "more_in_episode": 0,
        "folded": [],
    }
    return {**base, **overrides}


def response(*results: dict, **overrides) -> dict:
    base = {
        "total": len(results), "total_capped": False, "truncated": False, "page": 1,
        "has_more": False, "results": list(results), "mode": "exact", "sort": "relevance",
    }
    return {**base, **overrides}


def block(text: str, ranges: list, *, color: bool = False) -> str:
    """The indented text line of a one-result response."""
    out = format_results(response(result(text=text, ranges=ranges)), color=color)
    lines = out.splitlines()
    return lines[3]  # header, blank, title, text


# --- search() ----------------------------------------------------------------------------------


@pytest.fixture
def sleeps():
    return []


@pytest.fixture
def route(respx_mock):
    return respx_mock.get(f"{API}/api/search")


def run(client_sleeps, q="dovetail", **kwargs):
    with new_client() as client:
        return search(client, API, q, sleep=client_sleeps.append, **kwargs)


def test_request_url_and_params(route, sleeps):
    route.mock(return_value=httpx.Response(200, json=fixture("exact")))
    got = run(sleeps, '"hide glue" -titebond', mode="exact", sort="newest", page=3)
    assert got == fixture("exact")
    request = route.calls.last.request
    assert request.method == "GET"
    assert request.url.path == "/api/search"
    assert dict(request.url.params) == {
        "q": '"hide glue" -titebond', "mode": "exact", "sort": "newest", "page": "3"}
    raw = request.url.query
    assert b" " not in raw and b'"' not in raw  # URL-encoded, not sent raw
    assert b"%22hide" in raw and b"-titebond" in raw
    assert sleeps == []


def test_defaults_are_smart_relevance_page_one(route, sleeps):
    route.mock(return_value=httpx.Response(200, json=fixture("empty")))
    run(sleeps)
    assert dict(route.calls.last.request.url.params) == {
        "q": "dovetail", "mode": "smart", "sort": "relevance", "page": "1"}


def test_debug_asks_for_debug_1(route, sleeps):
    route.mock(return_value=httpx.Response(200, json=fixture("smart_debug")))
    run(sleeps, debug=True)
    assert dict(route.calls.last.request.url.params)["debug"] == "1"


def test_request_carries_the_bot_user_agent(route, sleeps):
    route.mock(return_value=httpx.Response(200, json=fixture("empty")))
    run(sleeps)
    assert route.calls.last.request.headers["User-Agent"] == USER_AGENT
    assert USER_AGENT.startswith("WoodTalkSearchBot/")


def test_a_trailing_slash_on_the_url_is_harmless(respx_mock, sleeps):
    r = respx_mock.get(f"{API}/api/search").mock(return_value=httpx.Response(200, json={}))
    with new_client() as client:
        search(client, API + "/", "x", sleep=sleeps.append)
    assert r.call_count == 1


def test_a_503_is_retried_once_then_succeeds(route, sleeps):
    route.mock(side_effect=[httpx.Response(503, json={"error": "unavailable"}),
                            httpx.Response(200, json=fixture("exact"))])
    assert run(sleeps) == fixture("exact")
    assert route.call_count == 2
    assert sleeps == [RETRY_S[0]]


def test_a_network_error_is_retried(route, sleeps):
    route.mock(side_effect=[httpx.ConnectError("boom"), httpx.Response(200, json=fixture("empty"))])
    assert run(sleeps) == fixture("empty")
    assert sleeps == [RETRY_S[0]]


def test_a_429_is_retried(route, sleeps):
    route.mock(side_effect=[httpx.Response(429), httpx.Response(200, json=fixture("empty"))])
    run(sleeps)
    assert route.call_count == 2


def test_three_500s_raise_after_two_sleeps(route, sleeps):
    route.mock(return_value=httpx.Response(500, json={"error": "internal"}))
    with pytest.raises(SearchError) as exc:
        run(sleeps)
    assert exc.value.status == 500
    assert route.call_count == 3
    assert sleeps == list(RETRY_S) == [1, 2]
    assert str(exc.value) == "search failed: HTTP 500 (internal) on GET wts-api-staging.example.workers.dev/api/search"


def test_network_errors_that_outlast_the_retries_have_no_status(route, sleeps):
    route.mock(side_effect=httpx.ConnectError("boom"))
    with pytest.raises(SearchError) as exc:
        run(sleeps)
    assert exc.value.status is None
    assert route.call_count == 3 and len(sleeps) == 2
    assert str(exc.value) == "search failed: ConnectError on GET wts-api-staging.example.workers.dev/api/search"


def test_a_404_fails_at_once(route, sleeps):
    route.mock(return_value=httpx.Response(404, json={"error": "not_found"}))
    with pytest.raises(SearchError) as exc:
        run(sleeps)
    assert exc.value.status == 404
    assert "HTTP 404 (not_found)" in str(exc.value)
    assert route.call_count == 1 and sleeps == []


def test_an_error_body_that_is_not_json_still_gives_the_status(route, sleeps):
    route.mock(return_value=httpx.Response(403, text="<html>blocked</html>"))
    with pytest.raises(SearchError) as exc:
        run(sleeps)
    assert exc.value.status == 403
    assert str(exc.value).startswith("search failed: HTTP 403 on GET ")
    assert "blocked" not in str(exc.value)


def test_invalid_json_raises(route, sleeps):
    route.mock(return_value=httpx.Response(200, text="<html>not json</html>"))
    with pytest.raises(SearchError, match="not valid JSON") as exc:
        run(sleeps)
    assert route.call_count == 1 and sleeps == []
    assert "not json" not in str(exc.value)


@pytest.mark.parametrize("body", [[1, 2], "text", 7])
def test_a_body_that_is_not_an_object_raises(route, sleeps, body):
    route.mock(return_value=httpx.Response(200, json=body))
    with pytest.raises(SearchError, match="not a JSON object"):
        run(sleeps)


@pytest.mark.parametrize(
    "mock",
    [
        pytest.param({"return_value": httpx.Response(503, json={"error": "unavailable"})}, id="503"),
        pytest.param({"return_value": httpx.Response(404, json={"error": "not_found"})}, id="404"),
        pytest.param({"return_value": httpx.Response(200, text="junk")}, id="bad-json"),
        pytest.param({"side_effect": httpx.ConnectError("boom")}, id="network"),
    ],
)
def test_errors_never_contain_the_query(route, sleeps, mock):
    route.mock(**mock)
    with pytest.raises(SearchError) as exc:
        run(sleeps, f"{SECRET_WORD} brewing")
    assert SECRET_WORD not in str(exc.value) and "q=" not in str(exc.value)
    assert "?" not in str(exc.value)


# --- format_results: highlighting --------------------------------------------------------------


def test_ranges_are_bracketed_without_color():
    assert block("we like hide glue a lot", [[8, 17]]) == "  we like [hide glue] a lot"


def test_ranges_are_bold_with_color():
    assert block("we like hide glue a lot", [[8, 17]], color=True) == (
        "  we like " + click.style("hide glue", bold=True) + " a lot")
    assert "\x1b[1m" in block("we like hide glue a lot", [[8, 17]], color=True)


def test_two_ranges_in_one_result():
    text = "hand cut dovetail and a dovetail saw"
    assert block(text, [[9, 17], [24, 32]]) == "  hand cut [dovetail] and a [dovetail] saw"


def test_ranges_at_the_start_and_end_of_the_text():
    assert block("dovetail layouts and more dovetail", [[0, 8], [26, 34]]) == (
        "  [dovetail] layouts and more [dovetail]")


def test_ranges_are_utf16_offsets_after_an_emoji():
    """Each emoji is two UTF-16 units but one Python character: slicing the str directly with
    the Worker's offsets would shift every highlight after it."""
    text = "We drove 🚗 to the show and the dovetail jig 🔧 broke, so we cut the dovetail by hand."
    assert block(text, [[32, 40], [69, 77]]) == (
        "  We drove 🚗 to the show and the [dovetail] jig 🔧 broke, so we cut the [dovetail] by hand.")


def test_a_range_may_include_an_emoji():
    assert block("so 🚗🚗 fast", [[3, 7]]) == "  so [🚗🚗] fast"


def test_a_range_that_splits_a_surrogate_pair_is_ignored():
    assert block("a 🚗 b", [[3, 4]]) == "  a 🚗 b"


@pytest.mark.parametrize(
    "ranges",
    [
        pytest.param([[5, 99]], id="past-the-end"),
        pytest.param([[40, 50]], id="entirely-outside"),
        pytest.param([[-3, 2]], id="negative"),
        pytest.param([[4, 4]], id="empty"),
        pytest.param([[6, 2]], id="backwards"),
        pytest.param([[1]], id="short"),
        pytest.param(["ab"], id="not-numbers"),
    ],
)
def test_a_bad_range_is_ignored_not_a_crash(ranges):
    assert block("hide glue", ranges) == "  hide glue"


def test_a_good_range_survives_next_to_a_bad_one():
    assert block("hide glue", [[0, 4], [5, 99]]) == "  [hide] glue"


def test_overlapping_ranges_do_not_duplicate_text():
    assert block("hide glue", [[0, 6], [3, 9]]) == "  [hide g]lue"


# --- format_results: the rest of a result ------------------------------------------------------


@pytest.mark.parametrize(
    ("ms", "clock"),
    [
        (0, "0:00"),
        (7_000, "0:07"),
        (7_999, "0:07"),
        (1_228_000, "20:28"),
        (3_599_000, "59:59"),
        (3_600_000, "1:00:00"),
        (3_725_000, "1:02:05"),
        (37_325_000, "10:22:05"),
    ],
)
def test_the_time_comes_from_hit_ms(ms, clock):
    title = format_results(response(result(hit_ms=ms)), color=False).splitlines()[2]
    assert title == f"#7 Hide Glue (2020-01-02)  {clock}"


def test_a_result_without_a_number_starts_with_the_title():
    r = result()
    r["episode"]["number"] = None
    r["episode"]["title"] = "Bonus: Shop Tour"
    title = format_results(response(r), color=False).splitlines()[2]
    assert title == "Bonus: Shop Tour (2020-01-02)  0:00"


def test_links_are_in_card_order_with_missing_ones_omitted():
    r = result()
    # Dict order is scrambled on purpose; apple is missing.
    r["episode"]["links"] = {"page": "https://e.example/p", "spotify": "https://s.example/x",
                             "youtube": "https://y.example/v"}
    lines = format_results(response(r), color=False).splitlines()
    assert lines[4:] == [
        "  youtube  https://y.example/v",
        "  spotify  https://s.example/x",
        "  page     https://e.example/p",
    ]


def test_all_four_links():
    lines = format_results(fixture("exact"), color=False).splitlines()
    assert lines[5:9] == [
        "  youtube  https://www.youtube.com/watch?v=Xk2mQp9vLrA&t=1221s",
        "  apple    https://podcasts.apple.com/podcast/id251471480?i=1000650000612",
        "  spotify  https://open.spotify.com/episode/4rT7wPz0Hn2eVbJ6cYdA1k",
        "  page     https://example.com/ep/612",
    ]


@pytest.mark.parametrize(("n", "line"), [(2, "  +2 more in episode"), (1, "  +1 more in episode")])
def test_more_in_episode(n, line):
    lines = format_results(response(result(more_in_episode=n)), color=False).splitlines()
    assert lines[4] == line


def test_no_more_line_when_there_are_no_more():
    out = format_results(response(result(more_in_episode=0)), color=False)
    assert "more in episode" not in out


def test_more_comes_before_the_links():
    r = result(more_in_episode=3)
    r["episode"]["links"] = {"page": "https://e.example/p"}
    lines = format_results(response(r), color=False).splitlines()
    assert lines[4:] == ["  +3 more in episode", "  page     https://e.example/p"]


def test_results_are_separated_by_a_blank_line():
    lines = format_results(response(result(), result()), color=False).splitlines()
    assert lines[1] == "" and lines[4] == ""
    assert lines[2].startswith("#7 ") and lines[5].startswith("#7 ")


# --- format_results: header and footers --------------------------------------------------------


def header(**overrides) -> str:
    return format_results(response(result(), **overrides), color=False).splitlines()[0]


def test_exact_header_counts_matches():
    assert header(total=57) == "57 matches"


def test_exact_header_singular():
    assert header(total=1) == "1 match"


def test_exact_header_when_the_count_is_capped():
    assert header(total=1000, total_capped=True) == "1000+ matches"


def test_exact_header_page_number_only_after_page_one():
    assert header(total=57, page=1) == "57 matches"
    assert header(total=57, page=2) == "57 matches, page 2"


def test_smart_header():
    assert header(mode="smart") == "smart search"
    assert header(mode="smart", page=3) == "smart search, page 3"


def test_degraded_smart_header():
    # The Worker says why (spec §4.4, §4.8): "unavailable", "budget" or "off".
    assert header(mode="smart", smart_degraded="unavailable") == (
        "smart search degraded (Workers AI or Vectorize unavailable): keyword results only")
    assert header(mode="smart", smart_degraded="budget", page=2) == (
        "smart search degraded (daily budget used up): keyword results only, page 2")
    assert header(mode="smart", smart_degraded="off") == (
        "smart search degraded (switched off): keyword results only")
    # An older Worker said `true`; an unknown reason is shown as is.
    assert header(mode="smart", smart_degraded=True) == (
        "smart search degraded: keyword results only")
    assert header(mode="smart", smart_degraded="quota") == (
        "smart search degraded (quota): keyword results only")


def folded_header(*folds: int, **overrides) -> str:
    """The header of a page whose results fold `folds` nearby hits each."""
    results = [result(chunk_id=i, more_in_episode=n, folded=list(range(n))) for i, n in enumerate(folds)]
    return format_results(response(*results, **overrides), color=False).splitlines()[0]


def test_header_says_when_matches_were_folded_into_fewer_results():
    # "5 matches" over 4 cards confused the maintainer at Checkpoint F: say why.
    assert folded_header(1, 0, 0, 0, total=5) == "5 matches; 4 results (1 folded into a nearby hit)"
    assert folded_header(2, 1, 0, total=6) == "6 matches; 3 results (3 folded into nearby hits)"


def test_folded_header_with_a_page_and_in_smart_mode():
    assert folded_header(1, 0, total=57, page=2) == (
        "57 matches, page 2; 2 results (1 folded into a nearby hit)")
    assert folded_header(1, 0, mode="smart") == (
        "smart search; 2 results (1 folded into a nearby hit)")


def test_header_unchanged_when_nothing_was_folded():
    assert folded_header(0, 0, 0, total=3) == "3 matches"


def test_no_results():
    assert format_results(fixture("empty"), color=False) == "0 matches\nNo results."
    smart = response(mode="smart", total=0)
    assert format_results(smart, color=False) == "smart search\nNo results."


def test_truncated_footer():
    out = format_results(fixture("exact_truncated"), color=False)
    assert out.endswith(
        '\n\nShowing the best 200 of 1000+ matches; add words, a "phrase" or year: to narrow.')
    assert "More:" not in out  # has_more is false at the cap


def test_truncated_footer_with_an_uncapped_total():
    out = format_results(response(result(), total=412, truncated=True), color=False)
    assert 'Showing the best 200 of 412 matches; add words, a "phrase" or year: to narrow.' in out


def test_more_footer():
    out = format_results(fixture("exact"), color=False)
    assert out.endswith("\n\nMore: --page 2")


def test_footer_order_is_truncated_then_more():
    out = format_results(response(result(), truncated=True, has_more=True, page=4), color=False)
    lines = out.splitlines()
    assert lines[-3] == ""
    assert lines[-2].startswith("Showing the best 200")
    assert lines[-1] == "More: --page 5"


def test_no_footer_without_flags():
    out = format_results(response(result()), color=False)
    assert "Showing" not in out and "More:" not in out
    assert not out.endswith("\n")


def test_related_results_are_marked_on_the_title_line():
    lines = format_results(response(result(match="related"), result(), mode="smart"),
                           color=False).splitlines()
    assert lines[2] == "#7 Hide Glue (2020-01-02)  0:00  related"
    assert lines[5] == "#7 Hide Glue (2020-01-02)  0:00"


def test_the_smart_fixture_end_to_end():
    out = format_results(fixture("smart"), color=False)
    assert out.splitlines() == [
        "smart search; 3 results (1 folded into a nearby hit)",
        "",
        "#590 Hide Glue, Again (2023-05-30)  35:10",
        "  [Hide] [glue] gives you more open time if you keep the pot warm, but titebond is easier.",
        "  +1 more in episode",
        "  youtube  https://www.youtube.com/watch?v=Lm4yHs7KaPo&t=2103s",
        "  spotify  https://open.spotify.com/episode/2bQe9xVd5LtRn8Fh3WzGcS?t=2103",
        "  page     https://example.com/ep/590",
        "",
        "#404 Restoring a Chair (2020-02-12)  25:00  related",
        "  Warm the pot to about 140 degrees and it stays workable for twenty minutes.",
        ("  apple    https://podcasts.apple.com/us/podcast/wood-talk-woodworking/id251471480"
         "?i=1000460000404&t=1493"),
        "  page     https://example.com/ep/404",
        "",
        "Listener Questions Extra (2016-09-21)  1:01  related",
        "  Fish [glue] never gels, so you can use it straight from the bottle.",
        "  page     https://example.com/ep/extra-3",
        "",
        "More: --page 2",
    ]


def test_the_debug_fixture():
    lines = format_results(fixture("smart_debug"), color=False).splitlines()
    assert lines[:2] == [
        "smart search; 2 results (2 folded into nearby hits)",
        "debug: 3 keyword hits, 50 meaning hits, 2 dropped (7702, 999999)",
    ]
    assert lines[3:8] == [
        "#590 Hide Glue, Again (2023-05-30)  35:10",
        "  [Hide] [glue] gives you more open time if you keep the pot warm, but titebond is easier.",
        "  +2 more in episode",
        "  debug    keyword #3, meaning #2 (0.812), rrf 0.0320; folded 59032, 59040",
        "  page     https://example.com/ep/590",
    ]
    assert lines[11] == "  debug    meaning #1 (0.846), rrf 0.0164"


def test_debug_line_reads_folded_from_the_result_not_its_debug_object():
    debug = {"keyword_rank": 3, "vector_rank": None, "vector_score": None, "rrf_score": 0.032}
    folded = format_results(response(result(more_in_episode=2, folded=[7, 9], debug=debug),
                                     mode="smart"), color=False).splitlines()
    assert "  debug    keyword #3, rrf 0.0320; folded 7, 9" in folded
    # An older Worker's debug.folded is no longer read.
    old = format_results(response(result(debug={**debug, "folded": [7, 9]}), mode="smart"),
                         color=False).splitlines()
    assert "  debug    keyword #3, rrf 0.0320" in old


def test_debug_summary_when_degraded_or_nothing_dropped():
    degraded = response(result(), mode="smart",
                        debug={"keyword_hits": 3, "vector_hits": None, "dropped": []})
    assert format_results(degraded, color=False).splitlines()[1] == (
        "debug: 3 keyword hits, no meaning search")
    clean = response(result(), mode="smart", debug={"keyword_hits": 0, "vector_hits": 1, "dropped": []})
    assert format_results(clean, color=False).splitlines()[1] == "debug: 0 keyword hits, 1 meaning hit"


def test_no_debug_lines_without_debug_data():
    out = format_results(fixture("smart"), color=False)
    assert "debug" not in out


def test_the_degraded_fixture():
    out = format_results(fixture("smart_degraded"), color=False)
    assert out.splitlines()[0] == (
        "smart search degraded (Workers AI or Vectorize unavailable): keyword results only")
    assert "[Hide] [glue] gives you more open time" in out


def test_the_exact_fixture_end_to_end():
    out = format_results(fixture("exact"), color=False)
    assert out.splitlines()[:5] == [
        "57 matches; 3 results (2 folded into nearby hits)",
        "",
        "#612 Dovetails, Glue and Bandsaw Tuning (2024-03-12)  20:28",
        "  Honestly I think a hand cut [dovetail] is overrated, but a good [dovetail] saw is worth the money.",
        "  +2 more in episode",
    ]
    assert "#598 Road Trip Special (2023-08-02)  1:02:05" in out
    assert "\nBonus: Shop Tour (2022-11-05)  0:07\n" in out
    assert "  [dovetail] layouts and then more [dovetail]" in out


def test_limit_shows_only_the_first_n_results():
    out = format_results(fixture("exact"), color=False, limit=2)
    assert "#612 Dovetails, Glue and Bandsaw Tuning" in out
    assert "#598 Road Trip Special" in out
    assert "Bonus: Shop Tour" not in out
    assert "\nShowing 2 of 3 results on this page (--limit 2)." in out


def test_limit_counts_only_the_results_shown():
    # The first result folds two hits; with one shown, the header says so in the singular.
    out = format_results(fixture("exact"), color=False, limit=1)
    assert out.splitlines()[0] == "57 matches; 1 result (2 folded into nearby hits)"


def test_limit_at_or_above_the_page_changes_nothing():
    plain = format_results(fixture("exact"), color=False)
    assert format_results(fixture("exact"), color=False, limit=3) == plain
    assert format_results(fixture("exact"), color=False, limit=10) == plain


def test_format_does_not_modify_the_response():
    data = fixture("exact")
    before = copy.deepcopy(data)
    format_results(data, color=True)
    assert data == before


# --- CLI ---------------------------------------------------------------------------------------


@pytest.fixture
def cli_setup(wts_home, monkeypatch):
    (wts_home / "config.toml").write_text(
        f'run_env = "staging"\n[env.staging]\napi_url = "{API}"\n')
    monkeypatch.setattr("wts.search.RETRY_S", (0, 0))  # the CLI doesn't inject a sleep


def invoke(*args: str):
    return CliRunner().invoke(main, ["search", *args])


def test_cli_prints_the_formatted_results(cli_setup, route):
    route.mock(return_value=httpx.Response(200, json=fixture("exact")))
    result_ = invoke("dovetail", "--mode", "exact")
    assert result_.exit_code == 0, result_.output
    assert result_.output.rstrip("\n") == format_results(fixture("exact"), color=False)
    assert "\x1b[" not in result_.output  # CliRunner's stdout is not a TTY: brackets, not bold
    assert dict(route.calls.last.request.url.params) == {
        "q": "dovetail", "mode": "exact", "sort": "relevance", "page": "1"}


def test_cli_highlights_in_bold_on_a_terminal(cli_setup, route, monkeypatch):
    route.mock(return_value=httpx.Response(200, json=fixture("exact")))
    monkeypatch.setattr("wts.cli.sys", SimpleNamespace(stdout=SimpleNamespace(isatty=lambda: True)))
    result_ = invoke("dovetail", "--mode", "exact")
    assert result_.exit_code == 0, result_.output
    assert click.style("dovetail", bold=True) in result_.output
    assert "[dovetail]" not in result_.output


def test_cli_json_has_no_color_even_on_a_terminal(cli_setup, route, monkeypatch):
    route.mock(return_value=httpx.Response(200, json=fixture("exact")))
    monkeypatch.setattr("wts.cli.sys", SimpleNamespace(stdout=SimpleNamespace(isatty=lambda: True)))
    result_ = invoke("--json", "dovetail")
    assert json.loads(result_.output) == fixture("exact")


def test_cli_passes_mode_sort_and_page(cli_setup, route):
    route.mock(return_value=httpx.Response(200, json=fixture("exact")))
    result_ = invoke("--mode", "exact", "--sort", "oldest", "--page", "2", "dovetail")
    assert result_.exit_code == 0, result_.output
    assert dict(route.calls.last.request.url.params) == {
        "q": "dovetail", "mode": "exact", "sort": "oldest", "page": "2"}


def test_cli_defaults_to_smart_search(cli_setup, route):
    route.mock(return_value=httpx.Response(200, json=fixture("smart_degraded")))
    result_ = invoke("hide", "glue")
    assert result_.exit_code == 0, result_.output
    assert dict(route.calls.last.request.url.params)["mode"] == "smart"
    assert result_.output.startswith("smart search degraded (Workers AI")


def test_cli_debug(cli_setup, route):
    route.mock(return_value=httpx.Response(200, json=fixture("smart_debug")))
    result_ = invoke("hide", "glue", "--debug")
    assert result_.exit_code == 0, result_.output
    assert dict(route.calls.last.request.url.params)["debug"] == "1"
    assert result_.output.splitlines()[1].startswith("debug: 3 keyword hits")
    plain = invoke("hide", "glue")
    assert "debug" not in dict(route.calls.last.request.url.params)
    assert plain.exit_code == 0


def test_cli_json_prints_the_response_as_is(cli_setup, route):
    route.mock(return_value=httpx.Response(200, json=fixture("exact")))
    result_ = invoke("--json", "dovetail")
    assert result_.exit_code == 0, result_.output
    assert json.loads(result_.output) == fixture("exact")
    assert result_.output.startswith('{\n  "total": 57')
    assert "🚗" in result_.output  # ensure_ascii is off: readable, not 🚗


def test_cli_limit_trims_the_printed_results_and_sends_nothing_new(cli_setup, route):
    route.mock(return_value=httpx.Response(200, json=fixture("exact")))
    result_ = invoke("--limit", "1", "dovetail")
    assert result_.exit_code == 0, result_.output
    assert result_.output.rstrip("\n") == format_results(fixture("exact"), color=False, limit=1)
    assert "limit" not in dict(route.calls.last.request.url.params)  # client-side only


def test_cli_limit_trims_the_json_results_too(cli_setup, route):
    route.mock(return_value=httpx.Response(200, json=fixture("exact")))
    result_ = invoke("--json", "--limit", "2", "dovetail")
    assert result_.exit_code == 0, result_.output
    data = json.loads(result_.output)
    assert data["results"] == fixture("exact")["results"][:2]
    assert {k: v for k, v in data.items() if k != "results"} == {
        k: v for k, v in fixture("exact").items() if k != "results"}


def test_cli_words_are_joined_and_a_dash_word_is_part_of_the_query(cli_setup, route):
    route.mock(return_value=httpx.Response(200, json=fixture("empty")))
    result_ = invoke("hide", "glue", "-titebond")
    assert result_.exit_code == 0, result_.output
    assert route.calls.last.request.url.params["q"] == "hide glue -titebond"


def test_cli_a_quoted_phrase_is_one_argument(cli_setup, route):
    route.mock(return_value=httpx.Response(200, json=fixture("empty")))
    result_ = invoke('"hide glue" -titebond year:2015')
    assert result_.exit_code == 0, result_.output
    assert route.calls.last.request.url.params["q"] == '"hide glue" -titebond year:2015'


def test_cli_options_may_follow_the_query(cli_setup, route):
    route.mock(return_value=httpx.Response(200, json=fixture("empty")))
    result_ = invoke("dovetail", "-titebond", "--mode", "exact")
    assert result_.exit_code == 0, result_.output
    params = dict(route.calls.last.request.url.params)
    assert params["q"] == "dovetail -titebond" and params["mode"] == "exact"


def test_cli_env_defaults_to_run_env(cli_setup, respx_mock, wts_home):
    (wts_home / "config.toml").write_text(
        'run_env = "production"\n[env.production]\napi_url = "https://search.example.org/"\n')
    route = respx_mock.get("https://search.example.org/api/search").mock(
        return_value=httpx.Response(200, json=fixture("empty")))
    result_ = invoke("dovetail")
    assert result_.exit_code == 0, result_.output
    assert route.call_count == 1


def test_cli_env_option_overrides_run_env(cli_setup, respx_mock, wts_home):
    (wts_home / "config.toml").write_text(
        'run_env = "staging"\n[env.staging]\napi_url = "https://staging.example.org"\n'
        '[env.production]\napi_url = "https://search.example.org"\n')
    route = respx_mock.get("https://search.example.org/api/search").mock(
        return_value=httpx.Response(200, json=fixture("empty")))
    result_ = invoke("--env", "production", "dovetail")
    assert result_.exit_code == 0, result_.output
    assert route.call_count == 1


def test_cli_without_env_or_run_env_is_a_usage_error(wts_home, respx_mock):
    (wts_home / "config.toml").write_text(f'[env.staging]\napi_url = "{API}"\n')
    result_ = invoke("dovetail")
    assert result_.exit_code == 2
    assert "--env or run_env" in result_.output
    assert len(respx_mock.calls) == 0


def test_cli_without_a_config_file_is_a_usage_error(wts_home):
    result_ = invoke("dovetail")
    assert result_.exit_code == 2
    assert "--env or run_env" in result_.output


def test_cli_missing_api_url_names_the_key(wts_home, respx_mock):
    (wts_home / "config.toml").write_text(
        'cloudflare_account_id = "a"\n[env.staging]\nd1_database_id = "d"\n'
        'vectorize_index = "v"\n')
    result_ = invoke("--env", "staging", "dovetail")
    assert result_.exit_code == 2
    assert "[env.staging] api_url" in result_.output
    assert len(respx_mock.calls) == 0


def test_cli_a_query_is_required():
    result_ = invoke()
    assert result_.exit_code == 2
    assert "QUERY" in result_.output


def test_cli_rejects_bad_choices_and_pages(cli_setup):
    assert invoke("--mode", "fuzzy", "x").exit_code == 2
    assert invoke("--sort", "best", "x").exit_code == 2
    assert invoke("--env", "prod", "x").exit_code == 2
    assert invoke("--page", "0", "x").exit_code == 2
    assert invoke("--limit", "0", "x").exit_code == 2


def test_cli_an_api_error_is_one_error_line_without_the_query(cli_setup, route):
    route.mock(return_value=httpx.Response(500, json={"error": "internal"}))
    result_ = invoke(SECRET_WORD, "brewing")
    assert result_.exit_code == 1
    assert route.call_count == 3  # the retries ran (without waiting)
    lines = result_.output.strip().splitlines()
    assert lines == [
        "Error: search failed: HTTP 500 (internal) on GET wts-api-staging.example.workers.dev/api/search"]
    assert SECRET_WORD not in result_.output
    assert "Traceback" not in result_.output


def test_cli_a_network_error_is_one_error_line(cli_setup, route):
    route.mock(side_effect=httpx.ConnectError("boom"))
    result_ = invoke("dovetail")
    assert result_.exit_code == 1
    assert len(result_.output.strip().splitlines()) == 1
    assert result_.output.startswith("Error: search failed: ConnectError on GET ")


def test_cli_help_shows_how_to_quote():
    result_ = invoke("--help")
    assert result_.exit_code == 0
    assert "hide glue" in result_.output and "-titebond" in result_.output
