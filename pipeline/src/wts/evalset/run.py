"""Running the test search set against a deployed environment (spec §7.2), through the same
client as `wts search`. Requests are paced to the Worker's per-IP limit (60 a minute), so a full
run of ~300 requests takes about five minutes."""

import json
import logging
import time
from collections import Counter
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

import click
import httpx

from wts.config import Config
from wts.evalset.cases import Case, CaseError, load_cases
from wts.evalset.score import CaseScore, clock, score_case, summarize, targets
from wts.notify import Notifier
from wts.search import SearchError, search

log = logging.getLogger("wts")

PACE_S = 1.0
METRICS = ("recall@10", "mrr", "ndcg@10", "time_hit_rate", "negative_pass_rate",
           "collapse_pass_rate")
_SHORT = {"recall@10": "recall", "mrr": "mrr", "ndcg@10": "ndcg", "time_hit_rate": "time",
          "negative_pass_rate": "negative", "collapse_pass_rate": "collapse"}


class EvalError(Exception):
    """A run that can't give meaningful scores. Names the case id, never the query."""


def ask(client: httpx.Client, api_url: str, case: Case, *,
        sleep: Callable[[float], None] = time.sleep,
        params: dict[str, str] | None = None) -> dict[str, dict]:
    """The case's answer in each of its modes. Related asks with `debug=1`: the report keeps
    each hit's meaning rank and similarity, and the edge cache is skipped. `params` (debug
    overrides) go with the related request only: the others ignore them."""
    answers = {}
    for mode in case.modes:
        try:
            answer = search(client, api_url, case.query, mode=mode, sort=case.sort,
                            debug=mode == "related", sleep=sleep,
                            extra=params if mode == "related" else None)
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
              params: dict[str, str] | None = None,
              ) -> list[tuple[Case, dict[str, dict], CaseScore]]:
    scored = []
    for case in cases:
        if progress:
            progress(case)
        answers = ask(client, api_url, case, sleep=sleep, params=params)
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
                 now: datetime, params: dict[str, str] | None = None) -> dict:
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
            "params": params or {}, "summary": summary, "targets": targets(summary), "cases": cases}


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
    lines = [f"{report['env']}: {n} case{'' if n == 1 else 's'}"]
    if report.get("params"):  # an experiment, not the deployed settings
        lines.append("params: " + " ".join(f"{k}={v}" for k, v in report["params"].items()))
    lines.append("")
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


def smoke(cfg: Config, env: str, client: httpx.Client, notifier: Notifier, *,
          directory: Path | None = None,
          sleep: Callable[[float], None] = time.sleep) -> Counter:
    """The `smoke: true` cases after a run that publishes (spec §8.1): each must find its
    expected episodes in the top 10. A failure is logged and notified; the run goes on."""
    counts: Counter = Counter()
    extra = {"step": "smoke"}
    try:
        api_url = cfg.api_url(env)
    except click.UsageError as exc:
        log.warning(f"no smoke search: {exc.message}", extra=extra)
        counts["skipped"] += 1
        return counts
    try:
        cases = [c for c in load_cases(directory) if c.smoke]
    except CaseError as exc:
        log.error(f"no smoke search: {exc}", extra=extra)
        counts["error"] += 1
        return counts
    if not cases:
        log.warning("no smoke search: no case is marked smoke: true", extra=extra)
        counts["skipped"] += 1
        return counts
    failures = []
    for case in cases:
        try:
            score = score_case(case, ask(client, api_url, case, sleep=sleep))
        except EvalError as exc:
            failures.append(str(exc).removeprefix("case "))
            continue
        if score.recall == 1.0:
            counts["ok"] += 1
        else:
            missed = [f for f in score.failures if "not in the top" in f]
            failures.append(f"{case.id}: {'; '.join(missed)}")
    counts["failed"] = len(failures)
    if failures:
        log.error(f"smoke search failed: {len(failures)} of {len(cases)}", extra=extra)
        notifier.send("wts: smoke search failed", "\n".join(f"- {f}" for f in failures),
                      priority="high", tags=("warning",))
    return counts
