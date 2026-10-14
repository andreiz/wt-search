"""Scoring the test search set (spec §7.2, plan 5 Task 2): pure, an API answer in, scores out."""

import math

import pytest

from wts.evalset.cases import Case, Item
from wts.evalset.score import (
    newly_missed,
    regressions,
    score_case,
    summarize,
    targets,
)


def hit(episode: int | None, at_s: int = 0, *, more: int = 0) -> dict:
    return {"episode": {"number": episode}, "hit_ms": at_s * 1000, "more_in_episode": more}


def answer(*results: dict) -> dict:
    return {"results": list(results)}


def case(**kw) -> Case:
    base = {"id": "c", "query": "q", "tag": "exact", "mode": "exact"}
    return Case(**{**base, **kw})


def test_found_first_is_a_perfect_score():
    s = score_case(case(expect=(Item(71, 100),)), {"exact": answer(hit(71, 120), hit(5))})
    assert (s.recall, s.rr, s.ndcg) == (1.0, 1.0, 1.0)
    assert (s.time_hits, s.time_items) == (1, 1)
    assert s.found_in == {"exact": [71]} and s.failures == []


def test_rank_three_and_a_cue_too_far_away():
    s = score_case(case(expect=(Item(71, 100),)),
                   {"exact": answer(hit(1), hit(2), hit(71, 146))})  # 46 s away
    assert s.recall == 1.0 and s.rr == pytest.approx(1 / 3)
    assert s.ndcg == pytest.approx(1 / math.log2(4))
    assert (s.time_hits, s.time_items) == (0, 1)
    assert s.failures == ["ep 71 at 1:40: cue not within 45 s"]


def test_beyond_the_top_ten_is_missed():
    results = [hit(n) for n in range(1, 11)] + [hit(71)]
    s = score_case(case(expect=(Item(71),)), {"exact": answer(*results)})
    assert (s.recall, s.rr, s.ndcg) == (0.0, 0.0, 0.0)
    assert s.failures == ["ep 71 not in the top 10"]


def test_an_episode_twice_counts_once_unless_two_items_want_it():
    one = score_case(case(expect=(Item(71),)), {"exact": answer(hit(71, 10), hit(71, 900))})
    assert one.ndcg == 1.0
    two = score_case(case(expect=(Item(71, 10), Item(71, 900))),
                     {"exact": answer(hit(71, 10), hit(71, 900))})
    assert two.ndcg == 1.0 and (two.time_hits, two.time_items) == (2, 2)


def test_a_result_without_a_number_never_matches():
    s = score_case(case(expect=(Item(71),)), {"exact": answer(hit(None), hit(71))})
    assert s.rr == 0.5


def test_both_takes_the_better_tab_and_says_which_found_it():
    c = case(mode="both", expect=(Item(71), Item(80)))
    s = score_case(c, {"exact": answer(hit(1), hit(2), hit(71)),
                       "related": answer(hit(80), hit(71))})
    assert s.recall == 1.0
    assert s.rr == 1.0  # ep 80 is first in related
    assert s.found_in == {"exact": [71], "related": [80, 71]}


def test_expect_absent_with_and_without_a_time():
    c = case(tag="negative", mode="related",
             expect_absent=(Item(127, 2668), Item(171)))
    ok = score_case(c, {"related": answer(hit(127, 100), hit(5))})  # 127 elsewhere: fine
    assert ok.absent_ok is True and ok.recall is None
    bad = score_case(c, {"related": answer(hit(5), hit(171, 30))})
    assert bad.absent_ok is False
    assert bad.failures == ["ep 171 should not be in the top 10 (#2 in related)"]


def test_collapse_checks_cards_and_more_in_episode_on_the_whole_page():
    c = case(tag="collapse", expect=(Item(604, 867, more_in_episode=2, cards=2),))
    ok = score_case(c, {"exact": answer(hit(604, 870, more=2), hit(604, 2928))})
    assert ok.collapse_ok is True
    bad = score_case(c, {"exact": answer(hit(604, 870, more=1))})
    assert bad.collapse_ok is False
    assert bad.failures == ["ep 604: 1 card, expected 2",
                            "ep 604 at 14:27: more_in_episode 1, expected 2"]


def test_summarize_overall_and_per_tag_leaves_out_what_has_no_data():
    a = score_case(case(id="a", tag="exact", expect=(Item(1, 0),)), {"exact": answer(hit(1))})
    b = score_case(case(id="b", tag="paraphrase", expect=(Item(2),)), {"exact": answer(hit(9))})
    n = score_case(case(id="n", tag="negative", expect_absent=(Item(3),)), {"exact": answer()})
    summary = summarize([a, b, n])
    assert summary["overall"] == {
        "cases": 3, "recall@10": 0.5, "mrr": 0.5, "ndcg@10": 0.5, "time_hit_rate": 1.0,
        "negative_pass_rate": 1.0,
    }
    assert summary["tags"]["paraphrase"] == {"cases": 1, "recall@10": 0.0, "mrr": 0.0,
                                             "ndcg@10": 0.0}
    assert summary["tags"]["negative"] == {"cases": 1, "negative_pass_rate": 1.0}


def test_targets_report_met_and_missing():
    summary = {"overall": {"recall@10": 0.9}, "tags": {"paraphrase": {"recall@10": 0.5}}}
    rows = {(t["scope"], t["metric"]): t for t in targets(summary)}
    assert rows[("overall", "recall@10")]["met"] is True
    assert rows[("paraphrase", "recall@10")]["met"] is False
    assert rows[("exact", "time_hit_rate")]["value"] is None
    assert rows[("exact", "time_hit_rate")]["met"] is None


def test_regressions_beyond_the_tolerance_only():
    baseline = {"overall": {"mrr": 0.80, "recall@10": 0.90},
                "tags": {"paraphrase": {"recall@10": 0.75}, "gone": {"mrr": 1.0}}}
    now = {"overall": {"mrr": 0.78, "recall@10": 0.87, "cases": 9},
           "tags": {"paraphrase": {"recall@10": 0.70}}}
    assert regressions(now, baseline) == [
        "overall recall@10 0.870 < baseline 0.900",
        "paraphrase recall@10 0.700 < baseline 0.750",
    ]


def test_newly_missed_lists_cases_that_got_worse():
    now = [score_case(case(id="a", expect=(Item(1),)), {"exact": answer()}),
           score_case(case(id="n", tag="negative", expect_absent=(Item(3),)),
                      {"exact": answer(hit(3))})]
    baseline = [{"id": "a", "recall": 1.0, "absent_ok": None},
                {"id": "n", "recall": None, "absent_ok": True},
                {"id": "gone", "recall": 1.0, "absent_ok": None}]
    assert newly_missed(now, baseline) == ["a", "n"]
