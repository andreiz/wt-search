"""Running the test search set against a deployed environment (spec §7.2), through the same
client as `wts search`. Requests are paced to the Worker's per-IP limit (60 a minute), so a full
run of ~300 requests takes about five minutes."""

import json
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

import httpx

from wts.evalset.cases import Case
from wts.evalset.score import CaseScore, clock, score_case, summarize, targets
from wts.search import SearchError, search

PACE_S = 1.0
METRICS = ("recall@10", "mrr", "ndcg@10", "time_hit_rate", "negative_pass_rate",
           "collapse_pass_rate")
_SHORT = {"recall@10": "recall", "mrr": "mrr", "ndcg@10": "ndcg", "time_hit_rate": "time",
          "negative_pass_rate": "negative", "collapse_pass_rate": "collapse"}


class EvalError(Exception):
    """A run that can't give meaningful scores. Names the case id, never the query."""


def ask(client: httpx.Client, api_url: str, case: Case, *,
        sleep: Callable[[float], None] = time.sleep) -> dict[str, dict]:
    """The case's answer in each of its modes. Related asks with `debug=1`: the report keeps
    each hit's meaning rank and similarity, and the edge cache is skipped."""
    answers = {}
    for mode in case.modes:
        try:
            answer = search(client, api_url, case.query, mode=mode, sort=case.sort,
                            debug=mode == "related", sleep=sleep)
        except SearchError as exc:  # never holds the query
            raise EvalError(f"case {case.id}: {exc}") from exc
        if reason := answer.get("smart_degraded"):
            raise EvalError(f"case {case.id}: related search degraded ({reason}); "
                            "scores would be meaningless")
        answers[mode] = answer
        sleep(PACE_S)
    return answers


def run_cases(client: httpx.Client, api_url: str, cases: list[Case], *,
              sleep: Callable[[float], None] = time.sleep,
              progress: Callable[[Case], None] | None = None,
              ) -> list[tuple[Case, dict[str, dict], CaseScore]]:
    scored = []
    for case in cases:
        if progress:
            progress(case)
        answers = ask(client, api_url, case, sleep=sleep)
        scored.append((case, answers, score_case(case, answers)))
    return scored


def _top_entry(result: dict) -> dict:
    entry = {"episode": (result.get("episode") or {}).get("number"),
             "at": clock(int(result.get("hit_ms", 0)) // 1000),
             "match": result.get("match")}
    debug = result.get("debug")
    if isinstance(debug, dict) and debug.get("vector_rank") is not None:
        entry["meaning_rank"] = debug["vector_rank"]
        entry["similarity"] = debug.get("vector_score")
    return entry


def build_report(env: str, api_url: str,
                 scored: list[tuple[Case, dict[str, dict], CaseScore]], *,
                 now: datetime) -> dict:
    scores = [s for _, _, s in scored]
    summary = summarize(scores)
    cases = []
    for case, answers, score in scored:
        entry = {"id": case.id, "tag": case.tag, "mode": case.mode, "query": case.query,
                 **{k: v for k, v in score.as_dict().items() if k not in ("id", "tag")}}
        entry["top"] = {mode: [_top_entry(r) for r in (a.get("results") or [])[:10]]
                        for mode, a in answers.items()}
        cases.append(entry)
    return {"env": env, "api_url": api_url, "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "summary": summary, "targets": targets(summary), "cases": cases}


def write_report(report: dict, directory: Path, *, update: bool) -> Path:
    stamp = report["at"].replace("-", "").replace(":", "")
    path = directory / "reports" / f"{stamp}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    path.write_text(text)
    if update:
        (directory / "baseline.json").write_text(text)
    return path


def load_baseline(directory: Path) -> dict | None:
    path = directory / "baseline.json"
    return json.loads(path.read_text()) if path.exists() else None


def format_report(report: dict, *, regressed: list[str], missed: list[str],
                  baseline: bool) -> str:
    """The console summary: a table overall and per tag, the targets, what failed."""
    summary = report["summary"]
    n = summary["overall"].get("cases", 0)
    lines = [f"{report['env']}: {n} case{'' if n == 1 else 's'}", ""]
    lines.append(f"{'':<12}{'cases':>6}" + "".join(f"{_SHORT[m]:>10}" for m in METRICS))
    rows = [("overall", summary["overall"]), *summary["tags"].items()]
    for name, metrics in rows:
        cells = "".join(f"{metrics[m]:>10.3f}" if m in metrics else f"{'-':>10}"
                        for m in METRICS)
        lines.append(f"{name:<12}{metrics.get('cases', 0):>6}{cells}")
    lines.append("")
    for t in report["targets"]:
        if t["value"] is None:
            state = "no cases"
        else:
            state = f"{t['value']:.3f} {'met' if t['met'] else 'NOT met'}"
        lines.append(f"target {t['scope']} {t['metric']} >= {t['target']}: {state}")
    failing = [c for c in report["cases"] if c["failures"]]
    if failing:
        lines += ["", "Failures:"]
        lines += [f"  {c['id']}: {'; '.join(c['failures'])}" for c in failing]
    if not baseline:
        lines += ["", "There's no baseline yet: `wts eval run --update` records this one."]
    if regressed:
        lines += ["", "Below the baseline:", *(f"  {r}" for r in regressed)]
    if missed:
        lines += ["Worse than in the baseline: " + ", ".join(missed)]
    return "\n".join(lines)
