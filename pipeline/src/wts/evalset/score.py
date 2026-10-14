"""Scores for the test search set (spec §7.2): an API answer in, numbers out. No I/O, so every
rule here is tested without the Worker."""

import math
from collections import defaultdict
from dataclasses import asdict, dataclass, field

from wts.evalset.cases import Case, Item

TOP = 10
TOLERANCE_S = 45
REGRESSION = 0.02
# Success criteria (spec §1): reported, never the exit code.
TARGETS = (
    ("overall", "recall@10", 0.85),
    ("paraphrase", "recall@10", 0.75),
    ("exact", "time_hit_rate", 0.80),
    ("jargon", "time_hit_rate", 0.80),
)


@dataclass
class CaseScore:
    id: str
    tag: str
    recall: float | None = None
    rr: float | None = None
    ndcg: float | None = None
    time_hits: int = 0
    time_items: int = 0
    absent_ok: bool | None = None
    collapse_ok: bool | None = None
    found_in: dict[str, list[int]] = field(default_factory=dict)
    failures: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def clock(seconds: int) -> str:
    """`m:ss`, or `h:mm:ss` from one hour (as `wts search` prints times)."""
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02}:{secs:02}" if hours else f"{minutes}:{secs:02}"


def _number(result: dict) -> int | None:
    episode = result.get("episode")
    return episode.get("number") if isinstance(episode, dict) else None


def _near(result: dict, item: Item) -> bool:
    if item.at_s is None:
        return True
    return abs(result.get("hit_ms", 0) / 1000 - item.at_s) <= TOLERANCE_S


def _matches(result: dict, item: Item) -> bool:
    """Same episode and, if the item has a time, a cue within the tolerance."""
    return _number(result) == item.episode and _near(result, item)


def _label(item: Item) -> str:
    return f"ep {item.episode}" + (f" at {clock(item.at_s)}" if item.at_s is not None else "")


def score_case(case: Case, answers: dict[str, dict]) -> CaseScore:
    score = CaseScore(case.id, case.tag)
    tops = {mode: (answers[mode].get("results") or [])[:TOP] for mode in case.modes}
    if case.expect:
        _score_expect(case, tops, score)
    if case.expect_absent:
        _score_absent(case, tops, score)
    if any(i.more_in_episode is not None or i.cards is not None for i in case.expect):
        page = answers[case.modes[0]].get("results") or []
        _score_collapse(case, page, score)
    return score


def _score_expect(case: Case, tops: dict[str, list[dict]], score: CaseScore) -> None:
    best: dict[int, int] = {}  # item index -> best rank over the tabs
    ndcgs = []
    for mode, top in tops.items():
        found = []
        credited: set[int] = set()
        dcg = 0.0
        for rank, result in enumerate(top, 1):
            number = _number(result)
            for i, item in enumerate(case.expect):
                if item.episode == number and rank < best.get(i, TOP + 1):
                    best[i] = rank
            # One gain per item: a second card of the episode can take a second item.
            free = [i for i, item in enumerate(case.expect)
                    if item.episode == number and i not in credited]
            if free:
                credited.add(free[0])
                dcg += 1 / math.log2(rank + 1)
                if number not in found:
                    found.append(number)
        ideal = sum(1 / math.log2(k + 1) for k in range(1, min(len(case.expect), TOP) + 1))
        ndcgs.append(dcg / ideal)
        score.found_in[mode] = found
    score.recall = len(best) / len(case.expect)
    score.rr = 1 / min(best.values()) if best else 0.0
    score.ndcg = max(ndcgs)
    for i, item in enumerate(case.expect):
        if i not in best:
            score.failures.append(f"ep {item.episode} not in the top {TOP}")
            continue
        if item.at_s is None:
            continue
        score.time_items += 1
        if any(_matches(r, item) for top in tops.values() for r in top):
            score.time_hits += 1
        else:
            score.failures.append(f"{_label(item)}: cue not within {TOLERANCE_S} s")


