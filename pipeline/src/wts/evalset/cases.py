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
