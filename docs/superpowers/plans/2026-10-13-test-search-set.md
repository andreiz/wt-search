# Test Search Set Implementation Plan (plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A file of searches with known right answers, a `wts eval run` command that scores a deployed environment against it, a smoke search after `wts run`, and `wts eval generate` for ~100 synthetic cases.

**Architecture:** A new package `pipeline/src/wts/evalset/` with four modules: `cases.py` loads and checks `eval/*.yaml`; `score.py` is pure (an API answer in, scores out); `run.py` asks the API through the existing `wts.search.search()`, paced to the Worker's per-IP limit, and writes reports; `generate.py` samples chunks from `state.db` and asks a local Ollama model for a query. `wts run` calls `run.smoke()` after publish. Nothing changes in the Worker or the page.

**Tech Stack:** Python 3.12, click, httpx, PyYAML, pytest + respx (all already in `pipeline/`). Ollama on the Mac for `generate` only.

**Spec:** `docs/superpowers/specs/2026-10-04-wood-talk-search-design.md` §7.2 (revised 2026-10-13), §8.1 "Smoke search", §8.2, §1 "Success criteria", §4.8 (rate limit, budget).

## Global Constraints

- Files are changed with Edit/Write only (no `sed -i`, no inline Python rewrites). One commit per task, straight to `main`. No push without the maintainer's word.
- `cd pipeline && uv run pytest -q` and `uv run ruff check .` pass after every task.
- The query string never appears in an error message or log line (`wts.search` already keeps it out of `SearchError`; don't add it back). Case **ids** may appear.
- At most one API request per second (`PACE_S = 1.0`): staging's `RL_READ` allows 60 a minute per IP.
- Matching tolerance is ±45 s (`TOLERANCE_S = 45`); "top 10" is the first 10 results of page 1 (`TOP = 10`).
- Regression tolerance is 0.02 (`REGRESSION = 0.02`).
- Success-criteria targets (spec §1), reported but never changing the exit code: Recall@10 ≥ 0.85 overall, ≥ 0.75 `paraphrase`; time hit rate ≥ 0.80 for `exact` and `jargon`.
- The repo's `eval/` is found as `Path(__file__).resolve().parents[4] / "eval"` from `pipeline/src/wts/evalset/*.py`; the env var `WTS_EVAL_DIR` overrides it (tests use it, as `WTS_CORRECTIONS_FILE` is used for the review tool).
- Comment style: short docstrings that say why, as in `wts/search.py`.

## Review Focus

1. **A time written unquoted in YAML.** PyYAML reads `at: 40:54` as the base-60 integer 2454, which is the right number of seconds; `at: "40:54"` is a string for `parse_time`. Both must load to `at_s == 2454`; `at: 1:02:03` likewise to 3723. (Task 1 test.)
2. **The same episode twice in the top 10** (two cards more than 120 s apart). It counts once for recall and once for nDCG gain; a second expected item for the same episode at another time can take the second card. (Task 2 test.)
3. **Related degraded mid-run** (budget used up, kill switch). The run stops with an error naming the case id and the reason, writes no report and no baseline. (Task 3 test.)
4. **A result whose `episode.number` is null** (a bonus episode without a number) must never match an item and must not crash scoring. (Task 2 test.)
5. **`--only` with `--update`** would make a partial baseline; refused. `--only` matching nothing is an error, not an empty report. (Task 3 tests.)

---

### Task 1: Case files and loader

**Files:**
- Create: `pipeline/src/wts/evalset/__init__.py`, `pipeline/src/wts/evalset/cases.py`
- Create: `eval/queries.yaml`, `eval/README.md`
- Modify: `.gitignore` (add `eval/reports/`)
- Test: `pipeline/tests/test_eval_cases.py`

**Interfaces:**
- Produces: `Item(episode: int, at_s: int | None = None, more_in_episode: int | None = None, cards: int | None = None)`; `Case(id, query, tag, mode="both", sort="relevance", expect: tuple[Item, ...] = (), expect_absent: tuple[Item, ...] = (), smoke=False, source="")` with property `modes -> tuple[str, ...]`; `CaseError(ValueError)`; `eval_dir() -> Path`; `load_cases(directory: Path | None = None) -> list[Case]`; constants `TAGS`, `MODES`, `SORTS`, `CASE_FILES`.

- [ ] **Step 1: Write the failing tests**

`pipeline/tests/test_eval_cases.py`:

```python
"""The test search set's case files (spec §7.2, plan 5 Task 1)."""

import pytest

from wts.evalset.cases import Case, CaseError, Item, eval_dir, load_cases


def write(tmp_path, text: str, name: str = "queries.yaml"):
    (tmp_path / name).write_text(text)
    return tmp_path


def test_a_full_case_loads(tmp_path):
    cases = load_cases(write(tmp_path, """
- id: aspirational-builds
  query: aspirational builds
  tag: paraphrase
  mode: related
  sort: newest
  expect:
    - {episode: 71, at: "40:54"}
  expect_absent:
    - {episode: 127}
  smoke: true
"""))
    assert cases == [Case(
        id="aspirational-builds", query="aspirational builds", tag="paraphrase", mode="related",
        sort="newest", expect=(Item(71, 2454),), expect_absent=(Item(127),), smoke=True,
        source="queries.yaml",
    )]


def test_defaults_are_both_modes_and_relevance(tmp_path):
    [case] = load_cases(write(tmp_path, "- {id: a, query: glue, tag: exact, expect: [{episode: 1}]}"))
    assert (case.mode, case.sort, case.smoke) == ("both", "relevance", False)
    assert case.modes == ("exact", "related")


def test_an_unquoted_time_is_read_as_seconds(tmp_path):
    # PyYAML reads 40:54 as base 60 (2454) and 1:02:03 as 3723: the same seconds.
    [case] = load_cases(write(tmp_path, """
- id: a
  query: glue
  tag: exact
  expect: [{episode: 1, at: 40:54}, {episode: 2, at: 1:02:03}, {episode: 3, at: 95}]
"""))
    assert [i.at_s for i in case.expect] == [2454, 3723, 95]


def test_both_files_load_in_order(tmp_path):
    write(tmp_path, "- {id: a, query: glue, tag: exact, expect: [{episode: 1}]}")
    write(tmp_path, "- {id: syn-1, query: clamps, tag: paraphrase, expect: [{episode: 2}]}",
          "synthetic.yaml")
    assert [(c.id, c.source) for c in load_cases(tmp_path)] == [
        ("a", "queries.yaml"), ("syn-1", "synthetic.yaml")]


def test_a_missing_file_is_no_cases(tmp_path):
    assert load_cases(tmp_path) == []


@pytest.mark.parametrize(("text", "message"), [
    ("{id: a}", "expected a list"),
    ("- just a string", "expected a mapping"),
    ("- {query: glue, tag: exact, expect: [{episode: 1}]}", "needs an id"),
    ("- {id: a, tag: exact, expect: [{episode: 1}]}", "needs a query"),
    ("- {id: a, query: glue, tag: vibes, expect: [{episode: 1}]}", "tag must be one of"),
    ("- {id: a, query: glue, tag: exact, mode: smart, expect: [{episode: 1}]}", "mode must be"),
    ("- {id: a, query: glue, tag: exact, sort: best, expect: [{episode: 1}]}", "sort must be"),
    ("- {id: a, query: glue, tag: exact}", "needs expect or expect_absent"),
    ("- {id: a, query: glue, tag: exact, expect: [{at: 3}]}", "episode must be"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: 0}]}", "episode must be"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: true}]}", "episode must be"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: 1, at: soon}]}", "not a time"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: 1, when: 3}]}", "unknown keys: when"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: 1}], extra: 1}", "unknown keys: extra"),
    ("- {id: a, query: glue, tag: exact, expect_absent: [{episode: 1}], smoke: true}",
     "a smoke case needs expect"),
    ("- {id: a, query: glue, tag: collapse, expect: [{episode: 1, cards: 2}]}",
     "need mode exact or related"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: 1}]}\n"
     "- {id: a, query: clamps, tag: exact, expect: [{episode: 2}]}", "id 'a' is used twice"),
    ("- [unclosed", "not valid YAML"),
])
def test_bad_cases_are_refused_with_a_reason(tmp_path, text, message):
    with pytest.raises(CaseError, match=message):
        load_cases(write(tmp_path, text))


def test_an_id_in_both_files_is_refused(tmp_path):
    write(tmp_path, "- {id: a, query: glue, tag: exact, expect: [{episode: 1}]}")
    write(tmp_path, "- {id: a, query: glue, tag: exact, expect: [{episode: 1}]}", "synthetic.yaml")
    with pytest.raises(CaseError, match="id 'a' is used twice"):
        load_cases(tmp_path)


def test_the_eval_dir_is_the_repos_unless_overridden(tmp_path, monkeypatch):
    monkeypatch.delenv("WTS_EVAL_DIR", raising=False)
    assert eval_dir().name == "eval" and (eval_dir().parent / "pipeline").is_dir()
    monkeypatch.setenv("WTS_EVAL_DIR", str(tmp_path))
    assert eval_dir() == tmp_path


def test_the_committed_cases_load():
    cases = load_cases(eval_dir())
    assert sum(c.smoke for c in cases) == 5
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd pipeline && uv run pytest tests/test_eval_cases.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'wts.evalset'`.

- [ ] **Step 3: Write the loader**

`pipeline/src/wts/evalset/__init__.py`:

```python
"""The test search set (spec §7.2): cases, scoring, runs against the API, synthetic cases."""
```

`pipeline/src/wts/evalset/cases.py`:

```python
"""The test search set's cases: `eval/queries.yaml` (by hand) and `eval/synthetic.yaml`
(`wts eval generate`), spec §7.2. Loading checks every case, so a typo fails before any request
is sent rather than scoring as a miss."""

import os
from dataclasses import dataclass
from pathlib import Path

import yaml

from wts.links import parse_time

CASE_FILES = ("queries.yaml", "synthetic.yaml")
TAGS = ("exact", "jargon", "paraphrase", "filter", "negative", "collapse")
MODES = ("exact", "related", "both")
SORTS = ("relevance", "newest", "oldest")
_CASE_KEYS = {"id", "query", "tag", "mode", "sort", "expect", "expect_absent", "smoke"}
_ITEM_KEYS = {"episode", "at", "more_in_episode", "cards"}


class CaseError(ValueError):
    """A case file that can't be used; the message names the file and the case."""


@dataclass(frozen=True)
class Item:
    """An episode, and optionally a time in it, that should (or shouldn't) come back."""

    episode: int
    at_s: int | None = None
    more_in_episode: int | None = None  # collapse cases: the matching result's field
    cards: int | None = None  # collapse cases: results for this episode on page 1


@dataclass(frozen=True)
class Case:
    id: str
    query: str
    tag: str
    mode: str = "both"
    sort: str = "relevance"
    expect: tuple[Item, ...] = ()
    expect_absent: tuple[Item, ...] = ()
    smoke: bool = False
    source: str = ""  # the file it came from

    @property
    def modes(self) -> tuple[str, ...]:
        """The API modes to ask: `both` is how the site is used, Exact then Related."""
        return ("exact", "related") if self.mode == "both" else (self.mode,)


def eval_dir() -> Path:
    """The repo's `eval/`, or `WTS_EVAL_DIR` (tests)."""
    override = os.environ.get("WTS_EVAL_DIR")
    return Path(override) if override else Path(__file__).resolve().parents[4] / "eval"


def load_cases(directory: Path | None = None) -> list[Case]:
    directory = directory or eval_dir()
    cases: list[Case] = []
    seen: dict[str, str] = {}
    for name in CASE_FILES:
        path = directory / name
        if not path.exists():
            continue
        try:
            data = yaml.safe_load(path.read_text()) or []
        except yaml.YAMLError as exc:
            raise CaseError(f"{name}: not valid YAML: {exc}") from exc
        if not isinstance(data, list):
            raise CaseError(f"{name}: expected a list of cases")
        for i, raw in enumerate(data, 1):
            case = _case(raw, name, i)
            if case.id in seen:
                raise CaseError(f"{name}: id {case.id!r} is used twice (also in {seen[case.id]})")
            seen[case.id] = name
            cases.append(case)
    return cases


def _case(raw: object, source: str, position: int) -> Case:
    where = f"{source} case {position}"
    if not isinstance(raw, dict):
        raise CaseError(f"{where}: expected a mapping")
    unknown = set(raw) - _CASE_KEYS
    if unknown:
        raise CaseError(f"{where}: unknown keys: {', '.join(sorted(unknown))}")
    case_id = raw.get("id")
    if not isinstance(case_id, str) or not case_id.strip():
        raise CaseError(f"{where}: needs an id")
    where = f"{source} {case_id!r}"
    query = raw.get("query")
    if not isinstance(query, str) or not query.strip():
        raise CaseError(f"{where}: needs a query")
    tag = raw.get("tag")
    if tag not in TAGS:
        raise CaseError(f"{where}: tag must be one of {', '.join(TAGS)}")
    mode = raw.get("mode", "both")
    if mode not in MODES:
        raise CaseError(f"{where}: mode must be one of {', '.join(MODES)}")
    sort = raw.get("sort", "relevance")
    if sort not in SORTS:
        raise CaseError(f"{where}: sort must be one of {', '.join(SORTS)}")
    expect = _items(raw.get("expect"), where, "expect")
    absent = _items(raw.get("expect_absent"), where, "expect_absent")
    if not expect and not absent:
        raise CaseError(f"{where}: needs expect or expect_absent")
    smoke = raw.get("smoke", False)
    if not isinstance(smoke, bool):
        raise CaseError(f"{where}: smoke must be true or false")
    if smoke and not expect:
        raise CaseError(f"{where}: a smoke case needs expect")
    collapse = any(i.more_in_episode is not None or i.cards is not None for i in expect)
    if collapse and mode == "both":
        # Folding is checked on one list; with two tabs it's unclear which.
        raise CaseError(f"{where}: more_in_episode and cards need mode exact or related")
    return Case(case_id, query, tag, mode, sort, expect, absent, smoke, source)


def _items(raw: object, where: str, key: str) -> tuple[Item, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise CaseError(f"{where}: {key} must be a list")
    items = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise CaseError(f"{where}: each {key} entry must be a mapping")
        unknown = set(entry) - _ITEM_KEYS
        if unknown:
            raise CaseError(f"{where}: {key}: unknown keys: {', '.join(sorted(unknown))}")
        episode = entry.get("episode")
        if not _count(episode, minimum=1):
            raise CaseError(f"{where}: {key}: episode must be a number from 1")
        items.append(Item(
            episode,
            _at(entry.get("at"), where, key),
            _optional_count(entry, "more_in_episode", where, key),
            _optional_count(entry, "cards", where, key),
        ))
    return tuple(items)


def _count(value: object, *, minimum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _optional_count(entry: dict, name: str, where: str, key: str) -> int | None:
    value = entry.get(name)
    if value is not None and not _count(value, minimum=0):
        raise CaseError(f"{where}: {key}: {name} must be a whole number")
    return value


def _at(value: object, where: str, key: str) -> int | None:
    """Seconds. An unquoted `40:54` arrives as PyYAML's base-60 int 2454, already seconds."""
    if value is None:
        return None
    if _count(value, minimum=0):
        return value
    try:
        return parse_time(str(value))
    except ValueError as exc:
        raise CaseError(f"{where}: {key}: {exc}") from exc
```

- [ ] **Step 4: Write the committed cases and README**

`eval/queries.yaml` — the five smoke searches (checked on staging 2026-10-13) and the judgements collected in testing (`docs/HANDOFF.md`). The maintainer adds his ~30 here.

```yaml
# The test search set, written by hand (spec §7.2). `wts eval run` scores staging against it;
# the five `smoke: true` cases also run after every `wts run` that publishes (§8.1).
# Times: "m:ss" or "h:mm:ss" (quote them) or seconds. A result matches within ±45 s.

# --- smoke: one distinctive word each, checked on staging 2026-10-13 ---
- id: conoid
  query: Conoid
  tag: jargon
  mode: exact
  expect: [{episode: 71, at: "41:01"}]
  smoke: true
- id: underbevel
  query: underbevel
  tag: jargon
  mode: exact
  expect: [{episode: 602, at: "10:21"}]
  smoke: true
- id: buttress-flare
  query: buttress flare
  tag: exact
  mode: exact
  expect: [{episode: 604, at: "14:27"}]
  smoke: true
- id: moxon
  query: Moxon
  tag: jargon
  mode: exact
  expect: [{episode: 603, at: "51:46"}]
  smoke: true
- id: snodgrass
  query: Snodgrass
  tag: jargon
  mode: exact
  expect: [{episode: 609}]
  smoke: true

# --- judgements from testing (docs/HANDOFF.md) ---
- id: aspirational-builds
  # Shannon's bucket list, 40:30-46:00; the Nakashima Conoid chair at 40:54.
  query: aspirational builds
  tag: paraphrase
  expect: [{episode: 71, at: "40:54"}]
- id: projects-i-dream-of-building
  query: projects I dream of building someday
  tag: paraphrase
  expect: [{episode: 71, at: "45:38"}]
- id: flattening-a-bench-top
  # #127 at 44:28 planes a cupped board ON the bench: not about flattening the top.
  query: flattening a bench top
  tag: negative
  mode: related
  expect_absent: [{episode: 127, at: "44:28"}]
- id: how-do-i-flatten-a-workbench-top
  # #171's listener answer on strengthening miters came back as a related hit.
  query: how do I flatten a workbench top
  tag: negative
  mode: related
  expect_absent: [{episode: 171}]
- id: hvlp-sprayer-2020
  # No 2020 episode talks about HVLP: the honest answer is nothing.
  query: hvlp sprayer year:2020
  tag: filter
  mode: related
  expect_absent: [{episode: 466}]
```

`eval/README.md`:

```markdown
# Test search set

Searches with known right answers, scored against a deployed environment (spec §7.2).

- `queries.yaml`: written by hand. Add a case for every "it should have found X" moment.
- `synthetic.yaml`: written by `wts eval generate` (don't edit by hand; regenerate and review
  the diff).
- `baseline.json`: the scores a run is compared with; `wts eval run --update` replaces it.
- `reports/`: one JSON per run (not committed).

    cd pipeline
    uv run wts eval run                  # staging (run_env); exits 1 on a drop > 0.02
    uv run wts eval run --only paraphrase
    uv run wts eval run --update         # accept the new scores as the baseline
    uv run wts eval generate --model qwen2.5:7b   # needs the Ollama app running
```

`.gitignore` — add after the `.superpowers/` block:

```
# wts eval run reports (eval/baseline.json is committed)
eval/reports/
```

- [ ] **Step 5: Run the tests**

Run: `cd pipeline && uv run pytest tests/test_eval_cases.py -q && uv run ruff check .`
Expected: all pass, ruff clean.

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/wts/evalset pipeline/tests/test_eval_cases.py eval .gitignore
git commit -m "eval: case files and their loader (plan 5, Task 1)"
```

---

### Task 2: Scoring

**Files:**
- Create: `pipeline/src/wts/evalset/score.py`
- Test: `pipeline/tests/test_eval_score.py`

**Interfaces:**
- Consumes: `Case`, `Item` from Task 1.
- Produces: `TOP = 10`, `TOLERANCE_S = 45`, `REGRESSION = 0.02`, `TARGETS`; `clock(seconds: int) -> str` (`m:ss` / `h:mm:ss`); `CaseScore` (dataclass, fields below); `score_case(case: Case, answers: dict[str, dict]) -> CaseScore` where `answers` maps an API mode (`"exact"`, `"related"`) to its parsed `/api/search` response; `summarize(scores: list[CaseScore]) -> dict` (`{"overall": metrics, "tags": {tag: metrics}}`); `targets(summary: dict) -> list[dict]`; `regressions(summary: dict, baseline: dict) -> list[str]`; `newly_missed(scores: list[CaseScore], baseline_cases: list[dict]) -> list[str]`.

`CaseScore` fields: `id: str`, `tag: str`, `recall: float | None`, `rr: float | None`, `ndcg: float | None`, `time_hits: int`, `time_items: int`, `absent_ok: bool | None`, `collapse_ok: bool | None`, `found_in: dict[str, list[int]]` (mode → expected episodes found in that tab's top 10), `failures: list[str]`. Method `as_dict() -> dict` (`dataclasses.asdict`).

Metric keys in `summarize`: `cases`, `recall@10`, `mrr`, `ndcg@10`, `time_hit_rate`, `negative_pass_rate`, `collapse_pass_rate`. A key is left out when no case in that scope has data for it. Values are rounded to 4 places.

- [ ] **Step 1: Write the failing tests**

`pipeline/tests/test_eval_score.py`:

```python
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd pipeline && uv run pytest tests/test_eval_score.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'wts.evalset.score'`.

- [ ] **Step 3: Write `score.py`**

```python
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
    return summary.get("overall", {}) if name == "overall" else summary.get("tags", {}).get(name, {})


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
```

- [ ] **Step 4: Run the tests**

Run: `cd pipeline && uv run pytest tests/test_eval_score.py -q && uv run ruff check .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/wts/evalset/score.py pipeline/tests/test_eval_score.py
git commit -m "eval: scoring, summaries, targets and regressions (plan 5, Task 2)"
```

---

### Task 3: `wts eval run`

**Files:**
- Create: `pipeline/src/wts/evalset/run.py`
- Modify: `pipeline/src/wts/cli.py` (a `wts eval` group with `run`), `pipeline/README.md` (commands table)
- Test: `pipeline/tests/test_eval_run.py`

**Interfaces:**
- Consumes: `Case`, `load_cases`, `eval_dir`, `CaseError` (Task 1); `score_case`, `summarize`, `targets`, `regressions`, `newly_missed`, `CaseScore` (Task 2); `wts.search.search(client, api_url, q, *, mode, sort, page=1, debug=False, sleep)` and `SearchError` (existing).
- Produces: `PACE_S = 1.0`; `EvalError(Exception)`; `ask(client, api_url, case, *, sleep=time.sleep) -> dict[str, dict]`; `run_cases(client, api_url, cases, *, sleep=time.sleep, progress=None) -> list[tuple[Case, dict[str, dict], CaseScore]]`; `build_report(env: str, api_url: str, scored, *, now: datetime) -> dict`; `write_report(report: dict, directory: Path, *, update: bool) -> Path`; `load_baseline(directory: Path) -> dict | None`; `format_report(report: dict, *, regressed: list[str], missed: list[str], baseline: bool) -> str`. Task 4 uses `ask` and `score_case`.

Report shape (`eval/reports/<YYYYmmddTHHMMSSZ>.json`, and `baseline.json`):

```json
{
  "env": "staging", "api_url": "https://…", "at": "2026-10-13T20:01:02Z",
  "summary": {"overall": {...}, "tags": {...}},
  "targets": [{"scope": "overall", "metric": "recall@10", "target": 0.85, "value": 0.88, "met": true}],
  "cases": [
    {"id": "conoid", "tag": "jargon", "mode": "exact", "query": "Conoid",
     "recall": 1.0, "rr": 1.0, "ndcg": 1.0, "time_hits": 1, "time_items": 1,
     "absent_ok": null, "collapse_ok": null, "found_in": {"exact": [71]}, "failures": [],
     "top": {"exact": [{"episode": 71, "at": "41:01", "match": "keyword"}]}}
  ]
}
```

A `top` entry for a related result also has `meaning_rank` and `similarity` when the answer's `debug` has them (`vector_rank`, `vector_score`). The report keeps queries (it is local and gitignored, and the baseline is the maintainer's own file); only error messages must not.

- [ ] **Step 1: Write the failing tests**

`pipeline/tests/test_eval_run.py`:

```python
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd pipeline && uv run pytest tests/test_eval_run.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'wts.evalset.run'`.

- [ ] **Step 3: Write `run.py`**

```python
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
```

- [ ] **Step 4: Add the CLI**

In `pipeline/src/wts/cli.py`, after `search_cmd` (before `@main.command("links")`):

```python
@main.group("eval")
def eval_group() -> None:
    """The test search set (spec §7.2): eval/queries.yaml and eval/synthetic.yaml."""


@eval_group.command("run")
@click.option("--env", "env", type=click.Choice(ENV_NAMES), default=None,
              help="Environment to score [default: run_env in config.toml].")
@click.option("--update", is_flag=True, help="Also make this report eval/baseline.json.")
@click.option("--only", default=None, metavar="TAG-OR-ID",
              help="Only the cases with this tag or id (not compared with the baseline).")
def eval_run_cmd(env: str | None, update: bool, only: str | None) -> None:
    """Send every case to the API and score the answers; exit 1 on a drop below the baseline.

    About one request a second (the Worker's limit is 60 a minute per IP); related requests
    count against the daily meaning budget. The report goes to eval/reports/.
    """
    from datetime import UTC, datetime

    from wts.evalset.cases import CaseError, eval_dir, load_cases
    from wts.evalset.run import (
        EvalError,
        build_report,
        format_report,
        load_baseline,
        run_cases,
        write_report,
    )
    from wts.evalset.score import newly_missed, regressions
    from wts.net import new_client

    if only and update:
        raise click.UsageError("--update records a full run; leave out --only")
    ctx = _ctx()
    name = env or ctx.cfg.run_env
    if not name:
        raise click.UsageError(f"no environment: use --env or run_env in {ctx.paths.config_file}")
    api_url = ctx.cfg.api_url(name)
    directory = eval_dir()
    try:
        cases = load_cases(directory)
    except CaseError as exc:
        raise click.ClickException(str(exc)) from exc
    if only:
        cases = [c for c in cases if only in (c.id, c.tag)]
        if not cases:
            raise click.ClickException(f"no case has the tag or id {only!r}")
    if not cases:
        raise click.ClickException(f"no cases in {directory}")
    try:
        with new_client() as client:
            scored = run_cases(client, api_url, cases,
                               progress=lambda c: click.echo(f"  {c.id}", err=True))
    except EvalError as exc:
        raise click.ClickException(str(exc)) from exc
    report = build_report(name, api_url, scored, now=datetime.now(UTC))
    baseline = None if only else load_baseline(directory)
    regressed = regressions(report["summary"], baseline["summary"]) if baseline else []
    missed = newly_missed([s for _, _, s in scored], baseline["cases"]) if baseline else []
    path = write_report(report, directory, update=update)
    click.echo(format_report(report, regressed=regressed, missed=missed,
                             baseline=baseline is not None or bool(only)))
    click.echo(f"\nReport: {path}" + (" (and eval/baseline.json)" if update else ""))
    if regressed and not update:
        raise SystemExit(1)
```

In `pipeline/README.md`, add rows for `wts eval run` and `wts eval generate` to the commands table, in its existing style (one line each: what it does, where the output goes).

- [ ] **Step 5: Run the tests**

Run: `cd pipeline && uv run pytest tests/test_eval_run.py tests/test_eval_score.py tests/test_eval_cases.py -q && uv run ruff check .`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/wts/evalset/run.py pipeline/src/wts/cli.py pipeline/README.md pipeline/tests/test_eval_run.py
git commit -m "eval: wts eval run, reports and the baseline (plan 5, Task 3)"
```

---

### Task 4: The smoke search after `wts run`

**Files:**
- Modify: `pipeline/src/wts/evalset/run.py` (add `smoke`), `pipeline/src/wts/steps.py` (`run_all`)
- Test: `pipeline/tests/test_eval_smoke.py`; modify `pipeline/tests/test_run.py` (the `calls` fixture and the two tests that list steps)

**Interfaces:**
- Consumes: `ask`, `EvalError` (Task 3); `score_case` (Task 2); `load_cases`, `eval_dir`, `CaseError` (Task 1); `Notifier.send(title, body, *, priority, tags)` (existing).
- Produces: `smoke(cfg: Config, env: str, client: httpx.Client, notifier: Notifier, *, directory: Path | None = None, sleep=time.sleep) -> Counter` with keys `ok`, `failed`, `skipped`, `error`. `run_all` records it as the `smoke` step, after publish and before backup, only when `env` is set.

- [ ] **Step 1: Write the failing tests**

`pipeline/tests/test_eval_smoke.py`:

```python
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
```

In `pipeline/tests/test_run.py`, the `calls` fixture also fakes the smoke search:

```python
    def fake_smoke(cfg, env, client, notifier):
        made.append(("smoke", env))
        return Counter(ok=5)
    ...
    monkeypatch.setattr(steps, "smoke", fake_smoke)
```

and the two tests change to:

```python
def test_run_all_with_env_publishes_then_backs_up_then_notifies(conn, paths, cfg, calls):
    upsert_from_fixture_and_scope(conn, "recent:2")
    results = quick_run(conn, paths, cfg, env="staging")
    assert [c[0] for c in calls] == ["publish", "smoke", "backup", "notify"]
    assert calls[0] == ("publish", "staging", sorted(scoped(conn)))
    assert calls[1] == ("smoke", "staging")
    # The summary sees every step's counts.
    assert calls[3] == ("notify", ["backup", "chunk", "download", "embed", "publish",
                                   "smoke", "transcribe"])
    assert results["publish"]["ok"] == 2 and results["backup"]["ok"] == 1
    assert results["smoke"]["ok"] == 5


def test_run_all_without_env_skips_publish_with_a_warning(conn, paths, cfg, calls, wts_messages):
    results = quick_run(conn, paths, cfg)
    assert [c[0] for c in calls] == ["backup", "notify"]
    assert "publish" not in results and "smoke" not in results
    assert any("not publishing" in m and "run_env" in m for m in wts_messages)
```

Run `grep -n '"publish", "backup"' pipeline/tests/test_run.py` and update any other test that lists steps in order the same way.

- [ ] **Step 2: Run them to see them fail**

Run: `cd pipeline && uv run pytest tests/test_eval_smoke.py tests/test_run.py -q`
Expected: FAIL (`ImportError: cannot import name 'smoke'`; `test_run.py` fails on `steps.smoke`).

- [ ] **Step 3: Write `smoke`**

Add to the imports of `pipeline/src/wts/evalset/run.py`, the `wts.evalset.cases` line replacing Task 3's (neither `wts.config` nor `wts.notify` imports `wts.evalset` or `wts.steps`, so there is no cycle):

```python
import logging
from collections import Counter

import click

from wts.config import Config
from wts.evalset.cases import Case, CaseError, load_cases
from wts.notify import Notifier
```

and append:

```python
log = logging.getLogger("wts")


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
```

An `EvalError` reads `case conoid: search failed: HTTP 503 …`, so the body line becomes `conoid: search failed: HTTP 503 …`.

- [ ] **Step 4: Call it from `run_all`**

In `pipeline/src/wts/steps.py`, import `from wts.evalset.run import smoke` with the other imports, and after the `for name, step in steps:` loop (still inside the `try`):

```python
        if env:  # the publish step ran: check the environment answers (spec §8.1)
            with run_record(conn, "smoke") as run:
                run.counts.update(smoke(cfg, env, client_, notifier))
            results["smoke"] = run.counts
```

Update the `run_all` docstring's first line to `feed → download → transcribe → chunk → embed → publish → smoke → backup`, and the spec §3 table row for `wts run` (drop "the smoke search comes in plan 5"; add "*(Smoke search: plan 5.)*").

- [ ] **Step 5: Run the tests**

Run: `cd pipeline && uv run pytest -q && uv run ruff check .`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/wts/evalset/run.py pipeline/src/wts/steps.py pipeline/tests/test_eval_smoke.py pipeline/tests/test_run.py docs/superpowers/specs/2026-10-04-wood-talk-search-design.md
git commit -m "run: a smoke search after publishing, notified on failure (plan 5, Task 4)"
```

---

### Task 5: `wts eval generate`

**Files:**
- Create: `pipeline/src/wts/evalset/generate.py`
- Modify: `pipeline/src/wts/config.py` (`eval_model`), `pipeline/src/wts/cli.py` (`eval generate`)
- Test: `pipeline/tests/test_eval_generate.py`

**Interfaces:**
- Consumes: `Case`, `Item`, `load_cases` (Task 1); `clock` from `wts.evalset.score` (Task 2, for `m:ss`); `state.db`'s `chunks` and `episodes`.
- Produces: `OLLAMA_URL = "http://localhost:11434"`; `GenerateError(Exception)`; `sample_chunks(conn, count: int, seed: int) -> list[sqlite3.Row]` (columns `number`, `start_ms`, `text`); `clean_query(text: str) -> str | None`; `ask_model(client, model: str, text: str, *, seed: int, url: str = OLLAMA_URL) -> str`; `generate(conn, client, model: str, *, count: int, seed: int) -> tuple[list[dict], int]` (case dicts, skipped count); `write_synthetic(cases: list[dict], path: Path, *, header: str) -> None`.

- [ ] **Step 1: Write the failing tests**

`pipeline/tests/test_eval_generate.py`:

```python
"""Synthetic cases (spec §7.2 source 2, plan 5 Task 5): a local model writes the query for a
sampled chunk, so the right answer is that chunk."""

import json

import httpx
import pytest
from click.testing import CliRunner
from conftest import insert_episode

from wts.cli import main
from wts.evalset.cases import load_cases
from wts.evalset.generate import (
    OLLAMA_URL,
    GenerateError,
    ask_model,
    clean_query,
    generate,
    sample_chunks,
    write_synthetic,
)
from wts.net import new_client

LONG = "We talked about flattening the top of a workbench with a jack plane. " * 8


def add_chunk(conn, episode_id, seq, start_ms, text=LONG, boilerplate=0):
    conn.execute(
        "insert into chunks (episode_id, seq, start_ms, end_ms, text, word_times, is_boilerplate)"
        " values (?, ?, ?, ?, ?, '[]', ?)",
        (episode_id, seq, start_ms, start_ms + 60_000, text, boilerplate))
    conn.commit()


@pytest.fixture
def corpus(conn):
    published = insert_episode(conn, number=71, status="published")
    unpublished = insert_episode(conn, number=72, status="embedded")
    add_chunk(conn, published, 0, 0)
    add_chunk(conn, published, 1, 61_000)
    add_chunk(conn, published, 2, 122_000, boilerplate=1)
    add_chunk(conn, published, 3, 183_000, text="too short")
    add_chunk(conn, unpublished, 0, 0)
    return conn


def test_sample_takes_long_non_boilerplate_chunks_of_published_episodes(corpus):
    rows = sample_chunks(corpus, 10, seed=1)
    assert [(r["number"], r["start_ms"]) for r in rows] == [(71, 0), (71, 61_000)]


def test_the_same_seed_gives_the_same_sample(corpus):
    a = [r["start_ms"] for r in sample_chunks(corpus, 1, seed=3)]
    assert a == [r["start_ms"] for r in sample_chunks(corpus, 1, seed=3)]


@pytest.mark.parametrize(("raw", "clean"), [
    ("flattening a workbench top", "flattening a workbench top"),
    ('"Flattening a workbench top."\n', "Flattening a workbench top"),
    ("Query: flattening a bench\nBecause…", "flattening a bench"),
    ("", None),
    ("one", None),
    ("a b c d e f g h i j k l m n o p", None),  # more than 12 words
    ("year:2020 sprayer", None),  # query syntax
    ("-glue clamps", None),
])
def test_clean_query(raw, clean):
    assert clean_query(raw) == clean


def test_ask_model_posts_to_ollama(respx_mock):
    route = respx_mock.post(f"{OLLAMA_URL}/api/generate").mock(
        return_value=httpx.Response(200, json={"response": "flattening a bench top"}))
    with new_client() as client:
        assert ask_model(client, "qwen2.5:7b", LONG, seed=4) == "flattening a bench top"
    sent = json.loads(route.calls[0].request.content)
    assert sent["model"] == "qwen2.5:7b" and sent["stream"] is False
    assert sent["options"] == {"temperature": 0, "seed": 4}
    assert LONG.strip() in sent["prompt"]


def test_ollama_not_running_says_start_it(respx_mock):
    respx_mock.post(f"{OLLAMA_URL}/api/generate").mock(side_effect=httpx.ConnectError("refused"))
    with new_client() as client, pytest.raises(GenerateError, match="Ollama app"):
        ask_model(client, "m", LONG, seed=1)


def test_a_missing_model_says_pull_it(respx_mock):
    respx_mock.post(f"{OLLAMA_URL}/api/generate").mock(
        return_value=httpx.Response(404, json={"error": "model 'm' not found"}))
    with new_client() as client, pytest.raises(GenerateError, match="ollama pull m"):
        ask_model(client, "m", LONG, seed=1)


def test_generate_writes_loadable_cases_and_counts_the_skipped(corpus, respx_mock, tmp_path):
    answers = iter(["flattening a workbench top", ""])
    respx_mock.post(f"{OLLAMA_URL}/api/generate").mock(
        side_effect=lambda request: httpx.Response(200, json={"response": next(answers)}))
    with new_client() as client:
        cases, skipped = generate(corpus, client, "m", count=2, seed=1)
    assert skipped == 1
    assert cases == [{"id": "syn-071-0000", "query": "flattening a workbench top",
                      "tag": "paraphrase", "expect": [{"episode": 71, "at": "0:00"}]}]
    write_synthetic(cases, tmp_path / "synthetic.yaml", header="# generated")
    text = (tmp_path / "synthetic.yaml").read_text()
    assert text.startswith("# generated\n")
    [case] = load_cases(tmp_path)
    assert case.mode == "both" and case.expect[0].at_s == 0


def test_cli_needs_a_model(wts_home, monkeypatch):
    r = CliRunner().invoke(main, ["eval", "generate"])
    assert r.exit_code == 2 and "eval_model" in r.output
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd pipeline && uv run pytest tests/test_eval_generate.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'wts.evalset.generate'`.

- [ ] **Step 3: Write `generate.py`**

```python
"""Synthetic test cases (spec §7.2, source 2): a local model, through Ollama on the Mac, writes
the query a listener would type to find a randomly sampled passage, so the right answer is that
passage. Seeded, so a rerun over the same chunks gives the same file."""

import random
import re
import sqlite3
from pathlib import Path

import httpx
import yaml

from wts.evalset.score import clock

OLLAMA_URL = "http://localhost:11434"
TIMEOUT_S = 120  # a cold model takes a while to load
MIN_CHARS = 400  # a chunk shorter than this rarely holds a findable topic
MAX_WORDS = 12
PROMPT = """Here is a passage from Wood Talk, a woodworking podcast:

{text}

A listener remembers this part of the show and wants to find it again. Write the search \
query they would type, 3 to 10 words. Describe what was discussed in your own words; don't \
copy distinctive phrases from the passage. Reply with the query only."""
_SYNTAX = re.compile(r"(^|\s)-|\w:\S")  # an exclusion or a filter like year:2020


class GenerateError(Exception):
    """Ollama can't be used; the message says what to do."""


def sample_chunks(conn: sqlite3.Connection, count: int, seed: int) -> list[sqlite3.Row]:
    rows = conn.execute(
        "select e.number, c.start_ms, c.text from chunks c join episodes e on e.id = c.episode_id"
        " where e.status = 'published' and e.number is not null and c.is_boilerplate = 0"
        " and length(c.text) >= ? order by e.number, c.start_ms", (MIN_CHARS,)).fetchall()
    picked = random.Random(seed).sample(rows, min(count, len(rows)))
    return sorted(picked, key=lambda r: (r["number"], r["start_ms"]))


def clean_query(text: str) -> str | None:
    """The model's reply as a query, or None when it isn't usable as one."""
    line = next((ln for ln in text.strip().splitlines() if ln.strip()), "")
    line = re.sub(r"^(search )?query:\s*", "", line.strip(), flags=re.IGNORECASE)
    line = line.strip().strip("\"'“”").rstrip(".").strip()
    words = line.split()
    if not 2 <= len(words) <= MAX_WORDS or _SYNTAX.search(line) or '"' in line:
        return None
    return line


def ask_model(client: httpx.Client, model: str, text: str, *, seed: int,
              url: str = OLLAMA_URL) -> str:
    try:
        resp = client.post(f"{url}/api/generate", timeout=TIMEOUT_S, json={
            "model": model, "prompt": PROMPT.format(text=text.strip()), "stream": False,
            "options": {"temperature": 0, "seed": seed}})
    except httpx.TransportError as exc:
        raise GenerateError(f"can't reach Ollama at {url} ({type(exc).__name__}): start the "
                            "Ollama app, or run `ollama serve`") from exc
    if resp.status_code == 404:
        raise GenerateError(f"model {model} is not installed: `ollama pull {model}`")
    if resp.status_code >= 400:
        raise GenerateError(f"Ollama answered HTTP {resp.status_code}")
    return str(resp.json().get("response", ""))


def generate(conn: sqlite3.Connection, client: httpx.Client, model: str, *, count: int,
             seed: int) -> tuple[list[dict], int]:
    cases, skipped = [], 0
    for i, row in enumerate(sample_chunks(conn, count, seed)):
        query = clean_query(ask_model(client, model, row["text"], seed=seed + i))
        if query is None:
            skipped += 1
            continue
        at = clock(row["start_ms"] // 1000)
        cases.append({"id": f"syn-{row['number']:03d}-{at.replace(':', ''):0>4}",
                      "query": query, "tag": "paraphrase",
                      "expect": [{"episode": row["number"], "at": at}]})
    return cases, skipped


def write_synthetic(cases: list[dict], path: Path, *, header: str) -> None:
    body = yaml.safe_dump(cases, sort_keys=False, allow_unicode=True, width=100)
    path.write_text(f"{header}\n{body}")
```

(`syn-071-0000` for 0:00, `syn-071-4101` for 41:01, `syn-071-10203` for 1:02:03: the id only has to be unique, and the zero-padding to four keeps short times aligned.)

- [ ] **Step 4: Config and CLI**

`pipeline/src/wts/config.py`: add the field `eval_model: str | None = None  # wts eval generate: an Ollama model` after `ntfy_url`, and `eval_model=data.get("eval_model"),` in `load_config`. Add a test to `tests/test_config.py` in its existing style that `eval_model = "qwen2.5:7b"` loads.

`pipeline/src/wts/cli.py`, after `eval_run_cmd`:

```python
@eval_group.command("generate")
@click.option("--model", default=None, help="Ollama model [default: eval_model in config.toml].")
@click.option("--count", type=click.IntRange(min=1), default=100, show_default=True)
@click.option("--seed", type=int, default=1, show_default=True)
def eval_generate_cmd(model: str | None, count: int, seed: int) -> None:
    """Write eval/synthetic.yaml: a local model's query for each of COUNT sampled passages.

    Needs the Ollama app (or `ollama serve`) running. The file is rewritten whole; check the
    diff before committing, and drop a case by regenerating with another seed rather than by
    hand.
    """
    from datetime import date

    from wts.evalset.cases import eval_dir
    from wts.evalset.generate import GenerateError, generate, write_synthetic
    from wts.net import new_client

    ctx = _ctx()
    model = model or ctx.cfg.eval_model
    if not model:
        raise click.UsageError(f"no model: use --model or eval_model in {ctx.paths.config_file}")
    try:
        with new_client() as client:
            cases, skipped = generate(ctx.conn(), client, model, count=count, seed=seed)
    except GenerateError as exc:
        raise click.ClickException(str(exc)) from exc
    path = eval_dir() / "synthetic.yaml"
    header = (f"# Written by `wts eval generate --model {model} --count {count} --seed {seed}`"
              f" on {date.today().isoformat()}.\n# Don't edit by hand: regenerate and review the diff.")
    write_synthetic(cases, path, header=header)
    click.echo(f"{len(cases)} cases written to {path}"
               + (f"; {skipped} replies weren't usable as a query" if skipped else ""))
```

- [ ] **Step 5: Run the tests**

Run: `cd pipeline && uv run pytest -q && uv run ruff check .`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/wts/evalset/generate.py pipeline/src/wts/config.py pipeline/src/wts/cli.py pipeline/tests/test_eval_generate.py pipeline/tests/test_config.py
git commit -m "eval: wts eval generate, synthetic cases from a local model (plan 5, Task 5)"
```

---

### Checkpoint K (the maintainer, on the Mac)

1. `cd pipeline && uv run wts eval run`: about 15 s for the committed cases. Read the table and the failures. `aspirational-builds` is expected to fail or rank low today (HANDOFF: 11th).
2. Add your ~30 cases to `eval/queries.yaml` (or send them in any form and Claude writes them). Rerun.
3. Start the Ollama app, `ollama pull <model>` if needed, then `uv run wts eval generate --model <model>`. Read `eval/synthetic.yaml`: are the queries ones a person would type? Rerun `wts eval run` (about five minutes now).
4. `uv run wts eval run --update`, then commit `eval/` (the baseline and both case files).
5. Next `wts run --env staging` ends with `smoke: ok=5`.

After this checkpoint the tuning ideas parked for the test set can be measured one at a time (HANDOFF: bge's query instruction, a similarity floor on related hits, topK 50 → 20–30, an `episode_id` metadata index for `ep:`, porter stemming of glue/glued/gluing, Newest vs Best match as the Exact default).