def _score_absent(case: Case, tops: dict[str, list[dict]], score: CaseScore) -> None:
    score.absent_ok = True
    for item in case.expect_absent:
        for mode, top in tops.items():
            rank = next((n for n, r in enumerate(top, 1) if _matches(r, item)), None)
            if rank is not None:
                score.absent_ok = False
                score.failures.append(
                    f"{_label(item)} should not be in the top {TOP} (#{rank} in {mode})")


def _score_collapse(case: Case, page: list[dict], score: CaseScore) -> None:
    score.collapse_ok = True
    for item in case.expect:
        if item.cards is not None:
            cards = sum(1 for r in page if _number(r) == item.episode)
            if cards != item.cards:
                score.collapse_ok = False
                word = "card" if cards == 1 else "cards"
                score.failures.append(
                    f"ep {item.episode}: {cards} {word}, expected {item.cards}")
        if item.more_in_episode is not None:
            result = next((r for r in page if _matches(r, item)), None)
            more = result.get("more_in_episode", 0) if result else None
            if more != item.more_in_episode:
                score.collapse_ok = False
                score.failures.append(
                    f"{_label(item)}: more_in_episode {more}, expected {item.more_in_episode}")


def _mean(values: list) -> float | None:
    return round(sum(values) / len(values), 4) if values else None


def _metrics(scores: list[CaseScore]) -> dict:
    with_expect = [s for s in scores if s.recall is not None]
    time_items = sum(s.time_items for s in scores)
    values = {
        "cases": len(scores),
        "recall@10": _mean([s.recall for s in with_expect]),
        "mrr": _mean([s.rr for s in with_expect]),
        "ndcg@10": _mean([s.ndcg for s in with_expect]),
        "time_hit_rate": (round(sum(s.time_hits for s in scores) / time_items, 4)
                          if time_items else None),
        "negative_pass_rate": _mean([s.absent_ok for s in scores if s.absent_ok is not None]),
        "collapse_pass_rate": _mean([s.collapse_ok for s in scores
                                     if s.collapse_ok is not None]),
    }
    return {k: v for k, v in values.items() if v is not None}


def summarize(scores: list[CaseScore]) -> dict:
    by_tag: dict[str, list[CaseScore]] = defaultdict(list)
    for s in scores:
        by_tag[s.tag].append(s)
    return {"overall": _metrics(scores),
            "tags": {tag: _metrics(group) for tag, group in sorted(by_tag.items())}}


def _scope(summary: dict, name: str) -> dict:
    if name == "overall":
        return summary.get("overall", {})
    return summary.get("tags", {}).get(name, {})


def targets(summary: dict) -> list[dict]:
    rows = []
    for scope, metric, target in TARGETS:
        value = _scope(summary, scope).get(metric)
        rows.append({"scope": scope, "metric": metric, "target": target, "value": value,
                     "met": None if value is None else value >= target})
    return rows


def regressions(summary: dict, baseline: dict) -> list[str]:
    """Every score more than REGRESSION below the baseline's, overall then per tag. A tag or
    metric missing on either side is not compared."""
    out = []
    names = ["overall", *sorted(summary.get("tags", {}))]
    for name in names:
        now, before = _scope(summary, name), _scope(baseline, name)
        for metric, value in now.items():
            if metric == "cases" or metric not in before:
                continue
            if before[metric] - value > REGRESSION + 1e-9:
                out.append(f"{name} {metric} {value:.3f} < baseline {before[metric]:.3f}")
    return out


def newly_missed(scores: list[CaseScore], baseline_cases: list[dict]) -> list[str]:
    """Ids of cases whose recall dropped or whose `expect_absent` started failing."""
    before = {c["id"]: c for c in baseline_cases}
    out = []
    for s in scores:
        old = before.get(s.id)
        if old is None:
            continue
        recall_dropped = (s.recall is not None and old.get("recall") is not None
                          and s.recall < old["recall"])
        absent_broke = s.absent_ok is False and old.get("absent_ok") is True
        if recall_dropped or absent_broke:
            out.append(s.id)
    return out
